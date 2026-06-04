<script>
	import { page } from '$app/stores';
	import { replaceState } from '$app/navigation';
	import { browser } from '$app/environment';
	import { get } from 'svelte/store';
	import { apiUrl } from '$lib/config';
	import {
		fetchCollection,
		fetchRoot,
		buildItemsUrl,
		fetchItemsPage,
		buildDatetime,
		collectionBbox,
		collectionInterval
	} from '$lib/stac';
	import StacMap from '$lib/StacMap.svelte';
	import { fsApiSupported, isHttps, filenameFromHref, fileExists } from '$lib/download';
	import { enqueueAssets, getHistory } from '$lib/queue';
	import { queueItems, historyItems } from '$lib/queueStore';
	import { start as startDownloads, acquireDirectory } from '$lib/downloadController';

	let id = $derived($page.params.id);

	let collection = $state(null);
	let collectionError = $state('');
	let loadingCollection = $state(false);

	// Catalog name (from the STAC landing page) used as the top download folder.
	let catalogName = $state('');
	$effect(() => {
		const root = $apiUrl;
		fetchRoot(root)
			.then((r) => {
				catalogName = r?.id || r?.title || hostnameOf(root);
			})
			.catch(() => {
				catalogName = hostnameOf(root);
			});
	});

	function hostnameOf(url) {
		try {
			return new URL(url).hostname;
		} catch {
			return 'catalog';
		}
	}

	let items = $state([]);
	let itemsError = $state('');
	let loadingItems = $state(false);

	// Pagination: each entry is a request (URL string for page 0, paging link
	// objects thereafter) so we can navigate forward and back even on APIs that
	// only return a `next` link.
	let pageRequests = $state([]);
	let pageIndex = $state(0);
	let nextLink = $state(null);
	let numberMatched = $state(null);

	// Filters
	let start = $state('');
	let end = $state('');
	let limit = $state(50);
	let useMapBounds = $state(false);
	let mapBounds = $state(null); // [w,s,e,n] from the map

	let selected = $state(null);
	// Bumped on each row click; a new object identity forces the map to refocus
	// even when the same item is clicked twice.
	let focusTarget = $state(null);
	let focusN = 0;

	function focusItem(item) {
		selected = item;
		focusN += 1;
		focusTarget = { feature: item, n: focusN };
	}

	// Item asset sub-tables are expanded by default; this tracks which rows the
	// user has explicitly collapsed (id -> true). Empty = all expanded.
	let collapsed = $state({});
	function toggleExpanded(itemId) {
		collapsed = { ...collapsed, [itemId]: !collapsed[itemId] };
	}

	// ---- Client-side asset selection filter -------------------------------
	// An asset is uniquely identified by its item id + asset key.
	const assetId = (itemId, key) => `${itemId}::${key}`;
	const uniqueSorted = (arr) => [...new Set(arr)].sort();

	// Multi-select filter values and the resulting selection set.
	let assetFilterKeys = $state([]);
	let assetFilterRoles = $state([]);
	let selectedAssets = $state(new Set());

	// Unique asset keys / roles available across the current page of items.
	let availableKeys = $derived(
		uniqueSorted(items.flatMap((i) => Object.keys(i.assets ?? {})))
	);
	let availableRoles = $derived(
		uniqueSorted(
			items.flatMap((i) => Object.values(i.assets ?? {}).flatMap((a) => a.roles ?? []))
		)
	);

	// Derive the selection from the key/role filters: an asset is selected when
	// its key is in the chosen keys OR any of its roles is in the chosen roles.
	// Re-runs whenever the filters or the page of items change.
	$effect(() => {
		const keys = assetFilterKeys;
		const roles = assetFilterRoles;
		const list = items;
		const next = new Set();
		if (keys.length || roles.length) {
			for (const item of list) {
				for (const [key, asset] of Object.entries(item.assets ?? {})) {
					const keyMatch = keys.includes(key);
					const roleMatch = (asset.roles ?? []).some((r) => roles.includes(r));
					if (keyMatch || roleMatch) next.add(assetId(item.id, key));
				}
			}
		}
		selectedAssets = next;
	});

	// Allow manual checkbox overrides on top of the filter-driven selection.
	function toggleAsset(id) {
		const next = new Set(selectedAssets);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedAssets = next;
	}

	function clearAssetFilter() {
		assetFilterKeys = [];
		assetFilterRoles = [];
		// The effect above will clear selectedAssets in response.
	}

	// Index of selection id -> asset for the current page, for quick href lookup.
	let assetIndex = $derived(
		(() => {
			const m = new Map();
			for (const item of items) {
				for (const [key, asset] of Object.entries(item.assets ?? {})) {
					m.set(assetId(item.id, key), asset);
				}
			}
			return m;
		})()
	);

	const fsSupported = fsApiSupported();

	let queuedNote = $state(''); // transient confirmation after enqueuing

	// ---- Asset status indicators (queued / downloaded / on-disk) ----------
	// Matched by href against the live queue + history stores; on-disk requires
	// the "Check disk" button (folder permission needs a user gesture).
	let queuedHrefs = $derived(new Set($queueItems.map((i) => i.href)));
	let historyHrefs = $derived(new Set($historyItems.map((h) => h.href)));

	let onDiskHrefs = $state(new Set());
	let diskChecking = $state(false);
	let diskCheckEnabled = $state(false); // true once the user has run a disk check
	let scanSeq = 0;

	function assetDescriptor(item, asset) {
		return {
			href: asset.href,
			filename: filenameFromHref(asset.href),
			itemId: item.id,
			collectionId: collection.id,
			catalogName: catalogName || 'catalog'
		};
	}

	async function scanDisk(dir) {
		const seq = ++scanSeq;
		const descs = [];
		for (const it of items) {
			for (const a of Object.values(it.assets ?? {})) {
				if (a.href) descs.push(assetDescriptor(it, a));
			}
		}
		const hits = await Promise.all(descs.map((d) => fileExists(dir, d)));
		if (seq !== scanSeq) return; // superseded by a newer scan
		const set = new Set();
		descs.forEach((d, i) => hits[i] && set.add(d.href));
		onDiskHrefs = set;
	}

	async function checkDisk() {
		if (diskChecking || !fsSupported) return;
		diskChecking = true;
		try {
			let dir = null;
			try {
				dir = await acquireDirectory(true);
			} catch {
				dir = null;
			}
			if (!dir) return;
			diskCheckEnabled = true;
			await scanDisk(dir);
		} finally {
			diskChecking = false;
		}
	}

	// Once enabled, re-scan silently (no prompt) whenever the page of items changes.
	$effect(() => {
		void items;
		if (!diskCheckEnabled) return;
		acquireDirectory(false)
			.then((dir) => {
				if (dir) scanDisk(dir);
			})
			.catch(() => {});
	});

	// Aggregate status for an item row (across its assets).
	function itemStatus(item) {
		let downloaded = 0;
		let queued = 0;
		for (const a of Object.values(item.assets ?? {})) {
			if (!a.href) continue;
			if (queuedHrefs.has(a.href)) queued++;
			if (historyHrefs.has(a.href) || onDiskHrefs.has(a.href)) downloaded++;
		}
		return { downloaded, queued };
	}

	// Count of selected assets that are actually downloadable (https hrefs).
	let httpsSelectedCount = $derived(
		(() => {
			let n = 0;
			for (const id of selectedAssets) {
				const asset = assetIndex.get(id);
				if (asset?.href && isHttps(asset.href)) n++;
			}
			return n;
		})()
	);

	// Duplicate-confirmation modal state.
	const DUP_WINDOW_DAYS = 30;
	let dupReview = $state([]); // duplicate candidates awaiting per-item decision
	let dupIndex = $state(0); // which duplicate is currently shown
	let dupAcceptAll = $state(false); // apply the next decision to all remaining
	let baseAssets = []; // non-duplicate assets to always enqueue
	let acceptedDuplicates = []; // duplicates the user chose to add

	let showDupModal = $derived(dupReview.length > dupIndex && dupReview.length > 0);
	let currentDup = $derived(dupReview[dupIndex] ?? null);
	let dupsRemaining = $derived(Math.max(0, dupReview.length - dupIndex));

	// Build the selected https assets, then flag potential duplicates: an asset
	// is a duplicate if it was downloaded within the last 30 days (history) OR it
	// already exists at its target path in the chosen download folder. Duplicates
	// open a confirmation modal cycled one at a time; the rest queue immediately.
	async function downloadSelectedAssets() {
		if (!fsSupported) return;
		const assets = [];
		for (const id of selectedAssets) {
			const asset = assetIndex.get(id);
			if (!asset?.href || !isHttps(asset.href)) continue;
			const itemId = id.slice(0, id.indexOf('::')); // id is `${itemId}::${key}`
			assets.push({
				href: asset.href,
				filename: filenameFromHref(asset.href),
				itemId,
				collectionId: collection.id,
				catalogName: catalogName || 'catalog'
			});
		}
		if (assets.length === 0) return;

		// Acquire the download folder first (keeps the click gesture valid for the
		// permission/picker prompt). Cancelling falls back to a history-only check.
		let dir = null;
		try {
			dir = await acquireDirectory(true);
		} catch {
			dir = null;
		}

		// Most-recent download time per href, within the dedupe window.
		const cutoff = Date.now() - DUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
		const recentByHref = new Map();
		for (const h of await getHistory()) {
			const t = h.downloadedAt ? Date.parse(h.downloadedAt) : NaN;
			if (!Number.isNaN(t) && t >= cutoff) {
				const prev = recentByHref.get(h.href);
				if (prev == null || t > prev) recentByHref.set(h.href, t);
			}
		}

		// Does each asset already exist on disk at its target path?
		const onDisk = dir
			? await Promise.all(assets.map((a) => fileExists(dir, a)))
			: assets.map(() => false);

		baseAssets = [];
		const duplicates = [];
		assets.forEach((a, i) => {
			const recent = recentByHref.has(a.href);
			if (recent || onDisk[i]) {
				duplicates.push({
					...a,
					lastDownloadedAt: recent ? new Date(recentByHref.get(a.href)).toISOString() : null,
					onDisk: onDisk[i]
				});
			} else {
				baseAssets.push(a);
			}
		});

		acceptedDuplicates = [];
		dupAcceptAll = false;
		dupIndex = 0;

		if (duplicates.length === 0) {
			await finalizeQueue();
			return;
		}
		dupReview = duplicates; // opens the modal
	}

	function acceptDuplicate() {
		if (dupAcceptAll) {
			acceptedDuplicates.push(...dupReview.slice(dupIndex));
			dupIndex = dupReview.length; // closes modal
			finalizeQueue();
		} else {
			acceptedDuplicates.push(dupReview[dupIndex]);
			advanceDuplicate();
		}
	}

	function skipDuplicate() {
		if (dupAcceptAll) {
			dupIndex = dupReview.length; // skip all remaining, closes modal
			finalizeQueue();
		} else {
			advanceDuplicate();
		}
	}

	function advanceDuplicate() {
		dupIndex += 1;
		if (dupIndex >= dupReview.length) finalizeQueue();
	}

	// Enqueue the resolved set and start the controller. Runs from a modal/button
	// click, so the user gesture needed for the directory picker is preserved.
	async function finalizeQueue() {
		dupReview = [];
		dupIndex = 0;
		const all = [...baseAssets, ...acceptedDuplicates];
		if (all.length === 0) {
			queuedNote = 'No assets added to the queue.';
			return;
		}
		await enqueueAssets(all);
		queuedNote = `Added ${all.length} asset${all.length === 1 ? '' : 's'} to the download queue.`;
		startDownloads(); // prompts for a folder if one isn't already chosen
	}

	let initialBbox = $derived(collection ? collectionBbox(collection) : null);

	// --- URL <-> items-search sync (start / end / limit / bbox) ---------------
	// Seed the search filters from the current URL query string. Read via get()
	// (non-reactive) so the collection-load effect doesn't depend on the URL —
	// otherwise every replaceState would re-run it and re-fetch.
	function readUrlFilters() {
		if (!browser) return;
		const p = get(page).url.searchParams;
		start = p.get('start') ?? '';
		end = p.get('end') ?? '';
		const lim = Number(p.get('limit'));
		if (lim) limit = lim;
		const bb = p.get('bbox');
		if (bb) {
			const a = bb.split(',').map(Number);
			if (a.length === 4 && a.every(Number.isFinite)) {
				mapBounds = a;
				useMapBounds = true;
			}
		}
	}

	// Write the current items-search filters into the URL (shallow, no reload).
	// Preserves the hash (set by the metadata scroll-spy).
	function syncUrl() {
		if (!browser) return;
		const u = new URL(get(page).url);
		const p = u.searchParams;
		start ? p.set('start', start) : p.delete('start');
		end ? p.set('end', end) : p.delete('end');
		p.set('limit', String(limit));
		if (useMapBounds && mapBounds) p.set('bbox', mapBounds.join(',')); else p.delete('bbox');
		replaceState(u, {});
	}

	// Load the collection metadata when id / API changes.
	$effect(() => {
		const root = $apiUrl;
		const cid = id;

		// Reset per-collection UI state so nothing bleeds across collections
		// (this route reuses the same component instance on navigation).
		items = [];
		itemsError = '';
		pageRequests = [];
		pageIndex = 0;
		nextLink = null;
		numberMatched = null;
		selected = null;
		focusTarget = null;
		collapsed = {};
		onDiskHrefs = new Set();
		assetFilterKeys = [];
		assetFilterRoles = [];
		selectedAssets = new Set();
		start = '';
		end = '';
		useMapBounds = false;
		mapBounds = null;
		dupReview = [];
		dupIndex = 0;
		dupAcceptAll = false;
		baseAssets = [];
		acceptedDuplicates = [];
		queuedNote = '';

		// Override the reset defaults with any items-search params from the URL.
		readUrlFilters();

		loadingCollection = true;
		collectionError = '';
		collection = null;
		fetchCollection(root, cid)
			.then((c) => {
				collection = c;
			})
			.catch((e) => {
				collectionError = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				loadingCollection = false;
			});
	});

	// Load the page described by pageRequests[pageIndex].
	async function loadPage() {
		loadingItems = true;
		itemsError = '';
		try {
			const page = await fetchItemsPage(pageRequests[pageIndex]);
			items = page.features;
			nextLink = page.nextLink;
			numberMatched = page.numberMatched;
			selected = null;
			focusTarget = null;
			collapsed = {};
		} catch (e) {
			itemsError = e instanceof Error ? e.message : String(e);
			items = [];
			nextLink = null;
		} finally {
			loadingItems = false;
		}
	}

	// Run a fresh items query using the current filters (resets pagination).
	function queryItems() {
		const filters = {
			limit: Number(limit) || undefined,
			datetime: buildDatetime(start, end)
		};
		if (useMapBounds && mapBounds) filters.bbox = mapBounds;
		syncUrl();
		pageRequests = [buildItemsUrl($apiUrl, id, filters)];
		pageIndex = 0;
		return loadPage();
	}

	function nextPage() {
		if (!nextLink) return;
		// Trim any forward history, then append the next request.
		pageRequests = [...pageRequests.slice(0, pageIndex + 1), nextLink];
		pageIndex += 1;
		loadPage();
	}

	function prevPage() {
		if (pageIndex === 0) return;
		pageIndex -= 1;
		loadPage();
	}

	// Auto-run an initial query once the collection is loaded.
	let queriedFor = $state('');
	$effect(() => {
		if (collection && queriedFor !== id) {
			queriedFor = id;
			queryItems();
		}
	});

	function prefillFromExtent() {
		if (!collection) return;
		const [s, e] = collectionInterval(collection);
		start = s ? s.slice(0, 10) : '';
		end = e ? e.slice(0, 10) : '';
	}

	let temporal = $derived(collection ? collectionInterval(collection) : [null, null]);
	let spatialBbox = $derived(collection ? collectionBbox(collection) : null);

	// --- Metadata sections: TOC + hash scroll-spy ----------------------------
	// Which sections to show in the table of contents (only those with data).
	// Overview / Extent / Downloads are always present.
	let sections = $derived(
		!collection
			? []
			: [
					{ id: 'sec-overview', label: 'Overview' },
					collection.description && { id: 'sec-description', label: 'Description' },
					{ id: 'sec-extent', label: 'Extent' },
					collection.providers?.length && { id: 'sec-providers', label: 'Providers' },
					collection.keywords?.length && { id: 'sec-keywords', label: 'Keywords' },
					collection.summaries && Object.keys(collection.summaries).length
						? { id: 'sec-summaries', label: 'Summaries' }
						: null,
					{ id: 'sec-downloads', label: 'Downloads' }
				].filter(Boolean)
	);

	let metaEl = $state(null); // the scrollable left panel; scroll-spy root
	let activeSection = $state('');

	// Reflect the scrolled-to section into the URL hash (shallow, no history spam).
	function setHash(secId) {
		if (!browser || !secId) return;
		const u = new URL(get(page).url);
		if (u.hash === `#${secId}`) return;
		u.hash = secId;
		replaceState(u, {});
	}

	// Pick the active section deterministically: the last section whose top has
	// scrolled up to (or past) the top of the scroll area (the TOC is a separate
	// pinned header outside it). A bottom clamp lets a tiny final section activate
	// when scrolled all the way down.
	function computeActive() {
		if (!metaEl) return;
		const els = [...metaEl.querySelectorAll('section[id^="sec-"]')];
		if (!els.length) return;
		const base = metaEl.getBoundingClientRect().top + 1;
		let current = els[0].id;
		for (const el of els) {
			if (el.getBoundingClientRect().top <= base) current = el.id;
			else break;
		}
		if (metaEl.scrollTop + metaEl.clientHeight >= metaEl.scrollHeight - 2) {
			current = els[els.length - 1].id;
		}
		if (current !== activeSection) {
			activeSection = current;
			setHash(current);
		}
	}

	// Scroll/​resize-driven scroll-spy, re-wired when the section set changes.
	$effect(() => {
		sections; // re-run when the section set changes
		if (!browser || !metaEl) return;
		let raf = 0;
		const onScroll = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				computeActive();
			});
		};
		computeActive();
		metaEl.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll);
		return () => {
			metaEl.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onScroll);
			if (raf) cancelAnimationFrame(raf);
		};
	});

	// Exact click navigation: scroll the section's heading to the top of the
	// scroll area.
	function gotoSection(e, secId) {
		e.preventDefault();
		if (!metaEl) return;
		const el = metaEl.querySelector('#' + CSS.escape(secId));
		if (!el) return;
		const top =
			el.getBoundingClientRect().top - metaEl.getBoundingClientRect().top + metaEl.scrollTop;
		metaEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
		activeSection = secId;
		setHash(secId);
	}
</script>

{#if loadingCollection}
	<p class="back"><a href="/">← All collections</a></p>
	<p>Loading collection…</p>
{:else if collectionError}
	<p class="back"><a href="/">← All collections</a></p>
	<div class="error">
		<strong>Failed to load collection.</strong>
		<pre>{collectionError}</pre>
	</div>
{:else if collection}
	<div class="cd-split">
		<div class="cd-meta">
			<nav class="cd-toc">
				{#each sections as s (s.id)}
					<a
						href="#{s.id}"
						class:active={activeSection === s.id}
						onclick={(e) => gotoSection(e, s.id)}>{s.label}</a
					>
				{/each}
			</nav>

			<div class="cd-scroll" bind:this={metaEl}>
			<p class="back"><a href="/">← All collections</a></p>
			<h1>{collection.title || collection.id}</h1>

			<section id="sec-overview" class="cd-section">
				<h2>Overview</h2>
				<div class="meta">
					<div><label>ID</label><code>{collection.id}</code></div>
					{#if collection.license}
						<div><label>License</label>{collection.license}</div>
					{/if}
					{#if collection.stac_version}
						<div><label>STAC version</label>{collection.stac_version}</div>
					{/if}
				</div>
			</section>

			{#if collection.description}
				<section id="sec-description" class="cd-section">
					<h2>Description</h2>
					<p class="desc">{collection.description}</p>
				</section>
			{/if}

			<section id="sec-extent" class="cd-section">
				<h2>Extent</h2>
				<h3>Spatial</h3>
				{#if spatialBbox}
					<p class="muted">
						W {spatialBbox[0]}, S {spatialBbox[1]}, E {spatialBbox[2]}, N {spatialBbox[3]}
					</p>
				{:else}
					<p class="muted">—</p>
				{/if}
				<h3>Temporal</h3>
				<p class="muted">{temporal[0] ?? '…'} → {temporal[1] ?? 'now'}</p>
			</section>

			{#if collection.providers?.length}
				<section id="sec-providers" class="cd-section">
					<h2>Providers</h2>
					<ul class="prov-list">
						{#each collection.providers as prov (prov.name)}
							<li>
								{#if prov.url}
									<a href={prov.url} target="_blank" rel="noreferrer">{prov.name}</a>
								{:else}
									{prov.name}
								{/if}
								{#if prov.roles?.length}
									<span class="muted"> — {prov.roles.join(', ')}</span>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if collection.keywords?.length}
				<section id="sec-keywords" class="cd-section">
					<h2>Keywords</h2>
					<div class="kw-list">
						{#each collection.keywords as kw (kw)}
							<span class="kw">{kw}</span>
						{/each}
					</div>
				</section>
			{/if}

			{#if collection.summaries && Object.keys(collection.summaries).length}
				<section id="sec-summaries" class="cd-section">
					<h2>Summaries</h2>
					<dl class="summary-list">
						{#each Object.entries(collection.summaries) as [k, v] (k)}
							<dt>{k}</dt>
							<dd class="muted">
								{Array.isArray(v)
									? v.join(', ')
									: typeof v === 'object'
										? JSON.stringify(v)
										: v}
							</dd>
						{/each}
					</dl>
				</section>
			{/if}

			<section id="sec-downloads" class="cd-section">
				<h2>Downloads</h2>

				<div class="filters">
			<div class="field">
				<label for="start">Start date</label>
				<input id="start" type="date" bind:value={start} />
			</div>
			<div class="field">
				<label for="end">End date</label>
				<input id="end" type="date" bind:value={end} />
			</div>
			<div class="field">
				<label for="limit">Items per page</label>
				<select id="limit" bind:value={limit} onchange={queryItems}>
					{#each [10, 25, 50, 100, 250] as n (n)}
						<option value={n}>{n}</option>
					{/each}
				</select>
			</div>
			<div class="field check">
				<label><input type="checkbox" bind:checked={useMapBounds} /> Restrict to map view</label>
			</div>
			<div class="actions">
				<button onclick={queryItems} disabled={loadingItems}>
					{loadingItems ? 'Querying…' : 'Query items'}
				</button>
				<button onclick={prefillFromExtent} type="button">Use full extent</button>
			</div>

			{#if itemsError}
				<div class="error small"><pre>{itemsError}</pre></div>
			{:else}
				<p class="count">
					{items.length} item{items.length === 1 ? '' : 's'} on this page{#if numberMatched != null}
						· {numberMatched} matched{/if}
				</p>
			{/if}

			{#if selected}
				<div class="selected">
					<h3>Selected item</h3>
					<div><code>{selected.id}</code></div>
					{#if selected.properties?.datetime}
						<div class="muted">{selected.properties.datetime}</div>
					{/if}
					<ul class="assets">
						{#each Object.entries(selected.assets ?? {}) as [key, asset] (key)}
							<li><a href={asset.href} target="_blank" rel="noreferrer">{asset.title || key}</a></li>
						{/each}
					</ul>
				</div>
			{/if}
				</div>

				<div class="results-head">
			<h2>Items</h2>
			<div class="pager">
				<button onclick={checkDisk} disabled={diskChecking || !fsSupported} title="Check which assets already exist in the download folder">
					{diskChecking ? 'Checking…' : diskCheckEnabled ? 'Re-check disk' : 'Check disk'}
				</button>
				<button onclick={prevPage} disabled={pageIndex === 0 || loadingItems}>← Prev</button>
				<span class="page-no">Page {pageIndex + 1}</span>
				<button onclick={nextPage} disabled={!nextLink || loadingItems}>Next →</button>
			</div>
		</div>

		{#if loadingItems}
			<p>Loading items…</p>
		{:else if items.length === 0 && !itemsError}
			<p>No items match the current filters.</p>
		{:else if items.length > 0}
			<div class="asset-filter">
				<div class="af-field">
					<label for="af-keys">Asset keys</label>
					<select id="af-keys" multiple size="4" bind:value={assetFilterKeys}>
						{#each availableKeys as k (k)}
							<option value={k}>{k}</option>
						{/each}
					</select>
				</div>
				<div class="af-field">
					<label for="af-roles">Asset roles</label>
					<select id="af-roles" multiple size="4" bind:value={assetFilterRoles}>
						{#each availableRoles as r (r)}
							<option value={r}>{r}</option>
						{/each}
					</select>
				</div>
				<div class="af-summary">
					<span class="af-count">{selectedAssets.size} asset{selectedAssets.size === 1 ? '' : 's'} selected</span>
					<div class="af-buttons">
						<button type="button" onclick={clearAssetFilter}>Clear</button>
						<button
							type="button"
							onclick={downloadSelectedAssets}
							disabled={httpsSelectedCount === 0 || !fsSupported}
						>
							Queue {httpsSelectedCount} selected asset{httpsSelectedCount === 1 ? '' : 's'} for download
						</button>
					</div>
					{#if selectedAssets.size > httpsSelectedCount}
						<span class="af-note">
							{selectedAssets.size - httpsSelectedCount} non-https asset{selectedAssets.size - httpsSelectedCount === 1 ? '' : 's'} skipped
						</span>
					{/if}
					{#if queuedNote}
						<span class="af-note">{queuedNote}</span>
					{/if}
					<span class="af-note"><a href="/downloadQueue">View download queue →</a></span>
					{#if !fsSupported}
						<span class="af-note">Folder download requires a Chromium-based browser.</span>
					{/if}
				</div>
			</div>

			<div class="item-cards">
				{#each items as item (item.id)}
					{@const assets = Object.entries(item.assets ?? {})}
					{@const st = itemStatus(item)}
					<article class="item-card" class:selected={selected && selected.id === item.id}>
						<header class="item-card-head">
							{#if assets.length > 0}
								<button
									class="toggle"
									aria-label={collapsed[item.id] ? 'Expand assets' : 'Collapse assets'}
									aria-expanded={collapsed[item.id] ? 'false' : 'true'}
									onclick={(e) => {
										e.stopPropagation();
										toggleExpanded(item.id);
									}}
								>
									{collapsed[item.id] ? '▸' : '▾'}
								</button>
							{/if}
							<button class="item-id" onclick={() => focusItem(item)} title="Zoom to item on map">
								<code>{item.id}</code>
							</button>
							<span class="muted item-dt">{item.properties?.datetime ?? '—'}</span>
							<span class="muted">{assets.length} asset{assets.length === 1 ? '' : 's'}</span>
							<span class="item-status">
								{#if st.downloaded}
									<span class="badge badge-done">{st.downloaded} downloaded</span>
								{/if}
								{#if st.queued}
									<span class="badge badge-queued">{st.queued} queued</span>
								{/if}
							</span>
						</header>
						{#if !collapsed[item.id]}
							<div class="item-assets">
								{#if assets.length === 0}
									<p class="muted">No assets.</p>
								{:else}
									<table class="assets-table">
										<thead>
											<tr>
												<th class="check-col"></th>
												<th>Key</th>
												<th>Title</th>
												<th>Type</th>
												<th>Roles</th>
												<th>Status</th>
												<th>Href</th>
											</tr>
										</thead>
										<tbody>
											{#each assets as [key, asset] (key)}
												{@const inQueue = !!asset.href && queuedHrefs.has(asset.href)}
												{@const inHistory = !!asset.href && historyHrefs.has(asset.href)}
												{@const onDisk = !!asset.href && onDiskHrefs.has(asset.href)}
												<tr>
													<td class="check-col">
														<input
															type="checkbox"
															checked={selectedAssets.has(assetId(item.id, key))}
															onchange={() => toggleAsset(assetId(item.id, key))}
															aria-label={`Select asset ${key}`}
														/>
													</td>
													<td><code>{key}</code></td>
													<td>{asset.title ?? '—'}</td>
													<td class="muted">{asset.type ?? '—'}</td>
													<td class="muted">{(asset.roles ?? []).join(', ') || '—'}</td>
													<td>
														{#if inQueue}
															<span class="badge badge-queued">Queued</span>
														{/if}
														{#if inHistory || onDisk}
															<span
																class="badge badge-done"
																title={[inHistory && 'in history', onDisk && 'on disk']
																	.filter(Boolean)
																	.join(', ')}>Downloaded</span
															>
														{/if}
														{#if !inQueue && !inHistory && !onDisk}
															<span class="muted">—</span>
														{/if}
													</td>
													<td>
														{#if asset.href}
															<a href={asset.href} target="_blank" rel="noreferrer">open</a>
														{:else}
															—
														{/if}
													</td>
												</tr>
											{/each}
										</tbody>
									</table>
								{/if}
							</div>
						{/if}
					</article>
				{/each}
			</div>
			{/if}
		</section>
		</div>
		</div>

		<div class="cd-map">
			{#key id}
				<StacMap
					{items}
					bbox={initialBbox}
					focus={focusTarget}
					highlightId={selected?.id ?? null}
					onselect={(f) => (selected = f)}
					onmove={(b) => (mapBounds = b)}
				/>
			{/key}
		</div>
	</div>
{/if}

{#if showDupModal && currentDup}
	<div class="modal-backdrop" role="presentation">
		<div class="modal" role="dialog" aria-modal="true" aria-label="Confirm duplicate download">
			<h2>Possible duplicate download</h2>
			<p class="modal-lead">
				This asset {currentDup.onDisk && currentDup.lastDownloadedAt
					? `is already in the download folder and was downloaded in the last ${DUP_WINDOW_DAYS} days`
					: currentDup.onDisk
						? 'is already in the download folder'
						: `was already downloaded in the last ${DUP_WINDOW_DAYS} days`}. Add it to the queue
				again?
			</p>
			<dl class="dup-info">
				<dt>File</dt>
				<dd><code>{currentDup.filename}</code></dd>
				<dt>Item</dt>
				<dd class="muted">{currentDup.itemId}</dd>
				{#if currentDup.lastDownloadedAt}
					<dt>Last downloaded</dt>
					<dd class="muted">{new Date(currentDup.lastDownloadedAt).toLocaleString()}</dd>
				{/if}
				<dt>In download folder</dt>
				<dd class="muted">{currentDup.onDisk ? 'Yes' : 'No'}</dd>
			</dl>

			<label class="dup-all">
				<input type="checkbox" bind:checked={dupAcceptAll} />
				Apply to all remaining duplicates
			</label>

			<div class="modal-actions">
				<button type="button" onclick={skipDuplicate}>
					{dupAcceptAll ? 'Skip all remaining' : 'Skip'}
				</button>
				<button type="button" onclick={acceptDuplicate}>
					{dupAcceptAll ? `Add all ${dupsRemaining} remaining` : 'Add to queue'}
				</button>
			</div>

			<p class="modal-foot">
				Reviewing {dupIndex + 1} of {dupReview.length} ·
				<strong>{dupsRemaining}</strong> potential duplicate download{dupsRemaining === 1 ? '' : 's'} remaining
			</p>
		</div>
	</div>
{/if}

<style>
	.back {
		margin: var(--space) 0;
	}
	.meta {
		display: flex;
		gap: calc(var(--space) * 2);
		flex-wrap: wrap;
		border: var(--border);
		padding: var(--space);
		margin-bottom: var(--space);
	}
	.desc {
		max-width: 80ch;
		color: var(--color-muted);
	}
	/* Two-pane split: metadata (60%, scrollable) + map (40%, fixed), 100vh.
	   On tablet/mobile it stacks to map-on-top (30vh) / metadata (70vh). */
	.cd-split {
		display: grid;
		grid-template-columns: 3fr 2fr; /* ~60 / 40 */
		grid-template-rows: 1fr;
		height: 100%; /* fills <main>, i.e. the viewport below the header */
	}
	/* Left pane: a non-scrolling flex column = pinned TOC header + scrolling body.
	   This pins the TOC reliably (no position:sticky) flush with the global topbar. */
	.cd-meta {
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
		border-right: var(--border);
	}
	.cd-scroll {
		flex: 1 1 0;
		min-height: 0;
		overflow-y: auto;
		padding: 0 var(--space) var(--space);
		scroll-behavior: smooth;
	}
	.cd-map {
		min-height: 0;
	}
	.cd-map :global(.map) {
		height: 100%;
		min-height: 0;
		border: none;
	}
	/* Table-of-contents nav: pinned header (a non-scrolling flex child of .cd-meta),
	   so it stays flush with the global topbar while .cd-scroll scrolls beneath it. */
	.cd-toc {
		flex: 0 0 auto;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		padding: 8px var(--space);
		background: var(--color-bg);
		border-bottom: var(--border);
	}
	.cd-toc a {
		font-size: 12px;
		color: var(--color-muted);
		text-decoration: none;
	}
	.cd-toc a:hover {
		color: var(--color-fg);
	}
	.cd-toc a.active {
		color: var(--color-fg);
		font-weight: 600;
		text-decoration: underline;
	}
	/* Each metadata section is hash-addressable; offset headings below the TOC. */
	.cd-section {
		padding-bottom: var(--space);
		margin-bottom: var(--space);
		scroll-margin-top: 44px;
	}
	.cd-section > h2 {
		font-size: 15px;
		margin: 0 0 8px 0;
	}
	.cd-section > h3 {
		font-size: 13px;
		margin: 10px 0 4px 0;
	}
	.prov-list {
		margin: 0;
		padding-left: 18px;
		font-size: 13px;
	}
	.kw-list {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.kw {
		border: var(--border);
		padding: 0 6px;
		font-size: 11px;
		line-height: 1.7;
	}
	.summary-list {
		margin: 0;
		font-size: 12px;
	}
	.summary-list dt {
		font-weight: 600;
	}
	.summary-list dd {
		margin: 0 0 6px 0;
		word-break: break-word;
	}
	.filters {
		border: var(--border);
		padding: var(--space);
		margin-bottom: 12px;
	}
	.field {
		margin-bottom: 12px;
	}
	.field input[type='date'],
	.field input[type='number'],
	.field select {
		width: 100%;
	}
	.field.check label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: var(--color-fg);
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}
	.count {
		font-size: 12px;
		color: var(--color-muted);
	}
	.selected {
		border-top: var(--border);
		padding-top: 12px;
		margin-top: 12px;
	}
	.selected h3 {
		font-size: 13px;
		margin-bottom: 6px;
	}
	.muted {
		color: var(--color-muted);
		font-size: 12px;
	}
	.assets {
		margin: 8px 0 0 0;
		padding-left: 18px;
		font-size: 12px;
	}
	.results-head {
		margin-top: 12px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space);
		flex-wrap: wrap;
	}
	.results-head h2 {
		font-size: 15px;
		margin: 0;
	}
	.pager {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.page-no {
		font-size: 12px;
		color: var(--color-muted);
	}
	/* Each item is a separate card with its assets table inside. */
	.item-cards {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 12px;
		font-size: 13px;
	}
	.item-card {
		border: var(--border);
		background: #fff;
	}
	.item-card.selected {
		border-color: #ff00ff;
	}
	.item-card-head {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		padding: 6px 8px;
		background: #f7f7f7;
	}
	.item-card.selected .item-card-head {
		background: #ededed;
	}
	.item-status {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		margin-left: auto;
	}
	button.item-id {
		border: none;
		background: none;
		padding: 0;
		cursor: pointer;
		color: inherit;
		font: inherit;
		text-decoration: underline;
	}
	button.item-id:hover {
		background: none;
		color: #b800b8;
	}
	button.toggle {
		border: none;
		background: none;
		padding: 0 4px;
		font-size: 12px;
		line-height: 1;
	}
	button.toggle:hover {
		background: none;
	}
	.item-assets {
		padding: 8px;
	}
	table.assets-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	table.assets-table th,
	table.assets-table td {
		border: var(--border);
		padding: 4px 8px;
		text-align: left;
		vertical-align: top;
	}
	table.assets-table th {
		font-weight: 600;
		background: #f0f0f0;
	}
	.check-col {
		width: 28px;
		text-align: center;
	}
	/* Status badges (queued / downloaded) — thin-border pills matching the theme. */
	.badge {
		display: inline-block;
		border: var(--border);
		padding: 0 5px;
		font-size: 11px;
		line-height: 1.6;
		white-space: nowrap;
		margin: 0 4px 2px 0;
	}
	.badge-done {
		background: #f0f0f0;
	}
	.badge-queued {
		font-style: italic;
	}
	.asset-filter {
		display: flex;
		align-items: flex-end;
		gap: var(--space);
		flex-wrap: wrap;
		border: var(--border);
		padding: var(--space);
		margin-top: 12px;
	}
	.af-field select {
		min-width: 180px;
	}
	.af-summary {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
		margin-left: auto;
	}
	.af-buttons {
		display: flex;
		gap: 8px;
	}
	.af-note {
		font-size: 12px;
		color: var(--color-muted);
	}
	.af-count {
		font-size: 13px;
		font-weight: 600;
	}
	.error {
		border: var(--border);
		padding: var(--space);
	}
	.error.small {
		padding: 8px;
	}
	.error pre {
		white-space: pre-wrap;
		font-size: 12px;
		color: var(--color-muted);
		margin: 0;
	}
	/* Tablet / mobile: stack vertically — map on top (30vh), metadata (70vh). */
	@media (max-width: 720px) {
		.cd-split {
			grid-template-columns: 1fr;
			grid-template-rows: 3fr 7fr; /* map 30% on top, metadata 70% below */
		}
		.cd-map {
			grid-row: 1;
			border-bottom: var(--border);
		}
		.cd-meta {
			grid-row: 2;
			border-right: none;
		}
	}

	/* Duplicate-confirmation modal */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 2000;
		background: rgba(0, 0, 0, 0.3);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space);
	}
	.modal {
		background: var(--color-bg);
		border: var(--border);
		padding: var(--space);
		width: 100%;
		max-width: 420px;
	}
	.modal h2 {
		font-size: 15px;
		margin-bottom: 8px;
	}
	.modal-lead {
		margin: 0 0 12px 0;
		font-size: 13px;
	}
	.dup-info {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 12px;
		margin: 0 0 12px 0;
		font-size: 13px;
	}
	.dup-info dt {
		color: var(--color-muted);
		font-size: 12px;
	}
	.dup-info dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.dup-all {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: var(--color-fg);
		margin-bottom: 12px;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.modal-foot {
		margin: 12px 0 0 0;
		font-size: 12px;
		color: var(--color-muted);
		border-top: var(--border);
		padding-top: 8px;
	}
</style>
