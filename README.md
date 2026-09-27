# Magat Dam FloodCast — dashboard snapshot

**Live page:** https://magat-dam-floodcast.vercel.app
(also GitHub Pages: https://xuantinhsea.github.io/magat-dam-floodcast/ once enabled — see below)

A static snapshot of the operator dashboard of an automated flood-forecasting
system for the **Magat River basin above Magat Dam** (Luzon, Philippines),
built on the ICHARM Rainfall–Runoff–Inundation (RRI) model.

> **Archived snapshot — not a live warning service.** The page is a frozen copy
> of the operational dashboard. The forecasts it shows were current when it was
> exported and must not be used operationally. For current conditions, follow
> PAGASA and your LGU.

## What is in it

The forecasts are real model runs: Open-Meteo forecast rainfall driving RRI,
post-processed into discharge, water level, flood depth and warning levels. No
observed river data is connected yet, and six of the seven stations use
provisional warning thresholds; both are stated on the page.

| Page | Shows |
|---|---|
| `index.html` | one-window operator view: map with depth / peak depth / rainfall / accumulated-rain layers, station warning cards and outlook matrix, discharge and water-level forecasts, and a timeline band — click any hour on it to read rain, discharge and water level there |
| `public.html` | the plain-language public page, marked as an archived snapshot |

## Layout

```
docs/                 the published site
  index.html, app.js, style.css, public.*, api-url.js
  config.js           mode: 'snapshot' — read data/ instead of a live API
  data/               every API response the pages need, as static files
  data/manifest.json  exported cycles, export time, the snapshot notice
  .nojekyll           serve files as they are
vercel.json           Vercel serves docs/ (redeploys on every push)
```

## Publishing

- **Vercel** redeploys automatically on every push to `main`.
- **GitHub Pages** (one-time): Settings → Pages → *Build and deployment* →
  Source: **Deploy from a branch**, Branch: **main**, folder **/docs** → Save.
  After that every push publishes there too.

## Updating the snapshot

`docs/` is generated, not edited. On the machine that runs the forecasting
pipeline (its API at `http://localhost:8000`):

```bash
# in the RRI warning-system repo
make export-static        # = python scripts/export_static.py --out ../magat-dam-floodcast/docs
cd ../magat-dam-floodcast
git add -A && git commit -m "Update snapshot" && git push
```
