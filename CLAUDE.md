# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start the Vite dev server.
- `npm run build` — produce the static SPA in `build/` (also the fastest way to typecheck/compile-check the whole app; run it after changes).
- `npm run preview` — serve the production build locally.

There is no test runner, linter, or formatter configured.

## Architecture

A SvelteKit **single-page app** (Svelte 5 runes) that is a browser-only front end for a STAC (SpatioTemporal Asset Catalog) API. There is no backend of our own — all data comes from a user-configurable remote STAC API.

- **Pure SPA setup.** `@sveltejs/adapter-static` with an `index.html` fallback (`svelte.config.js`), and `src/routes/+layout.js` sets `ssr=false`, `prerender=false`, `csr=true`. Everything runs client-side. Because there is no SSR, browser-only libraries can be imported normally at module top level (MapLibre is a plain top-level `import` in `StacMap.svelte`). A static host must serve `index.html` for unknown paths.
- **Vite plugin gotcha:** the SvelteKit Vite plugin is imported from `@sveltejs/kit/vite` (not `@sveltejs/vite-plugin-svelte`).

### Data flow

- `src/lib/config.js` — the `apiUrl` writable store is the single source of truth for the STAC API root, persisted to `localStorage` (`STORAGE_KEY = 'stac-api-url'`). The layout's top bar edits it; pages re-query reactively via `$effect` when it changes. `DEFAULT_API_URL` is the public "Kentucky From Above" stac-fastapi API (`https://spved5ihrl.execute-api.us-west-2.amazonaws.com`, CORS `*`). **Gotcha:** the default only applies when nothing is saved — an existing browser keeps its stored URL, so after changing `DEFAULT_API_URL` you must click **Reset** in the top bar (or clear localStorage) to actually switch.
- `src/lib/stac.js` — the only place that talks to the STAC API. Targets STAC API / OGC API Features endpoints (`/`, `/collections`, `/collections/{id}`, `/collections/{id}/items`). Also holds extent/datetime helpers used by the detail page.
- `src/routes/+page.svelte` — homepage: fetches collections into a filterable card grid.
- `src/routes/collections/[id]/+page.svelte` — the bulk of the app: collection metadata, map, item query filters, paginated results table, per-asset selection filter, and folder download. See below.
- `src/routes/downloadQueue/+page.svelte` — view/process the persistent download queue and retry failures (see Download queue below).

### Items pagination (detail page + stac.js)

Pagination is **token/link-based, not offset-based**. `buildItemsUrl()` builds the page-0 URL from filters; `fetchItemsPage()` fetches a page and returns `{ features, nextLink, numberMatched, numberReturned }`, extracting the `next` link from the response. The detail page keeps a `pageRequests` history stack (page 0 = URL string, later pages = the captured `next` link objects) plus `pageIndex`, so **Previous works even on APIs that only return a `next` link** (e.g. Planetary Computer). `requestLink()` handles both GET and POST-style paging links.

### Map component (`src/lib/StacMap.svelte`)

MapLibre GL JS (no API key — raster basemap from OpenStreetMap tiles), imported normally at the top of the component (`import maplibregl from 'maplibre-gl'` + the CSS). Props/callbacks: `items`, `bbox` (initial extent), `focus` (pan/zoom target), `onselect`, `onmove`.

- **Critical:** MapLibre click events return *serialized* features that **drop the STAC item's top-level `assets`**. `buildFC()` indexes originals by id in `originalById` and stashes `_stacId` in feature properties; `handleFeatureClick` looks the original back up so `onselect` receives the full item (with `assets`). Don't rely on the raw clicked feature.
- `focus` is a fresh `{ feature, n }` object per click (new identity) so clicking the same row re-zooms; `geomBbox()` computes a feature's extent for `fitBounds`.

### Asset selection + download (detail page)

- An asset is identified across the page by `` `${itemId}::${key}` `` (`assetId`). Selection lives in `selectedAssets` (a Set). Two multi-selects drive selection: **Asset keys** is fed by `availableKeys` (`items.flatMap(i => Object.keys(i.assets))`) and **Asset roles** by `availableRoles` (the assets' `.roles`) — two separate `$derived`s; do not conflate them. The selection `$effect` only **reads** the filters + `items` and only **writes** `selectedAssets`, so manual checkbox toggles (`toggleAsset`) don't retrigger it (no loop) and persist until a filter/page change re-derives. (Note: a token like `metadata`/`thumbnail` can legitimately appear in *both* dropdowns when it's both an asset key and a role in the data — that's correct, not a bug.)
- **Item asset sub-tables are expanded by default.** The component tracks `collapsed` (id → true) instead of expanded; a row's assets render when `!collapsed[item.id]`. Empty `collapsed = {}` (the reset default) means all open.
- **Per-collection state reset.** This route reuses the same component instance across `/collections/[id]` navigations, so the collection-load `$effect` (keyed on `id` + `$apiUrl`) resets all per-collection state up front — `items`, pagination, `selected`/`focusTarget`/`collapsed`, the asset filters/selection, query filters (keeps `limit`), and the duplicate-modal state — preventing stale options/selections from bleeding across collections. It writes only state it doesn't read (no loop) and leaves `queriedFor` so the new collection still auto-queries once.
- **Download is queue-based and persistent** (see below). The detail page enqueues the selected https assets (after a duplicate check) and kicks off the controller; it does not contain the download mechanics itself.

### Duplicate check before queuing (detail page)

When queuing selected assets, each is flagged as a *potential duplicate* if it was downloaded within the last `DUP_WINDOW_DAYS` (30) per `history` **OR** the file already exists on disk at its target path (**OR** logic). The folder is acquired first via `acquireDirectory(true)` (controller; prompts/persists, inside the click gesture — cancel falls back to history-only); on-disk presence uses `fileExists(dir, item)` from `download.js`, which walks the same `assetTargetPath(item)` (`<catalog>/<collection>/<itemId>/<filename>`) the writer uses. Duplicates open a confirm modal cycled one-by-one (Skip / Add, an "Apply to all remaining" checkbox, and a remaining-count footer); non-duplicates + accepted ones are enqueued and `start()`ed (reusing the just-authorized handle, so no second prompt).

### Download queue (`queue.js`, `queueStore.js`, `download.js`, `downloadController.js`, `DownloadWidget.svelte`, `/downloadQueue`)

- `queue.js` — IndexedDB layer (DB `stac-viewer`, **version 3**). Stores: `queue` (`pending`/`downloading`), `history` (completed, `downloadedAt`/`bytes`), `deadletter` (failed, `error`/`failedAt`), and `meta` (key/value, holds the persisted directory handle). List records carry `href`/`filename`/`itemId`/`collectionId`/`catalogName`. **Every list write emits a change event** — locally and cross-tab via `BroadcastChannel('stac-queue-changes')` (it doesn't fire on the sender, hence the explicit local fan-out). Subscribe with `onChange(cb)`. `meta` reads/writes are silent (no events).
- `queueStore.js` — reactive layer. Svelte stores `queueItems`/`historyItems`/`deadItems`, refreshed by `loadAll()` wired to `onChange`, so **all three lists update live with no page refresh** (incl. other tabs). `progress` is an in-memory store (item id → `{loaded,total}` bytes) updated per streamed chunk via `setProgress`/`clearProgress` — kept out of IndexedDB.
- `download.js` — stateless File System Access helpers only: `fsApiSupported`, `pickDirectory` (Chromium-only); `assetTargetPath(item)` (single source of truth for the `<catalog>/<collection>/<item id>/<filename>` path, used by both writer and checker); `fileExists(dir, item)` (read-only existence check for the duplicate logic); and `writeAsset(dir, item, usedByDir, onProgress)` which fetches one asset and streams it (manual `getReader()` loop reporting bytes) into that path, `writable.abort()`-ing the partial file on any failure. Only `http(s)` hrefs download; CORS required on the asset server.
- `downloadController.js` — **the singleton that owns the run loop and is the only thing that processes the queue.** `start()`/`pause()`/`retry(records)` plus a `status` store (`idle`/`running`/`paused`). Also exports `acquireDirectory(request)` (a wrapper over the private `ensureDirectory`) used by the detail page's duplicate check so it inspects the same persisted handle downloads write to. The loop processes `pending` items one at a time, checking the pause flag between items (so pause takes effect after the in-flight file), moving each to `history` or `deadletter`. The chosen directory handle is persisted to `meta` so a download survives refresh; `initOnLoad()` (called from the layout `onMount`) resets stuck `downloading` items back to `pending` and auto-resumes if `queryPermission` is still `granted`. Re-granting permission after a reload needs a user gesture, so the widget/queue-page Start button drives resume.
- **Cross-tab single-runner:** only one tab downloads at a time, enforced with the **Web Locks API** (`navigator.locks.request(RUNNER_LOCK, { ifAvailable: true }, …)` — the lock is held for the loop's duration and auto-releases on pause/finish/tab-close; a second tab requesting it gets `null` and doesn't start a duplicate). A separate `BroadcastChannel('stac-download-control')` broadcasts `status` and (throttled) `progress` from the active tab and relays `pause` requests, so every tab's widget/queue page shows the same live state; a tab opened mid-download sends `request-status` and the runner replies. The run loop also resets any `downloading` items to `pending` at start, so a crashed/closed runner's in-flight item is retried by the next runner. (This control channel is separate from queue.js's `stac-queue-changes` channel, which syncs the persisted lists.)
- **User-gesture rule:** anything that may prompt the directory picker or `requestPermission` (`start`, `retry`) must be called from a click handler.
- `DownloadWidget.svelte` — floating control rendered on every page from `+layout.svelte`. Shows remaining count + active-file progress and Start/Pause/Resume driven by the controller's `status`.

## Styling

Intentionally minimal (white bg, black text, thin borders, grid). All branding values are CSS variables in the `:root` block of `src/app.css` — re-skin there. Per-component styles are scoped `<style>` blocks.

## Known API caveat

`buildItemsUrl` sends `sortby=+id` per the STAC Sort extension. Some APIs honor it on GET `/items`; others ignore it (e.g. Planetary Computer only sorts via `POST /search`) — in that case it's a harmless no-op.

## Project state / recent work

See `docs/PROJECT_STATE.md` for a session-by-session log of what was built, the key decisions, what's verified vs. browser-only, and likely next steps — read it first when resuming.
