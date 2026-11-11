/* Wanderboard — map, city panel and trip planner.
   Content lives in cities.js. Your trip is saved in this browser. */

const $ = (s) => document.querySelector(s);
const STORE = 'wanderboard.v1';
const byId = Object.fromEntries(CITIES.map((c) => [c.id, c]));
// Prices are stored in CAD and converted for display.
const CUR = { CAD: { sym: '$', rate: 1 }, EUR: { sym: '€', rate: CAD_TO_EUR } };
const cur = () => CUR[state.cur];
const money = (n) => cur().sym + Math.round(n * cur().rate).toLocaleString('en-CA');
const moneyRange = (r) => r.split('–').map((p) => money(parseFloat(p.replace(/,/g, '')))).join('–');

/* ---------- state ---------- */
let state = load();
let openId = null;       // city shown in the left panel
let pendingDays = 1;     // nights picked in the panel before adding
let filter = null;       // country code or null
let tripOpen = false;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && Array.isArray(s.trip)) {
      return {
        trip: s.trip.filter((t) => byId[t.id]),
        legCost: s.legCost || {},
        room: s.room === 'priv' ? 'priv' : 'dorm',
        cur: s.cur === 'EUR' ? 'EUR' : 'CAD',
      };
    }
  } catch (e) { /* storage unavailable: start empty */ }
  return { trip: [], legCost: {}, room: 'dorm', cur: 'CAD' };
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: false, minZoom: 4, worldCopyJump: true });
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 18,
  attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors',
}).addTo(map);

const isWide = () => window.innerWidth > 820;
// The map can't animate while it has no size (e.g. the window is hidden).
const hasSize = () => { const s = map.getSize(); return s.x > 0 && s.y > 0; };

function boundsOf(list) { return L.latLngBounds(list.map((c) => [c.lat, c.lng])); }
function fitTo(list) {
  const wide = isWide();
  if (!hasSize() || !list.length) return;
  map.flyToBounds(boundsOf(list), {
    paddingTopLeft: [wide && openId ? 450 : 40, 110],
    paddingBottomRight: [wide && tripOpen ? 410 : 40, 40],
    maxZoom: 8, duration: 0.8,
  });
}
map.fitBounds(boundsOf(CITIES), { paddingTopLeft: [40, 110], paddingBottomRight: [40, 40] });
// If the page loaded while hidden, frame the map properly the first time it gets a size.
map.on('resize', (e) => {
  if (e.oldSize.x === 0 || e.oldSize.y === 0) {
    map.fitBounds(boundsOf(CITIES), { paddingTopLeft: [40, 110], paddingBottomRight: [40, 40], animate: false });
  }
});

const markers = {};
function pinIcon(c) {
  const i = state.trip.findIndex((t) => t.id === c.id);
  const cls = ['pin', i >= 0 ? 'in-trip' : '', c.id === openId ? 'active' : '', c.route === 'yes' ? 'on-route' : ''].join(' ');
  return L.divIcon({
    className: 'pin-wrap', iconSize: [38, 46], iconAnchor: [19, 44],
    html: `<div class="${cls}" style="--c:${COUNTRIES[c.country].color}"><span>${i >= 0 ? i + 1 : c.emoji}</span></div>`,
  });
}
CITIES.forEach((c) => {
  const m = L.marker([c.lat, c.lng], { icon: pinIcon(c), title: c.name, riseOnHover: true }).addTo(map);
  m.bindTooltip(c.name, { direction: 'top', offset: [0, -42], className: 'pin-tip' });
  m.on('click', () => openCity(c.id));
  markers[c.id] = m;
});

const routeLine = L.polyline([], { color: '#1d1a3a', weight: 3, opacity: 0.75, dashArray: '2 9', lineCap: 'round' }).addTo(map);

function updateMap() {
  CITIES.forEach((c) => {
    const m = markers[c.id];
    m.setIcon(pinIcon(c));
    const dim = filter && c.country !== filter;
    m.setOpacity(dim ? 0.25 : 1);
    m.setZIndexOffset(c.id === openId ? 1000 : state.trip.some((t) => t.id === c.id) ? 500 : 0);
  });
  routeLine.setLatLngs(state.trip.map((t) => [byId[t.id].lat, byId[t.id].lng]));
}

function focusCity(c) {
  if (!hasSize()) return;
  const z = Math.max(map.getZoom(), 7);
  const p = map.project([c.lat, c.lng], z);
  const off = isWide()
    ? L.point((430 - (tripOpen ? 390 : 0)) / 2, 0)
    : L.point(0, -window.innerHeight * 0.22);
  map.flyTo(map.unproject(p.subtract(off), z), z, { duration: 0.7 });
}

/* ---------- travel maths ---------- */
function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Rough guess at how you'd travel a leg and what it costs (CAD). Editable per leg in the trip panel.
function legInfo(a, b) {
  const d = km(a, b);
  let mode, icon, cost;
  if (a.country !== b.country) { icon = '✈️'; mode = 'International flight'; cost = 150; }
  else if (d < 150) { icon = '🚌'; mode = 'Bus or ferry'; cost = 17; }
  else if (d < 450) { icon = '🚌'; mode = 'Bus, ferry or short hop'; cost = 40; }
  else { icon = '✈️'; mode = 'Flight or night bus'; cost = 75; }
  const key = a.id + '>' + b.id;
  const custom = state.legCost[key];
  return { d, mode, icon, key, cost: custom != null ? custom : cost, custom: custom != null };
}
const bedPrice = (c) => (state.room === 'priv' ? c.priv : c.hostel);

function totals() {
  let nights = 0, beds = 0, daily = 0, transport = 0, dist = 0;
  state.trip.forEach((t, i) => {
    const c = byId[t.id];
    nights += t.days; beds += bedPrice(c) * t.days; daily += c.daily * t.days;
    if (i > 0) { const l = legInfo(byId[state.trip[i - 1].id], c); transport += l.cost; dist += l.d; }
  });
  return { nights, beds, daily, transport, dist, total: beds + daily + transport };
}

/* ---------- city panel ---------- */
function openCity(id) {
  openId = id;
  pendingDays = byId[id].days;
  render();
  $('#cityPanel').scrollTop = 0;
  const body = $('#cityPanel .body'); if (body) body.scrollTop = 0;
  focusCity(byId[id]);
}

function renderCity() {
  const el = $('#cityPanel');
  const c = byId[openId];
  el.classList.toggle('open', !!c);
  el.setAttribute('aria-hidden', c ? 'false' : 'true');
  if (!c) return;
  const co = COUNTRIES[c.country];
  const stop = state.trip.find((t) => t.id === c.id);
  const days = stop ? stop.days : pendingDays;
  const routeBadge = c.route === 'yes' ? '<span class="badge yes">On our route</span>'
    : c.route === 'optional' ? '<span class="badge opt">Optional</span>' : '';
  const source = c.estimate
    ? 'Rough guess. This city is not in the research sheet yet.'
    : `${c.count} hostels rated 8.7+ on Hostelworld · prices for ${c.dates}`;

  el.innerHTML = `
    <div class="hero" style="--c:${co.color}">
      <button class="x" data-act="close-city" aria-label="Close">✕</button>
      <div class="hero-emoji">${c.emoji}</div>
      <div class="hero-meta">${co.flag} ${co.name} ${routeBadge}</div>
      <h1>${c.name}</h1>
      <p>${c.tagline}</p>
    </div>
    <div class="body">
      <div class="tags">${c.tags.map((t) => `<span>${t}</span>`).join('')}</div>
      ${c.note ? `<div class="note">📌 ${c.note}</div>` : ''}

      <div class="stats">
        <div class="stat"><b>${money(c.hostel)}</b><small>dorm bed / night</small>${c.dormRange ? `<em>${c.dormRange.includes('–') ? 'range ' : 'all '}${moneyRange(c.dormRange)}</em>` : ''}</div>
        <div class="stat"><b>${money(c.priv)}</b><small>private room / night</small>${c.privRange ? `<em>${c.privRange.includes('–') ? 'range ' : 'all '}${moneyRange(c.privRange)}</em>` : ''}</div>
        <div class="stat"><b>~${money(c.daily)}</b><small>spending / day</small><em>rough guess</em></div>
      </div>
      <p class="source ${c.estimate ? 'warn' : ''}">${source} · ${state.cur}</p>

      <h3>The vibe</h3>
      <p>${c.vibe}</p>

      <h3>Adventures, photos &amp; memories</h3>
      <p>${c.attractions}</p>

      <h3>Top 5</h3>
      <ol class="top5">${c.top5.map((t) => `<li>${t}</li>`).join('')}</ol>

      ${c.picks.length ? `<h3>Top-rated hostels</h3><ul class="picks">${c.picks.map((p) => {
        const m = p.match(/^(.*)\s\(([\d.]+)\)$/);
        return m ? `<li><span>${m[1]}</span><b>${m[2]}</b></li>` : `<li><span>${p}</span></li>`;
      }).join('')}</ul>` : ''}

      <h3>Getting there</h3>
      <p>${c.getThere}</p>
    </div>
    <div class="foot">
      <div class="stepper">
        <button data-act="dec" data-id="${c.id}" aria-label="Fewer nights">−</button>
        <span><b>${days}</b> night${days === 1 ? '' : 's'}</span>
        <button data-act="inc" data-id="${c.id}" aria-label="More nights">+</button>
      </div>
      ${stop
        ? `<button class="btn ghost" data-act="remove" data-id="${c.id}">✓ In trip · remove</button>`
        : `<button class="btn" data-act="add" style="--c:${co.color}">Add to trip · ${money((bedPrice(c) + c.daily) * days)}</button>`}
    </div>`;
}

/* ---------- trip panel ---------- */
function renderTrip() {
  const el = $('#tripPanel');
  el.classList.toggle('open', tripOpen);
  el.setAttribute('aria-hidden', tripOpen ? 'false' : 'true');
  const t = totals();
  const n = state.trip.length;

  $('#tripPill').innerHTML = n
    ? `🎒 <b>${n}</b> stop${n === 1 ? '' : 's'} · <b>${t.nights}</b> nights · <b>${money(t.total)}</b>`
    : '🎒 My trip';

  const head = `
    <div class="trip-head">
      <div><h2>My trip</h2><small>${n ? `${n} stops · ${Math.round(t.dist).toLocaleString('en-CA')} km in a straight line` : 'Nothing added yet'}</small></div>
      <button class="x dark" data-act="toggle-trip" aria-label="Close">✕</button>
    </div>`;

  if (!n) {
    el.innerHTML = head + `
      <div class="body empty">
        <div class="big">🗺️</div>
        <p>Click a pin, pick how many nights, and add it. Your stops, days and budget add up here.</p>
        <button class="btn" data-act="load-route">Load the cities marked “on our route”</button>
      </div>`;
    return;
  }

  const rows = state.trip.map((s, i) => {
    const c = byId[s.id];
    let leg = '';
    if (i > 0) {
      const l = legInfo(byId[state.trip[i - 1].id], c);
      leg = `<div class="leg"><span>${l.icon} ${Math.round(l.d).toLocaleString('en-CA')} km · ${l.mode}</span>
        <label>${cur().sym}<input type="number" min="0" step="5" value="${Math.round(l.cost * cur().rate)}" data-leg="${l.key}" aria-label="Cost of this leg"></label></div>`;
    }
    return leg + `
      <div class="stop">
        <button class="num" style="--c:${COUNTRIES[c.country].color}" data-act="open" data-id="${c.id}">${i + 1}</button>
        <button class="stop-name" data-act="open" data-id="${c.id}">
          <b>${c.name}</b>
          <small>${money(bedPrice(c))} bed + ~${money(c.daily)}/day${c.estimate ? ' · guess' : ''}</small>
        </button>
        <div class="stepper sm">
          <button data-act="dec" data-id="${c.id}" aria-label="Fewer nights">−</button>
          <span><b>${s.days}</b>n</span>
          <button data-act="inc" data-id="${c.id}" aria-label="More nights">+</button>
        </div>
        <div class="moves">
          <button data-act="up" data-id="${c.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move earlier">↑</button>
          <button data-act="down" data-id="${c.id}" ${i === n - 1 ? 'disabled' : ''} aria-label="Move later">↓</button>
          <button data-act="remove" data-id="${c.id}" aria-label="Remove">✕</button>
        </div>
      </div>`;
  }).join('');

  const byCountry = {};
  state.trip.forEach((s) => { const k = byId[s.id].country; byCountry[k] = (byCountry[k] || 0) + s.days; });
  const pct = (v) => (t.total ? (v / t.total) * 100 : 0).toFixed(1);

  el.innerHTML = head + `
    <div class="body">
      <div class="seg" role="group" aria-label="Room type">
        <button data-act="room" data-room="dorm" class="${state.room === 'dorm' ? 'on' : ''}">Dorm bed</button>
        <button data-act="room" data-room="priv" class="${state.room === 'priv' ? 'on' : ''}">Private room</button>
      </div>
      <div class="stops">${rows}</div>
      <div class="trip-actions">
        <button class="link" data-act="optimize" ${n < 3 ? 'disabled' : ''}>✨ Shortest order</button>
        <button class="link danger" data-act="clear">Clear trip</button>
      </div>
    </div>
    <div class="summary">
      <div class="country-days">${Object.entries(byCountry).map(([k, d]) => `<span style="--c:${COUNTRIES[k].color}">${COUNTRIES[k].flag} ${d} nights</span>`).join('')}</div>
      <div class="bar"><i style="width:${pct(t.beds)}%;background:#ff5a4e"></i><i style="width:${pct(t.daily)}%;background:#ffb627"></i><i style="width:${pct(t.transport)}%;background:#12b5a6"></i></div>
      <dl>
        <div><dt><i style="background:#ff5a4e"></i>${state.room === 'priv' ? 'Private rooms' : 'Dorm beds'}</dt><dd>${money(t.beds)}</dd></div>
        <div><dt><i style="background:#ffb627"></i>Food, fun, scooters</dt><dd>~${money(t.daily)}</dd></div>
        <div><dt><i style="background:#12b5a6"></i>Getting between stops</dt><dd>~${money(t.transport)}</dd></div>
        <div class="total"><dt>${t.nights} nights · ${state.cur}</dt><dd>${money(t.total)}</dd></div>
      </dl>
      <small>${money(t.nights ? t.total / t.nights : 0)} a day on average. ${state.room === 'priv' ? 'Private price is per room; spending is per person.' : 'Per person.'} Flights to and from Asia not included.</small>
    </div>`;
}

/* ---------- country chips ---------- */
function renderChips() {
  $('#chips').innerHTML =
    `<button class="${filter ? '' : 'on'}" data-act="filter" data-c="">All</button>` +
    Object.entries(COUNTRIES).map(([k, co]) =>
      `<button class="${filter === k ? 'on' : ''}" style="--c:${co.color}" data-act="filter" data-c="${k}">${co.flag} <span>${co.name}</span></button>`).join('');
}

function renderCurrency() {
  $('#curToggle').innerHTML = ['CAD', 'EUR'].map((k) =>
    `<button data-act="cur" data-cur="${k}" class="${state.cur === k ? 'on' : ''}">${CUR[k].sym} ${k}</button>`).join('');
}

function render() { save(); renderChips(); renderCity(); renderTrip(); renderCurrency(); updateMap(); }

/* ---------- trip edits ---------- */
function setDays(id, delta) {
  const s = state.trip.find((t) => t.id === id);
  if (s) s.days = Math.min(60, Math.max(1, s.days + delta));
  else pendingDays = Math.min(60, Math.max(1, pendingDays + delta));
}
function move(id, delta) {
  const i = state.trip.findIndex((t) => t.id === id), j = i + delta;
  if (i < 0 || j < 0 || j >= state.trip.length) return;
  [state.trip[i], state.trip[j]] = [state.trip[j], state.trip[i]];
}
// Keeps the first stop where it is, then orders the rest for the shortest straight-line path.
function optimize() {
  const d = (a, b) => km(byId[a.id], byId[b.id]);
  const rest = state.trip.slice();
  let path = [rest.shift()];
  while (rest.length) {
    const last = path[path.length - 1];
    let bi = 0;
    rest.forEach((p, i) => { if (d(last, p) < d(last, rest[bi])) bi = i; });
    path.push(rest.splice(bi, 1)[0]);
  }
  const len = (r) => r.slice(1).reduce((s, p, i) => s + d(r[i], p), 0);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < path.length - 1; i++) {
      for (let j = i + 1; j < path.length; j++) {
        const cand = path.slice(0, i).concat(path.slice(i, j + 1).reverse(), path.slice(j + 1));
        if (len(cand) < len(path) - 0.01) { path = cand; improved = true; }
      }
    }
  }
  state.trip = path;
}

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'close-city': openId = null; break;
    case 'toggle-trip': tripOpen = !tripOpen; if (tripOpen && !isWide()) openId = null; break;
    case 'open': if (!isWide()) tripOpen = false; openCity(id); return;
    case 'add':
      state.trip.push({ id: openId, days: pendingDays });
      if (isWide()) tripOpen = true;
      break;
    case 'remove': state.trip = state.trip.filter((t) => t.id !== id); break;
    case 'inc': setDays(id, 1); break;
    case 'dec': setDays(id, -1); break;
    case 'up': move(id, -1); break;
    case 'down': move(id, 1); break;
    case 'room': state.room = b.dataset.room; break;
    case 'cur': state.cur = b.dataset.cur; break;
    case 'optimize': optimize(); render(); fitTo(state.trip.map((t) => byId[t.id])); return;
    case 'clear':
      if (!confirm('Remove every stop from your trip?')) return;
      state.trip = []; state.legCost = {};
      break;
    case 'load-route':
      state.trip = CITIES.filter((c) => c.route === 'yes').map((c) => ({ id: c.id, days: c.days }));
      render(); fitTo(state.trip.map((t) => byId[t.id]));
      return;
    case 'filter':
      filter = b.dataset.c || null;
      render(); fitTo(filter ? CITIES.filter((c) => c.country === filter) : CITIES);
      return;
  }
  render();
});

document.addEventListener('change', (e) => {
  const key = e.target.dataset && e.target.dataset.leg;
  if (!key) return;
  const v = parseFloat(e.target.value);
  if (isNaN(v) || v < 0) delete state.legCost[key]; else state.legCost[key] = v / cur().rate;
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openId) { openId = null; render(); }
});

tripOpen = isWide() && state.trip.length > 0;
render();
