# Project State — resume notes

Read this together with `CLAUDE.md` (architecture) when picking up fresh. This is the "where we left off" log: what exists, decisions made, what's verified vs. not, and likely next steps. Last updated 2026-06-02.

## What this app is

A SvelteKit SPA (Svelte 5 runes) front end for a STAC API. Homepage lists collections (filterable card grid); `/collections/[id]` shows collection metadata, a MapLibre map of items, query filters (date range, limit, map-bounds bbox), a paginated items table with expandable per-item asset sub-tables, an asset key/role multi-select filter, and a queue-based downloader; `/downloadQueue` manages the persistent download queue, history, and dead-letter. A floating `DownloadWidget` (Start/Pause/Resume + remaining count) shows on every page.

## Build / run

- `npm install`, then `npm run dev` (Vite) / `npm run build` (static SPA in `build/`) / `npm run preview`.
- `npm run build` is also the fastest full compile check. No tests/lint/format configured.
- Node 24 / npm 11 on the dev machine. Not a git repo.

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

## Open questions / possible next steps

- Confirm the "prompt for folder up front" UX feels right; alternative is "only run the on-disk check when permission is already granted" (no extra prompt). Easy toggle in `downloadSelectedAssets` (call `acquireDirectory(false)` / query-only).
- Pause is **between files** (in-flight file finishes). Could change to abort the in-flight transfer for instant stop (discards partial) if desired.
- No dedupe on enqueue across repeated clicks (queue can hold duplicate rows); the duplicate *modal* is the guard, not the queue itself.
- `sortby=+id` is sent but ignored by some APIs (no-op); enforce ordering via `POST /search` if a target API needs it.
- Large pages with all rows expanded render many asset sub-tables at once (heavier first paint) — fine, just noted.

## Map gotcha to remember

MapLibre click events return *serialized* features that drop the item's top-level `assets`. `StacMap.svelte` keeps `originalById` + `_stacId` to recover the full STAC item for `onselect`. Don't rely on the raw clicked feature.
