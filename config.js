/*
 * Vercel deployment: the dashboard's static files, hosted apart from the API.
 *
 * apiBase: null  -> no backend connected; both pages say so and show no data.
 * apiBase: 'https://rri-api.example.org'  -> the public HTTPS origin of the
 *   RRI FastAPI service (docker compose `api`). Must be https: the page is
 *   served over https and browsers block plain-http calls from it.
 *
 * After changing this, re-run `python scripts/stage_vercel.py` and redeploy
 * (see deploy/vercel/README.md). config.js is served uncached, so the change
 * takes effect on the next page load.
 */
window.RRI_CONFIG = Object.assign({ apiBase: null }, window.RRI_CONFIG || {});
