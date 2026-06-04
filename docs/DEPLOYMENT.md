# Deployment — GitHub Pages

The app is deployed as a static SPA to **GitHub Pages** via the **official GitHub
Actions Pages pipeline**. Every push/merge to `master` builds and deploys
automatically.

- **Live site:** https://iamgeodude.github.io/stac-viewer/
- **Hosting model:** *project* Pages site for `iamgeodude/stac-viewer`. Pages
  **source = "GitHub Actions"** (`build_type: workflow`) — the site is served
  from an uploaded build artifact, **not** from a branch. (The old `gh-pages`
  branch is obsolete and may be deleted.)
- **CI:** `.github/workflows/deploy.yml` runs on push to `master` (and
  `workflow_dispatch`).

## Pipeline (`.github/workflows/deploy.yml`)

Two jobs on **Node 24**:

1. **build** — `actions/checkout` → `actions/configure-pages` (sets the Pages
   source to GitHub Actions) → `actions/setup-node` (node 24, npm cache) →
   `npm ci` → build → `actions/upload-pages-artifact` (uploads `build/`).
   The build step is:
   ```
   BASE_PATH=/stac-viewer npm run build
   cp build/index.html build/404.html
   ```
2. **deploy** — `actions/deploy-pages` publishes the artifact to the
   `github-pages` environment; its output is the live URL.

Required permissions: `pages: write`, `id-token: write`, `contents: read`.
A `concurrency: { group: pages }` guard prevents overlapping deploys.

## Why a base path (`/stac-viewer`)

A project Pages site is served under a sub-path. `svelte.config.js` sets
`paths.base = process.env.BASE_PATH || ''` — empty for local `npm run dev` /
`npm run build` (root), and the CI build sets `BASE_PATH=/stac-viewer`.

**SvelteKit does NOT auto-prepend `base` to hardcoded root-relative links**, so
every internal link imports `base` from `$app/paths`
(`<a href="{base}/…">`, `` href={`${base}/collections/${id}`} ``) and the
layout's full-bleed check uses `` $page.url.pathname.startsWith(`${base}/collections/`) ``.
External links (provider URLs, asset hrefs, OSM tiles) and hash links stay
unprefixed.

## SPA routing on Pages

This is a pure client-side SPA (`fallback: 'index.html'`, no SSR/prerender). The
build copies `build/index.html` → `build/404.html`; GitHub Pages serves
`404.html` for any path that isn't a real file, so a hard refresh on e.g.
`/stac-viewer/collections/<id>` loads the SPA shell, which then client-routes.

- The deep-link response carries an **HTTP 404 status** — normal for SPA-on-Pages
  (the *body* is the full app). Navigation and assets work.
- No `.nojekyll` is needed: the Pages **artifact** deployment does not run Jekyll,
  so the `_app/` directory is served as-is.

## Deploying

- **Automatic:** push/merge to `master` → the workflow builds and deploys
  (typically live in ~1–2 min).
- **Manual:** `npm run deploy` (runs `gh workflow run deploy.yml --ref master`),
  or `gh workflow run deploy.yml`, or the **Actions ▸ Deploy to GitHub Pages ▸
  Run workflow** button.

## One-time Pages configuration

Set the Pages source to GitHub Actions (already done; `configure-pages` in the
workflow also enforces it each run):

```
gh api -X PUT repos/iamgeodude/stac-viewer/pages -f build_type=workflow
```

Check status / URL: `gh api repos/iamgeodude/stac-viewer/pages`.

## Verifying a deploy

- Watch the run: `gh run list --workflow=deploy.yml` → `gh run watch <id>`
  (`gh run view <id> --log-failed` on failure).
- `gh api repos/iamgeodude/stac-viewer/pages -q '{build_type,status,html_url}'`
  → `build_type: "workflow"`, `status: "built"`.
- Root loads with the right base:
  ```
  curl -s https://iamgeodude.github.io/stac-viewer/ | grep -oE 'base: "[^"]*"'
  # → base: "/stac-viewer"
  ```
  assets reference `/stac-viewer/_app/…`; a deep link
  (`/stac-viewer/downloadQueue`) returns the SPA shell (404 status expected).

## Gotchas

- **`package-lock.json` is tracked** (needed for `npm ci` in CI).
- **Browser-only features** (File System Access downloads, multi-tab single
  runner) require a Chromium browser in a secure context — Pages is HTTPS.
- The first run after switching the source establishes the Actions deployment;
  until it completes the site may briefly 404.
