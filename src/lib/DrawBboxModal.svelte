<script>
	import { onMount, onDestroy } from 'svelte';
	import maplibregl from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';

	/**
	 * Fullscreen modal map for drawing a search bounding box. The view is locked to
	 * the collection extent (maxBounds), and the drawn box is clamped to it.
	 *
	 * @typedef {Object} Props
	 * @property {number[]|null} [extent]  Collection extent [w,s,e,n] to restrict to.
	 * @property {number[]|null} [initial] Existing drawn bbox [w,s,e,n] to seed with.
	 * @property {(bbox:number[])=>void} [onconfirm] Called with the drawn [w,s,e,n].
	 * @property {()=>void} [oncancel]     Called when the user cancels.
	 */
	/** @type {Props} */
	let { extent = null, initial = null, onconfirm, oncancel } = $props();

	let el; // map container
	let map;
	let drawn = $state(initial && initial.length === 4 ? [...initial] : null); // [w,s,e,n]
	let dragging = false;
	let startLngLat = null;

	// Same no-key OSM raster basemap as StacMap.
	const STYLE = {
		version: 8,
		sources: {
			osm: {
				type: 'raster',
				tiles: [
					'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
					'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
					'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
				],
				tileSize: 256,
				attribution: '© OpenStreetMap contributors'
			}
		},
		layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
	};

	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

	// Clamp an extent to web-mercator-safe values and ensure it's non-degenerate.
	function sanitize(b) {
		if (!b || b.length < 4) return null;
		const w = clamp(b[0], -180, 180);
		const e = clamp(b[2], -180, 180);
		const s = clamp(b[1], -85, 85);
		const n = clamp(b[3], -85, 85);
		if (!(w < e) || !(s < n)) return null;
		return [w, s, e, n];
	}

	// Pad an extent outward by a fraction of its span (for a comfortable maxBounds).
	function pad(b, frac) {
		const dw = (b[2] - b[0]) * frac;
		const dh = (b[3] - b[1]) * frac;
		return sanitize([b[0] - dw, b[1] - dh, b[2] + dw, b[3] + dh]);
	}

	let ext = $derived(sanitize(extent));

	// A bbox is usable only if it has a real (non-zero) area.
	const valid = (b) => !!b && b[2] - b[0] > 1e-6 && b[3] - b[1] > 1e-6;
	const fmt = (n) => n.toFixed(4);

	function rectFC(b) {
		if (!b) return { type: 'FeatureCollection', features: [] };
		const [w, s, e, n] = b;
		return {
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					geometry: {
						type: 'Polygon',
						coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]
					},
					properties: {}
				}
			]
		};
	}

	function renderDrawn() {
		map?.getSource('draw')?.setData(rectFC(drawn));
	}

	// Box between two corners, clamped to the collection extent.
	function boxFrom(a, b) {
		let w = Math.min(a.lng, b.lng);
		let e = Math.max(a.lng, b.lng);
		let s = Math.min(a.lat, b.lat);
		let n = Math.max(a.lat, b.lat);
		if (ext) {
			w = clamp(w, ext[0], ext[2]);
			e = clamp(e, ext[0], ext[2]);
			s = clamp(s, ext[1], ext[3]);
			n = clamp(n, ext[1], ext[3]);
		}
		return [w, s, e, n];
	}

	function onMouseDown(e) {
		e.preventDefault();
		dragging = true;
		startLngLat = e.lngLat;
	}
	function onMouseMove(e) {
		if (!dragging || !startLngLat) return;
		drawn = boxFrom(startLngLat, e.lngLat);
		renderDrawn();
	}
	function onMouseUp(e) {
		if (!dragging) return;
		dragging = false;
		const box = startLngLat ? boxFrom(startLngLat, e.lngLat) : drawn;
		startLngLat = null;
		drawn = valid(box) ? box : null;
		renderDrawn();
	}

	function clearBox() {
		drawn = null;
		renderDrawn();
	}
	function confirmBox() {
		if (valid(drawn)) onconfirm?.(drawn);
	}

	function onKeydown(e) {
		if (e.key === 'Escape') oncancel?.();
	}
	// If the mouse is released outside the canvas, still end the drag.
	function onWindowUp() {
		dragging = false;
		startLngLat = null;
	}

	onMount(() => {
		map = new maplibregl.Map({ container: el, style: STYLE, center: [0, 20], zoom: 1 });
		map.addControl(new maplibregl.NavigationControl(), 'top-right');
		// Box-draw, not pan: drag draws a rectangle instead of moving the map.
		map.dragPan.disable();
		map.doubleClickZoom.disable();
		map.boxZoom.disable();

		map.on('load', () => {
			map.addSource('draw', { type: 'geojson', data: rectFC(drawn) });
			map.addLayer({
				id: 'draw-fill',
				type: 'fill',
				source: 'draw',
				paint: { 'fill-color': '#ff00ff', 'fill-opacity': 0.12 }
			});
			map.addLayer({
				id: 'draw-line',
				type: 'line',
				source: 'draw',
				paint: { 'line-color': '#ff00ff', 'line-width': 2 }
			});

			if (ext) {
				// Dashed outline of the collection extent the box is restricted to.
				map.addSource('extent', { type: 'geojson', data: rectFC(ext) });
				map.addLayer(
					{
						id: 'extent-line',
						type: 'line',
						source: 'extent',
						paint: { 'line-color': '#000000', 'line-width': 1, 'line-dasharray': [2, 2] }
					},
					'draw-fill'
				);
				const mb = pad(ext, 0.1) ?? ext;
				map.setMaxBounds([[mb[0], mb[1]], [mb[2], mb[3]]]);
				map.fitBounds([[ext[0], ext[1]], [ext[2], ext[3]]], { padding: 40, duration: 0 });
			}

			map.getCanvas().style.cursor = 'crosshair';
			map.on('mousedown', onMouseDown);
			map.on('mousemove', onMouseMove);
			map.on('mouseup', onMouseUp);
			map.resize();
		});

		window.addEventListener('mouseup', onWindowUp);
		window.addEventListener('keydown', onKeydown);
	});

	onDestroy(() => {
		window.removeEventListener('mouseup', onWindowUp);
		window.removeEventListener('keydown', onKeydown);
		if (map) map.remove();
	});
</script>

<div class="draw-modal" role="dialog" aria-modal="true" aria-label="Draw search bounding box">
	<div class="draw-head">
		<h2>Draw search area</h2>
		<span class="draw-hint">
			Click and drag on the map to draw a bounding box. Drawing is limited to the collection extent.
		</span>
		{#if valid(drawn)}
			<span class="draw-coords">
				W {fmt(drawn[0])}, S {fmt(drawn[1])}, E {fmt(drawn[2])}, N {fmt(drawn[3])}
			</span>
		{/if}
		<div class="draw-actions">
			<button type="button" onclick={clearBox} disabled={!drawn}>Clear</button>
			<button type="button" onclick={() => oncancel?.()}>Cancel</button>
			<button type="button" onclick={confirmBox} disabled={!valid(drawn)}>Use this area</button>
		</div>
	</div>
	<div class="draw-map" bind:this={el}></div>
</div>

<style>
	.draw-modal {
		position: fixed;
		inset: 0;
		z-index: 2500;
		background: var(--color-bg);
		display: flex;
		flex-direction: column;
	}
	.draw-head {
		display: flex;
		align-items: center;
		gap: var(--space);
		flex-wrap: wrap;
		padding: 8px var(--space);
		border-bottom: var(--border);
	}
	.draw-head h2 {
		font-size: 15px;
		margin: 0;
	}
	.draw-hint {
		font-size: 12px;
		color: var(--color-muted);
	}
	.draw-coords {
		font-size: 12px;
		color: var(--color-muted);
		font-family: var(--font-mono);
	}
	.draw-actions {
		margin-left: auto;
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.draw-map {
		flex: 1 1 0;
		min-height: 0;
	}
</style>
