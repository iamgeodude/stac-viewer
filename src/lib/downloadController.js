/**
 * Singleton controller that drives the download queue.
 *
 * Cross-tab behaviour:
 *   - The queue/history/deadletter lists already sync across tabs (queue.js
 *     change events → queueStore reload).
 *   - Only ONE tab actually downloads at a time, enforced with the Web Locks
 *     API (an exclusive lock held for the duration of the run loop). Other tabs
 *     that try to start while the lock is held do nothing.
 *   - The running tab broadcasts its `status` and active-file `progress` over a
 *     control BroadcastChannel so every tab's widget/queue page reflect the same
 *     state. Pause requests are relayed the same way, so any tab can pause the
 *     single active download.
 *
 * Also: the chosen directory handle is persisted (meta store) so a refreshed
 * session can resume without re-picking the folder, and `initOnLoad()` recovers
 * items left mid-download. Resume after a refresh is user-initiated (the Start
 * button), never automatic.
 */
import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import {
	getQueue,
	updateQueueItem,
	deleteQueueItem,
	addHistory,
	addDeadletter,
	enqueueAssets,
	deleteDeadletter,
	getMeta,
	saveMeta
} from './queue.js';
import { fsApiSupported, pickDirectory, writeAsset } from './download.js';
import { setProgress, clearProgress } from './queueStore.js';

const DIR_KEY = 'dirHandle';
const RUNNER_LOCK = 'stac-download-runner';

/** 'idle' | 'running' | 'paused' — synchronized across tabs. */
export const status = writable('idle');

let dirHandle = null;
let paused = false;
let amRunner = false; // this tab currently holds the runner lock
let usedByDir = new Map();
let lastProgress = null; // { id, loaded, total } for request-status replies
let lastProgressBroadcast = 0;
let currentAbort = null; // AbortController for the in-flight transfer (Pause aborts it)

// Abort the transfer currently in flight (if any) — used by Pause for an
// instant stop instead of waiting for the active file to finish.
function abortCurrent() {
	try {
		currentAbort?.abort();
	} catch {
		/* ignore */
	}
}

// ---- Cross-tab control channel -------------------------------------------

const control =
	browser && typeof BroadcastChannel !== 'undefined'
		? new BroadcastChannel('stac-download-control')
		: null;

function send(msg) {
	control?.postMessage(msg);
}

// Set local status and tell other tabs.
function setStatus(s) {
	status.set(s);
	send({ type: 'status', status: s });
}

if (control) {
	control.onmessage = (e) => {
		const m = e.data;
		switch (m.type) {
			case 'status':
				// Reflect the active tab's status (we never receive our own posts).
				status.set(m.status);
				break;
			case 'progress':
				setProgress(m.id, m.loaded, m.total);
				break;
			case 'progress-clear':
				clearProgress(m.id);
				break;
			case 'pause':
				// Another tab paused; stop our in-flight transfer immediately.
				paused = true;
				status.set('paused');
				abortCurrent();
				break;
			case 'request-status':
				// A newly opened tab is asking; only the active runner answers.
				if (amRunner) {
					send({ type: 'status', status: get(status) });
					if (lastProgress) send({ type: 'progress', ...lastProgress });
				}
				break;
		}
	};
}

// ---- Directory / permission ----------------------------------------------

async function verifyPermission(handle, request) {
	const opts = { mode: 'readwrite' };
	if ((await handle.queryPermission(opts)) === 'granted') return true;
	if (request && (await handle.requestPermission(opts)) === 'granted') return true;
	return false;
}

/**
 * Resolve a writable destination directory. Reuses the in-memory or persisted
 * handle when permission allows; otherwise (when `request`) prompts the picker.
 * Must be called from within a user gesture when a prompt may be needed.
 */
async function ensureDirectory(request) {
	if (dirHandle && (await verifyPermission(dirHandle, request))) return dirHandle;

	const stored = await getMeta(DIR_KEY);
	if (stored) {
		dirHandle = stored;
		if (await verifyPermission(dirHandle, request)) return dirHandle;
	}

	if (!request) return null;
	dirHandle = await pickDirectory(); // throws if the user cancels
	await saveMeta(DIR_KEY, dirHandle);
	return dirHandle;
}

/**
 * Public accessor for the destination directory, used by the duplicate check so
 * it inspects the same folder downloads write to. Prompts/requests permission
 * when `request` is true (call from a user gesture). Returns null if no folder
 * is available; throws only if the user cancels a picker prompt.
 */
export const acquireDirectory = (request = true) => ensureDirectory(request);

// ---- Run loop (single tab at a time) -------------------------------------

async function runLoop() {
	// Recover items a previously-crashed runner left mid-download.
	for (const it of (await getQueue()).filter((i) => i.status === 'downloading')) {
		it.status = 'pending';
		await updateQueueItem(it);
	}

	setStatus('running');
	try {
		for (;;) {
			if (paused) break;
			const pending = (await getQueue()).filter((i) => i.status === 'pending');
			if (pending.length === 0) break;

			const item = pending[0];
			item.status = 'downloading';
			await updateQueueItem(item);
			currentAbort = new AbortController();
			const { signal } = currentAbort;
			reportProgress(item.id, 0, 0, true);
			try {
				const bytes = await writeAsset(
					dirHandle,
					item,
					usedByDir,
					(loaded, total) => reportProgress(item.id, loaded, total),
					signal
				);
				await deleteQueueItem(item.id);
				await addHistory({ ...item, bytes });
			} catch (e) {
				if (signal.aborted) {
					// Paused mid-download → requeue (don't dead-letter); the partial
					// file was discarded by writeAsset, so it restarts cleanly on resume.
					item.status = 'pending';
					await updateQueueItem(item);
				} else {
					// Any real failure (HTTP, CORS, offline, write) → dead-letter w/ message.
					await deleteQueueItem(item.id);
					await addDeadletter(item, e);
				}
			} finally {
				currentAbort = null;
				clearProgress(item.id);
				send({ type: 'progress-clear', id: item.id });
				lastProgress = null;
			}
		}
	} finally {
		setStatus(paused ? 'paused' : 'idle');
	}
}

// Update local progress and (throttled) broadcast it to other tabs.
function reportProgress(id, loaded, total, force = false) {
	setProgress(id, loaded, total);
	lastProgress = { id, loaded, total };
	const now = typeof performance !== 'undefined' ? performance.now() : 0;
	if (force || loaded === total || now - lastProgressBroadcast > 150) {
		lastProgressBroadcast = now;
		send({ type: 'progress', id, loaded, total });
	}
}

// Acquire the cross-tab runner lock and run the loop. Resolves immediately if
// another tab is already the runner. The lock auto-releases when the loop ends.
function acquireAndRun() {
	if (amRunner) return;
	const run = async () => {
		amRunner = true;
		try {
			await runLoop();
		} finally {
			amRunner = false;
		}
	};
	if (navigator.locks?.request) {
		navigator.locks
			.request(RUNNER_LOCK, { ifAvailable: true }, async (lock) => {
				if (!lock) return; // another tab holds it → do not start a 2nd runner
				await run();
			})
			.catch(() => {});
	} else {
		run().catch(() => {});
	}
}

// ---- Public API ----------------------------------------------------------

/**
 * Start or resume processing in THIS tab. Acquires a directory (prompting if
 * needed) so must be called from a user-gesture handler. No-op if another tab
 * is already the active runner.
 */
export async function start() {
	if (!fsApiSupported()) return;
	paused = false;
	if (amRunner) {
		setStatus('running');
		return;
	}
	let dir;
	try {
		dir = await ensureDirectory(true);
	} catch {
		return; // user cancelled the picker
	}
	if (!dir) return;
	acquireAndRun();
}

/** Pause the single active download (from any tab). Aborts the in-flight file. */
export function pause() {
	paused = true;
	status.set('paused');
	abortCurrent(); // instant stop if this tab is the runner
	send({ type: 'pause' }); // relay to the runner tab (and others)
}

/** Re-enqueue selected dead-letter records and start processing. */
export async function retry(records) {
	await enqueueAssets(records);
	for (const r of records) await deleteDeadletter(r.id);
	return start();
}

/**
 * Run once on app load: sync status from any active tab and recover from a
 * refresh mid-download (reset stuck items). Does NOT auto-resume — after a
 * (hard) refresh the queue stays idle until the user clicks Start/Resume, even
 * if folder permission persists. The persisted handle is preloaded so that
 * user-initiated resume won't re-prompt for the folder when permission is still
 * granted.
 */
export async function initOnLoad() {
	if (!browser || !fsApiSupported()) return;

	// Reflect any tab that's already actively downloading.
	send({ type: 'request-status' });

	// Recover items a previous session left mid-download (downloading → pending).
	const queue = await getQueue();
	for (const it of queue.filter((i) => i.status === 'downloading')) {
		it.status = 'pending';
		await updateQueueItem(it);
	}

	// Preload the persisted directory handle (no prompt, no auto-run). Resume is
	// user-initiated via the widget/queue-page Start button.
	const stored = await getMeta(DIR_KEY);
	if (stored) dirHandle = stored;
}
