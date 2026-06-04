<script>
	// Floating download controller shown on every page (rendered in the layout).
	import { base } from '$app/paths';
	import { queueItems, progress } from '$lib/queueStore';
	import { status, start, pause } from '$lib/downloadController';
	import { fsApiSupported } from '$lib/download';

	const fsSupported = fsApiSupported();

	// Items in the queue store are only pending/downloading, so its length is
	// the number of downloads remaining.
	let remaining = $derived($queueItems.length);
	let active = $derived($queueItems.find((i) => i.status === 'downloading'));
	let activeProgress = $derived(active ? $progress[active.id] : null);
	let pct = $derived(
		activeProgress && activeProgress.total > 0
			? (activeProgress.loaded / activeProgress.total) * 100
			: null
	);
</script>

{#if fsSupported}
	<div class="widget">
		<div class="row">
			<span class="count"><strong>{remaining}</strong> in queue</span>
			{#if $status === 'running'}
				<button onclick={pause}>Pause</button>
			{:else}
				<button onclick={start} disabled={remaining === 0}>
					{$status === 'paused' ? 'Resume' : 'Start'}
				</button>
			{/if}
		</div>
		{#if active}
			<div class="active" title={active.filename}>
				<div class="name">{active.filename}</div>
				<div class="bar">
					{#if pct != null}
						<div class="bar-fill" style="width:{pct}%"></div>
					{:else}
						<div class="bar-fill indeterminate"></div>
					{/if}
				</div>
			</div>
		{/if}
		<a class="link" href="{base}/downloadQueue">Manage downloads →</a>
	</div>
{/if}

<style>
	.widget {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 1000;
		width: 220px;
		background: var(--color-bg);
		border: var(--border);
		padding: 10px;
		font-size: 13px;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.count {
		white-space: nowrap;
	}
	.active {
		margin-top: 8px;
	}
	.name {
		font-family: var(--font-mono);
		font-size: 11px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.bar {
		height: 8px;
		border: var(--border);
		background: #fff;
		margin-top: 3px;
		overflow: hidden;
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
			margin-left: -40%;
		}
		100% {
			margin-left: 100%;
		}
	}
	.link {
		display: inline-block;
		margin-top: 8px;
		font-size: 12px;
	}
</style>
