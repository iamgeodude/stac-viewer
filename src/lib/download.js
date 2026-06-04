/**
 * Asset download helpers built on the File System Access API. The queue run
 * loop that uses these lives in downloadController.js.
 */

/** Whether the browser supports picking a destination directory (Chromium). */
export function fsApiSupported() {
	return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** Only http(s) links can be fetched/downloaded by the browser. */
export const isHttps = (href) => typeof href === 'string' && /^https?:\/\//i.test(href);

/** Derive a filename from a URL's last path segment. */
export function filenameFromHref(href) {
	try {
		const seg = new URL(href).pathname.split('/').filter(Boolean).pop();
		return seg || 'download';
	} catch {
		return 'download';
	}
}

/** Make a string safe to use as a single filesystem path segment. */
export function safeSegment(s) {
	const cleaned = String(s ?? '')
		.trim()
		.replace(/[\\/:*?"<>|]+/g, '_')
		.replace(/^\.+$/, '_');
	return cleaned || 'unknown';
}

/** Resolve (creating as needed) a nested directory under a root handle. */
async function ensureDir(rootHandle, segments) {
	let handle = rootHandle;
	for (const seg of segments) {
		handle = await handle.getDirectoryHandle(safeSegment(seg), { create: true });
	}
	return handle;
}

/**
 * The top "<catalog>" folder for an asset: the originating STAC API route
 * (host + path, scheme stripped) as a single sanitized segment, e.g.
 *   https://planetarycomputer.microsoft.com/api/stac/v1
 *     → planetarycomputer.microsoft.com_api_stac_v1
 * Falls back to the stored catalog name (older records have no `apiRoot`).
 */
export function catalogSegment(item) {
	if (item.apiRoot) {
		try {
			const u = new URL(item.apiRoot);
			return safeSegment((u.host + u.pathname).replace(/\/+$/, ''));
		} catch {
			/* fall through to catalogName */
		}
	}
	return safeSegment(item.catalogName || 'catalog');
}

/**
 * The destination an asset is written to within the chosen directory:
 *   <api route>/<collection id>/<item id>/<filename>
 * Single source of truth shared by writeAsset (writer) and fileExists (check).
 * @returns {{ segments: string[], name: string }} sanitized path parts
 */
export function assetTargetPath(item) {
	const segments = [
		catalogSegment(item),
		safeSegment(item.collectionId),
		safeSegment(item.itemId)
	];
	const name = safeSegment(item.filename || filenameFromHref(item.href));
	return { segments, name };
}

/**
 * Read-only check: does the asset already exist at its target path inside the
 * chosen directory? Returns false on any miss (NotFound) or permission error.
 */
export async function fileExists(dirHandle, item) {
	try {
		let dir = dirHandle;
		const { segments, name } = assetTargetPath(item);
		for (const seg of segments) dir = await dir.getDirectoryHandle(seg);
		await dir.getFileHandle(name);
		return true;
	} catch {
		return false;
	}
}

/**
 * Find a filename not yet used in this directory this run. Pure — does NOT
 * reserve the name; the caller reserves (`used.add`) only after a *successful*
 * write, so a paused/aborted-then-resumed download reuses its original name
 * instead of gaining a "-1" suffix.
 */
function freeName(name, used) {
	if (!used.has(name)) return name;
	const dot = name.lastIndexOf('.');
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	let i = 1;
	let candidate;
	do {
		candidate = `${base}-${i}${ext}`;
		i++;
	} while (used.has(candidate));
	return candidate;
}

/** Prompt the user for a read/write destination directory. */
export function pickDirectory() {
	return window.showDirectoryPicker({ mode: 'readwrite' });
}

/**
 * Fetch one asset and stream it into
 *   <catalog name>/<collection name>/<item id>/<filename>
 * within the chosen directory, reporting byte progress via onProgress.
 * Throws on any failure (HTTP, CORS, connection drop, write) and on abort (the
 * passed AbortSignal — used by Pause for an instant stop); on a mid-stream
 * failure or abort the partially-written file is aborted/discarded.
 * @returns {Promise<number>} total bytes written
 */
export async function writeAsset(dirHandle, item, usedByDir, onProgress, signal) {
	const res = await fetch(item.href, signal ? { signal } : undefined);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);

	const total = Number(res.headers.get('Content-Length')) || 0;

	const { segments, name: baseName } = assetTargetPath(item);
	const targetDir = await ensureDir(dirHandle, segments);

	const dirKey = segments.join('/');
	let used = usedByDir.get(dirKey);
	if (!used) {
		used = new Set();
		usedByDir.set(dirKey, used);
	}
	const name = freeName(baseName, used);

	const fileHandle = await targetDir.getFileHandle(name, { create: true });
	const writable = await fileHandle.createWritable();
	let loaded = 0;
	try {
		onProgress?.(0, total);
		if (res.body?.getReader) {
			const reader = res.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				await writable.write(value);
				loaded += value.byteLength;
				onProgress?.(loaded, total);
			}
			await writable.close();
		} else {
			const blob = await res.blob();
			await writable.write(blob);
			await writable.close();
			loaded = blob.size;
			onProgress?.(loaded, loaded);
		}
	} catch (e) {
		// Discard the partial file so a failed/aborted download doesn't leave a stub.
		try {
			await writable.abort?.();
		} catch {
			/* ignore */
		}
		throw e;
	}
	// Reserve the name only now that the file is fully written, so an aborted
	// (paused) attempt doesn't claim the name and force a "-1" on resume.
	used.add(name);
	return loaded;
}
