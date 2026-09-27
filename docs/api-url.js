/*
 * Where each request goes: the live API, or a file in an exported snapshot.
 *
 * Both pages build every data URL through RRI.url(path), with `path` exactly as
 * the API would be called ('/warnings/stations?issue_time=...'). Live, that is
 * the API origin from config.js plus the path. In a snapshot -- the static copy
 * published to GitHub Pages -- it is a file under data/, named by the rule
 * below. scripts/export_static.py writes the files with the SAME rule
 * (snapshot_file), and tests/test_snapshot_paths.py checks the two agree.
 *
 * The rule: strip the leading '/', keep any extension (.png, .geojson, .csv),
 * add '.json' otherwise; if there is a query, sort its parameters and append
 * them as '__key-value~key-value' before the extension, with every character
 * outside [A-Za-z0-9._-] in a value replaced by '_'. So
 *   /map/2026092708/rain/accum/5.png?window=24&theme=dark
 *     -> data/map/2026092708/rain/accum/5__theme-dark~window-24.png
 */
'use strict';

(function () {
  const cfg = window.RRI_CONFIG || {};
  const snapshot = cfg.mode === 'snapshot';
  const base = (cfg.apiBase || '').replace(/\/+$/, '');
  const root = (cfg.snapshotBase || 'data').replace(/\/+$/, '');
  const clean = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

  function snapshotFile(path) {
    const [p, q = ''] = path.split('?');
    const params = new URLSearchParams(q);
    const keys = [...new Set(params.keys())].sort();
    const suffix = keys.map((k) => `${clean(k)}-${clean(params.get(k))}`).join('~');
    let file = p.replace(/^\/+/, '');
    let ext = '.json';
    const m = /\.(png|geojson|json|csv)$/.exec(file);
    if (m) {
      ext = m[0];
      file = file.slice(0, -ext.length);
    } else if (file.endsWith('/csv')) {
      ext = '.csv';
    }
    return `${root}/${file}${suffix ? `__${suffix}` : ''}${ext}`;
  }

  window.RRI = {
    snapshot,
    // null apiBase outside a snapshot = interface only, no backend wired up.
    configured: snapshot || cfg.apiBase !== null,
    url: (path) => (snapshot ? snapshotFile(path) : base + path),
    snapshotFile,
  };
}());
