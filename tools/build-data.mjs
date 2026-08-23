#!/usr/bin/env node
/**
 * GTFS -> kompakti binaaripaketti selaimen CSA-hakua varten.
 *
 * Kaytto:  node tools/build-data.mjs <purettu-gtfs-hakemisto> <ulostulohakemisto> [feed-id]
 *
 * Ympäristömuuttujat:
 *   WIN_START   aikaikkunan alku sekunteina keskiyosta (oletus 14400 = 04:00)
 *   WIN_END     aikaikkunan loppu                      (oletus 43200 = 12:00)
 *   WEEKDAY     0=su 1=ma ... 6=la                     (oletus 3 = keskiviikko)
 *   FOOT_M      jalankulkuvaihdon maksimietaisyys, m   (oletus 400)
 *   FOOT_MPS    jalankulun nopeus vaihdoissa, m/s      (oletus 1.2)
 *
 * Ulostulo (structure-of-arrays, jotta selain voi lukea suoraan typed arrayksi):
 *   stops.json      { name, lat, lon } per pysakki
 *   meta.json       paivamaara, lukumaarat, bbox, lisenssit
 *   conn_dep.bin    Uint32  lahtoaika  (sekuntia keskiyosta, voi olla > 86400)
 *   conn_arr.bin    Uint32  saapumisaika
 *   conn_from.bin   Uint32  lahtopysakin indeksi
 *   conn_to.bin     Uint32  saapumispysakin indeksi
 *   conn_trip.bin   Uint32  vuoron indeksi
 *   foot_start.bin  Uint32  CSR-alkuindeksit, pituus nStops+1
 *   foot_to.bin     Uint32  naapuripysakin indeksi
 *   foot_sec.bin    Uint16  kavelyaika sekunteina
 *
 * Yhteydet on jarjestetty LASKEVASTI lahtoajan mukaan -> taaksepain ajettava
 * Connection Scan Algorithm toimii yhdella pyyhkaisylla.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const GTFS = process.argv[2];
const OUT = process.argv[3];
const FEED = process.argv[4] || 'feed';

if (!GTFS || !OUT) {
  console.error('Kaytto: node tools/build-data.mjs <gtfs-dir> <out-dir> [feed-id]');
  process.exit(1);
}

const WIN_START = int(process.env.WIN_START, 4 * 3600);
const WIN_END = int(process.env.WIN_END, 12 * 3600);
const WEEKDAY = int(process.env.WEEKDAY, 3);
const FOOT_M = int(process.env.FOOT_M, 400);
const FOOT_MPS = num(process.env.FOOT_MPS, 1.2);

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

/* ---------- pieni CSV-lukija (kasittelee lainausmerkit) ---------- */

function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

/** Lukee koko tiedoston riveiksi ja kutsuu fn(rowObject). Pienille tiedostoille. */
function readCsv(file, fn) {
  const p = path.join(GTFS, file);
  if (!fs.existsSync(p)) return 0;
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.split(/\r?\n/);
  const head = splitCsv(stripBom(lines[0])).map(s => s.trim());
  const idx = {};
  head.forEach((h, i) => idx[h] = i);
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = splitCsv(lines[i]);
    fn(c, idx);
    n++;
  }
  return n;
}

/** Striimaa ison tiedoston rivi kerrallaan. */
async function streamCsv(file, fn) {
  const p = path.join(GTFS, file);
  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  let idx = null, n = 0;
  for await (const line of rl) {
    if (!line) continue;
    if (idx === null) {
      idx = {};
      splitCsv(stripBom(line)).forEach((h, i) => idx[h.trim()] = i);
      continue;
    }
    fn(splitCsv(line), idx);
    n++;
  }
  return n;
}

/* ---------- 1. valitse palvelupaiva ---------- */

const DAYNAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function ymd(d) {
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// Ensimmainen haluttu viikonpaiva vahintaan 3 vrk paasta (jotta data on varmasti voimassa)
const base = new Date(Date.now() + 3 * 86400000);
base.setUTCHours(12, 0, 0, 0);
while (base.getUTCDay() !== WEEKDAY) base.setUTCDate(base.getUTCDate() + 1);
const DATE = ymd(base);
log(`Kohdepaiva: ${DATE} (${DAYNAMES[WEEKDAY]})`);

const activeServices = new Set();
const dayCol = DAYNAMES[WEEKDAY];

readCsv('calendar.txt', (c, i) => {
  if (c[i[dayCol]] !== '1') return;
  const s = parseInt(c[i.start_date], 10), e = parseInt(c[i.end_date], 10);
  if (DATE >= s && DATE <= e) activeServices.add(c[i.service_id]);
});

readCsv('calendar_dates.txt', (c, i) => {
  if (parseInt(c[i.date], 10) !== DATE) return;
  const t = c[i.exception_type];
  if (t === '1') activeServices.add(c[i.service_id]);
  else if (t === '2') activeServices.delete(c[i.service_id]);
});

if (activeServices.size === 0) {
  console.error(`VIRHE: paivalle ${DATE} ei loytynyt yhtaan voimassaolevaa palvelua.`);
  console.error('Tarkista onko GTFS-paketin voimassaoloikkuna riittavan pitka.');
  process.exit(1);
}
log(`Voimassa olevia service_id:ta: ${activeServices.size}`);

/* ---------- 2. pysakit ---------- */

const stopIdx = new Map();
const stopName = [], stopLat = [], stopLon = [];

readCsv('stops.txt', (c, i) => {
  // location_type 1 = asema, 2..4 = sisaankaynnit yms -> otetaan vain varsinaiset pysakit
  const lt = i.location_type !== undefined ? c[i.location_type] : '0';
  if (lt !== '' && lt !== '0' && lt !== undefined) return;
  const lat = parseFloat(c[i.stop_lat]), lon = parseFloat(c[i.stop_lon]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  stopIdx.set(c[i.stop_id], stopName.length);
  stopName.push(c[i.stop_name] || '');
  stopLat.push(lat);
  stopLon.push(lon);
});
const nStops = stopName.length;
log(`Pysakkeja: ${nStops}`);
if (nStops === 0) { console.error('VIRHE: ei pysakkeja.'); process.exit(1); }

/* ---------- 3. vuorot ---------- */

const tripIdx = new Map();
readCsv('trips.txt', (c, i) => {
  if (!activeServices.has(c[i.service_id])) return;
  tripIdx.set(c[i.trip_id], tripIdx.size);
});
const nTrips = tripIdx.size;
log(`Vuoroja kohdepaivana: ${nTrips}`);
if (nTrips === 0) { console.error('VIRHE: ei vuoroja.'); process.exit(1); }

/* ---------- 4. pysahdykset ---------- */

function hms(s) {
  // "H:MM:SS" tai "HH:MM:SS", voi ylittaa 24 h
  if (!s) return -1;
  let h = 0, m = 0, sec = 0, part = 0, v = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 58) { // ':'
      if (part === 0) h = v; else if (part === 1) m = v;
      part++; v = 0;
    } else if (ch >= 48 && ch <= 57) v = v * 10 + (ch - 48);
  }
  sec = v;
  return h * 3600 + m * 60 + sec;
}

// Kasvavat taulukot
let cap = 1 << 20, len = 0;
let stTrip = new Int32Array(cap), stSeq = new Int32Array(cap),
    stStop = new Int32Array(cap), stArr = new Int32Array(cap), stDep = new Int32Array(cap);

function grow() {
  cap *= 2;
  const g = a => { const b = new Int32Array(cap); b.set(a); return b; };
  stTrip = g(stTrip); stSeq = g(stSeq); stStop = g(stStop); stArr = g(stArr); stDep = g(stDep);
}

const nRaw = await streamCsv('stop_times.txt', (c, i) => {
  const ti = tripIdx.get(c[i.trip_id]);
  if (ti === undefined) return;
  const si = stopIdx.get(c[i.stop_id]);
  if (si === undefined) return;
  const dep = hms(c[i.departure_time]);
  const arr = hms(c[i.arrival_time]);
  if (dep < 0 && arr < 0) return;
  // Karsitaan reilulla marginaalilla, yhteydet suodatetaan tarkemmin myohemmin
  if (arr > WIN_END + 7200 || dep < WIN_START - 7200) return;
  if (len === cap) grow();
  stTrip[len] = ti;
  stSeq[len] = parseInt(c[i.stop_sequence], 10) || 0;
  stStop[len] = si;
  stArr[len] = arr < 0 ? dep : arr;
  stDep[len] = dep < 0 ? arr : dep;
  len++;
});
log(`stop_times riveja luettu: ${nRaw}, ikkunaan osuvia: ${len}`);

// Jarjesta (trip, seq)
const orderArr = new Array(len);
for (let i = 0; i < len; i++) orderArr[i] = i;
orderArr.sort((a, b) => stTrip[a] - stTrip[b] || stSeq[a] - stSeq[b]);
log('Pysahdykset jarjestetty');

/* ---------- 5. yhteydet ---------- */

let cDep = [], cArr = [], cFrom = [], cTo = [], cTrip = [];
for (let k = 0; k + 1 < orderArr.length; k++) {
  const a = orderArr[k], b = orderArr[k + 1];
  if (stTrip[a] !== stTrip[b]) continue;
  const dep = stDep[a], arr = stArr[b];
  if (arr < dep) continue;              // rikkinainen rivi
  if (dep < WIN_START || dep > WIN_END) continue;
  if (stStop[a] === stStop[b]) continue;
  cDep.push(dep); cArr.push(arr);
  cFrom.push(stStop[a]); cTo.push(stStop[b]); cTrip.push(stTrip[a]);
}
const nConn = cDep.length;
log(`Yhteyksia: ${nConn}`);
if (nConn === 0) { console.error('VIRHE: ei yhteyksia aikaikkunassa.'); process.exit(1); }

// Jarjesta laskevasti lahtoajan mukaan
const ci = Array.from({ length: nConn }, (_, i) => i);
ci.sort((a, b) => cDep[b] - cDep[a]);

const DEP = new Uint32Array(nConn), ARR = new Uint32Array(nConn),
      FROM = new Uint32Array(nConn), TO = new Uint32Array(nConn), TRIP = new Uint32Array(nConn);
for (let k = 0; k < nConn; k++) {
  const i = ci[k];
  DEP[k] = cDep[i]; ARR[k] = cArr[i]; FROM[k] = cFrom[i]; TO[k] = cTo[i]; TRIP[k] = cTrip[i];
}
cDep = cArr = cFrom = cTo = cTrip = null;
log('Yhteydet jarjestetty laskevasti');

/* ---------- 6. jalankulkuvaihdot (CSR) ---------- */

const R = 6371000;
const lat0 = stopLat.reduce((s, v) => s + v, 0) / nStops;
const mPerLat = 111320;
const mPerLon = 111320 * Math.cos(lat0 * Math.PI / 180);

// ruudukkoindeksi
const cell = FOOT_M;
const grid = new Map();
const key = (gx, gy) => gx * 100000 + gy;
for (let i = 0; i < nStops; i++) {
  const gx = Math.floor(stopLon[i] * mPerLon / cell);
  const gy = Math.floor(stopLat[i] * mPerLat / cell);
  const k = key(gx, gy);
  let a = grid.get(k);
  if (!a) grid.set(k, a = []);
  a.push(i);
}

const footStart = new Uint32Array(nStops + 1);
const fTo = [], fSec = [];
for (let i = 0; i < nStops; i++) {
  footStart[i] = fTo.length;
  const gx = Math.floor(stopLon[i] * mPerLon / cell);
  const gy = Math.floor(stopLat[i] * mPerLat / cell);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const a = grid.get(key(gx + dx, gy + dy));
    if (!a) continue;
    for (const j of a) {
      if (j === i) continue;
      const ex = (stopLon[j] - stopLon[i]) * mPerLon;
      const ey = (stopLat[j] - stopLat[i]) * mPerLat;
      const d = Math.hypot(ex, ey);
      if (d > FOOT_M) continue;
      fTo.push(j);
      fSec.push(Math.max(1, Math.round(d / FOOT_MPS)));
    }
  }
}
footStart[nStops] = fTo.length;
log(`Jalankulkuvaihtoja: ${fTo.length}`);

/* ---------- 7. kirjoitus ---------- */

fs.mkdirSync(OUT, { recursive: true });
const w = (name, buf) => {
  fs.writeFileSync(path.join(OUT, name), buf);
  return fs.statSync(path.join(OUT, name)).size;
};
const b = ta => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength);

let total = 0;
total += w('conn_dep.bin', b(DEP));
total += w('conn_arr.bin', b(ARR));
total += w('conn_from.bin', b(FROM));
total += w('conn_to.bin', b(TO));
total += w('conn_trip.bin', b(TRIP));
total += w('foot_start.bin', b(footStart));
total += w('foot_to.bin', b(Uint32Array.from(fTo)));
total += w('foot_sec.bin', b(Uint16Array.from(fSec)));

const stops = { name: stopName, lat: stopLat.map(v => +v.toFixed(5)), lon: stopLon.map(v => +v.toFixed(5)) };
total += w('stops.json', JSON.stringify(stops));

function bbox() {
  let w = 180, s = 90, e = -180, n = -90;
  for (let i = 0; i < nStops; i++) {
    if (stopLon[i] < w) w = stopLon[i];
    if (stopLon[i] > e) e = stopLon[i];
    if (stopLat[i] < s) s = stopLat[i];
    if (stopLat[i] > n) n = stopLat[i];
  }
  return [w, s, e, n];
}

const meta = {
  feed: FEED,
  date: String(DATE),
  weekday: DAYNAMES[WEEKDAY],
  windowStart: WIN_START,
  windowEnd: WIN_END,
  nStops, nTrips, nConn, nFoot: fTo.length,
  bbox: bbox(),
  built: new Date().toISOString(),
  attribution: 'Pysakki- ja aikataulutiedot: HSL, CC BY 4.0. Karttapohja: OpenStreetMap-tekijat.'
};
total += w('meta.json', JSON.stringify(meta, null, 2));

log(`Valmis. Yhteensa ${(total / 1048576).toFixed(1)} MB (pakkaamattomana).`);
console.log(JSON.stringify(meta, null, 2));
