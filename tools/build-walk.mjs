#!/usr/bin/env node
/**
 * OSM -> kavelykelpoisuusrasteri + TARKKA viivageometria kavely- ja rataverkosta.
 *
 * Kaytto: node tools/build-walk.mjs <walk.geojsonseq> <ulostulohakemisto> <bbox>
 *   bbox = "lansi,etela,ita,pohjoinen" asteina
 *
 * Ymparistomuuttujat:
 *   CELL_M      rasterin ruutu metreina (oletus 50)
 *   DILATE      levityskierrokset       (oletus 1)
 *   SIMPLIFY_M  Douglas-Peucker         (oletus 6)
 *
 * Rasteri (walk_grid.bin) on VAIN pinta-alan laskentaa varten:
 *   2 = varsinainen tie, 1 = levitetty kulkualue, 0 = ei kuljettava.
 *
 * Viivageometria on reititysta ja piirtoa varten. Tiedosto luetaan KAHDESTI:
 * ensimmaisella kierroksella lasketaan kuinka monessa vaylassa kukin
 * koordinaatti esiintyy. Risteyspisteet (>=2 esiintymaa) pakotetaan sailymaan
 * yksinkertaistuksessa - muuten Douglas-Peucker poistaisi risteyksen keskelta
 * suoraa katua ja verkko hajoaisi erillisiksi paloiksi.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [, , SEQ, OUT, BBOX] = process.argv;
if (!SEQ || !OUT || !BBOX) {
  console.error('Kaytto: node tools/build-walk.mjs <walk.geojsonseq> <out-dir> <w,s,e,n>');
  process.exit(1);
}

const CELL_M = parseInt(process.env.CELL_M || '50', 10);
const DILATE = parseInt(process.env.DILATE || '1', 10);
const SIMPLIFY_M = parseFloat(process.env.SIMPLIFY_M || '6');

const [W, S, E, N] = BBOX.split(',').map(Number);
const PAD = 0.03;
const R = 6378137;
const toX = lon => R * lon * Math.PI / 180;
const toY = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const toLon = x => x / R * 180 / Math.PI;
const toLat = y => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;

const lat0 = (S + N) / 2;
const kMerc = 1 / Math.cos(lat0 * Math.PI / 180);
const cell = CELL_M * kMerc;
const x0 = toX(W - PAD), x1 = toX(E + PAD);
const y0 = toY(S - PAD), y1 = toY(N + PAD);
const gw = Math.ceil((x1 - x0) / cell), gh = Math.ceil((y1 - y0) / cell);

console.log(`Ruudukko ${gw} x ${gh} (${CELL_M} m), ${(gw * gh / 1e6).toFixed(2)} Mruutua`);
if (gw * gh > 40e6) { console.error('VIRHE: ruudukko liian iso, kasvata CELL_M.'); process.exit(1); }
const g = new Uint8Array(gw * gh);

/* ---------- luokittelu ---------- */

const OK = new Set(['footway', 'path', 'pedestrian', 'steps', 'living_street',
  'residential', 'service', 'unclassified', 'tertiary', 'tertiary_link',
  'secondary', 'secondary_link', 'primary', 'primary_link', 'cycleway',
  'track', 'road', 'crossing', 'corridor', 'platform']);
const RAIL_BIT = { rail: 1, light_rail: 1, narrow_gauge: 1, tram: 2, subway: 4, monorail: 4 };
const YARD = new Set(['yard', 'siding', 'spur', 'crossover']);

function classify(P) {
  if (!P) return null;
  const rb = P.railway ? (RAIL_BIT[P.railway] || 0) : 0;
  const rail = (rb && !YARD.has(P.service)) ? rb : 0;
  let walk = false;
  if (!(P.foot === 'no' || P.access === 'private' || P.access === 'no')) {
    if (P.highway && OK.has(P.highway)) walk = true;
  }
  return (walk || rail) ? { walk, rail } : null;
}

function parts(geom) {
  if (!geom) return [];
  return geom.type === 'LineString' ? [geom.coordinates]
    : geom.type === 'MultiLineString' ? geom.coordinates : [];
}

async function scan(fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(SEQ), crlfDelay: Infinity });
  for await (let ln of rl) {
    if (!ln) continue;
    if (ln.charCodeAt(0) === 0x1e) ln = ln.slice(1);
    if (!ln.startsWith('{')) continue;
    let f; try { f = JSON.parse(ln); } catch { continue; }
    const cls = classify(f.properties);
    if (!cls) continue;
    fn(cls, parts(f.geometry));
  }
}

/* ---------- kierros 1: risteyspisteet ---------- */

const KEYMUL = 20000000;
const seen = new Map();          // koordinaatti -> esiintymia
const junction = new Set();

await scan((cls, ps) => {
  for (const co of ps) {
    for (const c of co) {
      const k = Math.round(toX(c[0])) * KEYMUL + Math.round(toY(c[1]));
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      if (n === 2) junction.add(k);
    }
  }
});
console.log(`Koordinaatteja ${seen.size}, risteyspisteita ${junction.size}`);
seen.clear();

/* ---------- rasterointi ---------- */

function line(ax, ay, bx, by, val) {
  let i0 = Math.round((ax - x0) / cell), j0 = Math.round((ay - y0) / cell);
  const i1 = Math.round((bx - x0) / cell), j1 = Math.round((by - y0) / cell);
  const dx = Math.abs(i1 - i0), sx = i0 < i1 ? 1 : -1;
  const dy = -Math.abs(j1 - j0), sy = j0 < j1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 200000; guard++) {
    if (i0 >= 0 && i0 < gw && j0 >= 0 && j0 < gh) g[j0 * gw + i0] = val;
    if (i0 === i1 && j0 === j1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; i0 += sx; }
    if (e2 <= dx) { err += dx; j0 += sy; }
  }
}

/* ---------- yksinkertaistus risteykset sailyttaen ---------- */

const TOL = SIMPLIFY_M * kMerc;

function simplify(pts, keepFlags, tol) {
  const n = pts.length;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  for (let i = 0; i < n; i++) if (keepFlags[i]) keep[i] = 1;

  // pilkotaan sailytettavien pisteiden valeihin ja karsitaan kukin erikseen
  const anchors = [];
  for (let i = 0; i < n; i++) if (keep[i]) anchors.push(i);
  for (let s = 0; s + 1 < anchors.length; s++) {
    const stack = [[anchors[s], anchors[s + 1]]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const ax = pts[a][0], ay = pts[a][1];
      const ex = pts[b][0] - ax, ey = pts[b][1] - ay;
      const len2 = ex * ex + ey * ey;
      let bi = -1, bd = tol;
      for (let i = a + 1; i < b; i++) {
        const px = pts[i][0] - ax, py = pts[i][1] - ay;
        let d;
        if (len2 === 0) d = Math.hypot(px, py);
        else {
          let t = (px * ex + py * ey) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          d = Math.hypot(px - t * ex, py - t * ey);
        }
        if (d > bd) { bd = d; bi = i; }
      }
      if (bi < 0) continue;
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/* ---------- kierros 2: rasteri + vektorit ---------- */

function newSet() { return { start: [0], AX: [], AY: [], DX: [], DY: [], KIND: [] }; }
const walkV = newSet(), railV = newSet();

function pushWay(V, pts, keepFlags, kind) {
  const sp = simplify(pts, keepFlags, TOL);
  if (sp.length < 2) return;
  let px = Math.round(sp[0][0]), py = Math.round(sp[0][1]);
  V.AX.push(px); V.AY.push(py); V.KIND.push(kind);
  V.DX.push(0); V.DY.push(0);
  for (let i = 1; i < sp.length; i++) {
    const nx = Math.round(sp[i][0]), ny = Math.round(sp[i][1]);
    let ddx = nx - px, ddy = ny - py;
    while (Math.abs(ddx) > 32000 || Math.abs(ddy) > 32000) {
      const f = Math.min(32000 / (Math.abs(ddx) || 1), 32000 / (Math.abs(ddy) || 1));
      const mx = px + Math.round(ddx * f), my = py + Math.round(ddy * f);
      V.DX.push(mx - px); V.DY.push(my - py);
      px = mx; py = my; ddx = nx - px; ddy = ny - py;
    }
    V.DX.push(ddx); V.DY.push(ddy);
    px = nx; py = ny;
  }
  V.start.push(V.DX.length);
}

let nWalk = 0, nRail = 0;
await scan((cls, ps) => {
  for (const co of ps) {
    const mp = co.map(c => [toX(c[0]), toY(c[1])]);
    const flags = mp.map(p => junction.has(Math.round(p[0]) * KEYMUL + Math.round(p[1])) ? 1 : 0);
    if (cls.walk) {
      for (let k = 0; k + 1 < mp.length; k++) line(mp[k][0], mp[k][1], mp[k + 1][0], mp[k + 1][1], 2);
      pushWay(walkV, mp, flags, 1);
      nWalk++;
    }
    if (cls.rail) {                      // sama vayla voi kuulua molempiin
      pushWay(railV, mp, flags, cls.rail);
      nRail++;
    }
  }
});
console.log(`Kavelyvaylia ${nWalk}, rataosuuksia ${nRail}`);
if (nRail < 50) {
  console.error(`\nVAROITUS: rataosuuksia vain ${nRail}. OSM-syotteessa ei ole`);
  console.error(`rautatieaineistoa. Tarkista etta osmium tags-filter sisaltaa w/railway`);
  console.error(`ja etta lahde-pbf kattaa radat.\n`);
}

/* ---------- levitys (vain rasteriin) ---------- */

for (let d = 0; d < DILATE; d++) {
  const src = g.slice();
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    if (src[j * gw + i]) continue;
    let hit = 0;
    for (let dj = -1; dj <= 1 && !hit; dj++) {
      const jj = j + dj; if (jj < 0 || jj >= gh) continue;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di; if (ii < 0 || ii >= gw) continue;
        if (src[jj * gw + ii]) { hit = 1; break; }
      }
    }
    if (hit) g[j * gw + i] = 1;
  }
}
let on = 0, road = 0;
for (let i = 0; i < g.length; i++) { if (g[i]) on++; if (g[i] === 2) road++; }
console.log(`Kavelykelpoisia ruutuja ${on} (${(100 * on / g.length).toFixed(1)} %), joista tieta ${road}`);

/* ---------- kirjoitus ---------- */

fs.mkdirSync(OUT, { recursive: true });
const wb = (n, ta) => {
  fs.writeFileSync(path.join(OUT, n), Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength));
  return ta.byteLength;
};
wb('walk_grid.bin', g);

const emit = (V, pre) => {
  let b = 0;
  b += wb(`${pre}_start.bin`, Uint32Array.from(V.start));
  b += wb(`${pre}_ax.bin`, Int32Array.from(V.AX));
  b += wb(`${pre}_ay.bin`, Int32Array.from(V.AY));
  b += wb(`${pre}_dx.bin`, Int16Array.from(V.DX));
  b += wb(`${pre}_dy.bin`, Int16Array.from(V.DY));
  b += wb(`${pre}_kind.bin`, Uint8Array.from(V.KIND));
  console.log(`${pre}: ${V.AX.length} vaylaa, ${V.DX.length} pistetta, ${(b / 1048576).toFixed(1)} MB`);
  return b;
};
emit(walkV, 'way');
emit(railV, 'rway');

const meta = {
  w: gw, h: gh, cellM: CELL_M, lat0,
  bounds: [toLon(x0), toLat(y0 + gh * cell), toLon(x0 + gw * cell), toLat(y0)],
  mercX0: x0, mercY0: y0, mercCell: cell,
  kMerc, walkableFraction: on / g.length, roadCells: road,
  nWays: walkV.AX.length, nVerts: walkV.DX.length,
  nRailWays: railV.AX.length, nRailVerts: railV.DX.length
};
fs.writeFileSync(path.join(OUT, 'walk_meta.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify({ nWays: meta.nWays, nRailWays: meta.nRailWays }, null, 2));
