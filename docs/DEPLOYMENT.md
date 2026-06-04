# Deployment — GitHub Pages

The app is deployed as a static SPA to **GitHub Pages**.

- **Live site:** https://iamgeodude.github.io/stac-viewer/
- **Hosting model:** *project* Pages site for `iamgeodude/stac-viewer`, served
  from the **`gh-pages` branch** (path `/`), HTTPS enforced. The `gh-pages`
  branch holds only built output and is overwritten on every deploy — never edit
  it by hand.
- **One-command deploy:** `npm run deploy` (details below).

## Why a base path (`/stac-viewer`)

A project Pages site is served under a sub-path (`/stac-viewer/`), not the domain
root. So `svelte.config.js` sets:

```js
paths: { base: process.env.BASE_PATH || '' }
```

- Empty for local `npm run dev` / `npm run build` (app stays at root).
- The deploy script sets `BASE_PATH=/stac-viewer` so the built site resolves
  assets and routes under that prefix.

**SvelteKit does NOT auto-prepend `base` to hardcoded root-relative links.** Every
internal link therefore imports `base` from `$app/paths` and uses it:

- `<a href="{base}/">`, `<a href="{base}/downloadQueue">`,
  `` href={`${base}/collections/${id}`} `` — in `+layout.svelte`,
  `+page.svelte`, `collections/[id]/+page.svelte`, `downloadQueue/+page.svelte`,
  and `DownloadWidget.svelte`.
- The layout's full-bleed check also uses the prefix:
  `` $page.url.pathname.startsWith(`${base}/collections/`) `` — `$page.url.pathname`
  includes the base in production, so without this the detail-page layout breaks.

External links (provider URLs, asset hrefs, OSM tiles) and hash links
(`href="#sec-…"`) are intentionally left unprefixed.

## SPA routing on Pages

This is a pure client-side SPA (`fallback: 'index.html'`, no SSR/prerender), so
deep links need a fallback the static host will serve:

- The deploy copies `build/index.html` → `build/404.html`. GitHub Pages serves
  `404.html` for any path that isn't a real file, so a hard refresh on e.g.
  `/stac-viewer/collections/<id>` loads the SPA shell, which then client-routes.
  - Note: that deep-link response carries an **HTTP 404 status** — this is
    normal for SPA-on-Pages (the *body* is the full app). Only the document
    status is 404; navigation and assets work.
- A `.nojekyll` file is written into `build/` so GitHub's Jekyll step doesn't
  strip the `_app/` directory (Jekyll ignores paths starting with `_`).

## How to deploy

```
npm run deploy
```

which runs (see `package.json`):

```
rm -rf .svelte-kit/output build \
  && BASE_PATH=/stac-viewer vite build \
  && cp build/index.html build/404.html \
  && touch build/.nojekyll \
  && gh-pages -d build -t -b gh-pages
```

Step by step:
1. **Clean** `.svelte-kit/output` and `build` — avoids a stale `base: ""`
   leaking into the output if a prior no-base `npm run build` was run in the same
   checkout.
2. **Build** with `BASE_PATH=/stac-viewer`.
3. **404 fallback** + **`.nojekyll`** (the `-t` flag tells `gh-pages` to publish
   dotfiles like `.nojekyll`).
4. **Publish** `build/` to the `gh-pages` branch via the `gh-pages` npm package
   (a dev dependency). It commits and pushes the branch using your existing git
   credentials — no extra tokens needed.

Pages rebuilds automatically from the new `gh-pages` commit (typically live in
under a minute).

## One-time Pages configuration

Pages must be set to serve from the `gh-pages` branch. This is already enabled
for this repo; to (re)apply via the GitHub CLI:

```
gh api -X POST repos/iamgeodude/stac-viewer/pages \
  -f 'source[branch]=gh-pages' -f 'source[path]=/'
```

(Returns HTTP 409 "already enabled" if it's set — harmless.) Check current
status / URL with `gh api repos/iamgeodude/stac-viewer/pages`.

## Verifying a deploy

- `git ls-remote --heads origin gh-pages` shows the updated branch.
- Root loads with the right base:
  ```
  curl -s https://iamgeodude.github.io/stac-viewer/ | grep -oE 'base: "[^"]*"'
  # → base: "/stac-viewer"
  ```
  and assets reference `/stac-viewer/_app/…`.
- A deep link (`/stac-viewer/downloadQueue`) returns the SPA shell (correct base,
  `_app` entry scripts, `<title>STAC Viewer</title>`) — 404 status expected.

## Gotchas

- **`package-lock.json` is now tracked.** It was added when `gh-pages` was
  installed; keep it committed for reproducible installs.
- **Browser-only features** (File System Access downloads, multi-tab single
  runner) require a Chromium browser in a secure context — Pages is HTTPS, so
  they work on the live site as they do on `localhost`.
- The deploy targets the **`gh-pages`** branch specifically. Don't confuse it
  with feature branches (e.g. `gh-pages-deployment`, which holds *docs*).
