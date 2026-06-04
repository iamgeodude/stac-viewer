<script>
	import { onMount, onDestroy } from "svelte";
	import maplibregl from "maplibre-gl";
	import "maplibre-gl/dist/maplibre-gl.css";

	/**
	 * @typedef {Object} Props
	 * @property {any[]} items        STAC Item features to plot.
	 * @property {number[]|null} [bbox] Initial [w,s,e,n] to fit the view to.
	 * @property {{feature:any}|null} [focus] A feature to pan/zoom the map to.
	 * @property {string|null} [highlightId] Id of the item to highlight in magenta.
	 * @property {(item:any)=>void} [onselect] Called when a feature is clicked.
	 * @property {(bounds:number[])=>void} [onmove] Called with [w,s,e,n] on map move.
	 */
	/** @type {Props} */
	let {
		items = [],
		bbox = null,
		focus = null,
		highlightId = null,
		onselect,
		onmove,
	} = $props();

	let el; // map container
	let map;
	let loaded = false;
	// Map of STAC item id -> original item, so clicks can recover the full item
	// (with top-level `assets`), which MapLibre's serialized features drop.
	let originalById = new Map();

	// A no-key raster basemap using OpenStreetMap tiles.
	const STYLE = {
		version: 8,
		sources: {
			osm: {
				type: "raster",
				tiles: [
					"https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
					"https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
					"https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
				],
				tileSize: 256,
				attribution: "© OpenStreetMap contributors",
			},
		},
		layers: [{ id: "osm", type: "raster", source: "osm" }],
	};

	// Build a GeoJSON FeatureCollection, indexing originals by id and stashing
	// the id in properties (string ids aren't preserved on feature.id).
	function buildFC(features) {
		originalById = new Map();
		const out = [];
		for (const it of features ?? []) {
			if (!it.geometry) continue;
			originalById.set(it.id, it);
			out.push({
				type: "Feature",
				geometry: it.geometry,
				properties: {
					_stacId: it.id,
					datetime: it.properties?.datetime ?? "",
				},
			});
		}
		return { type: "FeatureCollection", features: out };
	}

	function render(features) {
		if (!map || !loaded) return;
		const src = map.getSource("items");
		if (src) src.setData(buildFC(features));
	}

	function fitBbox(b) {
		if (!map || !b || b.length < 4) return;
		map.fitBounds(
			[
				[b[0], b[1]],
				[b[2], b[3]],
			],
			{ padding: 20, maxZoom: 12, duration: 0 },
		);
	}

	// Compute [minX,minY,maxX,maxY] from any GeoJSON geometry's coordinates.
	function geomBbox(geometry) {
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		const walk = (c) => {
			if (typeof c[0] === "number") {
				const [x, y] = c;
				if (x < minX) minX = x;
				if (y < minY) minY = y;
				if (x > maxX) maxX = x;
				if (y > maxY) maxY = y;
			} else {
				c.forEach(walk);
			}
		};
		if (geometry?.coordinates) walk(geometry.coordinates);
		if (minX === Infinity) return null;
		return [minX, minY, maxX, maxY];
	}

	// Combined [w,s,e,n] across all item geometries, or null if none usable.
	function featuresBbox(features) {
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		for (const it of features ?? []) {
			const b = geomBbox(it.geometry);
			if (!b) continue;
			if (b[0] < minX) minX = b[0];
			if (b[1] < minY) minY = b[1];
			if (b[2] > maxX) maxX = b[2];
			if (b[3] > maxY) maxY = b[3];
		}
		if (minX === Infinity) return null;
		return [minX, minY, maxX, maxY];
	}

	// Zoom to the loaded items' combined extent; fall back to the collection
	// bbox when there are no items yet (e.g. before the first query returns).
	function fitToItems() {
		if (!map || !loaded) return;
		const b = featuresBbox(items);
		if (b) fitBbox(b);
		else if (bbox) fitBbox(bbox);
	}

	// Filter the magenta highlight layers to the currently highlighted item.
	function applyHighlight() {
		if (!map || !loaded) return;
		const f = ["==", ["get", "_stacId"], highlightId ?? "__none__"];
		map.setFilter("items-highlight-fill", f);
		map.setFilter("items-highlight-line", f);
	}

	function focusFeature(feature) {
		if (!map || !feature) return;
		const b = geomBbox(feature.geometry);
		if (b)
			map.fitBounds(
				[
					[b[0], b[1]],
					[b[2], b[3]],
				],
				{ padding: 40, maxZoom: 14 },
			);
	}

	function currentBounds() {
		const b = map.getBounds();
		return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
	}

	function handleFeatureClick(e) {
		const f = e.features?.[0];
		if (!f) return;
		const sid = f.properties?._stacId;
		const orig = originalById.get(sid);
		if (orig) onselect?.(orig);
		new maplibregl.Popup({ closeButton: true })
			.setLngLat(e.lngLat)
			.setHTML(
				`<strong>${sid}</strong><br/>${f.properties?.datetime ?? ""}`,
			)
			.addTo(map);
	}

	onMount(() => {
		map = new maplibregl.Map({
			container: el,
			style: STYLE,
			center: [0, 20],
			zoom: 1,
		});
		map.addControl(new maplibregl.NavigationControl(), "top-right");

		map.on("load", () => {
			loaded = true;
			map.addSource("items", { type: "geojson", data: buildFC(items) });
			map.addLayer({
				id: "items-fill",
				type: "fill",
				source: "items",
				paint: { "fill-color": "#000000", "fill-opacity": 0.05 },
			});
			map.addLayer({
				id: "items-outline",
				type: "line",
				source: "items",
				paint: { "line-color": "#000000", "line-width": 1 },
			});
			// Magenta highlight for the clicked/selected item, drawn on top.
			// Initial filter matches nothing until highlightId is set.
			const noMatch = ["==", ["get", "_stacId"], "__none__"];
			map.addLayer({
				id: "items-highlight-fill",
				type: "fill",
				source: "items",
				filter: noMatch,
				paint: { "fill-color": "#ff00ff", "fill-opacity": 0.15 },
			});
			map.addLayer({
				id: "items-highlight-line",
				type: "line",
				source: "items",
				filter: noMatch,
				paint: { "line-color": "#ff00ff", "line-width": 3 },
			});
			applyHighlight();

			for (const layer of [
				"items-fill",
				"items-outline",
				"items-highlight-fill",
			]) {
				map.on("click", layer, handleFeatureClick);
				map.on(
					"mouseenter",
					layer,
					() => (map.getCanvas().style.cursor = "pointer"),
				);
				map.on(
					"mouseleave",
					layer,
					() => (map.getCanvas().style.cursor = ""),
				);
			}

			fitToItems();
		});

		map.on("moveend", () => onmove?.(currentBounds()));
	});

	onDestroy(() => {
		if (map) map.remove();
	});

	// Re-render markers whenever items change.
	$effect(() => {
		render(items);
		fitToItems();
	});

	// Pan/zoom whenever the focus target changes (a fresh object per request).
	$effect(() => {
		if (focus?.feature) focusFeature(focus.feature);
	});

	// Re-apply the magenta highlight whenever the highlighted item changes.
	$effect(() => {
		highlightId;
		applyHighlight();
	});
</script>

<div class="map" bind:this={el}></div>

<style>
	.map {
		width: 100%;
		height: 100%;
		min-height: 420px;
		border: var(--border);
	}
	:global(.maplibregl-popup-content) {
		font-family: var(--font);
		font-size: 12px;
		border-radius: 0;
	}
</style>
