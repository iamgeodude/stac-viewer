<script>
	import { base } from '$app/paths';
	import { apiUrl } from '$lib/config';
	import { fetchCollections } from '$lib/stac';

	let collections = $state([]);
	let loading = $state(false);
	let error = $state('');
	let search = $state('');

	async function load(root) {
		loading = true;
		error = '';
		collections = [];
		try {
			collections = await fetchCollections(root);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	// Reload whenever the configured API URL changes.
	$effect(() => {
		load($apiUrl);
	});

	// Case-insensitive filter over id / title / description.
	let filtered = $derived(
		(() => {
			const q = search.trim().toLowerCase();
			if (!q) return collections;
			return collections.filter((c) => {
				const hay = `${c.id ?? ''} ${c.title ?? ''} ${c.description ?? ''}`.toLowerCase();
				return hay.includes(q);
			});
		})()
	);
</script>

<section class="header">
	<h1>Collections</h1>
	<input
		class="search"
		type="search"
		placeholder="Filter collections…"
		bind:value={search}
	/>
</section>

{#if loading}
	<p>Loading collections…</p>
{:else if error}
	<div class="error">
		<strong>Failed to load collections.</strong>
		<pre>{error}</pre>
	</div>
{:else if filtered.length === 0}
	<p>No collections found.</p>
{:else}
	<p class="count">{filtered.length} of {collections.length} collections</p>
	<div class="grid">
		{#each filtered as c (c.id)}
			<a class="card" href={`${base}/collections/${encodeURIComponent(c.id)}?api=${encodeURIComponent($apiUrl)}`}>
				<h2>{c.title || c.id}</h2>
				<div class="id"><code>{c.id}</code></div>
				{#if c.description}
					<p class="desc">{c.description}</p>
				{/if}
			</a>
		{/each}
	</div>
{/if}

<style>
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space);
		flex-wrap: wrap;
	}
	.search {
		min-width: 240px;
	}
	.count {
		color: var(--color-muted);
		font-size: 12px;
	}
	.error {
		border: var(--border);
		padding: var(--space);
	}
	.error pre {
		white-space: pre-wrap;
		font-size: 12px;
		color: var(--color-muted);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: var(--space);
	}
	.card {
		display: block;
		border: var(--border);
		padding: var(--space);
		text-decoration: none;
		color: var(--color-fg);
		background: var(--color-bg);
	}
	.card:hover {
		background: #f7f7f7;
	}
	.card h2 {
		font-size: 15px;
		margin-bottom: 6px;
	}
	.id {
		margin-bottom: 8px;
	}
	.desc {
		margin: 0;
		font-size: 13px;
		color: var(--color-muted);
		display: -webkit-box;
		-webkit-line-clamp: 4;
		line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
</style>
