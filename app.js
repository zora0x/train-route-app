/* Board Anywhere — client-side only. No server, no API key.
   Routes/station list: erail.in  (CORS: access-control-allow-origin: *)
   Live availability:   cttrainsapi.confirmtkt.com/api/v1/availability/fetchAvailability  (CORS: *)

   Both tolerate high concurrency: 532 calls at 32 workers finished in ~3s with zero
   errors, so every class is fetched for every station in parallel.                     */

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
// stations at/after which a train has left the Chandigarh corridor
const TERMINALS = ['CDG', 'UMB', 'RPJ', 'LDH', 'JUC', 'ASR', 'KLK', 'JAT', 'SVDK', 'AADR', 'CNDM'];

const CONCURRENCY = 24;          // measured safe; both APIs stayed at 200 even at 32

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
    trainId: f[27], distKm: f[33], type: f[26]
  };
}

async function trainRoute(trainId) {
  const txt = await fetch(ERAIL_ROUTE(trainId)).then(r => r.text());
  const stops = [];
  for (const part of txt.split('~^').slice(1)) {
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

/* ---------- ConfirmTkt availability (every class) ---------- */

async function availability(trainNo, cls, from, to, date, quota) {
  const p = new URLSearchParams({
    trainNo, travelClass: cls, quota,
    sourceStationCode: from, destinationStationCode: to,
    dateOfJourney: date,                       // DD-MM-YYYY — anything else errors
    enableTG: 'false', tGPlan: '', showTGPrediction: 'false',
    tgColor: 'DEFAULT', showPredictionGlobal: 'true',
    showNewMealOptions: 'true', showNewAlternates: 'false', showNewAltText: 'true'
  });
  const r = await fetch(`${CT_AVAIL}?${p}`, {
    method: 'POST', body: '', headers: { 'Content-Type': 'application/json' }
  });
  if (!r.ok) return null;
  const j = await r.json();
  const d = j && j.data;
  if (!d || !d.avlDayList || !d.avlDayList.length) return null;
  const today = d.avlDayList[0];            // index 0 = the queried date
  const fare = d.fareInfo || {};
  return {
    status: today.availablityStatus,
    display: today.availabilityDisplayName || today.availablityStatus,
    prediction: today.predictionPercentage,
    predictionText: today.predictionDisplayName,
    kind: today.availablityType,
    fare: fare.totalFare,
    baseFare: fare.baseFare,
    distance: d.distance
  };
}

function classify(av) {
  if (!av) return { cls: 'NIL', rank: 4, label: '—' };
  const s = (av.display || '').toUpperCase();
  if (av.kind === '1' || /^AVAILABLE|^AVL|^CURR_AVL/.test(s)) return { cls: 'AVL', rank: 0, label: av.display };
  if (/^RAC/.test(s)) return { cls: 'RAC', rank: 1, label: av.display };
  if (/^WL|GNWL|RLWL|PQWL|RQWL/.test(s)) return { cls: 'WL', rank: 2, label: av.display };
  if (/REGRET|NOT AVAILABLE|^NA$/.test(s)) return { cls: 'REG', rank: 3, label: 'Regret' };
  return { cls: 'NIL', rank: 4, label: av.display || '—' };
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

  // metadata + route for every train, in parallel
  const metas = await pool(list, t => trainMeta(t.num));
  const enriched = list.map((t, i) => Object.assign({}, metas[i] || t, { stops: [] }));
  const routes = await pool(enriched, async t => t.trainId ? await trainRoute(t.trainId) : []);
  enriched.forEach((t, i) => { t.stops = routes[i] || []; });

  const trains = enriched.filter(t => t.stops.length);
  if (!trains.length) { say('Could not load any routes.', 'err'); bar.hidden = true; return; }

  // Station window: from the user's origin through to the destination. Stops beyond
  // the destination stay in — finding seats from those is the whole point.
  const results = [];
  for (const t of trains) {
    const codes = t.stops.map(s => s.code);
    const start = codes.indexOf(from);
    if (start < 0) continue;
    let end = codes.indexOf(to, start);
    if (end < 0) {
      end = start;
      for (let i = start; i < codes.length; i++) {
        if (TERMINALS.includes(codes[i])) { end = i; break; }
        end = i;
      }
    }
    const window = t.stops.slice(start, end + 1);
    const boardable = window.slice(0, -1);
    if (!boardable.length) continue;
    results.push({ train: t, window, boardable, avail: {} });
  }

  if (!results.length) {
    say('None of those trains serve ' + from + '.', 'err'); bar.hidden = true; return;
  }

  // every class, every boarding station — all in parallel
  const jobs = [];
  for (const r of results) {
    for (const st of r.boardable) {
      for (const cls of CLASSES) jobs.push({ r, st, cls });
    }
  }
  const stationCount = results.reduce((a, r) => a + r.boardable.length, 0);
  prog(15, `Checking all ${CLASSES.length} classes from ${stationCount} stations (${jobs.length} requests) …`);

  await pool(jobs, async ({ r, st, cls }) => {
    const av = await availability(r.train.num, cls, st.code, to, date, quota);
    if (av) r.avail[st.code + '|' + cls] = av;
  }, (done, total) => prog(15 + 80 * done / total, `Availability ${done}/${total}`));

  prog(97, 'Rendering …');
  render(results, from, to, date, quota);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  prog(100, `Done — ${results.length} trains, ${stationCount} boarding stations, ` +
            `${CLASSES.length} classes each, in ${secs}s.`);
  bar.hidden = true;
}

/* ---------- render ---------- */

function bestRank(r) {
  let best = 99;
  for (const k in r.avail) best = Math.min(best, classify(r.avail[k]).rank);
  return best === 99 ? 4 : best;
}

function cell(av) {
  if (!av) return el('span', 'nil', '—');
  const c = classify(av);
  const wrap = el('span');
  wrap.append(el('span', 'pill ' + c.cls, c.label));
  if (av.prediction && c.cls === 'WL') wrap.append(el('span', 'chance', av.prediction + '%'));
  if (av.fare) wrap.append(el('span', 'fare', '₹' + Math.round(av.fare)));
  return wrap;
}

function render(results, from, to, date, quota) {
  const out = $('#out');
  results.sort((a, b) => bestRank(a) - bestRank(b) || a.train.num.localeCompare(b.train.num));

  for (const r of results) {
    const rank = bestRank(r);
    const badgeTxt = ['seats available', 'RAC only', 'waitlist only', 'closed', 'no data'][rank];
    const badgeCls = ['ok', 'rac', 'wl', 'closed', 'closed'][rank];
    const reach = (r.window[r.window.length - 1] || {}).code;

    const sec = el('section', 'train ' + badgeCls);
    const head = el('header');
    const left = el('div', 'tname');
    left.append(el('span', 'num', r.train.num));
    left.append(document.createTextNode((r.train.name || '').toLowerCase().replace(/\b\w/g, m => m.toUpperCase())));
    if (r.train.type) left.append(el('span', 'type', String(r.train.type).replace(/_/g, ' ').toLowerCase()));
    const right = el('div', 'tmeta');
    right.append(el('span', null, `route ${r.train.srcCode || '?'} → ${r.train.dstCode || '?'}`));
    right.append(el('span', null, `reaches ${reach}`));
    right.append(el('span', null, `${r.boardable.length} stations`));
    right.append(el('span', 'badge ' + badgeCls, badgeTxt));
    right.append(el('span', 'tog', 'collapse'));
    head.append(left, right);

    const sc = el('div', 'scroll');
    const tbl = el('table');
    const thead = el('thead');
    const htr = el('tr');
    ['Station', 'Dep', 'Km', 'Day'].forEach(h => htr.append(el('th', null, h)));
    for (const c of CLASSES) htr.append(el('th', null, c));
    thead.append(htr); tbl.append(thead);

    const tb = el('tbody');
    for (const st of r.boardable) {
      const tr = el('tr');
      if (st.code === from) tr.className = 'hi';
      const stn = el('td', 'stn');
      stn.append(el('b', null, st.code), el('span', null, st.name));
      if (st.code === from) stn.append(el('span', 'you', '● here'));
      tr.append(stn);
      tr.append(el('td', 'tm', st.dep || st.arr || '—'));
      tr.append(el('td', 'km', st.km != null ? st.km : '—'));
      tr.append(el('td', 'day', st.day || '—'));
      for (const cls of CLASSES) {
        const td = el('td', 'cls ' + cls.toLowerCase());
        td.append(cell(r.avail[st.code + '|' + cls]));
        tr.append(td);
      }
      tb.append(tr);
    }
    tbl.append(tb); sc.append(tbl);

    head.onclick = () => sec.classList.toggle('collapsed');
    sec.append(head, sc);
    out.append(sec);
  }
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
  $('#from').value = 'Kanpur Central (CNB)';
  $('#to').value = 'Chandigarh (CDG)';

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
