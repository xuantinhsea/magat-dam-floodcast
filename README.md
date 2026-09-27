# Magat Dam FloodCast — dashboard

Web dashboard for an automated flood-forecasting system for the **Magat River
basin above Magat Dam** (Luzon, Philippines), built on the ICHARM
Rainfall–Runoff–Inundation (RRI) model.

This repository holds the **browser interface only** — static HTML, CSS and
JavaScript. The forecasts themselves (rainfall ingest, the RRI model runs,
warning levels) come from a separate backend API that is not part of this
repository.

> **Not an official warning service.** This is a computer forecast and a
> development interface. Always follow instructions from your LGU, PAGASA and
> local disaster-risk-reduction office.

## Pages

| Page | For | Shows |
|---|---|---|
| `index.html` | duty forecasters | map with depth / rainfall layers, per-station warning cards, outlook matrix, discharge and water-level forecasts, a rainfall–discharge timeline |
| `public.html` | residents | one plain-language status, what to do, and where |

## Current status: not connected

`config.js` sets `apiBase: null`, so both pages load but show **no forecast**:
the dashboard says it is not connected to a forecast service, and the public
page shows **Status unavailable — do not treat this as an all-clear**. Neither
page ever shows a green "normal" status without data behind it.

## Connecting it to a forecast API

1. Run the backend so that its API is reachable over **HTTPS** (the page is
   served over HTTPS, and browsers block plain-HTTP requests from it).
2. Edit `config.js`:

   ```js
   window.RRI_CONFIG = Object.assign({ apiBase: 'https://your-api.example.org' }, window.RRI_CONFIG || {});
   ```

3. Commit and push; Vercel redeploys automatically. `config.js` is served
   uncached, so open pages pick up the change on their next reload.

## Deployment

Deployed on Vercel as a static site — no build step. `vercel.json` sets
`config.js` to no-cache and forbids framing the pages (a warning page must not
be embeddable in someone else's site).

## Where these files come from

They are generated from the main RRI warning-system codebase by its
`scripts/stage_vercel.py --out <this repo>`. Edit them there, not here, or
the next update will overwrite the change.
