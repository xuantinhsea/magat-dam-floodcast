/*
 * RRI flood warning dashboard — operator view.
 *
 * Talks to one API: same origin by default, or the origin set in config.js
 * when these files are hosted apart from it. No keys are handled here. State
 * lives in one object rather than spread across the DOM: the map,
 * slider, matrix, cards and charts all have to agree on which cycle, which
 * station and which hour is being shown, and drift between them on a warning
 * screen is worse than a visible error.
 *
 * Reading order the page is built around -- the questions a duty forecaster
 * asks, in the order they ask them:
 *   1. How bad, where, how soon?        situation strip, cards, outlook matrix
 *   2. Is it getting worse run to run?  trend, forecast evolution
 *   3. Why does the model say so?       hydrograph against catchment rainfall
 *   4. How far can I trust it?          provisional levels, cold start, skill
 */
'use strict';

const LEVELS = ['none', 'watch', 'warning', 'emergency'];
const LEVEL_NAME = { none: 'Normal', watch: 'Watch', warning: 'Warning', emergency: 'Emergency' };
// Levels carry a number as well as a colour everywhere they are drawn small
// (map markers, matrix cells), so they survive colour-blindness and greyscale.
const LEVEL_NUM = { none: '', watch: '1', warning: '2', emergency: '3' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const REFRESH_MS = 5 * 60e3;   // poll for a new cycle
const HISTORY_CYCLES = 8;      // forecast-evolution window
const PREV_OVERLAY = 3;        // previous cycles drawn on the hydrograph
const OBS_LOOKBACK_H = 72;     // observed history shown before issue time
const H = 3600e3;

/* Each map layer knows how to fetch its own frames, bounds and legend, so
 * adding a layer is a table entry rather than a new branch in every function. */
const LAYERS = {
  depth: {
    label: 'Depth',
    animated: true,
    meta: (cycle) => getJSON(`/map/${cycle}/meta?theme=${theme()}`),
    url: (cycle, frame, meta) =>
      `/map/${cycle}/depth/${meta.frames[frame].lead_hours}.png?theme=${theme()}`,
  },
  peak: {
    label: 'Peak depth',
    animated: false,
    meta: (cycle) => getJSON(`/map/${cycle}/meta?theme=${theme()}`),
    url: (cycle) => `/map/${cycle}/peak.png?theme=${theme()}`,
  },
  rain: {
    label: 'Rainfall',
    animated: true,
    // Draw the rain grid as discrete cells rather than letting the browser
    // interpolate. The forcing grid is coarse (32x39 here) and each cell is one
    // number the model was actually driven with; a smooth gradient invents
    // detail between cells that no data supports, and it hides the fact that
    // the rainfall grid is much coarser than the depth grid underneath it.
    pixelated: true,
    meta: async (cycle) => {
      const m = await getJSON(`/map/${cycle}/rain/meta?theme=${theme()}`);
      // Normalise to the same shape the depth layer returns.
      return {
        bounds: m.bounds,
        legend: m.legend,
        frames: Array.from({ length: m.n_frames }, (_, i) => ({ lead_hours: i })),
      };
    },
    url: (cycle, frame) =>
      `/map/${cycle}/rain/${String(frame).padStart(3, '0')}.png?theme=${theme()}`,
  },
  accum: {
    label: 'Rain total',
    animated: true,
    // Same grid as the hourly rate, so the same cell-by-cell drawing -- but a
    // different quantity (a total, mm) on its own scale.
    pixelated: true,
    meta: async (cycle) => {
      const m = await getJSON(
        `/map/${cycle}/rain/accum/meta?window=${state.accumWindow}&theme=${theme()}`);
      return {
        bounds: m.bounds,
        legend: m.legend,
        // Frame k is the total up to the END of rain step k.
        frames: Array.from({ length: m.n_frames }, (_, i) => ({ lead_hours: (i + 1) * m.step_hours })),
        max_total_mm: m.max_total_mm,
      };
    },
    url: (cycle, frame) =>
      `/map/${cycle}/rain/accum/${frame}.png?window=${state.accumWindow}&theme=${theme()}`,
    note: () => (state.accumWindow ? `${state.accumWindow}-h total to this hour` : 'total since issue'),
  },
};

const state = {
  basin: null,
  stationMeta: {},
  cycles: [],            // [{id, ms}] newest first
  cycleId: null,
  issueMs: null,
  followLatest: true,    // auto-load new cycles while looking at the newest
  layer: 'depth',
  accumWindow: 0,        // hours; 0 = accumulate from issue time
  meta: null,
  frame: 0,
  playing: false,
  timer: null,
  waitSince: 0,
  speed: 220,
  stationId: null,
  stationToken: 0,
  warnings: null,        // /warnings/stations for this cycle
  overview: null,        // {times: [ms], series: {sid: [q]}}
  history: null,         // /warnings/history up to this cycle
  runInfo: null,         // /forecast/cycles/{id}/info
  seriesCache: new Map(),
  rainCache: new Map(),
  frameCache: new Map(),
  matrixBlocks: [],
  blockHours: 6,         // outlook block width, fitted to the panel it sits in
  band: null,            // selected station's {sid, rain: [{t, v}], stage: {times, values}}
  rainLegend: null,      // the map's rainfall classes, reused to colour the band
  tz: 'utc',
  opacity: 0.8,
  charts: { q: null, h: null, evo: null },
  map: null, overlay: null, markers: null, labels: null, landmarks: null,
  markerById: {}, outline: null, rivers: null, layerControl: null,
};

/* ------------------------------------------------------------------ util -- */

/* Every request is built by RRI.url (api-url.js): the live API, or a file in an
 * exported snapshot. RRI.configured is false only for a static deployment with
 * no backend and no snapshot. */

async function getJSON(url) {
  const res = await fetch(RRI.url(url));
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showError(message) {
  const el = $('error-banner');
  el.textContent = message;
  el.hidden = false;
}

/** Viewer preferences only (time zone, basemap, opacity). Never warning state. */
const pref = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`rri.${key}`); return v === null ? fallback : v; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`rri.${key}`, String(value)); } catch { /* private mode */ }
  },
};

/** Cycle ids are YYYYMMDDHH in UTC. */
function cycleToMs(cycleId) {
  return Date.UTC(+cycleId.slice(0, 4), +cycleId.slice(4, 6) - 1,
    +cycleId.slice(6, 8), +cycleId.slice(8, 10));
}
const msToCycle = (ms) => new Date(ms).toISOString().slice(0, 13).replace(/[-T:]/g, '');

function fmtNumber(v, digits = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toLocaleString('en', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** The mode the map is actually being viewed in — the server renders a
 *  different, separately-validated ramp for each. */
const theme = () =>
  (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'dark' : 'light';

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ------------------------------------------------------------ time zone -- */

/* Everything is stored and fetched in UTC. What changes is only how a time is
 * PRINTED: in the basin's display zone (PHT for Magat) or in UTC, which is what
 * PAGASA/WMO products and the pipeline logs use. One switch drives every time
 * on the page, so the map, charts and cards can never disagree about it. */

const tzId = () => (state.tz === 'local' && state.basin?.display_timezone
  ? state.basin.display_timezone : 'UTC');
const tzLabel = () => (tzId() === 'UTC'
  ? 'UTC' : (state.basin.display_timezone_label || state.basin.display_timezone));

const _formatters = new Map();
function parts(ms) {
  const zone = tzId();
  let f = _formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    _formatters.set(zone, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, wd: o.weekday };
}

/** Offset of the display zone from UTC at an instant, in ms. */
function tzOffset(ms) {
  const p = parts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / 60e3) * 60e3;
}

/** First instant >= ms that falls on a multiple of `hours` in the display zone. */
function nextBoundary(ms, hours) {
  const off = tzOffset(ms);
  const step = hours * H;
  return Math.ceil((ms + off) / step) * step - off;
}

const pad = (n) => String(n).padStart(2, '0');

function fmtTime(ms, { weekday = true, zone = false, date = true } = {}) {
  const p = parts(ms);
  const d = date ? `${weekday ? `${p.wd} ` : ''}${p.d} ${MONTHS[p.mo - 1]} ` : '';
  return `${d}${pad(p.h)}:${pad(p.mi)}${zone ? ` ${tzLabel()}` : ''}`;
}

function fmtDay(ms) {
  const p = parts(ms);
  return `${p.wd} ${p.d} ${MONTHS[p.mo - 1]}`;
}

/** "Mon 21:00" -- unambiguous within a 7-day forecast, and short enough for a card. */
function fmtShort(ms) {
  const p = parts(ms);
  return `${p.wd} ${pad(p.h)}:${pad(p.mi)}`;
}

/** "in 30 h" — lead time before magnitude, the way warnings are acted on. */
function fmtLead(hours) {
  if (hours === null || hours === undefined) return '';
  if (hours < 0.5) return 'now';
  if (hours < 48) return `in ${Math.round(hours)} h`;
  return `in ${(hours / 24).toFixed(1)} days`;
}

function fmtAge(ms) {
  const h = (Date.now() - ms) / H;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h ago`;
  return `${(h / 24).toFixed(1)} days ago`;
}

/* ---------------------------------------------------------------- levels -- */

const lvIdx = (lv) => Math.max(0, LEVELS.indexOf(lv));
const worstOf = (levels) => levels.reduce((a, b) => (lvIdx(b) > lvIdx(a) ? b : a), 'none');
const thFor = (sid) => state.stationMeta[sid]?.thresholds || null;
const shortId = (sid) => sid.replace(new RegExp(`^${state.basin.name}-`, 'i'), '');
const stationName = (sid) => state.stationMeta[sid]?.name || sid;
const warnFor = (sid) => state.warnings?.stations.find((s) => s.station_id === sid) || null;

/** Same rule as the server's classify_deterministic: each level is >= its threshold. */
function levelFor(q, th) {
  if (!th || q === null || q === undefined) return 'none';
  if (q >= th.emergency) return 'emergency';
  if (q >= th.warning) return 'warning';
  if (q >= th.watch) return 'watch';
  return 'none';
}

function thresholdLines(th) {
  if (!th) return [];
  return ['watch', 'warning', 'emergency'].map((k) => ({
    key: k, value: th[k], color: cssVar(`--${k}`),
    label: `${LEVEL_NAME[k]} Q${th.levels[k]}`,
  }));
}

/**
 * Vertical extent for a discharge axis.
 *
 * Show the next threshold above the forecast peak, so "how far is it from the
 * next level" is readable at a glance -- unless the peak is tiny next to it,
 * in which case scaling to the threshold would flatten the hydrograph into the
 * x-axis. Then scale to the data and say the threshold is off the chart.
 */
function dischargeScale(dataMax, th) {
  const lines = thresholdLines(th);
  const next = lines.find((l) => l.value > dataMax);
  let top = dataMax;
  if (next && dataMax >= 0.45 * next.value) top = next.value;
  const max = niceCeil(Math.max(top, 1) * 1.08);
  return { max, offscale: lines.filter((l) => l.value > max) };
}

function niceCeil(v) {
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3
    : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10;
  return step * mag;
}

/* ------------------------------------------------------- deep linking -- */

/* The URL is the shareable unit: "look at the rainfall layer at +18 h for this
 * cycle" is a thing one operator sends another, and it should survive a paste
 * into chat. State lives in the hash so no round-trip is needed. */

function readHash() {
  const out = {};
  for (const [k, v] of new URLSearchParams(location.hash.slice(1))) out[k] = v;
  return out;
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.cycleId) p.set('cycle', state.cycleId);
  if (state.layer !== 'depth') p.set('layer', state.layer);
  if (state.layer === 'accum' && state.accumWindow) p.set('win', String(state.accumWindow));
  if (state.frame) p.set('t', String(state.frame));
  if (state.stationId) p.set('station', state.stationId);
  const next = `#${p}`;
  if (next !== location.hash) history.replaceState(null, '', next);
}

/* ------------------------------------------------------------------ boot -- */

async function boot() {
  if (!RRI.configured) {
    // Say exactly what is missing rather than failing on the first fetch: an
    // empty dashboard must never be mistaken for a quiet forecast.
    showError('This dashboard is not connected to a forecast API, so it shows no data. '
      + 'It is the interface only; the RRI backend has to be reachable at a public HTTPS '
      + 'address, set as apiBase in config.js.');
    $('status-pill').textContent = 'no API';
    $('basin-sub').textContent = 'not connected to a forecast service';
    $('station-cards').innerHTML = '<p class="empty">No forecast service connected.</p>';
    $('sit-level').textContent = 'Unavailable';
    $('sit-level-sub').textContent = 'no forecast service connected';
    return;
  }
  try {
    state.basin = await getJSON('/stations');
  } catch (err) {
    showError(`Cannot reach the API: ${err.message}. No forecast is shown — do not read this screen as an all-clear.`);
    $('status-pill').textContent = 'API unreachable';
    $('sit-level').textContent = 'Unavailable';
    return;
  }
  if (RRI.snapshot) state.manifest = await getJSON('/manifest').catch(() => null);
  state.stationMeta = Object.fromEntries(state.basin.stations.map((s) => [s.id, s]));
  state.tz = state.basin.display_timezone ? pref.get('tz', 'local') : 'utc';
  state.opacity = clamp(+pref.get('opacity', '0.8') || 0.8, 0.2, 1);

  renderBasinHeader();
  initTimeZone();
  initRails();
  initMap();
  initTimeline();
  initBand();
  initStationControls();
  initKeyboard();
  initToast();

  await refreshCycleList();
  if (!state.cycles.length) {
    $('status-pill').textContent = 'no forecast';
    $('station-cards').innerHTML =
      '<p class="empty">No forecast cycle has been post-processed yet.<br>Run a cycle, then reload.</p>';
    return;
  }

  const want = readHash();
  if (['0', '24', '72'].includes(want.win)) state.accumWindow = +want.win;
  $('accum-window').value = String(state.accumWindow);
  if (want.layer && LAYERS[want.layer]) setLayerButtons(want.layer);
  if (want.station && state.stationMeta[want.station]) state.stationId = want.station;
  $('station-select').value = state.stationId;

  const cycle = state.cycles.some((c) => c.id === want.cycle) ? want.cycle : state.cycles[0].id;
  await loadCycle(cycle, want.t ? Number(want.t) : 0);

  setInterval(renderClock, 60e3);
  // A snapshot never changes, so there is nothing to poll for.
  if (!RRI.snapshot) {
    setInterval(checkForNewCycle, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForNewCycle(); });
  }
}

function renderBasinHeader() {
  const b = state.basin;
  // A snapshot has no API behind it to document.
  if (RRI.snapshot) $('api-docs').hidden = true; else $('api-docs').href = RRI.url('/docs');
  $('basin-name').textContent = `${b.name.charAt(0).toUpperCase() + b.name.slice(1)} basin`;
  $('basin-sub').textContent = b.description || `${b.country} · RRI ${b.model_version}`;
  $('foot-model').textContent =
    `RRI ${b.model_version} · ${b.grid.ncols}×${b.grid.nrows} @ ${(b.grid.cellsize * 111).toFixed(2)} km`
    + ` · cycles ${b.cycles_utc.map((h) => `${pad(h)}Z`).join('/')}`;

  if (b.thresholds_provisional) {
    $('provisional-banner').hidden = false;
    $('provisional-basis').textContent = b.thresholds_basis ||
      'Warning thresholds are not validated against an adequate observed record.';
  }

  const ss = $('station-select');
  ss.innerHTML = '';
  for (const s of b.stations) ss.add(new Option(`${shortId(s.id)} — ${s.name || s.id}`, s.id));
  state.stationId = b.stations.length ? b.stations[0].id : null;
}

function initTimeZone() {
  if (!state.basin.display_timezone) return;
  $('tz-seg').hidden = false;
  $('tz-local').textContent = state.basin.display_timezone_label || state.basin.display_timezone;
  const apply = (tz) => {
    state.tz = tz;
    pref.set('tz', tz);
    $('tz-local').classList.toggle('is-active', tz === 'local');
    $('tz-utc').classList.toggle('is-active', tz === 'utc');
    $('foot-tz').textContent = tzLabel();
    if (state.cycleId) rerenderTimes();
  };
  $('tz-local').onclick = () => apply('local');
  $('tz-utc').onclick = () => apply('utc');
  apply(state.tz);
}

/** Everything that prints a time, re-printed after a time-zone switch. */
function rerenderTimes() {
  renderCycleOptions();
  renderSituation();
  renderCards();
  renderMatrix();
  setFrame(state.frame, { quiet: true });
  refreshStation();
}

/* --------------------------------------------------------------- cycles -- */

async function refreshCycleList() {
  try {
    const rows = await getJSON('/forecast/cycles?limit=40');
    state.cycles = rows.map((c) => {
      const ms = Date.parse(c.issue_time);
      return { id: msToCycle(ms), ms };
    });
  } catch {
    state.cycles = [];
  }
  renderCycleOptions();
}

function renderCycleOptions() {
  const select = $('cycle-select');
  const keep = state.cycleId;
  select.innerHTML = '';
  state.cycles.forEach((c, i) => {
    select.add(new Option(`${fmtTime(c.ms, { zone: true })}${i === 0 ? ' (latest)' : ''}`, c.id));
  });
  if (keep) select.value = keep;
  select.onchange = () => loadCycle(select.value);
}

async function loadCycle(cycleId, startFrame = 0) {
  stopPlay();
  state.cycleId = cycleId;
  state.issueMs = cycleToMs(cycleId);
  state.frame = startFrame;
  state.followLatest = cycleId === state.cycles[0]?.id;
  $('cycle-select').value = cycleId;
  $('error-banner').hidden = true;

  const issueIso = new Date(state.issueMs).toISOString();
  const [warnings, overview, hist, info, rainMeta] = await Promise.all([
    getJSON(`/warnings/stations?issue_time=${enc(issueIso)}`).catch(() => null),
    getJSON(`/forecast/cycles/${cycleId}/series`).catch(() => null),
    getJSON(`/warnings/history?until=${enc(issueIso)}&limit=${HISTORY_CYCLES}`).catch(() => null),
    getJSON(`/forecast/cycles/${cycleId}/info`).catch(() => null),
    // The band colours rain with the map's own classes, fetched rather than
    // restated so the two can never disagree about what a colour means.
    state.rainLegend ? null : getJSON(`/map/${cycleId}/rain/meta`).catch(() => null),
  ]);
  if (state.cycleId !== cycleId) return;  // superseded by a newer selection
  if (rainMeta?.legend) state.rainLegend = rainMeta.legend;

  state.warnings = warnings;
  state.overview = overview && {
    times: overview.times.map((t) => Date.parse(t)),
    series: overview.stations,
  };
  state.history = hist;
  state.runInfo = info;

  renderClock();
  renderSituation();
  renderCards();
  buildMarkers();
  renderMatrix();
  await loadLayerMeta();
  await refreshStation();
  writeHash();
}

/** The value of a series at an instant: the last output at or before it. */
function valueAt(times, values, ms) {
  if (!times?.length || ms < times[0]) return null;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= ms) lo = mid; else hi = mid - 1;
  }
  return values[lo] ?? null;
}

/** Discharge at a station at an instant. */
function qAt(sid, ms) {
  const ov = state.overview;
  return ov?.series[sid] ? valueAt(ov.times, ov.series[sid], ms) : null;
}

/* ------------------------------------------------ freshness & new cycles -- */

/* Stale reassurance is the specific danger of an unattended warning screen: a
 * pipeline that stopped two days ago still shows its last "Normal". So the page
 * checks for new cycles on its own, and says loudly when none has arrived on
 * schedule. */

function cycleIntervalHours() {
  const n = state.basin.cycles_utc?.length || 4;
  return 24 / n;
}

function nextScheduledIssue(afterMs) {
  const hours = [...(state.basin.cycles_utc || [0, 6, 12, 18])].sort((a, b) => a - b);
  const d = new Date(afterMs);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  for (let k = 0; k < 3; k++) {
    for (const h of hours) {
      const t = day + k * 24 * H + h * H;
      if (t > afterMs) return t;
    }
  }
  return afterMs + cycleIntervalHours() * H;
}

function renderClock() {
  if (!state.cycles.length || !state.cycleId) return;
  const latest = state.cycles[0];
  const ageH = (Date.now() - latest.ms) / H;
  const limit = 2 * cycleIntervalHours();

  const stale = $('stale-banner');
  if (RRI.snapshot) {
    // A snapshot is old by design; say what it is instead of blaming a pipeline.
    stale.hidden = true;
    renderSnapshotNotice();
  } else if (ageH > limit) {
    stale.hidden = false;
    stale.textContent =
      `The newest forecast was issued ${fmtAge(latest.ms)} (${fmtTime(latest.ms, { zone: true })}). `
      + `Cycles are scheduled every ${cycleIntervalHours()} h, so at least one run has been missed. `
      + 'Check the pipeline before relying on this forecast.';
  } else {
    stale.hidden = true;
  }

  const old = $('old-cycle-banner');
  const idx = state.cycles.findIndex((c) => c.id === state.cycleId);
  if (idx > 0) {
    old.hidden = false;
    $('old-cycle-text').textContent =
      `Viewing an older cycle, issued ${fmtTime(state.issueMs, { zone: true })} — `
      + `${idx} cycle${idx > 1 ? 's' : ''} behind the latest. Warnings shown are what was forecast then.`;
  } else {
    old.hidden = true;
  }

  $('cycle-age').textContent = fmtAge(state.issueMs);
  $('cycle-age').classList.toggle('is-stale', !RRI.snapshot && idx === 0 && ageH > limit);
  renderRunSummary();
}

/**
 * An exported snapshot says so on every view: it is a frozen copy, and a
 * forecast read from it is the forecast of the day it was exported, however
 * current the page may look.
 */
function renderSnapshotNotice() {
  const el = $('snapshot-banner');
  const m = state.manifest;
  el.hidden = false;
  const exported = m?.exported_at ? fmtTime(Date.parse(m.exported_at), { zone: true }) : 'an earlier date';
  const n = m?.cycles?.length || state.cycles.length;
  el.innerHTML = `<strong>Archived snapshot.</strong> ${esc(m?.notice
    || 'This page is a frozen copy of the operational dashboard and does not update.')}`
    + ` Exported ${esc(exported)}, covering ${n} forecast cycle${n === 1 ? '' : 's'}.`;
}

async function checkForNewCycle() {
  let newest;
  try {
    newest = (await getJSON('/forecast/cycles?limit=1'))[0];
  } catch {
    return;  // the next poll retries; a transient failure is not news
  }
  if (!newest) return;
  const id = msToCycle(Date.parse(newest.issue_time));
  if (id === state.cycles[0]?.id) { renderClock(); return; }

  await refreshCycleList();
  const label = fmtTime(cycleToMs(id), { zone: true });
  if (state.followLatest) {
    const before = worstOf((state.warnings?.stations || []).map((s) => s.alert_level));
    await loadCycle(id, 0);
    const after = worstOf((state.warnings?.stations || []).map((s) => s.alert_level));
    const change = after !== before ? ` Basin status ${LEVEL_NAME[before]} → ${LEVEL_NAME[after]}.` : '';
    showToast(`New forecast loaded — issued ${label}.${change}`);
  } else {
    showToast(`A newer forecast is available (issued ${label}).`, {
      action: { label: 'Load it', fn: () => loadCycle(id, 0) },
    });
  }
}

function initToast() {
  $('toast-close').onclick = hideToast;
  $('goto-latest').onclick = () => state.cycles.length && loadCycle(state.cycles[0].id, 0);
}

function showToast(text, { action = null, timeout = 12000 } = {}) {
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { hideToast(); action.fn(); };
  }
  $('toast').hidden = false;
  clearTimeout(state.toastTimer);
  if (timeout) state.toastTimer = setTimeout(hideToast, timeout);
}

function hideToast() { $('toast').hidden = true; }

/* ------------------------------------------------------------ situation -- */

function renderSituation() {
  const stations = state.warnings?.stations || [];
  const counts = { none: 0, watch: 0, warning: 0, emergency: 0 };
  for (const s of stations) counts[s.alert_level] = (counts[s.alert_level] || 0) + 1;
  const worst = worstOf(stations.map((s) => s.alert_level));

  // -- status. No record is not "Normal": it stays neutral grey, never green.
  const known = stations.length > 0;
  $('sit-status').className = `sit-item sit-status${known ? ` lv-${worst}` : ''}`;
  $('sit-level').textContent = known ? LEVEL_NAME[worst] : 'No warning record';
  $('sit-level-sub').textContent = [...LEVELS].reverse().filter((l) => counts[l])
    .map((l) => `${counts[l]} ${LEVEL_NAME[l]}`).join(' · ');
  const pill = $('status-pill');
  pill.textContent = known ? LEVEL_NAME[worst] : 'no record';
  pill.className = known ? `pill pill-${worst}` : 'pill';
  document.title = `${worst === 'none' ? '' : `${LEVEL_NAME[worst].toUpperCase()} · `}`
    + `${state.basin.name.charAt(0).toUpperCase() + state.basin.name.slice(1)} — RRI Flood Warning`;

  // -- first crossing of any level, read off the series rather than the peak
  let first = null;
  const ov = state.overview;
  if (ov) {
    for (const [sid, q] of Object.entries(ov.series)) {
      const th = thFor(sid);
      if (!th) continue;
      const i = q.findIndex((v) => v !== null && v >= th.watch);
      if (i >= 0 && (!first || ov.times[i] < first.ms)) first = { sid, ms: ov.times[i], i };
    }
  }
  if (first) {
    const already = first.i === 0;
    $('sit-first').textContent = `${shortId(first.sid)} reaches Watch`;
    $('sit-first-sub').textContent = already
      ? 'already above Watch at the first output hour'
      : `${fmtLead((first.ms - state.issueMs) / H)} · ${fmtTime(first.ms, { zone: true })}`;
  } else {
    $('sit-first').textContent = ov ? 'None forecast' : '—';
    $('sit-first-sub').textContent = ov ? `all stations stay below Watch for ${ov.times.length} h` : '';
  }

  // -- rarest peak. Lead with a return period read off a real frequency curve;
  // a "rough" one (the alert levels read as 5/25/100-yr) assumes what it
  // reports and must not become the headline just because it is larger.
  const withRp = stations.filter((s) => s.return_period);
  const hasCurve = (s) => !!thFor(s.station_id)?.curve?.length;
  const rarest = (rows) => rows.reduce((a, b) => (b.return_period > a.return_period ? b : a));
  if (withRp.length) {
    const real = withRp.filter(hasCurve);
    const rough = withRp.filter((s) => !hasCurve(s));
    const top = real.length ? rarest(real) : rarest(rough);
    $('sit-rp').textContent = `~${fmtNumber(top.return_period)}-yr flood`;
    let sub = `${shortId(top.station_id)} · ${fmtNumber(top.peak_value)} m³/s`
      + (hasCurve(top) ? ' · frequency curve' : ' · rough (no frequency curve)');
    if (real.length && rough.length) {
      const r = rarest(rough);
      if (r.return_period > top.return_period) {
        sub += ` · rough est. ~${fmtNumber(r.return_period)}-yr at ${shortId(r.station_id)}`;
      }
    }
    $('sit-rp-sub').textContent = sub;
  } else {
    $('sit-rp').textContent = stations.length ? 'Below the lowest return period' : '—';
    $('sit-rp-sub').textContent = stations.length ? 'on every station\'s frequency curve' : '';
  }

  renderTrendSummary();
  renderRunSummary();
  // Tiles clamp their detail line to fit one window; the full text is a hover away.
  for (const el of document.querySelectorAll('.sit-s, .sit-v')) el.title = el.textContent;
}

/** Run-to-run change: one run jumping is noise, several climbing is a signal. */
function renderTrendSummary() {
  const hist = state.history?.stations || {};
  let up = 0;
  let down = 0;
  let steady = 0;
  let raised = 0;
  let lowered = 0;
  let biggest = null;
  for (const [sid, pts] of Object.entries(hist)) {
    const cur = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    if (!cur || !prev || Date.parse(cur.issue_time) !== state.issueMs) continue;
    if (!prev.peak_value || cur.peak_value === null) continue;
    const change = (cur.peak_value - prev.peak_value) / prev.peak_value;
    if (change > 0.02) up++; else if (change < -0.02) down++; else steady++;
    if (lvIdx(cur.alert_level) > lvIdx(prev.alert_level)) raised++;
    if (lvIdx(cur.alert_level) < lvIdx(prev.alert_level)) lowered++;
    if (!biggest || Math.abs(change) > Math.abs(biggest.change)) biggest = { sid, change };
  }
  const n = up + down + steady;
  const el = $('sit-trend');
  if (!n) {
    el.textContent = 'No previous cycle';
    el.className = 'sit-v';
    $('sit-trend-sub').textContent = 'nothing to compare against';
    return;
  }
  const dir = up > down + steady ? 'Rising' : down > up + steady ? 'Falling' : up > down ? 'Mostly rising'
    : down > up ? 'Mostly falling' : 'Steady';
  el.textContent = dir;
  el.className = `sit-v trend-${up > down ? 'up' : down > up ? 'down' : 'flat'}`;
  const bits = [`peaks up at ${up} of ${n}`];
  if (biggest && Math.abs(biggest.change) > 0.02) {
    bits.push(`largest ${biggest.change > 0 ? '+' : ''}${Math.round(biggest.change * 100)}% at ${shortId(biggest.sid)}`);
  }
  if (raised) bits.push(`${raised} raised a level`);
  if (lowered) bits.push(`${lowered} lowered`);
  $('sit-trend-sub').textContent = bits.join(' · ');
}

function renderRunSummary() {
  if (!state.cycleId) return;
  $('sit-run').textContent = `Issued ${fmtTime(state.issueMs, { zone: true })}`;
  const init = state.runInfo?.initial_state;
  let initText;
  if (init === 'warm') initText = 'warm start';
  else if (init === 'cold') initText = 'COLD START — early hours under-predict';
  else if (init === 'partial') initText = 'partial warm start';
  else initText = state.basin.observed_enabled ? 'initial state not recorded' : 'likely cold start (no observed rain)';
  const isLatest = state.cycles[0]?.id === state.cycleId;
  const next = isLatest && !RRI.snapshot
    ? ` · next ${fmtTime(nextScheduledIssue(state.issueMs), { date: false })}` : '';
  $('sit-run-sub').textContent = `${fmtAge(state.issueMs)} · ${initText}${next}`;
  $('sit-run-sub').classList.toggle('is-caution', init === 'cold' || (!init && !state.basin.observed_enabled));
}

/* ----------------------------------------------------------------- cards -- */

function sortedWarnings() {
  const rows = [...(state.warnings?.stations || [])];
  const ratio = (s) => (s.peak_value || 0) / (thFor(s.station_id)?.watch || Infinity);
  // Most urgent first: highest level, then soonest crossing, then closest to Watch.
  return rows.sort((a, b) => (lvIdx(b.alert_level) - lvIdx(a.alert_level))
    || ((a.hours_to_threshold ?? Infinity) - (b.hours_to_threshold ?? Infinity))
    || (ratio(b) - ratio(a)));
}

function previousPoint(sid) {
  const pts = state.history?.stations?.[sid] || [];
  const cur = pts[pts.length - 1];
  if (!cur || Date.parse(cur.issue_time) !== state.issueMs) return null;
  return pts[pts.length - 2] || null;
}

function trendBadge(sid, peak) {
  const prev = previousPoint(sid);
  if (!prev || !prev.peak_value || peak === null) return '';
  const change = (peak - prev.peak_value) / prev.peak_value;
  const pct = Math.round(change * 100);
  const cls = change > 0.02 ? 'up' : change < -0.02 ? 'down' : 'flat';
  const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '■';
  return `<span class="trend trend-${cls}" title="Change in forecast peak since the previous cycle">`
    + `${arrow} ${pct > 0 ? '+' : ''}${pct}%</span>`;
}

function renderCards() {
  const el = $('station-cards');
  if (!state.warnings) {
    el.innerHTML = '<p class="empty">No warning record for this cycle.</p>';
    return;
  }
  el.innerHTML = sortedWarnings().map((s) => {
    const sid = s.station_id;
    const th = thFor(sid);
    const peakMs = s.peak_time ? Date.parse(s.peak_time) : null;
    // Lead time before magnitude: how long until this station's level, or --
    // when it stays Normal -- how close its peak comes to Watch.
    const lead = s.alert_level === 'none'
      ? (th ? `${Math.round((s.peak_value / th.watch) * 100)}% of Watch` : 'Normal')
      : `${LEVEL_NAME[s.alert_level]} ${s.hours_to_threshold === null ? '' : s.hours_to_threshold < 0.5
        ? 'now' : `in ${fmtNumber(s.hours_to_threshold)} h`}`;
    const rough = th && !th.curve.length;
    const rp = s.return_period ? ` · ~${fmtNumber(s.return_period)} yr${rough ? '*' : ''}` : '';
    const peakWhen = peakMs ? `· ${fmtShort(peakMs)}` : '';
    const peakTitle = peakMs
      ? `Forecast peak ${fmtTime(peakMs, { zone: true })}, ${fmtLead((peakMs - state.issueMs) / H)}` : '';
    return `
      <article class="card lv-${s.alert_level}${sid === state.stationId ? ' is-selected' : ''}"
               data-station="${esc(sid)}" tabindex="0" role="button"
               aria-label="${esc(stationName(sid))}: ${LEVEL_NAME[s.alert_level]}">
        <div class="card-top">
          <span class="card-name" title="${esc(stationName(sid))}"><span class="card-id">${esc(shortId(sid))}</span> ${esc(stationName(sid))}</span>
          <span class="pill pill-${s.alert_level}">${LEVEL_NAME[s.alert_level]}</span>
        </div>
        <div class="card-body">
          <div class="card-facts">
            <div title="${esc(peakTitle)}"><b>${fmtNumber(s.peak_value)}</b> m³/s ${trendBadge(sid, s.peak_value)} ${peakWhen}</div>
            <div>${lead}${rp}${s.thresholds_provisional
              ? ' <span class="card-flag" title="Provisional warning levels">prov.</span>' : ''}</div>
          </div>
          ${sparkline(sid)}
        </div>
      </article>`;
  }).join('') + (state.warnings.stations.some((s) => s.return_period && !thFor(s.station_id)?.curve.length)
    ? '<p class="muted small cards-note">* Rough: read off the alert levels, not a frequency analysis.</p>' : '');

  for (const card of el.querySelectorAll('.card[data-station]')) {
    const pick = () => selectStation(card.dataset.station, { scroll: true });
    card.onclick = pick;
    card.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } };
  }
}

/** A glanceable hydrograph: the shape of the forecast against its next level. */
function sparkline(sid) {
  const ov = state.overview;
  const q = ov?.series[sid];
  if (!q || q.length < 2) return '';
  const vals = q.filter((v) => v !== null);
  if (!vals.length) return '';
  const w = 96;
  const h = 32;
  const th = thFor(sid);
  const { max } = dischargeScale(Math.max(...vals), th);
  const x = (i) => (i / (q.length - 1)) * w;
  const y = (v) => h - (v / max) * (h - 2) - 1;
  let d = '';
  q.forEach((v, i) => { if (v !== null) d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
  const lines = thresholdLines(th).filter((l) => l.value <= max).map((l) =>
    `<line x1="0" x2="${w}" y1="${y(l.value).toFixed(1)}" y2="${y(l.value).toFixed(1)}" class="spark-th spark-${l.key}"/>`)
    .join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`
    + `${lines}<path d="${d}" class="spark-line"/></svg>`;
}

/* ------------------------------------------------------------------- map -- */

function initMap() {
  const [w, s, e, n] = state.basin.bounds;
  state.map = L.map('map', { zoomControl: true });

  // Terrain matters for flood reading -- valleys and floodplains are where the
  // water goes -- and imagery is how an operator recognises a place.
  const base = {
    Streets: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '&copy; OpenStreetMap',
    }),
    Terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
    }),
    Satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 18,
        attribution: 'Tiles &copy; Esri — Esri, Maxar, Earthstar Geographics, GIS User Community',
      }),
  };
  (base[pref.get('basemap', 'Streets')] || base.Streets).addTo(state.map);
  state.map.on('baselayerchange', (ev) => pref.set('basemap', ev.name));

  document.getElementById('map').classList.add('has-overlay');
  state.markers = L.layerGroup().addTo(state.map);
  state.labels = L.layerGroup().addTo(state.map);
  state.landmarks = L.layerGroup().addTo(state.map);
  addLandmarks(state.landmarks, state.basin.landmarks);

  state.layerControl = L.control.layers(base, {
    'Forecast stations': state.markers,
    'Station labels': state.labels,
    Landmarks: state.landmarks,
  }, { collapsed: true, position: 'topright' }).addTo(state.map);

  // Frame the basin in the part of the map the panels leave uncovered, not
  // under them. On a phone the panels are below the map, so no allowance.
  const frame = () => {
    state.map.invalidateSize();
    const desk = window.matchMedia('(min-width: 961px)').matches;
    const l = desk ? $('rail-left').offsetWidth + 24 : 12;
    const r = desk ? $('rail-right').offsetWidth + 24 : 12;
    state.map.fitBounds([[s, w], [n, e]], {
      paddingTopLeft: [l, desk ? 52 : 12], paddingBottomRight: [r, desk ? 44 : 12],
    });
  };
  state.frameMap = frame;
  frame();
  // Re-frame once layout has settled and on resize: fitBounds before the grid
  // has sized #map picks a zoom for the wrong container and shows half of Luzon.
  requestAnimationFrame(frame);
  window.addEventListener('resize', () => { frame(); renderMatrix(); });

  // Surveyed river network first, then the catchment boundary on top. Both are
  // context, not data -- they load independently and the map works without
  // either, so a missing shapefile degrades the view rather than breaking it.
  getJSON('/layers/rivers.geojson').then((gj) => {
    state.rivers = L.geoJSON(gj, {
      style: { color: cssVar('--river'), weight: 1.1, opacity: 0.75 },
      interactive: false,
    }).addTo(state.map);
    state.rivers.bringToBack();
    state.layerControl.addOverlay(state.rivers, 'River network');
  }).catch(() => {});

  getJSON('/layers/basin.geojson').then((gj) => {
    state.outline = L.geoJSON(gj, {
      style: {
        color: cssVar('--accent'), weight: 2, opacity: 0.95,
        fill: true, fillColor: cssVar('--accent'), fillOpacity: 0.04,
      },
      interactive: false,
    }).addTo(state.map);
    state.layerControl.addOverlay(state.outline, 'Basin boundary');
  }).catch(() => {
    // Fall back to the DEM-derived outline, which is always available because
    // it is computed from the model itself.
    getJSON('/map/basin/outline.geojson').then((gj) => {
      state.outline = L.geoJSON(gj, {
        style: { color: cssVar('--accent'), weight: 2, fill: false, dashArray: '4 3' },
        interactive: false,
      }).addTo(state.map);
      state.layerControl.addOverlay(state.outline, 'Model domain');
    }).catch(() => {});
  });

  for (const key of Object.keys(LAYERS)) $(`layer-${key}`).onclick = () => setLayer(key);
  $('accum-window').onchange = async (ev) => {
    state.accumWindow = +ev.target.value;
    stopPlay();
    await loadLayerMeta();
    writeHash();
  };

  const op = $('opacity');
  op.value = String(Math.round(state.opacity * 100));
  op.oninput = () => {
    state.opacity = +op.value / 100;
    pref.set('opacity', state.opacity);
    if (state.overlay) state.overlay.setOpacity(state.opacity);
  };

  // The popup button repeats the select action for keyboard and touch users,
  // and scrolls the chart into view on a phone where it is far below the map.
  state.map.on('popupopen', (ev) => {
    const btn = ev.popup.getElement().querySelector('.pop-btn');
    if (btn) btn.onclick = () => selectStation(btn.dataset.station, { scroll: true });
  });
}

/** Landmarks are orientation only: distinct shape, no level colour, no data. */
function addLandmarks(group, landmarks) {
  for (const m of landmarks || []) {
    L.marker([m.lat, m.lon], {
      icon: L.divIcon({
        className: 'landmark-pin',
        html: '<span class="landmark-dot" aria-hidden="true"></span>',
        iconSize: [16, 16], iconAnchor: [8, 8],
      }),
      keyboard: false,
    })
      .bindPopup(`<strong>${esc(m.name)}</strong><br><em>Not a forecast point.</em>`
        + (m.note ? `<br><span style="font-size:0.85em">${esc(m.note)}</span>` : ''))
      .addTo(group);
  }
}

function stationIcon(lv, selected) {
  return L.divIcon({
    className: 'stn-icon',
    html: `<span class="stn lv-${lv}${selected ? ' is-selected' : ''}">${LEVEL_NUM[lv]}</span>`,
    iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -9],
  });
}

function buildMarkers() {
  state.markers.clearLayers();
  state.labels.clearLayers();
  state.markerById = {};
  for (const s of state.basin.stations) {
    if (s.lat === null || s.lon === null) continue;
    const m = L.marker([s.lat, s.lon], {
      icon: stationIcon('none', false), title: s.name || s.id, riseOnHover: true,
    });
    // Clicking the marker selects the station outright rather than only
    // opening a popup: the question a marker raises is "what does it forecast",
    // and making that a second click loses the thread.
    m.on('click', () => selectStation(s.id, { scroll: false }));
    m.bindPopup(() => popupHtml(s.id), { minWidth: 250 });
    m.addTo(state.markers);
    state.markerById[s.id] = m;

    L.marker([s.lat, s.lon], {
      icon: L.divIcon({
        className: 'stn-label', html: `<span>${esc(shortId(s.id))}</span>`,
        iconSize: null, iconAnchor: [-11, 7],
      }),
      interactive: false, keyboard: false,
    }).addTo(state.labels);
  }
}

/**
 * Markers show the level AT THE MAP'S TIME while a time-stepped layer is on,
 * and the forecast-peak level on the peak map -- so every marker always
 * describes the same moment as the overlay under it.
 */
function updateMarkers() {
  const atTime = LAYERS[state.layer].animated && state.meta;
  const t = frameMs();
  for (const [sid, m] of Object.entries(state.markerById)) {
    const lv = atTime ? levelFor(qAt(sid, t), thFor(sid)) : (warnFor(sid)?.alert_level || 'none');
    const sel = sid === state.stationId;
    const key = `${lv}|${sel}`;
    if (m._lvKey !== key) {
      m.setIcon(stationIcon(lv, sel));
      m.setZIndexOffset(sel ? 1000 : lvIdx(lv) * 100);
      m._lvKey = key;
    }
  }
  const nums = ['watch', 'warning', 'emergency']
    .map((l) => `<span><b class="stn stn-sm lv-${l}">${LEVEL_NUM[l]}</b>${LEVEL_NAME[l]}</span>`).join('');
  $('legend-stations').innerHTML =
    `<span><b class="stn stn-sm lv-none"></b>Normal</span>${nums}`
    + `<span class="legend-note">Stations: ${atTime ? `level at ${esc(fmtTime(t, { zone: true }))}` : 'forecast peak level'}</span>`;
}

function popupHtml(sid) {
  const s = warnFor(sid);
  const th = thFor(sid);
  const t = frameMs();
  const animated = LAYERS[state.layer].animated;
  const qNow = animated ? qAt(sid, t) : null;
  const lvNow = levelFor(qNow, th);
  const lv = s?.alert_level || 'none';
  return `
    <div class="pop">
      <div class="pop-head">
        <strong>${esc(stationName(sid))}</strong>
        <span class="pill pill-${lv}">${LEVEL_NAME[lv]}</span>
      </div>
      ${animated && qNow !== null ? `<p class="pop-now">At ${esc(fmtTime(t, { zone: true }))}:
        <b>${fmtNumber(qNow)} m³/s</b> · ${LEVEL_NAME[lvNow]}</p>` : ''}
      <dl class="pop-grid">
        <div><dt>Forecast peak</dt><dd>${fmtNumber(s?.peak_value)} m³/s</dd></div>
        <div><dt>Peak at</dt><dd>${s?.peak_time ? esc(fmtTime(Date.parse(s.peak_time))) : '—'}</dd></div>
        <div><dt>Time to level</dt><dd>${s?.hours_to_threshold == null ? '—' : `${fmtNumber(s.hours_to_threshold)} h`}</dd></div>
        <div><dt>Return period</dt><dd>${s?.return_period ? `~${fmtNumber(s.return_period)} yr` : '—'}</dd></div>
      </dl>
      ${th ? `<p class="pop-th">Thresholds ${fmtNumber(th.watch)} / ${fmtNumber(th.warning)} / ${fmtNumber(th.emergency)} m³/s</p>` : ''}
      <button type="button" class="pop-btn" data-station="${esc(sid)}">Show forecast ↓</button>
    </div>`;
}

function setLayerButtons(key) {
  state.layer = key;
  for (const k of Object.keys(LAYERS)) $(`layer-${k}`).classList.toggle('is-active', k === key);
  $('accum-window').hidden = key !== 'accum';
}

async function setLayer(key) {
  setLayerButtons(key);
  stopPlay();
  await loadLayerMeta();
  writeHash();
}

async function loadLayerMeta() {
  const layer = LAYERS[state.layer];
  $('timeline').classList.toggle('is-static', !layer.animated);

  try {
    state.meta = await layer.meta(state.cycleId);
  } catch (err) {
    showError(`No ${layer.label.toLowerCase()} data for this cycle: ${err.message}`);
    state.meta = null;
    if (state.overlay) { state.overlay.remove(); state.overlay = null; }
    updateMarkers();
    return;
  }

  $('error-banner').hidden = true;
  renderLegend();

  const slider = $('slider');
  slider.max = String(Math.max(0, state.meta.frames.length - 1));
  if (state.frame > +slider.max) state.frame = 0;
  slider.value = String(state.frame);

  setFrame(state.frame);
}

function frameUrl(i) {
  return RRI.url(LAYERS[state.layer].url(state.cycleId, i, state.meta));
}

function drawOverlay() {
  if (!state.meta) return;
  const layer = LAYERS[state.layer];
  const [w, s, e, n] = state.meta.bounds;
  const url = frameUrl(state.frame);
  const bounds = [[s, w], [n, e]];
  const className = layer.pixelated ? 'overlay-grid' : '';

  // The rainfall grid has different bounds from the model grid, and is drawn
  // cell-by-cell rather than smoothed -- neither is changeable on a live
  // ImageOverlay, so both go in the key and a change of either rebuilds it.
  // Stepping the time slider within one layer still only re-points the URL.
  const key = `${bounds}|${className}`;
  if (state.overlay && state.overlay._overlayKey === key) {
    if (state.overlay._url !== url) state.overlay.setUrl(url);
  } else {
    if (state.overlay) state.overlay.remove();
    state.overlay = L.imageOverlay(url, bounds, {
      opacity: state.opacity, interactive: false, className,
    });
    state.overlay._overlayKey = key;
    state.overlay.addTo(state.map);
    if (state.outline) state.outline.bringToFront();
  }
}

/** Warm the browser cache ahead of the playhead so playback does not flicker. */
function prefetchFrame(i) {
  if (!state.meta || !LAYERS[state.layer].animated) return null;
  const url = frameUrl(i);
  let entry = state.frameCache.get(url);
  if (!entry) {
    const img = new Image();
    entry = { img, failed: false };
    img.onerror = () => { entry.failed = true; };
    img.src = url;
    state.frameCache.set(url, entry);
    if (state.frameCache.size > 600) state.frameCache.delete(state.frameCache.keys().next().value);
  }
  return entry;
}

function renderLegend() {
  $('legend').innerHTML = ((state.meta && state.meta.legend) || [])
    .map((l) => `<span><i style="background:${l.color}"></i>${esc(l.label)}</span>`)
    .join('');
}

/* -------------------------------------------------------------- timeline -- */

function frameMs(i = state.frame) {
  const f = state.meta?.frames?.[i];
  if (!f) return state.issueMs;
  return f.valid_time ? Date.parse(f.valid_time) : state.issueMs + f.lead_hours * H;
}

function initTimeline() {
  $('slider').oninput = (ev) => { stopPlay(); setFrame(+ev.target.value); };
  $('play').onclick = togglePlay;
  $('step-back').onclick = () => { stopPlay(); stepFrame(-1); };
  $('step-fwd').onclick = () => { stopPlay(); stepFrame(1); };
  const speed = $('speed');
  speed.value = pref.get('speed', '220');
  state.speed = +speed.value || 220;
  speed.onchange = () => { state.speed = +speed.value; pref.set('speed', speed.value); };
}

function stepFrame(delta) {
  if (!state.meta || !LAYERS[state.layer].animated) return;
  setFrame(clamp(state.frame + delta, 0, state.meta.frames.length - 1));
}

function setFrame(i, { quiet = false } = {}) {
  if (!state.meta || !state.meta.frames.length) return;
  state.frame = clamp(i, 0, state.meta.frames.length - 1);
  const f = state.meta.frames[state.frame];
  const ms = frameMs();

  const animated = LAYERS[state.layer].animated;
  $('frame-time').textContent = animated ? fmtTime(ms, { zone: true }) : 'Peak over forecast';
  const note = LAYERS[state.layer].note;
  $('frame-lead').textContent = animated
    ? `+${f.lead_hours} h`
      + (f.max_depth_m !== undefined ? ` · max ${f.max_depth_m.toFixed(2)} m` : '')
      + (note ? ` · ${note()}` : '')
    : (state.meta.peak_depth_m !== undefined ? `max ${state.meta.peak_depth_m.toFixed(2)} m` : '');
  $('slider').value = String(state.frame);

  drawOverlay();
  updateMarkers();
  highlightMatrix();
  redrawCursors();
  drawBand();
  renderBandValues();
  if (animated) for (let k = 1; k <= 3; k++) prefetchFrame((state.frame + k) % state.meta.frames.length);
  if (!state.playing && !quiet) writeHash();
}

/* ------------------------------------------------------ timeline band -- */

/* One canvas, one time axis: the selected station's catchment rainfall hangs
 * from the top edge and its discharge rises from the foot. A rain burst and the
 * rise it drives sit one above the other, so the catchment's response time is
 * read straight off the screen. Clicking or dragging anywhere on the band moves
 * the map, the charts and the markers to that hour, and the readout beside it
 * gives rain, discharge and water level there. */

const BAND = { padL: 10, padR: 12, labelH: 15 };

function bandSpan() {
  const ov = state.overview;
  const t0 = state.issueMs;
  const t1 = ov?.times?.length ? ov.times[ov.times.length - 1]
    : t0 + (state.basin?.simulation_hours || 168) * H;
  return { t0, t1: Math.max(t1, t0 + H) };
}

/** Time under the pointer is the playhead's time; the map follows. */
function initBand() {
  const c = $('band-canvas');
  let dragging = false;
  const pick = (ev) => {
    if (!state.cycleId) return;
    const r = c.getBoundingClientRect();
    const { t0, t1 } = bandSpan();
    const plotW = Math.max(1, r.width - BAND.padL - BAND.padR);
    const f = clamp((ev.clientX - r.left - BAND.padL) / plotW, 0, 1);
    jumpToTime(t0 + f * (t1 - t0));
  };
  c.addEventListener('pointerdown', (ev) => {
    dragging = true;
    c.setPointerCapture(ev.pointerId);
    pick(ev);
  });
  c.addEventListener('pointermove', (ev) => { if (dragging) pick(ev); });
  const end = () => { dragging = false; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  // Redraw on any size change -- window, panel toggle, font load -- not only
  // on window resize.
  if (window.ResizeObserver) new ResizeObserver(() => drawBand()).observe(c);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', drawBand);
}

function rainClassColour(mmh) {
  const scale = state.rainLegend;
  if (!scale) return null;
  for (const band of scale) {
    if (mmh < band.min_m) return null;
    if (band.max_m === null || band.max_m === undefined || mmh < band.max_m) return band.color;
  }
  return scale[scale.length - 1].color;
}

function drawBand() {
  const c = $('band-canvas');
  const ctx = c?.getContext('2d');
  if (!ctx || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth;
  const Hc = c.clientHeight;
  c.width = Math.round(W * dpr);
  c.height = Math.round(Hc * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, Hc);

  const muted = cssVar('--text-muted');
  const grid = cssVar('--border');
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  if (!state.cycleId || !state.overview) {
    ctx.fillStyle = muted;
    ctx.fillText(state.cycleId ? 'No series for this cycle.' : 'Loading…', BAND.padL, Hc / 2 - 6);
    return;
  }

  const { t0, t1 } = bandSpan();
  const plotW = Math.max(1, W - BAND.padL - BAND.padR);
  const x = (t) => BAND.padL + ((t - t0) / (t1 - t0)) * plotW;
  const bodyH = Hc - BAND.labelH;
  const rainH = Math.round(bodyH * 0.42);
  const flowTop = rainH + 4;
  const flowH = Math.max(10, bodyH - flowTop - 2);
  const sid = state.stationId;

  // Day grid in the display zone, labelled along the foot.
  for (let t = nextBoundary(t0, 24); t <= t1; t += 24 * H) {
    const px = Math.round(x(t)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, bodyH);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(fmtDay(t), px + 3, bodyH + 2);
  }

  // Rainfall bars, coloured by the map's own classes; below the lowest class
  // they are drawn grey, where the map draws nothing.
  const rain = bandData()?.rain || null;
  let rainMax = 0;
  if (rain?.length) {
    rainMax = Math.max(2, ...rain.map((r) => r.v));
    const barW = Math.max(1, plotW / ((t1 - t0) / H + 1) - 0.4);
    for (const r of rain) {
      if (r.v <= 0 || r.t < t0 || r.t > t1 + H) continue;
      const colour = rainClassColour(r.v);
      ctx.fillStyle = colour || muted;
      ctx.globalAlpha = colour ? 0.9 : 0.35;
      // Bar spans the hour it fell in, ending at r.t.
      ctx.fillRect(x(r.t) - barW, 0, barW, Math.max(1, (r.v / rainMax) * (rainH - 2)));
    }
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = grid;
  ctx.beginPath();
  ctx.moveTo(0, rainH + 0.5);
  ctx.lineTo(W, rainH + 0.5);
  ctx.stroke();
  bandLabel(ctx, rain?.length
    ? `rain · ${shortId(sid)} catchment · max ${rainMax.toFixed(1)} mm/h`
    : 'rain · loading…', BAND.padL + 2, 2);

  // Discharge, scaled to the series with Watch kept in view.
  const q = state.overview.series[sid];
  const th = thFor(sid);
  if (q?.length) {
    const vals = q.filter((v) => v !== null);
    const top = Math.max(Math.max(...vals) * 1.15, th ? th.watch * 1.05 : 0, 1);
    const y = (v) => flowTop + flowH - (Math.max(0, v) / top) * flowH;
    if (th) {
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      for (const k of ['watch', 'warning', 'emergency']) {
        if (th[k] > top) continue;
        ctx.strokeStyle = cssVar(`--${k}`);
        ctx.beginPath();
        ctx.moveTo(BAND.padL, Math.round(y(th[k])) + 0.5);
        ctx.lineTo(W - BAND.padR, Math.round(y(th[k])) + 0.5);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    const accent = cssVar('--accent');
    ctx.beginPath();
    let started = false;
    state.overview.times.forEach((t, i) => {
      if (q[i] === null) return;
      if (started) ctx.lineTo(x(t), y(q[i])); else ctx.moveTo(x(t), y(q[i]));
      started = true;
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.lineTo(x(state.overview.times[state.overview.times.length - 1]), flowTop + flowH);
    ctx.lineTo(x(state.overview.times[0]), flowTop + flowH);
    ctx.closePath();
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    bandLabel(ctx, `discharge · ${shortId(sid)} · max ${fmtNumber(Math.max(...vals))} m³/s`,
      BAND.padL + 2, flowTop + 1);
  }

  // Wall-clock now: left of it has already happened, whatever the model says.
  const now = Date.now();
  if (now >= t0 && now <= t1) {
    const px = Math.round(x(now)) + 0.5;
    ctx.strokeStyle = muted;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, bodyH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = muted;
    ctx.fillText('now', px + 3, bodyH - 12);
  }

  // Playhead last, on top of everything.
  const t = bandTime();
  if (t !== null && t >= t0 && t <= t1) {
    const hx = Math.round(x(t)) + 0.5;
    const cursor = cssVar('--cursor');
    ctx.strokeStyle = cursor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, bodyH);
    ctx.stroke();
    ctx.fillStyle = cursor;
    ctx.beginPath();
    ctx.moveTo(hx - 5, 0);
    ctx.lineTo(hx + 5, 0);
    ctx.lineTo(hx, 7);
    ctx.closePath();
    ctx.fill();
    const qv = qAt(sid, t);
    if (qv !== null && q?.length) {
      const vals = q.filter((v) => v !== null);
      const top = Math.max(Math.max(...vals) * 1.15, th ? th.watch * 1.05 : 0, 1);
      ctx.beginPath();
      ctx.arc(hx, flowTop + flowH - (Math.max(0, qv) / top) * flowH, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Text on a translucent chip, legible over bars and curves alike. */
function bandLabel(ctx, text, x, y) {
  ctx.save();
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  const w = ctx.measureText(text).width;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = cssVar('--surface');
  ctx.fillRect(x - 3, y - 1, w + 6, 13);
  ctx.globalAlpha = 1;
  ctx.fillStyle = cssVar('--text-muted');
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** The selected station's rain and stage -- only if they belong to this cycle. */
function bandData() {
  const b = state.band;
  return b && b.sid === state.stationId && b.cycleId === state.cycleId ? b : null;
}

/** The instant the band and readout describe: the map's hour, or the peak. */
function bandTime() {
  if (LAYERS[state.layer].animated && state.meta) return frameMs();
  const w = warnFor(state.stationId);
  return w?.peak_time ? Date.parse(w.peak_time) : null;
}

/** Rain, discharge and water level for the selected station at the band's hour. */
function renderBandValues() {
  const el = $('band-values');
  const sid = state.stationId;
  const t = bandTime();
  if (!sid || t === null) { el.innerHTML = ''; return; }
  const th = thFor(sid);
  const q = qAt(sid, t);
  const lv = levelFor(q, th);
  const band = bandData();
  // Rain is the rate over the hour ENDING at t -- the rain that just fell.
  const r = band?.rain?.find((p) => p.t === Math.round(t / H) * H);
  const h = band?.stage ? valueAt(band.stage.times, band.stage.values, t) : null;
  const atPeak = !LAYERS[state.layer].animated;
  el.innerHTML = `
    <dt>Station</dt><dd title="${esc(stationName(sid))}">${esc(shortId(sid))} · ${esc(stationName(sid))}</dd>
    <dt>Rain</dt><dd>${r ? `${fmtNumber(r.v, 1)} mm/h` : '—'}</dd>
    <dt>Discharge</dt><dd>${q === null ? '—' : `${fmtNumber(q)} m³/s`}${q === null ? ''
      : `<span class="pill pill-${lv}">${LEVEL_NAME[lv]}</span>`}</dd>
    <dt>Water level</dt><dd>${h === null ? '—' : `${fmtNumber(h, 2)} m`}${atPeak ? ' <span class="muted">(at peak)</span>' : ''}</dd>`;
}

function togglePlay() { if (state.playing) stopPlay(); else startPlay(); }

function startPlay() {
  if (!state.meta || !LAYERS[state.layer].animated) return;
  state.playing = true;
  $('play').textContent = '❚❚';
  $('play').setAttribute('aria-label', 'Pause animation');

  // Advance only once the next frame is in the cache, so a slow link shows a
  // slower animation rather than a flickering or blank one.
  const tick = () => {
    if (!state.playing) return;
    const next = (state.frame + 1) % state.meta.frames.length;
    const entry = prefetchFrame(next);
    const ready = !entry || entry.failed || (entry.img.complete && entry.img.naturalWidth > 0)
      || (state.waitSince && Date.now() - state.waitSince > 1500);
    if (ready) {
      state.waitSince = 0;
      setFrame(next);
      state.timer = setTimeout(tick, state.speed);
    } else {
      if (!state.waitSince) state.waitSince = Date.now();
      state.timer = setTimeout(tick, 40);
    }
  };
  state.timer = setTimeout(tick, state.speed);
}

function stopPlay() {
  const was = state.playing;
  state.playing = false;
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Play animation');
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.waitSince = 0;
  if (was) writeHash();
}

/**
 * Point the map at an instant, switching off the peak map if it is showing.
 *
 * Numbered, because the layer switch is awaited: while dragging across the
 * band from the peak map, an early request would otherwise finish after a
 * later one and snap the playhead back to where the drag began.
 */
let jumpSeq = 0;
async function jumpToTime(ms) {
  const seq = ++jumpSeq;
  if (!LAYERS[state.layer].animated) await setLayer('depth');
  if (seq !== jumpSeq || !state.meta) return;
  stopPlay();
  let best = 0;
  let bestD = Infinity;
  state.meta.frames.forEach((_, i) => {
    const d = Math.abs(frameMs(i) - ms);
    if (d < bestD) { bestD = d; best = i; }
  });
  setFrame(best);
}

function initKeyboard() {
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    const tag = t.tagName;
    if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && t.type !== 'range')) return;
    if (t.closest && t.closest('.leaflet-container')) return;  // arrows pan the map there
    const onSlider = t.id === 'slider';
    switch (ev.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onSlider && !ev.shiftKey) return;  // native single step
        if (tag === 'INPUT' && !onSlider) return;
        ev.preventDefault();
        stopPlay();
        stepFrame((ev.key === 'ArrowLeft' ? -1 : 1) * (ev.shiftKey ? 6 : 1));
        break;
      case ' ':
        if (tag === 'BUTTON' || t.getAttribute('role') === 'button' || tag === 'A') return;
        ev.preventDefault();
        togglePlay();
        break;
      case 'Home':
      case 'End':
        if (onSlider) return;
        if (!state.meta) return;
        ev.preventDefault();
        stopPlay();
        setFrame(ev.key === 'Home' ? 0 : state.meta.frames.length - 1);
        break;
      default:
    }
  });
}

/* --------------------------------------------------------- outlook matrix -- */

/* Station x time at a glance: the view that answers "which stations, and
 * when" in one read, and the one warning centres (EFAS, national hydromet
 * services) lead with. Blocks follow the display clock, so a column reads as
 * "Sunday morning", not as an offset from an issue time. */

function renderMatrix() {
  const el = $('matrix');
  const ov = state.overview;
  if (!ov || !ov.times.length) {
    el.innerHTML = '<p class="empty">No discharge series for this cycle.</p>';
    state.matrixBlocks = [];
    return;
  }
  const tEnd = ov.times[ov.times.length - 1];
  // Block width fitted to the panel: 6-hour blocks where there is room, 12 or
  // 24 where there is not, so the whole horizon is visible without scrolling.
  const avail = Math.max(120, ($('rail-left').clientWidth || 340) - 70);
  const spanH = (tEnd - state.issueMs) / H;
  const bh = [6, 12, 24].find((b) => (spanH / b + 1) * 19 <= avail) || 24;
  state.blockHours = bh;
  $('matrix-caption').textContent =
    `Highest level in each ${bh}-hour block (${tzLabel()}) · click a cell to see that hour`;
  const blocks = [];
  let start = state.issueMs;
  let end = nextBoundary(start + 1, bh);
  while (start < tEnd) {
    blocks.push({ start, end: Math.min(end, tEnd) });
    start = end;
    end += bh * H;
  }
  state.matrixBlocks = blocks;

  // Day header: group blocks by the display-zone date of their start.
  const days = [];
  for (const b of blocks) {
    const label = fmtDay(b.start);
    if (days.length && days[days.length - 1].label === label) days[days.length - 1].n++;
    else days.push({ label, n: 1 });
  }

  const idx = ov.times.map((t) => blocks.findIndex((b) => t > b.start && t <= b.end));
  const stations = state.basin.stations.filter((s) => ov.series[s.id]);
  const rows = stations.map((s) => {
    const q = ov.series[s.id];
    const th = thFor(s.id);
    const cells = blocks.map(() => ({ q: null, t: null }));
    q.forEach((v, i) => {
      const k = idx[i];
      if (k < 0 || v === null) return;
      if (cells[k].q === null || v > cells[k].q) cells[k] = { q: v, t: ov.times[i] };
    });
    const tds = cells.map((c, k) => {
      const lv = levelFor(c.q, th);
      const title = `${shortId(s.id)} · ${fmtTime(blocks[k].start)}–${fmtTime(blocks[k].end, { date: false })} ${tzLabel()}`
        + ` · max ${fmtNumber(c.q)} m³/s · ${LEVEL_NAME[lv]}`;
      return `<td class="mx-cell lv-${lv}" data-block="${k}" data-t="${c.t ?? ''}" title="${esc(title)}">${LEVEL_NUM[lv]}</td>`;
    }).join('');
    return `<tr data-station="${esc(s.id)}" class="${s.id === state.stationId ? 'is-selected' : ''}" tabindex="0">
      <th scope="row" class="mx-stn"><span class="mx-id">${esc(shortId(s.id))}</span></th>${tds}</tr>`;
  }).join('');

  el.innerHTML = `
    <table class="matrix">
      <thead>
        <tr><th class="mx-stn mx-corner" rowspan="2">${esc(tzLabel())}</th>
          ${days.map((d) => `<th class="mx-day" colspan="${d.n}">${esc(d.label)}</th>`).join('')}</tr>
        <tr>${blocks.map((b, k) => `<th class="mx-hr" data-block="${k}">${pad(parts(b.start).h)}</th>`).join('')}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  el.querySelector('tbody').onclick = (ev) => {
    const row = ev.target.closest('tr[data-station]');
    if (!row) return;
    selectStation(row.dataset.station, { scroll: false });
    const cell = ev.target.closest('td.mx-cell');
    if (cell && cell.dataset.t) jumpToTime(+cell.dataset.t);
  };
  el.querySelector('tbody').onkeydown = (ev) => {
    const row = ev.target.closest('tr[data-station]');
    if (row && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      selectStation(row.dataset.station, { scroll: true });
    }
  };
  highlightMatrix();
}

function highlightMatrix() {
  const el = $('matrix');
  for (const c of el.querySelectorAll('.is-now')) c.classList.remove('is-now');
  if (!LAYERS[state.layer].animated || !state.meta) return;
  const t = frameMs();
  const k = state.matrixBlocks.findIndex((b) => t > b.start && t <= b.end);
  if (k < 0) return;
  for (const c of el.querySelectorAll(`[data-block="${k}"]`)) c.classList.add('is-now');
}

/* -------------------------------------------------------------- station -- */

function initStationControls() {
  $('station-select').onchange = (ev) => selectStation(ev.target.value, { scroll: false });
  $('show-prev').checked = pref.get('showPrev', '0') === '1';
  $('show-rain').checked = pref.get('showRain', '1') === '1';
  $('show-prev').onchange = (ev) => { pref.set('showPrev', ev.target.checked ? '1' : '0'); refreshStation(); };
  $('show-rain').onchange = (ev) => { pref.set('showRain', ev.target.checked ? '1' : '0'); refreshStation(); };
  $('jump-peak').onclick = () => {
    const s = warnFor(state.stationId);
    if (s?.peak_time) jumpToTime(Date.parse(s.peak_time));
  };
  $('print-btn').onclick = () => window.print();
  $('station-basis').onclick = (ev) => ev.currentTarget.classList.toggle('is-open');
  $('station-basis').title = 'Click to show or hide the full text';
}

/** Point every station-scoped panel at one station, from anywhere. */
function selectStation(stationId, { scroll = false } = {}) {
  if (!stationId) return;
  state.stationId = stationId;
  $('station-select').value = stationId;
  for (const el of document.querySelectorAll('[data-station]')) {
    if (el.matches('.card, tr')) el.classList.toggle('is-selected', el.dataset.station === stationId);
  }
  updateMarkers();
  drawBand();
  renderBandValues();
  refreshStation();
  writeHash();
  if (window.matchMedia('(min-width: 961px)').matches) {
    // One window: open the station panel where it is, rather than scrolling.
    setRail('right', true);
    $('detail-body').scrollTop = 0;
  } else if (scroll) {
    $('station-head').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ---------------------------------------------------------------- rails -- */

/* Both panels collapse to a strip, so the whole map can be seen; the choice is
 * remembered. The left panel holds the station list and the outlook matrix as
 * tabs -- both answer "which stations", so they share the space. */

function setRail(side, open) {
  const rail = $(`rail-${side}`);
  const was = !rail.classList.contains('is-collapsed');
  if (was === open) return;
  rail.classList.toggle('is-collapsed', !open);
  $('canvas').classList.toggle(`${side === 'left' ? 'l' : 'r'}-collapsed`, !open);
  const btn = $(`toggle-${side}`);
  const glyph = side === 'left' ? (open ? '‹' : '›') : (open ? '›' : '‹');
  btn.textContent = glyph;
  btn.setAttribute('aria-label', open ? 'Collapse panel' : 'Expand panel');
  btn.title = btn.getAttribute('aria-label');
  pref.set(`rail-${side}`, open ? '1' : '0');
  if (side === 'left' && open) renderMatrix();
}

function setTab(tab) {
  for (const t of ['cards', 'outlook']) {
    $(`tab-${t}`).hidden = t !== tab;
    $(`tab-btn-${t}`).classList.toggle('is-active', t === tab);
    $(`tab-btn-${t}`).setAttribute('aria-selected', String(t === tab));
  }
  pref.set('rail-tab', tab);
  if (tab === 'outlook') renderMatrix();
}

function initRails() {
  $('toggle-left').onclick = () => setRail('left', $('rail-left').classList.contains('is-collapsed'));
  $('toggle-right').onclick = () => setRail('right', $('rail-right').classList.contains('is-collapsed'));
  for (const b of document.querySelectorAll('.rail-tabs [data-tab]')) b.onclick = () => setTab(b.dataset.tab);
  setTab(pref.get('rail-tab', 'cards') === 'outlook' ? 'outlook' : 'cards');
  if (pref.get('rail-left', '1') === '0') setRail('left', false);
  if (pref.get('rail-right', '1') === '0') setRail('right', false);

  // The provisional notice is one line; the full basis is a click away.
  const prov = $('provisional-banner');
  const toggle = () => prov.classList.toggle('is-open');
  prov.onclick = toggle;
  prov.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } };
}

async function cachedSeries(kind, sid, cycleId) {
  const key = `${kind}|${sid}|${cycleId}`;
  if (!state.seriesCache.has(key)) {
    const q = `?issue_time=${enc(new Date(cycleToMs(cycleId)).toISOString())}`;
    // Failures are not cached: a transient error must not blank a chart for good.
    state.seriesCache.set(key, getJSON(`/forecast/${kind}/${enc(sid)}${q}`)
      .catch(() => { state.seriesCache.delete(key); return null; }));
  }
  return state.seriesCache.get(key);
}

async function cachedRain(sid, cycleId) {
  const key = `${sid}|${cycleId}`;
  if (!state.rainCache.has(key)) {
    state.rainCache.set(key, getJSON(`/map/${cycleId}/rain/catchment?station_id=${enc(sid)}`)
      .catch(() => { state.rainCache.delete(key); return null; }));
  }
  return state.rainCache.get(key);
}

async function refreshStation() {
  const sid = state.stationId;
  const cycleId = state.cycleId;
  if (!sid || !cycleId) return;
  const token = ++state.stationToken;

  const q = `?issue_time=${enc(new Date(state.issueMs).toISOString())}`;
  $('download-csv').href = RRI.url(`/forecast/discharge/${enc(sid)}/csv${q}`);
  $('download-csv-hr').href = RRI.url(`/forecast/discharge/${enc(sid)}/csv${q}&variable=stage`);

  const endMs = state.issueMs + (state.basin.simulation_hours + 1) * H;
  const obsDays = Math.ceil((OBS_LOOKBACK_H + state.basin.simulation_hours + 2) / 24);
  const prevIds = $('show-prev').checked ? previousCycleIds(PREV_OVERLAY) : [];

  const [discharge, stage, rain, obs, ...prev] = await Promise.all([
    cachedSeries('discharge', sid, cycleId),
    cachedSeries('stage', sid, cycleId),
    cachedRain(sid, cycleId),  // always: the band's hyetograph needs it
    getJSON(`/verification/observed/${enc(sid)}?days=${obsDays}&until=${enc(new Date(endMs).toISOString())}`)
      .catch(() => null),
    ...prevIds.map((id) => cachedSeries('discharge', sid, id)),
  ]);
  if (token !== state.stationToken) return;  // a newer selection has taken over

  // The band's copy: rain keyed by the END of each hour (the rain that has
  // just fallen at that time), and the stage series for the readout.
  state.band = {
    sid,
    cycleId,
    rain: rain?.mm_per_hour?.map((v, i) => ({
      t: Math.round(Date.parse(rain.start_times[i]) / H) * H + rain.step_hours * H, v,
    })) || [],
    stage: stage?.values?.length ? {
      times: stage.values.map((p) => Date.parse(p.time)),
      values: stage.values.map((p) => p.value),
    } : null,
  };
  drawBand();
  renderBandValues();

  renderStationCharts({
    discharge, stage, rain, showRain: $('show-rain').checked, obs,
    prev: prev.map((p, i) => ({ id: prevIds[i], series: p })),
  });
  renderEvolution();
  refreshVerification();
}

/** Cycles before the one on screen, newest first -- what was forecast earlier. */
function previousCycleIds(n) {
  const i = state.cycles.findIndex((c) => c.id === state.cycleId);
  return i < 0 ? [] : state.cycles.slice(i + 1, i + 1 + n).map((c) => c.id);
}

function renderStationCharts({ discharge, stage, rain, showRain = true, obs, prev }) {
  const sid = state.stationId;
  const th = thFor(sid);
  const w = warnFor(sid);

  if (!discharge || !discharge.values.length) {
    $('chart-note').textContent = 'No discharge series for this cycle.';
    for (const k of ['q', 'h']) if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
    renderFacts(null, rain, th, w);
    return;
  }

  const toMap = (s) => new Map(s.values.map((p) => [Math.round(Date.parse(p.time) / H) * H, p.value]));
  const fc = toMap(discharge);
  const fcTimes = [...fc.keys()];
  const tFirst = fcTimes[0];
  const tLast = fcTimes[fcTimes.length - 1];

  // Observed, snapped to the hour, from a few days before issue to the end.
  const obsMap = new Map();
  for (const p of obs?.values || []) {
    const t = Math.round(Date.parse(p.time) / H) * H;
    if (t >= state.issueMs - OBS_LOOKBACK_H * H && t <= tLast) obsMap.set(t, p.value);
  }
  const t0 = obsMap.size ? Math.min(state.issueMs, ...obsMap.keys()) : state.issueMs;

  // One shared hourly axis for every dataset, so a tooltip reads forecast,
  // observed, earlier cycles and rainfall for the same hour together.
  const grid = [];
  for (let t = t0; t <= tLast; t += H) grid.push(t);
  const on = (m) => grid.map((t) => ({ x: t, y: m.has(t) ? m.get(t) : null }));

  const prevSets = (prev || []).filter((p) => p.series?.values?.length).map((p, i) => ({
    label: `Issued ${fmtTime(cycleToMs(p.id), { weekday: false })}`,
    data: on(toMap(p.series)),
    // Older = fainter; the eye should land on the newest run first.
    borderColor: withAlpha(cssVar('--text-muted'), 0.8 - i * 0.2),
    borderWidth: 1.2, pointRadius: 0, fill: false, tension: 0.25,
    borderDash: [4, 3], order: 5 + i, unit: 'm³/s', digits: 0,
  }));

  const dataMax = Math.max(
    ...fc.values(), ...(obsMap.size ? obsMap.values() : [0]),
    ...prevSets.flatMap((d) => d.data.map((p) => p.y ?? 0)),
  );
  const scale = dischargeScale(dataMax, th);
  // RRI's diffusion-wave routing admits brief backwater (small negative Q).
  // Left alone, one -14 m3/s step drags the axis a whole tick (-2,000) below
  // zero and squashes the hydrograph; pin the axis at 0 when reverse flow is
  // trivial, and say so in the note. Larger reverse flow keeps its full axis.
  const fcMin = Math.min(...fc.values());
  const pinZero = fcMin >= -0.02 * Math.max(dataMax, 1);

  const datasets = [{
    label: 'Forecast',
    data: on(fc),
    borderColor: cssVar('--accent'),
    backgroundColor: withAlpha(cssVar('--accent'), 0.13),
    borderWidth: 2.2, pointRadius: 0, fill: 'origin', tension: 0.25, order: 0,
    unit: 'm³/s', digits: 0,
  }];
  if (obsMap.size) {
    datasets.push({
      label: 'Observed', data: on(obsMap), borderColor: cssVar('--text'),
      borderWidth: 1.8, pointRadius: 0, fill: false, tension: 0.2, order: 1,
      unit: 'm³/s', digits: 0,
    });
  }
  datasets.push(...prevSets);

  // Rainfall: rate over the hour ENDING at each grid time, hung from the top
  // of the chart -- the classic hydrograph layout, cause above effect.
  let rainMax = 0;
  if (showRain && rain && rain.mm_per_hour?.length) {
    const rm = new Map();
    rain.start_times.forEach((s, i) => {
      rm.set(Math.round(Date.parse(s) / H) * H + rain.step_hours * H, rain.mm_per_hour[i]);
    });
    rainMax = Math.max(...rain.mm_per_hour, 1);
    datasets.push({
      type: 'bar', label: 'Catchment rain', yAxisID: 'yRain',
      data: on(rm), backgroundColor: withAlpha(cssVar('--rain-bar'), 0.55),
      borderWidth: 0, barPercentage: 1, categoryPercentage: 1, order: 20,
      unit: 'mm/h', digits: 1,
    });
  }

  const xMin = grid[0];
  const xMax = grid[grid.length - 1];
  state.charts.q = replaceChart(state.charts.q, 'chart-q', {
    type: 'line',
    data: { datasets },
    options: chartOptions({
      xMin, xMax, yMax: scale.max, yMin: pinZero ? 0 : undefined, yTitle: 'm³/s', legend: true,
      thresholds: thresholdLines(th), rainMax,
    }),
  });

  const hMap = stage && stage.values.length ? toMap(stage) : null;
  const hFig = $('chart-h').closest('.chart-fig');
  if (hMap) {
    hFig.hidden = false;
    state.charts.h = replaceChart(state.charts.h, 'chart-h', {
      type: 'line',
      data: {
        datasets: [{
          label: 'Forecast', data: on(hMap), borderColor: cssVar('--accent'),
          backgroundColor: withAlpha(cssVar('--accent'), 0.13),
          borderWidth: 2, pointRadius: 0, fill: 'origin', tension: 0.25, unit: 'm', digits: 2,
        }],
      },
      options: chartOptions({ xMin, xMax, yTitle: 'm', legend: false, thresholds: [] }),
    });
  } else {
    if (state.charts.h) { state.charts.h.destroy(); state.charts.h = null; }
    hFig.hidden = true;
  }

  const hPeak = hMap ? Math.max(...hMap.values()) : null;
  const off = scale.offscale.map((l) => `${l.label} ${fmtNumber(l.value)}`).join(', ');
  $('chart-note').textContent =
    `${fc.size} hourly steps from ${fmtTime(tFirst, { zone: true })}`
    + (hPeak !== null ? ` · peak h ${hPeak.toFixed(2)} m` : '')
    + (obsMap.size ? ` · ${obsMap.size} observed points` : ' · no observations on record')
    + (off ? ` · off scale: ${off} m³/s` : '')
    + (fcMin < 0 ? ` · brief reverse flow to ${fmtNumber(fcMin)} m³/s${pinZero ? ' (below the axis)' : ''}` : '')
    + ' · click a chart to move the map to that hour';
  $('rain-caption').textContent = showRain && rain
    ? `+ rain over the ${fmtNumber(rain.area_km2)} km² draining here, mm/h` : '';

  renderFacts(discharge, rain, th, w);
  renderThresholdBasis(th);
}

function renderFacts(discharge, rain, th, w) {
  const items = [];
  if (w) {
    const peakMs = w.peak_time ? Date.parse(w.peak_time) : null;
    items.push(['Forecast peak', `${fmtNumber(w.peak_value)} m³/s`
      + (peakMs ? ` · ${fmtTime(peakMs, { zone: true })} (${fmtLead((peakMs - state.issueMs) / H)})` : '')]);
    items.push(['Level', `${LEVEL_NAME[w.alert_level]}${w.return_period ? ` · ~${fmtNumber(w.return_period)}-yr` : ''}`]);
  }
  if (rain) {
    items.push(['Catchment', `${fmtNumber(rain.area_km2)} km² · ${fmtNumber(rain.total_mm)} mm in `
      + `${Math.round(rain.mm_per_hour.length * rain.step_hours / 24)} d (max ${fmtNumber(rain.max_hourly_mm, 1)} mm/h)`]);
  }
  if (th) {
    items.push(['Thresholds', `${fmtNumber(th.watch)} / ${fmtNumber(th.warning)} / ${fmtNumber(th.emergency)} m³/s`]);
  }
  $('station-facts').innerHTML = items
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

/* How much to trust THIS station's levels, stated where the levels are shown.
 * Per-station, because a point with a real frequency analysis behind it and a
 * point whose levels were scaled from a neighbour are not equally reliable,
 * and one page-wide banner cannot tell you which is which. */
function renderThresholdBasis(th) {
  const el = $('station-basis');
  if (!th) { el.textContent = ''; el.className = 'muted small chart-caption'; return; }

  if (th.provisional) {
    el.className = 'small chart-caption basis-provisional';
    el.textContent = `Provisional thresholds — ${th.basis}`;
  } else {
    el.className = 'small chart-caption basis-derived';
    el.textContent = `Thresholds from a ${th.curve.length}-point flood-frequency curve`
      + ` (Q${th.levels.watch} / Q${th.levels.warning} / Q${th.levels.emergency}).`;
  }
}

/* ---------------------------------------------------------------- charts -- */

function withAlpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/* Threshold bands, NWS-hydrograph style: the zone between two levels is tinted
 * with the lower level's colour, so where the curve sits reads without
 * consulting a legend. Drawn under the data. */
const thresholdPlugin = {
  id: 'thresholds',
  beforeDatasetsDraw(chart, _args, opts) {
    const lines = opts?.lines || [];
    const y = chart.scales.y;
    if (!lines.length || !y) return;
    const { ctx, chartArea: a } = chart;
    ctx.save();
    lines.forEach((l, i) => {
      if (l.value >= y.max) return;
      const hi = i + 1 < lines.length ? Math.min(lines[i + 1].value, y.max) : y.max;
      const top = y.getPixelForValue(hi);
      const bottom = y.getPixelForValue(l.value);
      ctx.globalAlpha = 0.09;
      ctx.fillStyle = l.color;
      ctx.fillRect(a.left, top, a.right - a.left, bottom - top);
    });
    ctx.globalAlpha = 1;
    ctx.font = '600 10px system-ui, sans-serif';
    // Hydrographs: labels at the right, over the recession limb, where the
    // rain bars and the rising limb rarely are. Charts whose newest point sits
    // at the right edge ask for the left instead.
    const left = opts.labelSide === 'left';
    ctx.textAlign = left ? 'left' : 'right';
    for (const l of lines) {
      if (l.value > y.max) continue;
      const py = Math.round(y.getPixelForValue(l.value)) + 0.5;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 1.3;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(a.left, py);
      ctx.lineTo(a.right, py);
      ctx.stroke();
      ctx.fillStyle = l.color;
      ctx.fillText(l.label, left ? a.left + 4 : a.right - 4, py - 3);
    }
    ctx.restore();
  },
};

/* Issue time and the map's current hour, drawn on every time chart, so the
 * chart and the map are visibly looking at the same moment. */
const timeMarksPlugin = {
  id: 'timeMarks',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts?.show) return;
    const x = chart.scales.x;
    const { ctx, chartArea: a } = chart;
    const draw = (ms, color, dash, width, label) => {
      if (ms < x.min || ms > x.max) return;
      const px = Math.round(x.getPixelForValue(ms)) + 0.5;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(px, a.top);
      ctx.lineTo(px, a.bottom);
      ctx.stroke();
      if (label) {
        ctx.fillStyle = color;
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(label, px - 3, a.bottom - 4);
      }
      ctx.restore();
    };
    draw(state.issueMs, cssVar('--text-muted'), [2, 3], 1, 'Issued');
    if (LAYERS[state.layer].animated && state.meta) draw(frameMs(), cssVar('--cursor'), [], 1.6, '');
  },
};

function redrawCursors() {
  for (const k of ['q', 'h']) if (state.charts[k]) state.charts[k].draw();
}

function timeTicks(axis) {
  const span = (axis.max - axis.min) / H;
  // As many ticks as fit at ~64 px each, on a whole-hour step the clock uses.
  const fit = Math.max(3, Math.floor((axis.chart.width || 400) / 64));
  const step = [6, 12, 24, 48, 72].find((s) => span / s <= fit) || 96;
  const ticks = [];
  for (let t = nextBoundary(axis.min, step); t <= axis.max; t += step * H) ticks.push({ value: t });
  axis.ticks = ticks;
}

function tickLabel(v) {
  const p = parts(v);
  return p.h === 0 && p.mi === 0 ? `${p.wd} ${p.d}` : `${pad(p.h)}:${pad(p.mi)}`;
}

function chartOptions({ xMin, xMax, yMax, yMin, yTitle, legend, thresholds, rainMax = 0 }) {
  const tc = cssVar('--text-muted');
  const gc = cssVar('--border');
  const scales = {
    x: {
      type: 'linear', min: xMin, max: xMax,
      afterBuildTicks: timeTicks,
      ticks: { color: tc, autoSkip: false, maxRotation: 0, callback: tickLabel },
      grid: { color: gc },
    },
    y: {
      beginAtZero: true, max: yMax, min: yMin,
      title: { display: true, text: yTitle, color: tc },
      ticks: { color: tc, maxTicksLimit: 6 }, grid: { color: gc },
    },
  };
  if (rainMax) {
    scales.yRain = {
      position: 'right', reverse: true, min: 0,
      // Bars fill at most the top ~40% of the plot, clear of the hydrograph.
      max: niceCeil(rainMax * 2.5),
      title: { display: true, text: 'rain mm/h', color: tc },
      ticks: { color: tc, maxTicksLimit: 4 }, grid: { display: false },
    };
  }
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    scales,
    onClick: (evt, _els, chart) => {
      const a = chart.chartArea;
      // Clicks on the legend toggle a dataset; only the plot area moves the map.
      if (evt.x < a.left || evt.x > a.right || evt.y < a.top || evt.y > a.bottom) return;
      const ms = chart.scales.x.getValueForPixel(evt.x);
      if (Number.isFinite(ms)) jumpToTime(ms);
    },
    plugins: {
      thresholds: { lines: thresholds },
      timeMarks: { show: true },
      legend: { display: !!legend, labels: { color: tc, boxWidth: 12, usePointStyle: true } },
      tooltip: {
        filter: (item) => item.parsed.y !== null,
        callbacks: {
          title: (items) => fmtTime(items[0].parsed.x, { zone: true }),
          label: (item) =>
            `${item.dataset.label}: ${fmtNumber(item.parsed.y, item.dataset.digits ?? 1)} ${item.dataset.unit || ''}`,
        },
      },
    },
  };
}

function replaceChart(existing, canvasId, config) {
  if (existing) existing.destroy();
  return new Chart($(canvasId), config);
}

/* ------------------------------------------------------ forecast evolution -- */

function renderEvolution() {
  const sid = state.stationId;
  const pts = (state.history?.stations?.[sid] || []).filter((p) => p.peak_value !== null);
  const th = thFor(sid);
  $('evo-window').textContent = pts.length ? `last ${pts.length} cycle${pts.length > 1 ? 's' : ''}` : '';
  $('evo-summary').textContent = evolutionSummary(pts);

  if (!pts.length) {
    if (state.charts.evo) { state.charts.evo.destroy(); state.charts.evo = null; }
    return;
  }
  const dataMax = Math.max(...pts.map((p) => p.peak_value));
  const scale = dischargeScale(dataMax, th);
  const colours = pts.map((p) => cssVar(`--${p.alert_level}`));
  const tc = cssVar('--text-muted');
  const gc = cssVar('--border');

  state.charts.evo = replaceChart(state.charts.evo, 'chart-evo', {
    type: 'line',
    data: {
      labels: pts.map((p) => fmtTime(Date.parse(p.issue_time), { weekday: false })),
      datasets: [{
        label: 'Forecast peak',
        data: pts.map((p) => p.peak_value),
        borderColor: cssVar('--text-muted'), borderWidth: 1.5,
        pointBackgroundColor: colours, pointBorderColor: cssVar('--surface'),
        pointRadius: pts.map((p) => (Date.parse(p.issue_time) === state.issueMs ? 7 : 5)),
        pointBorderWidth: 1.5, tension: 0,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: {
        x: { ticks: { color: tc, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { beginAtZero: false, max: scale.max, ticks: { color: tc, maxTicksLimit: 5 }, grid: { color: gc } },
      },
      plugins: {
        thresholds: { lines: thresholdLines(th), labelSide: 'left' },
        timeMarks: { show: false },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const p = pts[item.dataIndex];
              const peakAt = p.peak_time ? ` at ${fmtTime(Date.parse(p.peak_time), { zone: true })}` : '';
              return `${fmtNumber(p.peak_value)} m³/s${peakAt} · ${LEVEL_NAME[p.alert_level]}`;
            },
          },
        },
      },
    },
  });
}

/** Plain-language read of the run-to-run history; the chart is the evidence. */
function evolutionSummary(pts) {
  if (!pts.length) return 'No warning history for this station.';
  if (pts.length === 1) return 'Only one cycle on record — no trend to read yet.';
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  let rises = 0;
  for (let i = pts.length - 1; i > 0 && pts[i].peak_value > pts[i - 1].peak_value * 1.02; i--) rises++;
  let falls = 0;
  for (let i = pts.length - 1; i > 0 && pts[i].peak_value < pts[i - 1].peak_value * 0.98; i--) falls++;

  const bits = [];
  if (rises >= 2) {
    const from = pts[pts.length - 1 - rises].peak_value;
    bits.push(`Forecast peak has risen in each of the last ${rises} cycles, `
      + `${fmtNumber(from)} → ${fmtNumber(last.peak_value)} m³/s (+${Math.round((last.peak_value / from - 1) * 100)}%).`);
  } else if (falls >= 2) {
    const from = pts[pts.length - 1 - falls].peak_value;
    bits.push(`Forecast peak has fallen in each of the last ${falls} cycles, `
      + `${fmtNumber(from)} → ${fmtNumber(last.peak_value)} m³/s.`);
  } else {
    const c = Math.round((last.peak_value / prev.peak_value - 1) * 100);
    bits.push(`Forecast peak ${c === 0 ? 'unchanged' : `${c > 0 ? 'up' : 'down'} ${Math.abs(c)}%`} on the previous cycle.`);
  }
  if (lvIdx(last.alert_level) !== lvIdx(prev.alert_level)) {
    bits.push(`Level ${lvIdx(last.alert_level) > lvIdx(prev.alert_level) ? 'raised' : 'lowered'} `
      + `from ${LEVEL_NAME[prev.alert_level]} to ${LEVEL_NAME[last.alert_level]} this cycle.`);
  }
  if (last.peak_time && prev.peak_time) {
    const shift = (Date.parse(last.peak_time) - Date.parse(prev.peak_time)) / H;
    if (Math.abs(shift) >= 3) {
      bits.push(`Peak now expected ${Math.round(Math.abs(shift))} h ${shift < 0 ? 'EARLIER' : 'later'} than last cycle said.`);
    }
  }
  return bits.join(' ');
}

/* ---------------------------------------------------------- verification -- */

async function refreshVerification() {
  if (!state.stationId) return;
  const el = $('verification');
  let v;
  try {
    v = await getJSON(`/verification/${encodeURIComponent(state.stationId)}`);
  } catch (err) {
    el.innerHTML = `<p class="empty">Verification unavailable: ${esc(err.message)}</p>`;
    return;
  }

  $('verif-window').textContent = v.computed_at
    ? `${v.window_days}-day window · computed ${fmtTime(Date.parse(v.computed_at), { zone: true })}`
    : '';

  // "Unmeasured" and "unskilful" are different statements, and the UI must not
  // let one be read as the other.
  if (!v.measured) {
    el.innerHTML = `<p class="empty">${esc(v.summary)}</p>`;
    return;
  }

  const cell = (x, p = 1) => (x === null || x === undefined ? '—' : x.toFixed(p));
  const rows = v.by_lead.map((b) => `
    <tr class="${b.lead_bucket === 'all' ? 'row-total' : ''}">
      <td>${esc(b.lead_bucket)}</td>
      <td class="num">${b.n_pairs}</td>
      <td class="num">${cell(b.bias)}</td>
      <td class="num">${cell(b.rmse)}</td>
      <td class="num">${cell(b.nash_sutcliffe, 2)}</td>
    </tr>`).join('');

  el.innerHTML = `
    <p class="verif-summary">${esc(v.summary)}</p>
    <div class="table-wrap">
      <table class="tbl">
        <thead><tr>
          <th>Lead</th><th class="num">n</th><th class="num">Bias</th>
          <th class="num">RMSE</th><th class="num">NSE</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted small">Bias and RMSE in m³/s. NSE 1.0 is perfect; 0 means no better
      than always predicting the long-term average.</p>`;
}

Chart.register(thresholdPlugin, timeMarksPlugin);
boot();
