// Pure helpers for the dynamic, recursive collection-metadata renderer
// (see MetaValue.svelte). No Svelte / DOM here — just data shaping.

// Top-level fields that are structural/navigational noise, not user-facing
// metadata. These never get a section.
export const HIDDEN_FIELDS = new Set(['type', 'links', 'stac_extensions', 'conformsTo']);

// Scalar top-level fields that deserve their own section instead of being folded
// into the grouped "Overview" (long free text reads badly as a one-line row).
const OWN_SECTION_SCALARS = new Set(['description']);

// `title` is rendered as the page <h1>, so it's never repeated as metadata.
const SKIP_IN_OVERVIEW = new Set(['title']);

export function isScalar(v) {
	return v === null || v === undefined || typeof v !== 'object';
}

export function isEmpty(v) {
	if (v === null || v === undefined) return true;
	if (typeof v === 'string') return v.trim() === '';
	if (Array.isArray(v)) return v.length === 0;
	if (typeof v === 'object') return Object.keys(v).length === 0;
	return false;
}

// Known acronyms/labels that the generic humanizer would mangle.
const LABEL_OVERRIDES = {
	id: 'ID',
	url: 'URL',
	href: 'Href',
	stac_version: 'STAC version',
	stac_extensions: 'STAC extensions',
	item_assets: 'Item assets',
	gsd: 'GSD',
	epsg: 'EPSG',
	rel: 'Rel',
	eo: 'EO',
	doi: 'DOI'
};

// "stac_version" -> "STAC version", "providers" -> "Providers",
// "sci:citation" -> "sci:citation" (keeps extension prefixes readable).
export function humanize(key) {
	if (key in LABEL_OVERRIDES) return LABEL_OVERRIDES[key];
	const s = String(key)
		.replace(/_/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.trim();
	return s.charAt(0).toUpperCase() + s.slice(1);
}

export function sectionId(key) {
	return 'sec-' + String(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Classify a value so the renderer can pick a layout.
export function valueKind(v) {
	if (isScalar(v)) return 'scalar';
	if (Array.isArray(v)) {
		if (v.length === 0) return 'scalar'; // renders as "—"
		if (v.every((x) => isScalar(x))) return 'array-scalars';
		if (v.every((x) => Array.isArray(x))) return 'array-arrays';
		if (v.some((x) => x && typeof x === 'object' && !Array.isArray(x))) return 'array-objects';
		return 'array-arrays';
	}
	// plain object
	const vals = Object.values(v);
	return vals.every((x) => isScalar(x)) ? 'flat-object' : 'nested-object';
}

// Preferred column order for known STAC arrays-of-objects / asset maps. Unknown
// keys are appended after these.
const COLUMN_HINTS = {
	providers: ['name', 'roles', 'url', 'description'],
	links: ['rel', 'type', 'title', 'href', 'method'],
	assets: ['title', 'type', 'roles', 'href', 'description'],
	item_assets: ['title', 'type', 'roles', 'description']
};

// Ordered union of object keys across `items`, honoring COLUMN_HINTS[fieldKey].
export function columnsFor(fieldKey, items) {
	const present = new Set();
	for (const it of items) {
		if (it && typeof it === 'object' && !Array.isArray(it)) {
			for (const k of Object.keys(it)) present.add(k);
		}
	}
	const hint = COLUMN_HINTS[fieldKey] ?? [];
	const ordered = hint.filter((k) => present.has(k));
	for (const k of present) if (!ordered.includes(k)) ordered.push(k);
	return ordered;
}

// STAC summaries may express a value as a numeric range object.
export function isRange(o) {
	if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
	const keys = Object.keys(o);
	return keys.length > 0 && keys.every((k) => k === 'minimum' || k === 'maximum');
}

export function looksLikeUrl(s) {
	return typeof s === 'string' && /^https?:\/\//i.test(s.trim());
}

// Build the ordered list of metadata sections for a collection.
// Returns [{ id, label, key, value }]. Scalars are grouped into one "Overview"
// section; every other (non-hidden, non-empty) top-level field gets its own.
export function buildSections(collection) {
	if (!collection || typeof collection !== 'object') return [];
	const sections = [];
	const overview = {};

	for (const [key, value] of Object.entries(collection)) {
		if (HIDDEN_FIELDS.has(key) || isEmpty(value)) continue;
		if (isScalar(value) && !OWN_SECTION_SCALARS.has(key)) {
			if (!SKIP_IN_OVERVIEW.has(key)) overview[key] = value;
			continue;
		}
		sections.push({ id: sectionId(key), label: humanize(key), key, value });
	}

	if (Object.keys(overview).length) {
		sections.unshift({ id: 'sec-overview', label: 'Overview', key: 'overview', value: overview });
	}
	return sections;
}
