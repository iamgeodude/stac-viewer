/**
 * IndexedDB-backed download queue, completed history, and dead-letter queue.
 *
 * Stores:
 *   - `queue`      : assets to download (status: pending | downloading)
 *   - `history`    : completed downloads (status: done, with downloadedAt)
 *   - `deadletter` : assets whose download failed, with the error
 *
 * Every write emits a change event (locally + cross-tab via BroadcastChannel)
 * so reactive views can update without a page refresh — see queueStore.js.
 */

const DB_NAME = 'stac-viewer';
const DB_VERSION = 3;
export const QUEUE = 'queue';
export const HISTORY = 'history';
export const DEADLETTER = 'deadletter';
const META = 'meta'; // misc key/value (e.g. persisted directory handle)

let dbPromise;

function openDB() {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			for (const store of [QUEUE, HISTORY, DEADLETTER]) {
				if (!db.objectStoreNames.contains(store)) {
					db.createObjectStore(store, { keyPath: 'id', autoIncrement: true });
				}
			}
			if (!db.objectStoreNames.contains(META)) {
				db.createObjectStore(META, { keyPath: 'key' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

// ---- Change notifications (local + cross-tab) ----------------------------

const listeners = new Set();
let channel;
function getChannel() {
	if (channel === undefined) {
		channel =
			typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('stac-queue-changes') : null;
		if (channel) channel.onmessage = () => listeners.forEach((cb) => cb());
	}
	return channel;
}

/** Register a callback fired on any store change (this tab or another). */
export function onChange(cb) {
	getChannel();
	listeners.add(cb);
	return () => listeners.delete(cb);
}

function emitChange() {
	// BroadcastChannel doesn't deliver to the sender, so notify locally too.
	listeners.forEach((cb) => cb());
	getChannel()?.postMessage('changed');
}

// ---- IndexedDB primitives ------------------------------------------------

function promisify(req) {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function writeTx(store, fn) {
	const db = await openDB();
	await new Promise((resolve, reject) => {
		const tx = db.transaction(store, 'readwrite');
		fn(tx.objectStore(store));
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
	emitChange();
}

/** Read all records from a store. */
export async function getAll(store) {
	const db = await openDB();
	return promisify(db.transaction(store, 'readonly').objectStore(store).getAll());
}

/** Append records (without ids) to a store. */
export const addItems = (store, records) => writeTx(store, (os) => records.forEach((r) => os.add(r)));

/** Put (insert or update) a single record that already has an id. */
export const putItem = (store, record) => writeTx(store, (os) => os.put(record));

/** Delete a record by id. */
export const deleteItem = (store, id) => writeTx(store, (os) => os.delete(id));

/** Delete every record in a store. */
export const clearStore = (store) => writeTx(store, (os) => os.clear());

// ---- Convenience wrappers ------------------------------------------------

export const getQueue = () => getAll(QUEUE);
export const getHistory = () => getAll(HISTORY);
export const getDeadletter = () => getAll(DEADLETTER);

/** Enqueue assets for download. */
export function enqueueAssets(assets) {
	const now = new Date().toISOString();
	return addItems(
		QUEUE,
		assets.map((a) => ({
			href: a.href,
			filename: a.filename,
			itemId: a.itemId,
			collectionId: a.collectionId,
			catalogName: a.catalogName,
			status: 'pending',
			addedAt: a.addedAt ?? now,
			downloadedAt: null
		}))
	);
}

export const updateQueueItem = (item) => putItem(QUEUE, item);
export const deleteQueueItem = (id) => deleteItem(QUEUE, id);

/** Record a completed download in the history store. */
export function addHistory(asset) {
	return addItems(HISTORY, [
		{
			href: asset.href,
			filename: asset.filename,
			itemId: asset.itemId,
			collectionId: asset.collectionId,
			catalogName: asset.catalogName,
			addedAt: asset.addedAt ?? null,
			downloadedAt: new Date().toISOString(),
			bytes: asset.bytes ?? null
		}
	]);
}

/** Record a failed download in the dead-letter store. */
export function addDeadletter(asset, error) {
	return addItems(DEADLETTER, [
		{
			href: asset.href,
			filename: asset.filename,
			itemId: asset.itemId,
			collectionId: asset.collectionId,
			catalogName: asset.catalogName,
			addedAt: asset.addedAt ?? null,
			error: String(error?.message ?? error),
			failedAt: new Date().toISOString()
		}
	]);
}

export const deleteDeadletter = (id) => deleteItem(DEADLETTER, id);

// ---- Misc key/value meta (no change events; not part of the lists) -------

export async function saveMeta(key, value) {
	const db = await openDB();
	await new Promise((resolve, reject) => {
		const tx = db.transaction(META, 'readwrite');
		tx.objectStore(META).put({ key, value });
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function getMeta(key) {
	const db = await openDB();
	const rec = await promisify(db.transaction(META, 'readonly').objectStore(META).get(key));
	return rec?.value;
}

export async function deleteMeta(key) {
	const db = await openDB();
	await new Promise((resolve, reject) => {
		const tx = db.transaction(META, 'readwrite');
		tx.objectStore(META).delete(key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
