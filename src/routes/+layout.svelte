<script>
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { apiUrl, DEFAULT_API_URL } from '$lib/config';
	import DownloadWidget from '$lib/DownloadWidget.svelte';
	import { initOnLoad } from '$lib/downloadController';

	let { children } = $props();

	// The collection detail page owns the full viewport (two-pane 100vh layout),
	// so main goes edge-to-edge (no padding) and clips its own overflow there.
	let fullBleed = $derived($page.url.pathname.startsWith('/collections/'));

	// Recover any interrupted download when the app loads.
	onMount(initOnLoad);

	// Local editable copy of the API URL; committed on "Apply".
	let draft = $state($apiUrl);

	function apply() {
		const v = draft.trim();
		if (v) $apiUrl = v;
	}

	function reset() {
		draft = DEFAULT_API_URL;
		$apiUrl = DEFAULT_API_URL;
	}
</script>

<header class="topbar">
	<a class="brand" href="/">STAC Viewer</a>
	<a class="nav" href="/downloadQueue">Download queue</a>
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
