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
    for (let k = 0; k + 1 < co.length; k++) {
      line(toX(co[k][0]), toY(co[k][1]), toX(co[k + 1][0]), toY(co[k + 1][1]));
    }
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
fs.writeFileSync(path.join(OUT, 'walk_meta.json'), JSON.stringify(meta, null, 2));
console.log(`walk_grid.bin ${(g.byteLength / 1048576).toFixed(1)} MB`);
console.log(JSON.stringify(meta, null, 2));
