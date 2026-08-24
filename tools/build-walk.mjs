#!/usr/bin/env node
/**
 * OSM:n jalankulkuverkko -> kavelykelpoisuusrasteri.
 *
 * Kaytto: node tools/build-walk.mjs <walk.geojsonseq> <ulostulohakemisto> <bbox>
 *   bbox = "lansi,etela,ita,pohjoinen" asteina (esim. meta.json:n bbox)
 *
 * Ymparistomuuttujat:
 *   CELL_M    ruudun koko metreina (oletus 50)
 *   DILATE    kuinka monta ruutua verkkoa levitetaan (oletus 1)
 *
 * Ulostulo:
 *   walk_grid.bin   Uint8, 1 = kavelykelpoinen, 0 = ei
 *   walk_meta.json  ruudukon geometria Web Mercatorissa
 *
 * Periaate: oletuksena mikaan ei ole kavelykelpoista. Vain jalankulkijalle
 * sallitut tiet piirretaan rasteriin ja levitetaan yhdella ruudulla, jotta
 * korttelien sisaosat tulevat mukaan. Vesistot ja moottoritiet jaavat
 * automaattisesti ulos, koska ne eivat ole kavelykelpoisia teita.
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
const SIMPLIFY_M = parseFloat(process.env.SIMPLIFY_M || '6');   // Douglas-Peucker, metria

const [W, S, E, N] = BBOX.split(',').map(Number);
const PAD = 0.03;   // astetta marginaalia reunoille

const R = 6378137;
const toX = lon => R * lon * Math.PI / 180;
const toY = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const toLon = x => x / R * 180 / Math.PI;
const toLat = y => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;

const lat0 = (S + N) / 2;
const kMerc = 1 / Math.cos(lat0 * Math.PI / 180);      // merc-yksikkoa / todellinen metri
const cell = CELL_M * kMerc;

const x0 = toX(W - PAD), x1 = toX(E + PAD);
const y0 = toY(S - PAD), y1 = toY(N + PAD);
const gw = Math.ceil((x1 - x0) / cell);
const gh = Math.ceil((y1 - y0) / cell);

console.log(`Ruudukko ${gw} x ${gh} (${CELL_M} m), ${(gw * gh / 1e6).toFixed(2)} Mruutua`);
if (gw * gh > 40e6) { console.error('VIRHE: ruudukko liian iso, kasvata CELL_M.'); process.exit(1); }

const g = new Uint8Array(gw * gh);

/* --- vektorigeometria piirtoa varten --- */
const wayStart = [0];
const AX = [], AY = [], DX = [], DY = [];
const TOL = SIMPLIFY_M * kMerc;

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const ex = bx - ax, ey = by - ay;
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
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function pushWay(pts) {
  const sp = simplify(pts, TOL);
  if (sp.length < 2) return;
  let px = Math.round(sp[0][0]), py = Math.round(sp[0][1]);
  AX.push(px); AY.push(py);
  DX.push(0); DY.push(0);
  for (let i = 1; i < sp.length; i++) {
    const nx = Math.round(sp[i][0]), ny = Math.round(sp[i][1]);
    let ddx = nx - px, ddy = ny - py;
    // Int16 ei riita hyvin pitkiin suoriin -> pilkotaan
    while (Math.abs(ddx) > 32000 || Math.abs(ddy) > 32000) {
      const f = Math.min(32000 / (Math.abs(ddx) || 1), 32000 / (Math.abs(ddy) || 1));
      const mx = px + Math.round(ddx * f), my = py + Math.round(ddy * f);
      DX.push(mx - px); DY.push(my - py);
      px = mx; py = my; ddx = nx - px; ddy = ny - py;
    }
    DX.push(ddx); DY.push(ddy);
    px = nx; py = ny;
  }
  wayStart.push(DX.length);
}

/* --- sallitut tietyypit --- */
const OK = new Set(['footway', 'path', 'pedestrian', 'steps', 'living_street',
  'residential', 'service', 'unclassified', 'tertiary', 'tertiary_link',
  'secondary', 'secondary_link', 'primary', 'primary_link', 'cycleway',
  'track', 'road', 'crossing', 'corridor', 'platform']);

function walkable(p) {
  if (!p) return false;
  if (p.foot === 'no' || p.access === 'private' || p.access === 'no') return false;
  if (p.highway && OK.has(p.highway)) return true;
  return false;
}

/* --- viivan rasterointi (Bresenham) --- */
function line(ax, ay, bx, by) {
  let i0 = Math.round((ax - x0) / cell), j0 = Math.round((ay - y0) / cell);
  const i1 = Math.round((bx - x0) / cell), j1 = Math.round((by - y0) / cell);
  const dx = Math.abs(i1 - i0), sx = i0 < i1 ? 1 : -1;
  const dy = -Math.abs(j1 - j0), sy = j0 < j1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 100000; guard++) {
    if (i0 >= 0 && i0 < gw && j0 >= 0 && j0 < gh) g[j0 * gw + i0] = 2;   // 2 = varsinainen tie
    if (i0 === i1 && j0 === j1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; i0 += sx; }
    if (e2 <= dx) { err += dx; j0 += sy; }
  }
}

/* --- luetaan GeoJSON-seq --- */
const rl = readline.createInterface({
  input: fs.createReadStream(SEQ), crlfDelay: Infinity
});

let nWays = 0, nUsed = 0;
for await (let ln of rl) {
  if (!ln) continue;
  if (ln.charCodeAt(0) === 0x1e) ln = ln.slice(1);   // RS-erotin
  if (!ln.startsWith('{')) continue;
  let f;
  try { f = JSON.parse(ln); } catch { continue; }
  nWays++;
  if (!walkable(f.properties)) continue;
  const geom = f.geometry;
  if (!geom) continue;
  const parts = geom.type === 'LineString' ? [geom.coordinates]
    : geom.type === 'MultiLineString' ? geom.coordinates : [];
  for (const co of parts) {
    const mp = co.map(c => [toX(c[0]), toY(c[1])]);
    for (let k = 0; k + 1 < mp.length; k++) line(mp[k][0], mp[k][1], mp[k + 1][0], mp[k + 1][1]);
    pushWay(mp);
  }
  nUsed++;
}
console.log(`Vaylia luettu: ${nWays}, kavelykelpoisia: ${nUsed}`);

/* --- levitys --- */
for (let d = 0; d < DILATE; d++) {
  const src = g.slice();
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      if (src[j * gw + i]) continue;
      let hit = 0;
      for (let dj = -1; dj <= 1 && !hit; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= gh) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di; if (ii < 0 || ii >= gw) continue;
          if (src[jj * gw + ii]) { hit = 1; break; }
        }
      }
      if (hit) g[j * gw + i] = 1;   // 1 = levitetty, kuljettava mutta ei piirrettava
    }
  }
}

let on = 0, road = 0;
for (let i = 0; i < g.length; i++) { if (g[i]) on++; if (g[i] === 2) road++; }
console.log(`Kavelykelpoisia ruutuja: ${on} (${(100 * on / g.length).toFixed(1)} %), joista tieta ${road}`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'walk_grid.bin'), Buffer.from(g.buffer, 0, g.byteLength));
const meta = {
  w: gw, h: gh, cellM: CELL_M, lat0,
  bounds: [toLon(x0), toLat(y0 + gh * cell), toLon(x0 + gw * cell), toLat(y0)],
  mercX0: x0, mercY0: y0, mercCell: cell,
  walkableFraction: on / g.length, roadCells: road
};
// vektoriviivat
const nWaysOut = AX.length;
const wb = (name, ta) => {
  fs.writeFileSync(path.join(OUT, name), Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength));
  return ta.byteLength;
};
let vb = 0;
vb += wb('way_start.bin', Uint32Array.from(wayStart));
vb += wb('way_ax.bin', Int32Array.from(AX));
vb += wb('way_ay.bin', Int32Array.from(AY));
vb += wb('way_dx.bin', Int16Array.from(DX));
vb += wb('way_dy.bin', Int16Array.from(DY));
meta.nWays = nWaysOut;
meta.nVerts = DX.length;
console.log(`Vektoriviivoja: ${nWaysOut} vaylaa, ${DX.length} pistetta, ${(vb / 1048576).toFixed(1)} MB`);

fs.writeFileSync(path.join(OUT, 'walk_meta.json'), JSON.stringify(meta, null, 2));
console.log(`walk_grid.bin ${(g.byteLength / 1048576).toFixed(1)} MB`);
console.log(JSON.stringify(meta, null, 2));
