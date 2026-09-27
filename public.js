/*
 * Public flood status page.
 *
 * Same API as the operator dashboard, deliberately different reading of it.
 *
 * The editorial rules here matter as much as the code:
 *
 *  - Lead the with ACTION, not the measurement. "Prepare to evacuate" is what
 *    a resident needs; 4,200 m³/s is not.
 *  - Show the WORST level across all stations. A page that averaged them, or
 *    showed only the nearest, could tell someone they were safe while a
 *    station upstream was at emergency.
 *  - Never render a level without its time. Stale reassurance is the specific
 *    danger of a page like this, so if the forecast is old the page says so
 *    instead of quietly presenting it as current.
 *  - Fail loudly. If the API cannot be reached, say that — do not leave the
 *    default "all clear" showing.
 */
'use strict';

const LEVELS = ['none', 'watch', 'warning', 'emergency'];

const COPY = {
  none: {
    label: 'No flood warning',
    meaning: 'River levels are expected to stay within normal limits.',
    action: 'No action needed. Keep following local advisories during heavy rain.',
  },
  watch: {
    label: 'Watch',
    meaning: 'River levels will rise well above normal.',
    action: 'Stay alert and follow local advisories. Check on anyone who would need help to move.',
  },
  warning: {
    label: 'Warning',
    meaning: 'Significant flooding is expected.',
    action: 'Prepare to evacuate. Move people, vehicles and livestock to higher ground.',
  },
  emergency: {
    label: 'Emergency',
    meaning: 'Severe flooding is expected.',
    action: 'Act on your evacuation plan now. Do not wait for water to arrive.',
  },
};

// A forecast older than this is presented as possibly out of date rather than
// as the current picture.
const STALE_HOURS = 12;

// A page left open on a barangay-hall screen must not freeze on an old
// forecast; reload the status on this interval.
const REFRESH_MS = 10 * 60e3;

const $ = (id) => document.getElementById(id);

// API origin; '' = same origin, null = no backend connected (see config.js).
const API = ((window.RRI_CONFIG && window.RRI_CONFIG.apiBase) || '').replace(/\/+$/, '');
const API_CONFIGURED = !window.RRI_CONFIG || window.RRI_CONFIG.apiBase !== null;

async function getJSON(url) {
  const res = await fetch(API + url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// Residents read local time. The basin's display zone (PHT for Magat) leads;
// UTC is used only when none is configured.
let zone = { id: 'UTC', label: 'UTC' };

function fmtWhen(d) {
  const f = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone.id,
  });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return `${o.weekday} ${o.day} ${o.month}, ${o.hour}:${o.minute} ${zone.label}`;
}

/** Plain-language time-from-now, because "in about 2 days" beats a timestamp. */
function relative(from, to) {
  const h = (to - from) / 3600e3;
  if (h < 0) return 'now';
  if (h < 1.5) return 'within the hour';
  if (h < 36) return `in about ${Math.round(h)} hours`;
  return `in about ${Math.round(h / 24)} days`;
}

function setStatus(level, extra) {
  const c = COPY[level] || COPY.none;
  $('pub-status').className = `pub-status lv-${level}`;
  $('pub-level').textContent = c.label;
  $('pub-meaning').textContent = extra || c.meaning;
  $('pub-action').textContent = c.action;
  document.title = level === 'none'
    ? 'Magat River — No flood warning'
    : `Magat River — ${c.label.toUpperCase()}`;
}

function fail(message) {
  $('pub-status').className = 'pub-status lv-watch';
  $('pub-level').textContent = 'Status unavailable';
  $('pub-meaning').textContent = message;
  $('pub-action').textContent =
    'Do not treat this as an all-clear. Follow your LGU and PAGASA advisories.';
}

async function main() {
  if (!API_CONFIGURED) {
    fail('This page is not connected to the forecast service, so no current status can be shown.');
    return;
  }
  let basin;
  let warnings;
  try {
    basin = await getJSON('/stations');
    warnings = await getJSON('/warnings/stations');
  } catch {
    fail('The forecast service could not be reached, so no current status can be shown.');
    return;
  }

  if (basin.display_timezone) {
    zone = { id: basin.display_timezone, label: basin.display_timezone_label || basin.display_timezone };
  }
  $('pub-title').textContent = `${basin.name.charAt(0).toUpperCase() + basin.name.slice(1)} River`;

  const stations = warnings.stations || [];
  if (!stations.length) {
    fail('No forecast has been issued yet for this river.');
    return;
  }

  // Worst level across every station, never an average or the nearest one.
  const worst = stations.reduce(
    (acc, s) => (LEVELS.indexOf(s.alert_level) > LEVELS.indexOf(acc) ? s.alert_level : acc),
    'none');

  const issued = new Date(warnings.issue_time);
  const now = new Date();
  const ageHours = (now - issued) / 3600e3;
  const stale = ageHours > STALE_HOURS;

  setStatus(worst, stale
    ? `This forecast was issued ${Math.round(ageHours)} hours ago and may be out of date.`
    : undefined);

  // Soonest threshold crossing among the stations at the worst level.
  const leading = stations
    .filter((s) => s.alert_level === worst && s.hours_to_threshold !== null)
    .sort((a, b) => a.hours_to_threshold - b.hours_to_threshold)[0];

  if (worst !== 'none' && leading) {
    const peak = new Date(leading.peak_time);
    $('pub-when-card').hidden = false;
    $('pub-when').textContent =
      `Highest water expected ${relative(now, peak)} — ${fmtWhen(peak)}.`;
  }
  $('pub-issued').textContent =
    `Forecast issued ${fmtWhen(issued)}${stale ? ' · possibly out of date' : ''}.`;
  $('pub-foot').textContent =
    `Automated forecast from the ICHARM RRI model, ${basin.description || basin.name}. `
    + `Times shown in ${zone.label}. Issued ${fmtWhen(issued)}. This page updates itself every 10 minutes.`;

  // Per-place list.
  const byId = Object.fromEntries(basin.stations.map((s) => [s.id, s]));
  $('pub-places').innerHTML = stations.map((s) => {
    const meta = byId[s.station_id] || {};
    const c = COPY[s.alert_level] || COPY.none;
    const when = s.alert_level === 'none' || !s.peak_time
      ? 'within normal limits'
      : `highest water ${relative(now, new Date(s.peak_time))}`;
    return `<li class="lv-${s.alert_level}">
        <span>
          <span class="pub-place-name">${meta.name || s.station_id}</span><br>
          <span class="pub-place-when">${when}</span>
        </span>
        <span class="pub-chip lv-${s.alert_level}">${c.label}</span>
      </li>`;
  }).join('');

  if (basin.thresholds_provisional) {
    $('pub-provisional').hidden = false;
    $('pub-provisional-text').textContent =
      'The levels used to decide these warnings are provisional. They have not yet been '
      + 'checked against a long record of measured river flow, so treat them as a guide '
      + 'and always follow official advisories.';
  }

  drawMap(basin, warnings, byId);
}

function drawMap(basin, warnings, byId) {
  const [w, s, e, n] = basin.bounds;
  const map = L.map('pub-map', {
    zoomControl: false, attributionControl: true,
    // A static picture: on a phone, a pannable map inside a scrolling page
    // traps the scroll and is more obstacle than feature.
    dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
    touchZoom: false, keyboard: false,
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 15, attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  const frame = () => { map.invalidateSize(); map.fitBounds([[s, w], [n, e]], { padding: [12, 12] }); };
  frame();
  requestAnimationFrame(frame);
  window.addEventListener('resize', frame);

  getJSON('/layers/rivers.geojson')
    .then((gj) => L.geoJSON(gj, { style: { color: '#6ba3c9', weight: 1, opacity: 0.7 }, interactive: false }).addTo(map))
    .catch(() => {});
  getJSON('/layers/basin.geojson')
    .then((gj) => L.geoJSON(gj, {
      style: { color: '#1c6fb5', weight: 2, fill: true, fillColor: '#1c6fb5', fillOpacity: 0.05 },
      interactive: false,
    }).addTo(map))
    .catch(() => {});

  // Peak inundation, not an animated series: the public question is "does it
  // reach me at all", not "when exactly".
  const cycle = new Date(warnings.issue_time).toISOString().slice(0, 13).replace(/[-T:]/g, '');
  const peakUrl = `${API}/map/${cycle}/peak.png`;
  fetch(peakUrl).then((r) => {
    if (!r.ok) return;
    L.imageOverlay(peakUrl, [[s, w], [n, e]], { opacity: 0.85 }).addTo(map);
  }).catch(() => {});

  for (const m of basin.landmarks || []) {
    L.marker([m.lat, m.lon], {
      icon: L.divIcon({
        className: 'landmark-pin',
        html: '<span class="landmark-dot" aria-hidden="true"></span>',
        iconSize: [14, 14], iconAnchor: [7, 7],
      }),
      interactive: false, keyboard: false,
    }).addTo(map);
  }

  for (const st of warnings.stations) {
    const meta = byId[st.station_id];
    if (!meta) continue;
    const colour = getComputedStyle(document.documentElement)
      .getPropertyValue(`--${st.alert_level}`).trim() || '#666';
    L.circleMarker([meta.lat, meta.lon], {
      radius: 8, color: '#fff', weight: 2, fillColor: colour, fillOpacity: 1, interactive: false,
    }).addTo(map);
  }
}

main();
// A full reload rather than a partial refresh: it rebuilds every element from
// the API, so nothing on screen can be left over from the previous forecast,
// and an unreachable API shows "Status unavailable" instead of the old status.
setTimeout(() => location.reload(), REFRESH_MS);
