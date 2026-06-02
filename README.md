# STAC Viewer

A SvelteKit single-page app (SPA) front end for a SpatioTemporal Asset Catalog
(STAC) API.

- **Homepage** — queries the STAC API's `/collections` endpoint and renders the
  results as a filterable card grid.
- **Collection detail** (`/collections/{id}`) — shows the collection metadata and
  plots its items on a MapLibre GL map, with filters (date range, result limit, and
  "restrict to map view" bounding box) that query `/collections/{id}/items`. Items
  list in a paginated table with expandable per-item asset sub-tables and a
  key/role asset filter.
- **Downloads** — selected assets are queued and downloaded to a chosen folder via
  the File System Access API (Chromium only), with a persistent IndexedDB queue,
  download history, dead-letter retry, cross-tab single-runner, pause/resume, and a
  duplicate check (history + on-disk). Managed at `/downloadQueue` and via the
  floating widget on every page.

The STAC API URL is configurable from the top bar and is remembered in
`localStorage`. It defaults to a public
["Kentucky From Above"](https://spved5ihrl.execute-api.us-west-2.amazonaws.com) STAC API.
Changing the default in code only affects browsers with no saved URL — click
**Reset** in the top bar to switch an existing one.

## Develop

```bash
npm install
npm run dev
```

## Build (static SPA)

```bash
npm run build      # outputs to ./build (index.html SPA fallback + assets)
npm run preview
```

The build uses `@sveltejs/adapter-static` with an `index.html` fallback, so the
output is a pure client-side SPA that can be hosted on any static file server or
CDN. Configure the host to serve `index.html` for unknown paths so client-side
routing works.

## Design / theming

The UI is intentionally minimal — white background, black text, thin borders,
simple grid layouts — to make custom branding straightforward later. All
branding-relevant values (colors, borders, spacing, fonts) are defined as CSS
variables in the `:root` block of `src/app.css`; change them there to re-skin the
whole app.

## Structure

| Path | Purpose |
| --- | --- |
| `src/lib/stac.js` | STAC API client (collections, items, pagination, filter helpers) |
| `src/lib/config.js` | Configurable + persisted API URL store |
| `src/lib/StacMap.svelte` | MapLibre GL map component |
| `src/lib/queue.js` | IndexedDB layer: queue / history / dead-letter / meta + change events |
| `src/lib/queueStore.js` | Reactive Svelte stores over the queue + in-memory progress |
| `src/lib/download.js` | File System Access helpers (`writeAsset`, `fileExists`, `assetTargetPath`) |
| `src/lib/downloadController.js` | Single-runner download loop, pause/resume, cross-tab lock |
| `src/lib/DownloadWidget.svelte` | Floating download controller (all pages) |
| `src/routes/+page.svelte` | Homepage: collection card grid |
| `src/routes/collections/[id]/+page.svelte` | Collection detail: map, filters, items table, asset selection, duplicate check |
| `src/routes/downloadQueue/+page.svelte` | Queue / history / dead-letter management |

See `CLAUDE.md` for architecture and `docs/PROJECT_STATE.md` for resume notes.
