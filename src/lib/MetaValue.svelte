<script>
	// Recursive, STAC-schema-aware renderer for one metadata value. Branches on
	// valueKind() and recurses via <svelte:self> for nested objects/arrays.
	import { valueKind, humanize, columnsFor, isRange, looksLikeUrl } from '$lib/stacMeta';

	/**
	 * @typedef {Object} Props
	 * @property {any} value      The metadata value to render.
	 * @property {string} [fieldKey] The value's field name (drives column hints).
	 * @property {number} [depth]  Recursion depth (guards against pathological nesting).
	 */
	/** @type {Props} */
	let { value, fieldKey = '', depth = 0 } = $props();

	let kind = $derived(valueKind(value));

	// Format one bbox array as W,S,E,N (z values, if any, are ignored for display).
	function fmtBbox(b) {
		if (!Array.isArray(b) || b.length < 4) return Array.isArray(b) ? b.join(', ') : '—';
		return `W ${b[0]}, S ${b[1]}, E ${b[2]}, N ${b[3]}`;
	}
	function fmtInterval(iv) {
		if (!Array.isArray(iv)) return '—';
		const [s, e] = iv;
		return `${s ?? '…'} → ${e ?? 'now'}`;
	}
</script>

{#if depth > 6}
	<pre class="raw">{JSON.stringify(value, null, 2)}</pre>
{:else if isRange(value)}
	<span>{value.minimum ?? '…'} – {value.maximum ?? '…'}</span>
{:else if fieldKey === 'extent' && value && typeof value === 'object'}
	<!-- STAC extent: formatted spatial + temporal instead of a generic table. -->
	<div class="extent">
		<h3>Spatial</h3>
		{#if value.spatial?.bbox?.length}
			{#each value.spatial.bbox as b (b.join(','))}
				<p class="muted">{fmtBbox(b)}</p>
			{/each}
		{:else}
			<p class="muted">—</p>
		{/if}
		<h3>Temporal</h3>
		{#if value.temporal?.interval?.length}
			{#each value.temporal.interval as iv (iv.join(','))}
				<p class="muted">{fmtInterval(iv)}</p>
			{/each}
		{:else}
			<p class="muted">—</p>
		{/if}
	</div>
{:else if kind === 'scalar'}
	{#if value === null || value === undefined || value === ''}
		<span class="muted">—</span>
	{:else if looksLikeUrl(value)}
		<a href={value} target="_blank" rel="noreferrer">{value}</a>
	{:else}
		<span class="scalar">{value}</span>
	{/if}
{:else if kind === 'array-scalars'}
	<div class="pills">
		{#each value as v, i (i)}
			<span>{v}</span>
		{/each}
	</div>
{:else if kind === 'array-arrays'}
	<div class="lines">
		{#each value as row, i (i)}
			<div class="muted">{Array.isArray(row) ? row.join(', ') : row}</div>
		{/each}
	</div>
{:else if kind === 'flat-object'}
	<dl class="kv">
		{#each Object.entries(value) as [k, v] (k)}
			<dt>{humanize(k)}</dt>
			<dd><svelte:self value={v} fieldKey={k} depth={depth + 1} /></dd>
		{/each}
	</dl>
{:else if kind === 'array-objects'}
	{@const cols = columnsFor(fieldKey, value)}
	<table class="obj-table">
		<thead>
			<tr>
				{#each cols as c (c)}
					<th>{humanize(c)}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each value as item, i (i)}
				<tr>
					{#each cols as c (c)}
						<td><svelte:self value={item?.[c]} fieldKey={c} depth={depth + 1} /></td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
{:else}
	<!-- nested-object: 2-col key|value table; value cells recurse into subtables. -->
	<table class="kv-table">
		<tbody>
			{#each Object.entries(value) as [k, v] (k)}
				<tr>
					<th>{humanize(k)}</th>
					<td><svelte:self value={v} fieldKey={k} depth={depth + 1} /></td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<style>
	.muted {
		color: var(--color-muted);
		font-size: 12px;
	}
	.scalar {
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	a {
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.extent h3 {
		font-size: 13px;
		margin: 10px 0 4px 0;
	}
	.extent h3:first-child {
		margin-top: 0;
	}
	.pills {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.pills span {
		border: var(--border);
		padding: 0 6px;
		font-size: 11px;
		line-height: 1.7;
	}
	.lines div {
		overflow-wrap: anywhere;
	}
	dl.kv {
		margin: 0;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 12px;
		font-size: 12px;
	}
	dl.kv dt {
		font-weight: 600;
		color: var(--color-muted);
	}
	dl.kv dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	th,
	td {
		border: var(--border);
		padding: 4px 8px;
		text-align: left;
		vertical-align: top;
	}
	/* Array-of-objects header row. */
	.obj-table thead th {
		font-weight: 600;
		background: #f0f0f0;
		white-space: nowrap;
	}
	/* Key|value table: first-column row headers hug their content. */
	.kv-table th {
		font-weight: 600;
		background: #f7f7f7;
		white-space: nowrap;
		width: 1%;
		vertical-align: top;
	}
	.raw {
		white-space: pre-wrap;
		font-size: 11px;
		color: var(--color-muted);
		margin: 0;
	}
</style>
