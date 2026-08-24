#!/usr/bin/env node
/**
 * OSM-vaylageometria -> tarkka reititettava verkko (solmut + kaaret).
 *
 * Kaytto: node tools/build-graph.mjs <walk.geojsonseq> <data-hakemisto>
 *
 * Ymparistomuuttujat:
 *   SIMPLIFY_M   Douglas-Peucker toleranssi, m (oletus 4). Risteyssolmut
 *                sailytetaan aina, joten yhtenaisyys ei riko.
 *
 * Ulostulo:
 *   g_node_x.bin      Int32   solmun mercator-X metreina
 *   g_node_y.bin      Int32   solmun mercator-Y
 *   g_edge_start.bin  Uint32  CSR-alkuindeksit, pituus nNodes+1
 *   g_edge_to.bin     Uint32  naapurisolmu
 *   g_edge_len.bin    Uint16  todellinen pituus metreina (katkaistu 65535:een)
 *   g_edge_mode.bin   Uint8   1 = kavely, 2 = rautatie, 4 = raitiotie, 8 = metro
 *   g_meta.json
 *
 * TARKEAA: risteykset tunnistetaan siita etta kaksi vaylaa jakaa TASMALLEEN
 * saman koordinaatin. OSM:ssa ne jakavat saman solmun, joten kvantisoinnin
 * jalkeen koordinaatit ovat identtiset. Ilman tata verkko hajoaisi
 * yhdistymattomiksi paloiksi.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [, , SEQ, OUT] = process.argv;
if (!SEQ || !OUT) { console.error('Kaytto: node tools/build-graph.mjs <geojsonseq> <data-dir>'); process.exit(1); }

const SIMPLIFY_M = parseFloat(process.env.SIMPLIFY_M || '4');

const R = 6378137;
const toX = lon => R * lon * Math.PI / 180;
const toY = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

const WALK_OK = new Set(['footway', 'path', 'pedestrian', 'steps', 'living_street',
  'residential', 'service', 'unclassified', 'tertiary', 'tertiary_link',
  'secondary', 'secondary_link', 'primary', 'primary_link', 'cycleway',
  'track', 'road', 'crossing', 'corridor', 'platform']);
const RAIL_BIT = { rail: 2, light_rail: 2, narrow_gauge: 2, tram: 4, subway: 8, monorail: 8 };

function modeOf(p) {
  if (!p) return 0;
  if (p.railway) {
    if (p.service === 'yard' || p.service === 'siding' || p.service === 'spur') return 0;
    return RAIL_BIT[p.railway] || 0;
  }
  if (p.foot === 'no' || p.access === 'private' || p.access === 'no') return 0;
  if (p.highway && WALK_OK.has(p.highway)) return 1;
  return 0;
}

const KEY = 33554432;                       // 2^25, riittaa mercator-metreille
const key = (x, y) => x * KEY + y;

/* ---------- vaihe 1: lue vaylat ja laske koordinaattien esiintymat ---------- */

const ways = [];                            // { m, pts: [[x,y],...] }
const seen = new Map();                     // key -> esiintymien maara

async function readWays() {
  const rl = readline.createInterface({ input: fs.createReadStream(SEQ), crlfDelay: Infinity });
  let n = 0;
  for await (let ln of rl) {
    if (!ln) continue;
    if (ln.charCodeAt(0) === 0x1e) ln = ln.slice(1);
    if (!ln.startsWith('{')) continue;
    let f; try { f = JSON.parse(ln); } catch { continue; }
    const m = modeOf(f.properties);
    if (!m) continue;
    const g = f.geometry;
    if (!g) continue;
    const parts = g.type === 'LineString' ? [g.coordinates]
      : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const co of parts) {
      if (co.length < 2) continue;
      const pts = [];
      let px = NaN, py = NaN;
      for (const c of co) {
        const x = Math.round(toX(c[0])), y = Math.round(toY(c[1]));
        if (x === px && y === py) continue;
        pts.push([x, y]); px = x; py = y;
      }
      if (pts.length < 2) continue;
      ways.push({ m, pts });
      for (const [x, y] of pts) {
        const k = key(x, y);
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      n++;
    }
  }
  return n;
}

const nWays = await readWays();
console.log(`Vaylia: ${nWays}, koordinaattipisteita: ${seen.size}`);

/* ---------- vaihe 2: harvennus, risteykset sailyttaen ---------- */

function simplify(pts, tol, keepFlag) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  for (let i = 1; i < pts.length - 1; i++) if (keepFlag[i]) keep[i] = 1;

  // DP jokaiselle sailytettyjen pisteiden valiselle jaksolle
  const anchors = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) anchors.push(i);
  for (let a = 0; a + 1 < anchors.length; a++) {
    const s0 = anchors[a], s1 = anchors[a + 1];
    const stack = [[s0, s1]];
    while (stack.length) {
      const [p, q] = stack.pop();
      if (q - p < 2) continue;
      const ax = pts[p][0], ay = pts[p][1], ex = pts[q][0] - ax, ey = pts[q][1] - ay;
      const len2 = ex * ex + ey * ey;
      let bi = -1, bd = tol;
      for (let i = p + 1; i < q; i++) {
        const dx = pts[i][0] - ax, dy = pts[i][1] - ay;
        let d;
        if (len2 === 0) d = Math.hypot(dx, dy);
        else {
          let t = (dx * ex + dy * ey) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          d = Math.hypot(dx - t * ex, dy - t * ey);
        }
        if (d > bd) { bd = d; bi = i; }
      }
      if (bi < 0) continue;
      keep[bi] = 1;
      stack.push([p, bi], [bi, q]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// mercator-yksikko != metri; jaetaan leveyspiirin mukaan
const midY = (() => { let s = 0, n = 0; for (const w of ways) { s += w.pts[0][1]; n++; } return n ? s / n : 8400000; })();
const midLat = (2 * Math.atan(Math.exp(midY / R)) - Math.PI / 2);
const kMerc = 1 / Math.cos(midLat);
const TOL = SIMPLIFY_M * kMerc;

let kept = 0;
for (const w of ways) {
  const flag = w.pts.map(([x, y]) => (seen.get(key(x, y)) || 0) > 1 ? 1 : 0);
  w.pts = simplify(w.pts, TOL, flag);
  kept += w.pts.length;
}
console.log(`Harvennuksen jalkeen pisteita: ${kept} (toleranssi ${SIMPLIFY_M} m, risteykset sailytetty)`);

/* ---------- vaihe 3: solmut ja kaaret ---------- */

const nodeId = new Map();
const NX = [], NY = [];
const idOf = (x, y) => {
  const k = key(x, y);
  let id = nodeId.get(k);
  if (id === undefined) { id = NX.length; nodeId.set(k, id); NX.push(x); NY.push(y); }
  return id;
};

const eFrom = [], eTo = [], eLen = [], eMode = [];
for (const w of ways) {
  for (let i = 0; i + 1 < w.pts.length; i++) {
    const a = idOf(w.pts[i][0], w.pts[i][1]);
    const b = idOf(w.pts[i + 1][0], w.pts[i + 1][1]);
    if (a === b) continue;
    const dx = (w.pts[i + 1][0] - w.pts[i][0]) / kMerc;
    const dy = (w.pts[i + 1][1] - w.pts[i][1]) / kMerc;
    const len = Math.min(65535, Math.max(1, Math.round(Math.hypot(dx, dy))));
    eFrom.push(a, b); eTo.push(b, a); eLen.push(len, len); eMode.push(w.m, w.m);
  }
}
const nNodes = NX.length, nEdges = eTo.length;
console.log(`Solmuja: ${nNodes}, kaaria: ${nEdges} (molempiin suuntiin)`);

// CSR
const start = new Uint32Array(nNodes + 1);
for (let i = 0; i < nEdges; i++) start[eFrom[i] + 1]++;
for (let i = 0; i < nNodes; i++) start[i + 1] += start[i];
const ETO = new Uint32Array(nEdges), ELEN = new Uint16Array(nEdges), EMODE = new Uint8Array(nEdges);
const fill = start.slice();
for (let i = 0; i < nEdges; i++) {
  const p = fill[eFrom[i]]++;
  ETO[p] = eTo[i]; ELEN[p] = eLen[i]; EMODE[p] = eMode[i];
}

/* ---------- vaihe 4: pysakkien lahin solmu ---------- */

const stopsPath = path.join(OUT, 'stops.json');
let stopNode = null, stopRail = null;
if (fs.existsSync(stopsPath)) {
  const stops = JSON.parse(fs.readFileSync(stopsPath, 'utf8'));
  const n = stops.lat.length;
  stopNode = new Int32Array(n).fill(-1);
  stopRail = new Int32Array(n).fill(-1);

  // ruutuindeksi solmuille (500 m ruutu)
  const CELL = 500 * kMerc;
  const gridW = new Map(), gridR = new Map();
  const gk = (x, y) => Math.floor(x / CELL) * 100000 + Math.floor(y / CELL);
  const nodeMode = new Uint8Array(nNodes);
  for (let i = 0; i < nEdges; i++) nodeMode[ETO[i]] |= EMODE[i];
  for (let i = 0; i < nNodes; i++) {
    const k = gk(NX[i], NY[i]);
    if (nodeMode[i] & 1) { let a = gridW.get(k); if (!a) gridW.set(k, a = []); a.push(i); }
    if (nodeMode[i] & 14) { let a = gridR.get(k); if (!a) gridR.set(k, a = []); a.push(i); }
  }
  const nearest = (grid, x, y, maxM) => {
    let best = -1, bd = (maxM * kMerc) ** 2;
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    const r = Math.ceil(maxM * kMerc / CELL);
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      const a = grid.get((gx + dx) * 100000 + (gy + dy));
      if (!a) continue;
      for (const i of a) {
        const d = (NX[i] - x) ** 2 + (NY[i] - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  };
  let okW = 0, okR = 0;
  for (let s = 0; s < n; s++) {
    const x = toX(stops.lon[s]), y = toY(stops.lat[s]);
    stopNode[s] = nearest(gridW, x, y, 250); if (stopNode[s] >= 0) okW++;
    stopRail[s] = nearest(gridR, x, y, 400); if (stopRail[s] >= 0) okR++;
  }
  console.log(`Pysakkeja kavelyverkkoon: ${okW}/${n}, rataverkkoon: ${okR}/${n}`);
}

/* ---------- kirjoitus ---------- */

fs.mkdirSync(OUT, { recursive: true });
const wb = (name, ta) => {
  fs.writeFileSync(path.join(OUT, name), Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength));
  return ta.byteLength;
};
let total = 0;
total += wb('g_node_x.bin', Int32Array.from(NX));
total += wb('g_node_y.bin', Int32Array.from(NY));
total += wb('g_edge_start.bin', start);
total += wb('g_edge_to.bin', ETO);
total += wb('g_edge_len.bin', ELEN);
total += wb('g_edge_mode.bin', EMODE);
if (stopNode) { total += wb('g_stop_node.bin', stopNode); total += wb('g_stop_rail.bin', stopRail); }

const meta = { nNodes, nEdges, simplifyM: SIMPLIFY_M, kMerc, bytes: total };
fs.writeFileSync(path.join(OUT, 'g_meta.json'), JSON.stringify(meta, null, 2));
console.log(`Verkko kirjoitettu, ${(total / 1048576).toFixed(1)} MB pakkaamattomana.`);
