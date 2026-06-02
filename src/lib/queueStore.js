/**
 * Reactive view over the IndexedDB queue/history/deadletter stores.
 *
 * `loadAll()` reads the persisted stores into Svelte stores; it is wired to the
 * change events from queue.js so the three lists stay current without any page
 * refresh (including changes made in other tabs). `progress` is in-memory only
 * (per-file byte progress for the actively downloading item) to avoid writing
 * IndexedDB on every streamed chunk.
 */
import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { getQueue, getHistory, getDeadletter, onChange } from './queue.js';

export const queueItems = writable([]);
export const historyItems = writable([]);
export const deadItems = writable([]);

/** Map of queue item id -> { loaded, total } bytes for the current download. */
export const progress = writable({});

const byAddedAsc = (a, b) => (a.addedAt ?? '').localeCompare(b.addedAt ?? '');
const byDownloadedDesc = (a, b) => (b.downloadedAt ?? '').localeCompare(a.downloadedAt ?? '');
const byFailedDesc = (a, b) => (b.failedAt ?? '').localeCompare(a.failedAt ?? '');

let loading = false;
export async function loadAll() {
	if (loading) return; // coalesce overlapping reloads
	loading = true;
	try {
		const [q, h, d] = await Promise.all([getQueue(), getHistory(), getDeadletter()]);
		queueItems.set(q.sort(byAddedAsc));
		historyItems.set(h.sort(byDownloadedDesc));
		deadItems.set(d.sort(byFailedDesc));
	} finally {
		loading = false;
	}
}

export function setProgress(id, loaded, total) {
	progress.update((p) => ({ ...p, [id]: { loaded, total } }));
}

export function clearProgress(id) {
	progress.update((p) => {
		const next = { ...p };
		delete next[id];
		return next;
	});
}

if (browser) {
	// Refresh whenever any store changes (this tab or another), and once now.
	onChange(loadAll);
	loadAll();
}
