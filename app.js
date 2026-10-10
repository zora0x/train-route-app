/* Board Anywhere — client-side only. No server, no API key.
   Routes/station list: erail.in  (CORS: access-control-allow-origin: *)
   Live availability:   cttrainsapi.confirmtkt.com/api/v1/availability/fetchAvailability  (CORS: *)

   Both tolerate high concurrency: 532 calls at 32 workers finished in ~3s with zero
   errors, so every class is fetched for every station in parallel.

   Nothing here is route-specific: any pair of stations, any date, any quota.      */

const ERAIL_TRAIN = n =>
  `https://erail.in/rail/getTrains.aspx?TrainNo=${n}&DataSource=0&Language=0&Cache=true`;
const ERAIL_BETWEEN = (a, b) =>
  `https://erail.in/rail/getTrains.aspx?Station_From=${a}&Station_To=${b}&DataSource=0&Language=0&Cache=true`;
const ERAIL_ROUTE = id =>
  `https://erail.in/data.aspx?Action=TRAINROUTE&Password=2012&Data1=${id}&Data2=0&Cache=true`;
const CT_AVAIL = 'https://cttrainsapi.confirmtkt.com/api/v1/availability/fetchAvailability';

// All rail classes, most expensive first.
const CLASSES = ['1A', '2A', '3A', '3E', 'CC', 'FC', 'SL', '2S'];
const CLASS_NAMES = {
  '1A': 'First AC', '2A': 'AC 2-Tier', '3A': 'AC 3-Tier', '3E': 'AC 3-Economy',
  'CC': 'AC Chair Car', 'FC': 'First Class', 'SL': 'Sleeper', '2S': 'Second Sitting'
};
// (no station list here on purpose — the cut is geographic, not a hardcoded list)

/* Bounded parallelism. Measured against the live API: 6 workers 38 req/s,
   16 → ~95, 24 → 156, 48 → 275, 96 → 162 (past 48 the server starts queueing
   and latency rises). 48 is the measured peak, and no request failed at it. */
const CONCURRENCY = 48;

/* When a train never stops at your destination it runs on past it — a train to
   Amritsar passes Chandigarh without halting. To find where to stop the boarding
   window we take the stop nearest the destination by great-circle distance, which
   is the point where that train is closest to your destination. This is pure
   geography, so it works for any route in India and any station pair.            */

function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Index of the stop closest to the destination. Only meaningful for stops that
   have coordinates; erail supplies them for every stop we saw (0 missing). */
function nearestStopIndex(stops, dest) {
  let best = -1, bestKm = Infinity;
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].lat == null || stops[i].lon == null) continue;
    const km = haversineKm(stops[i], dest);
    if (km < bestKm) { bestKm = km; best = i; }
  }
  return best;
}

const $ = s => document.querySelector(s);
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };

/* ---------- bounded parallel map ---------- */

async function pool(items, worker, onProgress) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (e) { out[i] = null; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return out;
}

/* ---------- station autocomplete ---------- */

let STATIONS = [];
let fromSel = null, toSel = null;

async function loadStations() {
  try {
    const r = await fetch('stations.json');
    STATIONS = await r.json();
  } catch (e) {
    $('#status').className = 'status err';
    $('#status').textContent = 'Could not load stations.json — serve this folder over HTTP, not file://';
  }
}

function attachSuggest(input, box) {
  let idx = -1, items = [];
  const close = () => { box.hidden = true; idx = -1; };

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { close(); return; }
    const scored = [];
    for (const s of STATIONS) {
      const n = s.name.toLowerCase(), c = s.code.toLowerCase();
      let sc = -1;
      if (c === q) sc = 0;
      else if (n.startsWith(q)) sc = 1;
      else if (c.startsWith(q)) sc = 2;
      else if (n.includes(q) || c.includes(q)) sc = 3;
      if (sc >= 0) scored.push([sc, s.name.length, s]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    items = scored.slice(0, 12).map(x => x[2]);
    if (!items.length) { close(); return; }
    box.innerHTML = '';
    items.forEach((s, i) => {
      const d = el('div');
      d.append(el('span', null, s.name), el('code', null, s.code));
      d.onmousedown = ev => { ev.preventDefault(); choose(i); };
      box.append(d);
    });
    box.hidden = false; idx = -1;
  });

  function choose(i) {
    const s = items[i];
    input.value = `${s.name} (${s.code})`;
    close();
  }

  input.addEventListener('keydown', ev => {
    if (box.hidden) return;
    const rows = [...box.children];
    if (ev.key === 'ArrowDown') { ev.preventDefault(); idx = Math.min(idx + 1, rows.length - 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); idx = Math.max(idx - 1, 0); }
    else if (ev.key === 'Enter') { if (idx >= 0) { ev.preventDefault(); choose(idx); } return; }
    else if (ev.key === 'Escape') { close(); return; }
    rows.forEach((r, i) => r.classList.toggle('sel', i === idx));
    if (idx >= 0) rows[idx].scrollIntoView({ block: 'nearest' });
  });

  input.addEventListener('blur', () => setTimeout(close, 150));
}

/* ---------- erail helpers ---------- */

function fields(raw) { return raw.split('~').filter(x => x !== ''); }

async function trainsBetween(from, to) {
  const txt = await fetch(ERAIL_BETWEEN(from, to)).then(r => r.text());
  const out = [];
  for (const part of txt.split('~^').slice(1)) {
    const f = part.split('~').filter(x => x !== '');
    if (f.length < 16) continue;
    out.push({
      num: f[0], name: f[1], srcCode: f[3], dstCode: f[5],
      fromCode: f[7], toCode: f[9], dep: f[10], arr: f[11], dur: f[12],
      runningDays: f[13], trainId: null
    });
  }
  return out;
}

async function trainMeta(num) {
  const txt = await fetch(ERAIL_TRAIN(num)).then(r => r.text());
  const f = fields(txt);
  if (f.length < 30) return null;
  return {
    num, name: f[2], srcCode: f[4], dstCode: f[6],
    dep: f[11], arr: f[12], dur: f[13], runningDays: f[14],
    trainId: f[27], distKm: f[33], type: f[26],
    classes: classesFromComposition(f)
  };
}

/* The coach-composition field looks like
     ',,En:LPR,LPR,LPR:GN,GN,GN:A,A1,2A:B,B1,3A:...,SL:S,S1,SL'
   and names exactly which classes the train carries. Asking ConfirmTkt for a
   class the train does not have returns nothing, so we skip those outright —
   that alone cuts 56% of the availability requests.                        */
function classesFromComposition(f) {
  let best = null;
  for (const field of f) {
    if (field.length > 500 || field.split(',').length < 9) continue;
    const found = new Set(field.match(/\b(?:1A|2A|3A|3E|CC|FC|SL|2S)\b/g) || []);
    // Require coach numbers ('A,A1,2A') or a luggage/guard van to trust the field.
    const trustworthy = /\b(?:1A|2A|3A|3E|CC|FC|SL|2S)\b,\d/.test(field) ||
                        /LPR|SLRD|VP\b|EOG|GS\b/.test(field);
    if (found.size && trustworthy && (!best || found.size > best.size)) best = found;
  }
  if (!best) return CLASSES.slice();               // unknown -> ask for everything
  return CLASSES.filter(c => best.has(c));
}

/* The route payload is: a fare preamble, then stops delimited by '~^'. The
   origin stop is NOT delimited — it is glued to the tail of the preamble with
   '#^'. So splitting on '~^' alone loses the origin (stop index 1), which is
   usually the user's boarding station. Normalise '#^' to '~^' first.          */
async function trainRoute(trainId) {
  const txt = await fetch(ERAIL_ROUTE(trainId)).then(r => r.text());
  const stops = [];
  for (const part of txt.replace(/#\^/g, '~^').split('~^')) {
    const f = part.split('~');
    if (f.length < 12 || !/^\d+$/.test((f[0] || '').trim())) continue;
    const num = x => (x && /^-?\d+$/.test(x)) ? parseInt(x, 10) : null;
    stops.push({
      idx: parseInt(f[0], 10),
      code: f[1],
      name: f[2],
      arr: (f[3] === 'First') ? null : f[3],
      dep: (f[4] === 'Last') ? null : f[4],
      haltMin: num(f[5]),
      km: num(f[6]),
      day: f[7],
      lat: parseFloat(f[14]) || null,
      lon: parseFloat(f[15]) || null
    });
  }
  return stops;
}

/* ---------- ConfirmTkt availability ----------
   NOTE ON SPEED: the request must stay a *simple* CORS request. Sending a
   Content-Type header (or anything non-safelisted) makes the browser fire an
   OPTIONS preflight first, which halves the 6-socket pool and cuts throughput
   from ~54 req/s to ~13.
   So: POST with an empty body and NO Content-Type. The server reads every
   parameter from the query string, and POST-without-content-type is still
   "simple" — no preflight. (A plain GET is *not* accepted: it returns 405.) */

async function availability(trainNo, cls, from, to, date, quota) {
  const p = new URLSearchParams({
    trainNo, travelClass: cls, quota,
    sourceStationCode: from, destinationStationCode: to,
    dateOfJourney: date,                       // DD-MM-YYYY — anything else errors
    enableTG: 'false', tGPlan: '', showTGPrediction: 'false',
    tgColor: 'DEFAULT', showPredictionGlobal: 'true',
    showNewMealOptions: 'true', showNewAlternates: 'false', showNewAltText: 'true'
  });
  const r = await fetch(`${CT_AVAIL}?${p}`, { method: 'POST', body: '' });
  if (!r.ok) return null;
  const j = await r.json();
  const d = j && j.data;
  if (!d || !d.avlDayList || !d.avlDayList.length) return null;
  const fare = d.fareInfo || {};

  /* One call returns the queried date AND the next three. Index 0 is the date
     asked for; 1..3 are the following days. Reading all four costs nothing and
     lets the UI show "it opens up on the 8th" — often the answer the user needs. */
  const parse = (day) => ({
    date: day.availablityDate,
    status: day.availablityStatus,
    display: day.availabilityDisplayName || day.availablityStatus,
    prediction: day.predictionPercentage,
    predictionText: day.predictionDisplayName,
    kind: day.availablityType
  });

  const days = d.avlDayList.map(parse).filter(x => x.display);
  if (!days.length) return null;
  const today = days[0];
  return {
    status: today.status,
    display: today.display,
    prediction: today.prediction,
    predictionText: today.predictionText,
    kind: today.kind,
    fare: fare.totalFare,
    baseFare: fare.baseFare,
    distance: d.distance,
    days                                        // [queried date, +1, +2, +3]
  };
}

/* ---------- cache ----------
   Route and class data change only when the timetable changes, so it is cached
   in localStorage for a day. Availability is volatile and must never be cached.
   A repeat search of the same route then skips the route fetches entirely.     */

const ROUTE_TTL_MS = 24 * 3600e3;
const routeKey = (num) => 'rt|' + num;

function cacheGet(key, ttl) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const hit = JSON.parse(raw);
    if (!hit || typeof hit.t !== 'number') return null;
    if (ttl && Date.now() - hit.t > ttl) { localStorage.removeItem(key); return null; }
    return hit.v;
  } catch (e) { return null; }
}

function cacheSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: val }));
  } catch (e) { /* quota full or private mode — caching is an optimisation only */ }
}

async function cachedRoute(trainId) {
  const key = routeKey(trainId);
  const hit = cacheGet(key, ROUTE_TTL_MS);
  if (hit) return hit;
  const stops = await trainRoute(trainId);
  if (stops && stops.length) cacheSet(key, stops);
  return stops;
}

async function cachedMeta(num) {
  const key = 'mt|' + num;
  const hit = cacheGet(key, ROUTE_TTL_MS);
  if (hit) return hit;
  const m = await trainMeta(num);
  if (m) cacheSet(key, m);
  return m;
}

/* ---------- pipeline ---------- */

async function run(from, to, date, quota) {
  const status = $('#status'), bar = $('#bar'), barI = $('#bar i'), out = $('#out');
  out.innerHTML = '';
  bar.hidden = false; barI.style.width = '0%';
  const t0 = performance.now();

  const say = (msg, cls) => { status.className = 'status' + (cls ? ' ' + cls : ''); status.textContent = msg; };
  const prog = (pct, msg) => { barI.style.width = pct + '%'; if (msg) say(msg); };

  say('Finding trains between ' + from + ' and ' + to + ' …');
  const list = await trainsBetween(from, to);
  if (!list.length) { say('No trains found between ' + from + ' and ' + to + '.', 'err'); bar.hidden = true; return; }
  prog(6, `${list.length} trains found — loading full routes …`);

  // metadata + route for every train, in parallel (cached after the first run)
  const metas = await pool(list, t => cachedMeta(t.num));
  const enriched = list.map((t, i) => Object.assign({}, metas[i] || t, { stops: [] }));
  const routes = await pool(enriched, async t => t.trainId ? await cachedRoute(t.trainId) : []);
  enriched.forEach((t, i) => { t.stops = routes[i] || []; });

  const trains = enriched.filter(t => t.stops.length);
  if (!trains.length) { say('Could not load any routes.', 'err'); bar.hidden = true; return; }

  /* Destination coordinates, harvested from the routes we just fetched — the
     destination station is a stop on at least one of these trains, and erail
     supplies lat/lon for every stop. Costs zero extra requests. */
  const destCoord = {};
  for (const t of trains) {
    const hit = t.stops.find(s => s.code === to);
    if (hit && hit.lat != null) destCoord[to] = { lat: hit.lat, lon: hit.lon };
  }
  const haveDest = !!destCoord[to];

  // Boarding window: the train's ENTIRE route up to the destination, not just the
  // part after your station. A seat freed up at an earlier stop is still bookable
  // for the leg you actually ride — and that is exactly the seat you want.
  const results = [];
  for (const t of trains) {
    const codes = t.stops.map(s => s.code);
    const srcIdx = codes.indexOf(from);
    if (srcIdx < 0) continue;              // train never serves your station

    // End where the train reaches your destination. When it never stops there,
    // end at the stop nearest your destination — the point where that train
    // comes closest to it. Geographic, so it works for any station pair.
    let end = codes.indexOf(to, srcIdx);
    if (end < 0) {
      if (haveDest) {
        const near = nearestStopIndex(t.stops, destCoord[to]);
        end = near >= 0 ? near : t.stops.length - 1;
      } else {
        end = t.stops.length - 1;          // no coordinates: keep the whole route
      }
    }

    const window = t.stops.slice(0, end + 1);   // from the train's own origin
    const boardable = window.slice(0, -1);      // the destination itself is not boardable
    if (!boardable.length) continue;
    results.push({ train: t, window, boardable, srcIdx, classes: t.classes || CLASSES.slice(), avail: {} });
  }

  if (!results.length) {
    say('None of those trains serve ' + from + '.', 'err'); bar.hidden = true; return;
  }

  const stationCount = results.reduce((a, r) => a + r.boardable.length, 0);
  const totalJobs = results.reduce((a, r) => a + r.boardable.length * r.classes.length, 0);

  /* Phase 1 — your station only, for every train. That is the answer to
     "can I get a seat where I actually board", so it renders immediately and
     the page feels instant even on a 1,400-request search. */
  const priority = [];
  for (const r of results) {
    const st = r.boardable.find(s => s.code === from) || r.boardable[r.boardable.length - 1];
    for (const cls of r.classes) priority.push({ r, st, cls });
  }
  await pool(priority, async ({ r, st, cls }) => {
    const av = await availability(r.train.num, cls, st.code, to, date, quota);
    if (av) r.avail[st.code + '|' + cls] = av;
  });

  prog(30, `Your stations checked — filling in the rest of each route (${totalJobs} requests) …`);
  render(results, from, to, date, quota, true);          // streaming: rest still loading
  const firstPaint = ((performance.now() - t0) / 1000).toFixed(1);
  prog(32, `First results in ${firstPaint}s — now checking every station on each route …`);

  /* Phase 2 — every other station on every route, in the background. The table
     is already on screen; each train re-renders as its rows complete. */
  const rest = [];
  for (const r of results) {
    for (const st of r.boardable) {
      if (st.code === from) continue;                 // already fetched in phase 1
      for (const cls of r.classes) rest.push({ r, st, cls });
    }
  }
  await pool(rest, async ({ r, st, cls }) => {
    const av = await availability(r.train.num, cls, st.code, to, date, quota);
    if (av) r.avail[st.code + '|' + cls] = av;
  }, (done, total) => {
    prog(32 + 68 * done / total, `Availability ${done}/${total}`);
    // Re-render rarely: a full pass rebuilds ~18k nodes, so doing it often costs
    // more than it shows. Three times is enough to feel alive without thrashing.
    if (done === Math.ceil(total * 0.33) || done === Math.ceil(total * 0.66) || done === total) {
      render(results, from, to, date, quota, done < total);
    }
  });

  prog(100, 'Rendering …');
  render(results, from, to, date, quota);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  prog(100, `Done — ${results.length} trains, ${stationCount} boarding stations, in ${secs}s.`);
  bar.hidden = true;
}

/* ---------- render ----------
   Built as HTML strings and inserted in one pass: ~1,500 rows x ~12 cells is
   ~18k DOM nodes, and appending them one at a time blocks the main thread for
   minutes. String building plus a single innerHTML assignment is milliseconds.
   (It also removes a real bug: the old version referenced `cols` before its
   own `const cols = r.classes` line, which threw a ReferenceError and silently
   killed the render.)                                                          */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const RANK_TXT = ['seats available', 'RAC only', 'waitlist only', 'closed', 'no data'];
const RANK_CLS = ['ok', 'rac', 'wl', 'closed', 'closed'];

function classify(av) {
  if (!av) return { cls: 'NIL', rank: 4, label: '—' };
  const s = (av.display || '').toUpperCase();
  if (av.kind === '1' || /^AVAILABLE|^AVL|^CURR_AVL/.test(s)) return { cls: 'AVL', rank: 0, label: av.display };
  if (/^RAC/.test(s)) return { cls: 'RAC', rank: 1, label: av.display };
  if (/^WL|GNWL|RLWL|PQWL|RQWL/.test(s)) return { cls: 'WL', rank: 2, label: av.display };
  if (/REGRET|NOT AVAILABLE|^NA$/.test(s)) return { cls: 'REG', rank: 3, label: 'Regret' };
  return { cls: 'NIL', rank: 4, label: av.display || '—' };
}

function cellHTML(av, pending) {
  if (!av) return pending ? '<span class="wait">…</span>' : '<span class="nil">—</span>';
  const c = classify(av);
  let h = `<span class="pill ${c.cls}">${esc(c.label)}</span>`;
  if (av.prediction && c.cls === 'WL') h += `<span class="chance">${esc(av.prediction)}%</span>`;
  if (av.fare) h += `<span class="fare">₹${Math.round(av.fare)}</span>`;

  /* If this date is waitlisted but a nearby date has real seats, say so — that
     is often the only way to travel confirmed. Only the queried date's pill
     keeps the colour, so the row still reads at a glance. */
  if (av.days && av.days.length > 1 && c.cls === 'WL') {
    const better = av.days.slice(1).find(d => {
      const b = classify({ display: d.display, kind: d.kind });
      return b.cls === 'AVL' || b.cls === 'RAC';
    });
    if (better) {
      const b = classify({ display: better.display, kind: better.kind });
      h += `<span class="alt" title="${esc(better.date)}: ${esc(better.display)}">` +
           `${b.cls === 'AVL' ? 'seats' : 'RAC'} on ${esc(shortDate(better.date))}</span>`;
    }
  }
  return h;
}

/* '8-11-2026' -> '8 Nov' */
function shortDate(s) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s || '');
  if (!m) return s || '';
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(m[1], 10)} ${MON[parseInt(m[2], 10) - 1]}`;
}

function bestRank(r) {
  let best = 99;
  for (const k in r.avail) best = Math.min(best, classify(r.avail[k]).rank);
  return best === 99 ? 4 : best;
}

/* `streaming` is true while later stations are still being fetched, so cells
   that have no data yet show a faint "…" instead of a flat dash. */
function render(results, from, to, date, quota, streaming) {
  results.sort((a, b) => bestRank(a) - bestRank(b) || a.train.num.localeCompare(b.train.num));

  const parts = [];
  for (const r of results) {
    const cols = r.classes;
    const rank = bestRank(r);
    const reach = (r.window[r.window.length - 1] || {}).code;
    const name = esc((r.train.name || '').toLowerCase().replace(/\b\w/g, m => m.toUpperCase()));
    const type = r.train.type ? `<span class="type">${esc(String(r.train.type).replace(/_/g, ' ').toLowerCase())}</span>` : '';

    const head =
      `<header>
         <div class="tname"><span class="num">${esc(r.train.num)}</span>${name}${type}</div>
         <div class="tmeta">
           <span>route ${esc(r.train.srcCode || '?')} &rarr; ${esc(r.train.dstCode || '?')}</span>
           <span>reaches ${esc(reach)}</span>
           <span>${r.boardable.length} stations</span>
           <span>${cols.length} classes</span>
           <span class="badge ${RANK_CLS[rank]}">${RANK_TXT[rank]}</span>
           <span class="tog">collapse</span>
         </div>
       </header>`;

    const thead = '<thead><tr>' +
      ['Station', 'Dep', 'Km', 'Day'].map(h => `<th>${h}</th>`).join('') +
      cols.map(c => `<th title="${esc(CLASS_NAMES[c] || '')}">${c}</th>`).join('') +
      '</tr></thead>';

    let body = '';
    for (let i = 0; i < r.boardable.length; i++) {
      const st = r.boardable[i];
      const isYours = st.code === from;
      const before = i < r.srcIdx;
      const cls = isYours ? ' class="hi"' : (before ? ' class="before"' : '');
      const tag = isYours ? '<span class="you">● your stop</span>'
                : before ? '<span class="pre">earlier</span>' : '';
      body += `<tr${cls}>
        <td class="stn"><b>${esc(st.code)}</b><span>${esc(st.name)}</span>${tag}</td>
        <td class="tm">${esc(st.dep || st.arr || '—')}</td>
        <td class="km">${st.km != null ? esc(st.km) : '—'}</td>
        <td class="day">${esc(st.day || '—')}</td>` +
        cols.map(c => `<td class="cls ${c.toLowerCase()}">${cellHTML(r.avail[st.code + '|' + c], streaming && st.code !== from)}</td>`).join('') +
      '</tr>';
    }

    parts.push(`<section class="train ${RANK_CLS[rank]}">${head}
      <div class="scroll"><table>${thead}<tbody>${body}</tbody></table></div></section>`);
  }

  $('#out').innerHTML = parts.join('');

  // collapse toggle, attached now that the sections exist
  $('#out').querySelectorAll('.train > header').forEach(h => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });
}

/* ---------- boot ---------- */

function resolveCode(text) {
  const t = (text || '').trim();
  const inParens = t.match(/\(([A-Za-z0-9]{2,6})\)\s*$/);
  const q = (inParens ? inParens[1] : t).toLowerCase();
  return STATIONS.find(s => s.code.toLowerCase() === q)
      || STATIONS.find(s => s.name.toLowerCase() === t.toLowerCase().replace(/\s*\([^)]*\)\s*$/, ''))
      || null;
}

(function init() {
  const d = new Date(Date.now() + 864e5 * 3);
  $('#date').value = d.toISOString().slice(0, 10);
  loadStations();
  attachSuggest($('#from'), $('#sugFrom'));
  attachSuggest($('#to'), $('#sugTo'));
  // No prefill: the tool covers all of Indian Railways, so it starts empty and
  // waits for the user's own journey.
  $('#from').value = '';
  $('#to').value = '';
  $('#from').placeholder = 'From station';
  $('#to').placeholder = 'To station';
  $('#from').focus();

  $('#f').addEventListener('submit', ev => {
    ev.preventDefault();
    const from = resolveCode($('#from').value);
    const to = resolveCode($('#to').value);
    if (!from || !to) {
      const st = $('#status'); st.className = 'status err';
      st.textContent = 'Pick both stations from the suggestion list.';
      return;
    }
    fromSel = from; toSel = to;
    $('#from').value = `${from.name} (${from.code})`;
    $('#to').value = `${to.name} (${to.code})`;
    const iso = $('#date').value;
    if (!iso) { $('#status').textContent = 'Pick a date.'; return; }
    const [Y, M, D] = iso.split('-');
    run(fromSel.code, toSel.code, `${D}-${M}-${Y}`, $('#quota').value);
  });
})();
