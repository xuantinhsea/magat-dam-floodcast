/*
 * Static snapshot (GitHub Pages): no API behind the page. Every request is a
 * file under data/, written by scripts/export_static.py and named by the rule
 * in api-url.js. The page states on every view that it is an archived copy.
 */
window.RRI_CONFIG = Object.assign({ mode: 'snapshot', snapshotBase: 'data' }, window.RRI_CONFIG || {});
