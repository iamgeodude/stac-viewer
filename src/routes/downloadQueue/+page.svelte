<script>
	import { base } from '$app/paths';
	import { apiUrl } from '$lib/config';
	import { clearStore, QUEUE, HISTORY, DEADLETTER } from '$lib/queue';
	import { queueItems, historyItems, deadItems, progress } from '$lib/queueStore';
	import { fsApiSupported } from '$lib/download';
	import { status, start, pause, retry } from '$lib/downloadController';

	const fsSupported = fsApiSupported();

	// STAC-browser links for queue/history/dead-letter rows. The collection opens
	// in this app's collection page; the item opens the STAC API item JSON (no
	// per-item page exists). The item link uses the record's persisted `apiRoot`
	// (the API it was queued from), falling back to the currently-configured
	// apiUrl for older records that predate apiRoot persistence.
	const rootFor = (rec) => (rec.apiRoot || $apiUrl || '').replace(/\/+$/, '');
	const collPageHref = (rec) =>
		rec.collectionId ? `${base}/collections/${encodeURIComponent(rec.collectionId)}` : null;
	const itemApiHref = (rec) =>
		rec.collectionId && rec.itemId
			? `${rootFor(rec)}/collections/${encodeURIComponent(rec.collectionId)}/items/${encodeURIComponent(rec.itemId)}`
			: null;

	let selectedDead = $state(new Set());

	// Live counts derived from the reactive stores (auto-update, no refresh).
	let pending = $derived($queueItems.filter((i) => i.status === 'pending'));

	const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

	function fmtBytes(n) {
		if (!n && n !== 0) return '';
		const units = ['B', 'KB', 'MB', 'GB'];
		let v = n;
		let u = 0;
		while (v >= 1024 && u < units.length - 1) {
			v /= 1024;
			u++;
		}
		return `${v.toFixed(v < 10 && u > 0 ? 1 : 0)} ${units[u]}`;
	}

	function toggleDead(id) {
		const next = new Set(selectedDead);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedDead = next;
	}

	async function retrySelected() {
		if (!fsSupported) return;
		const records = $deadItems.filter((d) => selectedDead.has(d.id));
		if (records.length === 0) return;
		selectedDead = new Set();
		await retry(records);
	}

	async function clearAllQueue() {
		await clearStore(QUEUE);
	}
	async function clearHistory() {
		await clearStore(HISTORY);
	}
	async function clearDead() {
		selectedDead = new Set();
		await clearStore(DEADLETTER);
	}
</script>

<p class="back"><a href="{base}/">← All collections</a></p>
<h1>Downloads</h1>
<p class="muted small hint">
	Filenames open the asset, item IDs open the STAC API, collection IDs open the collection page.
</p>

{#if !fsSupported}
	<p class="note">Downloading requires a Chromium-based browser (File System Access API).</p>
{/if}

<!-- Shared row cells, so the three tables stay visually + behaviourally consistent. -->
{#snippet fileCell(rec)}
	<td class="wrap">
		{#if rec.href}
			<a href={rec.href} target="_blank" rel="noreferrer" title={rec.href}><code>{rec.filename}</code></a>
		{:else}
			<code>{rec.filename}</code>
		{/if}
	</td>
{/snippet}
{#snippet itemCell(rec)}
	<td class="wrap">
		{#if itemApiHref(rec)}
			<a href={itemApiHref(rec)} target="_blank" rel="noreferrer" title="View item in the STAC API"
				>{rec.itemId}</a
			>
		{:else}
			<span class="muted">{rec.itemId ?? '—'}</span>
		{/if}
	</td>
{/snippet}
{#snippet collCell(rec)}
	<td class="wrap">
		{#if collPageHref(rec)}
			<a href={collPageHref(rec)} title="View collection in the browser">{rec.collectionId}</a>
		{:else}
			<span class="muted">—</span>
		{/if}
	</td>
{/snippet}

<!-- Active queue -->
<section>
	<div class="head">
		<h2>Queue ({$queueItems.length})</h2>
		<div class="actions">
			<span class="muted">{pending.length} pending · {$status}</span>
			{#if $status === 'running'}
				<button onclick={pause}>Pause</button>
			{:else}
				<button onclick={start} disabled={pending.length === 0 || !fsSupported}>
					{$status === 'paused' ? 'Resume' : 'Start'}
				</button>
			{/if}
			<button onclick={clearAllQueue} disabled={$queueItems.length === 0}>Clear queue</button>
		</div>
	</div>

	{#if $queueItems.length === 0}
		<p class="muted">Queue is empty.</p>
	{:else}
		<table>
			<thead>
				<tr>
					<th>Status</th>
					<th>Filename</th>
					<th>Item</th>
					<th>Collection</th>
					<th>Progress</th>
					<th>Added</th>
				</tr>
			</thead>
			<tbody>
				{#each $queueItems as it (it.id)}
					{@const p = $progress[it.id]}
					<tr>
						<td><span class="status status-{it.status}">{it.status}</span></td>
						{@render fileCell(it)}
						{@render itemCell(it)}
						{@render collCell(it)}
						<td class="progress-cell">
							{#if it.status === 'downloading' && p}
								{#if p.total > 0}
									<div class="bar"><div class="bar-fill" style="width:{(p.loaded / p.total) * 100}%"></div></div>
									<span class="muted small">{fmtBytes(p.loaded)} / {fmtBytes(p.total)}</span>
								{:else}
									<div class="bar"><div class="bar-fill indeterminate"></div></div>
									<span class="muted small">{fmtBytes(p.loaded)}</span>
								{/if}
							{:else}
								<span class="muted small">—</span>
							{/if}
						</td>
						<td class="muted">{fmt(it.addedAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<!-- Completed history -->
<section>
	<div class="head">
		<h2>Download history ({$historyItems.length})</h2>
		<div class="actions">
			<button onclick={clearHistory} disabled={$historyItems.length === 0}>Clear history</button>
		</div>
	</div>

	{#if $historyItems.length === 0}
		<p class="muted">No completed downloads yet.</p>
	{:else}
		<table>
			<thead>
				<tr>
					<th>Filename</th>
					<th>Item</th>
					<th>Collection</th>
					<th>Size</th>
					<th>Downloaded</th>
				</tr>
			</thead>
			<tbody>
				{#each $historyItems as h (h.id)}
					<tr>
						{@render fileCell(h)}
						{@render itemCell(h)}
						{@render collCell(h)}
						<td class="muted">{h.bytes != null ? fmtBytes(h.bytes) : '—'}</td>
						<td class="muted">{fmt(h.downloadedAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<!-- Dead-letter -->
<section>
	<div class="head">
		<h2>Dead-letter ({$deadItems.length})</h2>
		<div class="actions">
			<button onclick={retrySelected} disabled={selectedDead.size === 0 || !fsSupported}>
				Retry {selectedDead.size} selected
			</button>
			<button onclick={clearDead} disabled={$deadItems.length === 0}>Clear all</button>
		</div>
	</div>

	{#if $deadItems.length === 0}
		<p class="muted">No failed downloads.</p>
	{:else}
		<table>
			<thead>
				<tr>
					<th class="check-col"></th>
					<th>Filename</th>
					<th>Item</th>
					<th>Collection</th>
					<th>Error</th>
					<th>Failed</th>
				</tr>
			</thead>
			<tbody>
				{#each $deadItems as d (d.id)}
					<tr>
						<td class="check-col">
							<input
								type="checkbox"
								checked={selectedDead.has(d.id)}
								onchange={() => toggleDead(d.id)}
								aria-label={`Select ${d.filename} for retry`}
							/>
						</td>
						{@render fileCell(d)}
						{@render itemCell(d)}
						{@render collCell(d)}
						<td class="err">{d.error}</td>
						<td class="muted">{fmt(d.failedAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<style>
	.back {
		margin: 0 0 var(--space) 0;
	}
	section {
		margin-bottom: calc(var(--space) * 2);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space);
		flex-wrap: wrap;
	}
	.head h2 {
		font-size: 15px;
		margin: 0;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.note {
		border: var(--border);
		padding: var(--space);
	}
	.muted {
		color: var(--color-muted);
	}
	.small {
		font-size: 11px;
	}
	.hint {
		margin: -4px 0 var(--space) 0;
	}
	/* Long filenames / ids / hrefs wrap instead of stretching the table. */
	.wrap {
		overflow-wrap: anywhere;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 12px;
		font-size: 13px;
	}
	th,
	td {
		border: var(--border);
		padding: 6px 8px;
		text-align: left;
		vertical-align: top;
	}
	th {
		font-weight: 600;
		background: #f7f7f7;
	}
	.check-col {
		width: 28px;
		text-align: center;
	}
	.progress-cell {
		min-width: 160px;
	}
	.err {
		color: var(--color-muted);
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.status {
		border: var(--border);
		padding: 1px 6px;
		font-size: 12px;
		text-transform: capitalize;
	}
	.status-downloading {
		font-style: italic;
	}
	/* Thin progress bar, theme-neutral (black fill on white). */
	.bar {
		height: 8px;
		border: var(--border);
		background: #fff;
		margin-bottom: 3px;
	}
	.bar-fill {
		height: 100%;
		background: #000;
		transition: width 0.1s linear;
	}
	.bar-fill.indeterminate {
		width: 40%;
		animation: slide 1.2s infinite ease-in-out;
	}
	@keyframes slide {
		0% {
			margin-left: 0;
		}
		50% {
			margin-left: 60%;
		}
		100% {
			margin-left: 0;
		}
	}
</style>
