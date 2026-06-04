<script>
	import '../app.css';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import { replaceState } from '$app/navigation';
	import { browser } from '$app/environment';
	import { base } from '$app/paths';
	import { apiUrl, DEFAULT_API_URL } from '$lib/config';
	import DownloadWidget from '$lib/DownloadWidget.svelte';
	import { initOnLoad } from '$lib/downloadController';

	let { children } = $props();

	// The collection detail page owns the full viewport (two-pane 100vh layout),
	// so main goes edge-to-edge (no padding) and clips its own overflow there.
	let fullBleed = $derived($page.url.pathname.startsWith(`${base}/collections/`));

	// Recover any interrupted download when the app loads.
	onMount(initOnLoad);

	// Local editable copy of the API URL; committed on "Apply".
	let draft = $state($apiUrl);

	// URL → store: the active STAC API is dynamic from an `?api=<url>` query param,
	// so /downloadQueue links can switch the app to another catalog. Read the store
	// non-reactively (get) so this fires only on URL changes, not on store changes
	// (which would fight the top-bar edits below). localStorage still persists the
	// last API when no `?api=` is present.
	$effect(() => {
		if (!browser) return;
		const api = $page.url.searchParams.get('api');
		if (api && /^https?:\/\//i.test(api) && api !== get(apiUrl)) {
			apiUrl.set(api);
			draft = api;
		}
	});

	// store → URL: reflect a chosen API into `?api=` so the current page is
	// shareable and stays pinned to its catalog.
	function syncApiToUrl(value) {
		if (!browser) return;
		const u = new URL(get(page).url);
		if (u.searchParams.get('api') === value) return;
		u.searchParams.set('api', value);
		replaceState(u, {});
	}

	function apply() {
		const v = draft.trim();
		if (v) {
			$apiUrl = v;
			syncApiToUrl(v);
		}
	}

	function reset() {
		draft = DEFAULT_API_URL;
		$apiUrl = DEFAULT_API_URL;
		syncApiToUrl(DEFAULT_API_URL);
	}
</script>

<header class="topbar">
	<a class="brand" href="{base}/">STAC Viewer</a>
	<a class="nav" href="{base}/downloadQueue">Download queue</a>
	<div class="api">
		<label for="api-url">STAC API URL</label>
		<div class="api-row">
			<input
				id="api-url"
				type="url"
				bind:value={draft}
				placeholder="https://example.com/stac/v1"
				onkeydown={(e) => e.key === 'Enter' && apply()}
			/>
			<button onclick={apply}>Apply</button>
			<button onclick={reset}>Reset</button>
		</div>
	</div>
</header>

<main class:fullbleed={fullBleed}>
	{@render children()}
</main>

<DownloadWidget />

<style>
	.topbar {
		display: flex;
		align-items: flex-end;
		gap: var(--space);
		padding: var(--space);
		border-bottom: var(--border);
		flex-wrap: wrap;
	}
	.brand {
		font-size: 18px;
		font-weight: 700;
		text-decoration: none;
		white-space: nowrap;
	}
	.nav {
		white-space: nowrap;
		font-size: 13px;
	}
	.api {
		flex: 1;
		min-width: 280px;
	}
	.api-row {
		display: flex;
		gap: 8px;
	}
	.api-row input {
		flex: 1;
		min-width: 0;
	}
	main {
		flex: 1; /* fill the viewport height below the header */
		min-height: 0;
		overflow-y: auto;
		padding: var(--space);
	}
	/* Detail route: edge-to-edge, panes manage their own scrolling. */
	main.fullbleed {
		padding: 0;
		overflow: hidden;
	}
</style>
