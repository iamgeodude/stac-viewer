/**
 * Minimal STAC API client.
 *
 * Targets STAC API / OGC API - Features endpoints:
 *   GET {root}/collections                 -> { collections: [...] }
 *   GET {root}/collections/{id}            -> Collection
 *   GET {root}/collections/{id}/items      -> FeatureCollection of Items
 */

function trimRoot(root) {
	return root.replace(/\/+$/, '');
}

async function getJson(url) {
	const res = await fetch(url, {
		headers: { Accept: 'application/json' }
	});
	if (!res.ok) {
		let detail = '';
		try {
			detail = await res.text();
		} catch (_) {
			/* ignore */
		}
		throw new Error(`Request failed (${res.status} ${res.statusText}) for ${url}\n${detail}`);
	}
	return res.json();
}

/** Fetch the STAC API landing page (root Catalog document). */
export async function fetchRoot(root) {
	return getJson(trimRoot(root));
}

/** Fetch all collections from a STAC API root. */
export async function fetchCollections(root) {
	const data = await getJson(`${trimRoot(root)}/collections`);
	// STAC API returns { collections: [...] }; be lenient about shape.
	return data.collections ?? data.features ?? [];
}

/** Fetch a single collection by id. */
export async function fetchCollection(root, id) {
	return getJson(`${trimRoot(root)}/collections/${encodeURIComponent(id)}`);
}

/**
 * Build the items URL for a collection with optional filters.
 * @param {string} root
 * @param {string} id
 * @param {{ bbox?: number[], datetime?: string, limit?: number }} [filters]
 */
export function buildItemsUrl(root, id, filters = {}) {
	const params = new URLSearchParams();
	if (filters.limit) params.set('limit', String(filters.limit));
	if (filters.bbox && filters.bbox.length === 4) params.set('bbox', filters.bbox.join(','));
	if (filters.datetime) params.set('datetime', filters.datetime);
	// Order results by item id ascending (STAC API Sort extension).
	params.set('sortby', '+id');

	const qs = params.toString();
	return `${trimRoot(root)}/collections/${encodeURIComponent(id)}/items${qs ? `?${qs}` : ''}`;
}

/**
 * Perform a request described by a STAC link (or a plain URL string).
 * Handles GET (the common case) and POST-style paging links.
 */
async function requestLink(link) {
	if (typeof link === 'string') return getJson(link);
	const method = (link.method || 'GET').toUpperCase();
	if (method === 'POST') {
		const res = await fetch(link.href, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify(link.body ?? {})
		});
		if (!res.ok) {
			throw new Error(`Request failed (${res.status} ${res.statusText}) for ${link.href}`);
		}
		return res.json();
	}
	return getJson(link.href);
}

/**
 * Fetch one page of items, given either a URL string or a paging link object.
 * Returns the features plus paging metadata for the caller to navigate.
 * @returns {Promise<{ features: any[], nextLink: any|null, numberMatched: number|null, numberReturned: number }>}
 */
export async function fetchItemsPage(target) {
	const data = await requestLink(target);
	const links = Array.isArray(data.links) ? data.links : [];
	const next = links.find((l) => l.rel === 'next');
	const features = data.features ?? [];
	return {
		features,
		// Keep the whole link object so GET/POST paging both work.
		nextLink: next ?? null,
		numberMatched: data.numberMatched ?? data.context?.matched ?? null,
		numberReturned: data.numberReturned ?? data.context?.returned ?? features.length
	};
}

/**
 * Build an RFC 3339 interval string for the STAC `datetime` query param.
 * Either bound may be empty (open interval). Returns undefined if both empty.
 */
export function buildDatetime(start, end) {
	const s = start ? `${start}T00:00:00Z` : '..';
	const e = end ? `${end}T23:59:59Z` : '..';
	if (s === '..' && e === '..') return undefined;
	return `${s}/${e}`;
}

/** Extract a [west, south, east, north] bbox from a collection's spatial extent. */
export function collectionBbox(collection) {
	const bbox = collection?.extent?.spatial?.bbox?.[0];
	if (Array.isArray(bbox) && bbox.length >= 4) {
		// Some extents use 6 values (3D); take horizontal components.
		return [bbox[0], bbox[1], bbox[bbox.length - 2], bbox[bbox.length - 1]];
	}
	return null;
}

/** Extract the temporal interval [start, end] (ISO strings or null). */
export function collectionInterval(collection) {
	const interval = collection?.extent?.temporal?.interval?.[0];
	if (Array.isArray(interval)) return interval;
	return [null, null];
}
