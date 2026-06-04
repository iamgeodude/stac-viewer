# Project State — resume notes

Read this together with `CLAUDE.md` (architecture) when picking up fresh. This is the "where we left off" log: what exists, decisions made, what's verified vs. not, and likely next steps. Last updated 2026-06-03.

## What this app is

A SvelteKit SPA (Svelte 5 runes) front end for a STAC API. Homepage lists collections (filterable card grid); `/collections/[id]` shows the collection's metadata as **hash-routed sections** in the left panel (Overview / Description / Extent / Providers / Keywords / Summaries / **Downloads**) with a sticky table-of-contents nav + scroll-spy, a MapLibre map of items on the right, and — under **Downloads** — the item search/filter UI (date range, limit, map-bounds bbox; **synced to the URL query string**), an asset key/role multi-select filter, a queue-based downloader, and the paginated per-item **cards** (each with its own expandable assets table); `/downloadQueue` manages the persistent download queue, history, and dead-letter. A floating `DownloadWidget` (Start/Pause/Resume + remaining count) shows on every page.

## Build / run

- `npm install`, then `npm run dev` (Vite) / `npm run build` (static SPA in `build/`) / `npm run preview`.
- `npm run build` is also the fastest full compile check. No tests/lint/format configured.
- Node 24 / npm 11 on the dev machine. Git repo on `master` (also pushed to `origin` = github.com/iamgeodude/stac-viewer). The black-line/auto-zoom/cards/magenta UI work (timeline 10–13) was committed on branch `item-select-ui` and fast-forward-merged into `master` (commit `d098fb3`). The collection-detail restructure (timeline 14) is **uncommitted** in the working tree as of this writing. Git identity is set repo-locally to `geodude <whoisthegeodude@gmail.com>` (no global identity on this machine).

## Feature timeline (all implemented & building)

1. Scaffolded the SPA: adapter-static + SPA fallback, Leaflet→**MapLibre GL JS** map, configurable STAC API URL persisted to localStorage.
2. Items: link/token pagination (Prev works via a request-history stack), row→map pan/zoom, items-per-page selector, expandable per-item **asset sub-tables**.
3. Asset selection filter: **Asset keys** and **Asset roles** multi-selects driving a `selectedAssets` Set + per-asset checkboxes; selected-count.
4. Downloads, evolved over several steps into the current design:
   - File System Access API (`showDirectoryPicker`) → nested folders `<catalog>/<collection>/<itemId>/<filename>`.
   - **IndexedDB queue** (`queue`/`history`/`deadletter`/`meta`, DB v3) with cross-tab live sync (BroadcastChannel) and in-memory per-file byte `progress`.
   - **Single-runner controller** (`downloadController.js`) with pause/resume, **Web Locks** so only one tab downloads, status/progress broadcast across tabs, resume-after-refresh (persisted dir handle + `initOnLoad`).
   - **Duplicate check** before queuing.
5. Map swapped Leaflet → MapLibre; later changed the MapLibre import from a dynamic `await import` to a normal top-level `import` (safe because `ssr=false`).
6. Default STAC API switched from Microsoft Planetary Computer → **"Kentucky From Above"** (`https://spved5ihrl.execute-api.us-west-2.amazonaws.com`, stac-fastapi, CORS `*`, 9 collections: dem/laz/orthos phase 1–3).
7. Per-collection **state reset** on `[id]` change (route reuses the component instance) so nothing bleeds across collections.
8. Item asset sub-tables now **expanded by default** (track `collapsed`, not expanded).
9. Duplicate check extended: flag if downloaded ≤30d ago (history) **OR** file exists on disk in the chosen folder; prompt for the folder up front (cancel → history-only).
10. **Map symbology simplified** (`StacMap.svelte`): items now render as a near-transparent black fill (`fill-opacity 0.05`, for click hit-testing) + plain black 1px outlines. Removed the `items-point` circle layer (white-fill/black-stroke vertex dots). Click/hover handlers repointed to `["items-fill", "items-outline"]`. Caveat: bare `Point`-geometry items no longer get a visible marker (Kentucky footprints are polygons, so no impact).
11. **Items map auto-zooms to the loaded items' extent** (`StacMap.svelte`): new `featuresBbox(items)` (combines per-feature `geomBbox`) + `fitToItems()`; the load handler and the items `$effect` fit to the items' combined extent, **refitting whenever the item set changes** (initial query, pagination, filters). Falls back to the collection `bbox` prop (`initialBbox`) when no items are loaded yet. No query→refit loop because `onmove` only stores `mapBounds` (map-bounds querying is a manual button).
12. **Items table → per-item cards** (`/collections/[id]`): replaced the single `<table class="items">` with a `.item-cards` flex column (`gap: 8px` = the small vertical gap). Each item is an `<article class="item-card">` with a header (toggle, clickable ID, datetime, asset count, status badges) and its assets table inside `.item-assets`. The **item ID** (a `<button class="item-id">`) is now the click target for zoom (whole-row click removed) → calls the existing `focusItem`. Collapse/expand, asset checkboxes, badges, and the download flow are unchanged.
13. **Magenta highlight of the clicked item on the map** (`StacMap.svelte`): new `highlightId` prop drives two top-most layers `items-highlight-fill` (`#ff00ff`, opacity 0.15) + `items-highlight-line` (`#ff00ff`, width 3), filtered to the highlighted `_stacId` via `applyHighlight()` (run at layer creation + in a `highlightId` `$effect`). `items-highlight-fill` is added to the click handler loop so clicking a highlighted polygon still re-selects. Wired as `highlightId={selected?.id ?? null}`; since both `focusItem` (card-ID click) and the map's `onselect` set `selected`, clicking either a card ID or a polygon zooms/selects and paints that geometry magenta. The selected card also gets a magenta border + tinted header.
14. **Collection-detail left panel restructured into hash-routed metadata sections + URL-synced item search** (`src/routes/collections/[id]/+page.svelte`, single-file change):
    - **URL query sync (items search only):** new `readUrlFilters()` seeds `start`/`end`/`limit`/`bbox` from `get(page).url.searchParams` (read via `get()`, NON-reactively, so the collection-load `$effect` doesn't depend on the URL and re-fetch on every `replaceState`); a `bbox` param also sets `mapBounds` + `useMapBounds`. `syncUrl()` writes those params back via `replaceState` (shallow, preserves the hash) and is called inside `queryItems()`, so the Query button + the `limit` dropdown both sync. Reload restores the inputs and re-runs the same query. Asset key/role filters are intentionally NOT synced. New imports: `replaceState` (`$app/navigation`), `browser` (`$app/environment`), `get` (`svelte/store`).
    - **Hash-routed metadata sections:** the flat metadata block is now a sticky `<nav class="cd-toc">` + a series of `<section id="sec-…">` (Overview, Description, Extent with **Spatial**/**Temporal** `<h3>` subheaders, Providers, Keywords, Summaries, Downloads). `sections` (`$derived`) lists only sections whose data is present. Scroll-spy: an `IntersectionObserver` rooted on `.cd-meta` (`bind:this={metaEl}`, declared `$state(null)`; `rootMargin: '0px 0px -70% 0px'`) sets `activeSection` (highlighted TOC link) and updates the URL hash via `replaceState` as you scroll; the `$effect` re-binds per collection and disconnects on cleanup. Removed the old `scroll-snap-type`/`.cd-snap` (fought scroll-spy); added `scroll-margin-top` so headings clear the sticky TOC.
    - **"Downloads" section** now contains the moved item search/filter UI, asset key/role selection + queue buttons, pager, and the `.item-cards` list — every handler/binding preserved (`queryItems`, `prefillFromExtent`, `checkDisk`, `clearAssetFilter`, `downloadSelectedAssets`, `toggleAsset`, `focusItem`, pager). Map stays on the right, click-to-zoom + magenta highlight intact.
    - **Follow-up fixes (scroll-spy accuracy + sticky-TOC gap):** the first IntersectionObserver scroll-spy was inaccurate (picked the arbitrary last `isIntersecting` entry, lost small sections) and the sticky TOC showed a transparent strip below the topbar. Replaced the observer with a deterministic scroll/resize-driven `computeActive()` — picks the **last** section whose top crossed the line just under the TOC, with a bottom clamp so a tiny final section still activates — plus `tocHeight()` (live, handles a wrapped multi-row TOC) and `gotoSection()` which intercepts TOC clicks and `metaEl.scrollTo`s the heading to exactly under the TOC (independent of native `scroll-margin-top`). The gap was caused by `.cd-meta`'s top padding offsetting the `sticky; top:0` child; fixed by dropping `.cd-meta`'s top padding (`padding: 0 var(--space) var(--space)`) and adding `.back { margin: var(--space) 0 }`, so the TOC is flush with the global topbar.

## Key decisions / conventions

- **Pure SPA**, no SSR/prerender → browser-only libs import normally at top level.
- **Default API only applies to fresh localStorage.** After changing `DEFAULT_API_URL`, click **Reset** in the top bar to actually switch an existing browser.
- **Asset keys vs roles are correct and separate** (`Object.keys(assets)` vs `assets[*].roles`). Overlap of a token in both dropdowns (e.g. `metadata`, `thumbnail`) is real data, not a bug. If the UI ever shows a *role-only* word (e.g. `visual`) under keys, that's a **stale build** — rebuild.
- **Duplicate rule = history OR on-disk**; folder prompted up front; modal cycles one-by-one with an "apply to all remaining" bypass.
- **User-gesture rule:** `start`, `retry`, `acquireDirectory(true)` may prompt the picker / `requestPermission`, so only call them from click handlers.
- Minimal styling; all theme values are CSS variables in `src/app.css :root`.

## Verified vs. NOT verified

- **Verified:** `npm run build` passes; `/`, `/collections/[id]`, `/downloadQueue` all return 200 in dev; STAC API shapes and CORS confirmed via curl; asset key/role separation confirmed against the API data.
- **NOT verified (browser-only, can't be exercised from CLI):** anything behind the File System Access API and multi-tab behavior — directory picker, permission prompts, actual file writes/streaming progress, the duplicate on-disk check, pause/resume mid-download, resume-after-refresh, Web-Locks single-runner handoff, cross-tab status/progress sync. These compile and are structurally correct but need a manual Chromium pass (Chrome/Edge; secure context i.e. localhost/https). Use the dev server and DevTools (offline throttling to test dead-letter; two tabs to test single-runner).
- **Recent UI changes (build-passes, but visual behavior not yet eyeballed in a browser):** black-line item symbology (no vertex dots), items-extent auto-zoom + refit-on-page-change, the per-item **card** layout (gap, header, clickable ID → zoom), and the **magenta** highlight of the clicked item on the map (timeline 10–13). Plus the collection-detail restructure (timeline 14): **URL query sync** of the items search (set filters + Query → URL gains `?start=…&end=…&limit=…&bbox=…`; reload should restore + re-run), the **hash-routed** metadata sections (TOC click → scroll + `#sec-…`; scroll → scroll-spy updates hash + active link), and the **Downloads** section holding the moved search/filter UI + cards. All compile via `npm run build`; confirm look/interaction (esp. scroll-spy hash updates, anchor scroll within the `.cd-meta` overflow container, and reload-restores-query) with `npm run dev` on a Kentucky collection.

## Open questions / possible next steps

- Confirm the "prompt for folder up front" UX feels right; alternative is "only run the on-disk check when permission is already granted" (no extra prompt). Easy toggle in `downloadSelectedAssets` (call `acquireDirectory(false)` / query-only).
- Pause is **between files** (in-flight file finishes). Could change to abort the in-flight transfer for instant stop (discards partial) if desired.
- No dedupe on enqueue across repeated clicks (queue can hold duplicate rows); the duplicate *modal* is the guard, not the queue itself.
- `sortby=+id` is sent but ignored by some APIs (no-op); enforce ordering via `POST /search` if a target API needs it.
- Large pages with all rows expanded render many asset sub-tables at once (heavier first paint) — fine, just noted.

## Map gotcha to remember

MapLibre click events return *serialized* features that drop the item's top-level `assets`. `StacMap.svelte` keeps `originalById` + `_stacId` to recover the full STAC item for `onselect`. Don't rely on the raw clicked feature.
