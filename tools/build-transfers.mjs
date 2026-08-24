#!/usr/bin/env node
/**
 * Laskee pysakkien valiset jalankulkuvaihdot UUDELLEEN todellista
 * katuverkkoa pitkin ja korvaa build-data.mjs:n linnuntiearviot.
 *
 * Kaytto: node tools/build-transfers.mjs <data-hakemisto> [gtfs-hakemisto]
 *
 * Ymparistomuuttujat:
 *   FOOT_M     maksimietaisyys metreina (oletus 400)
 *   FOOT_MPS   kavelynopeus m/s        (oletus 1.2)
 *
 * Lukee:  stops.json, walk_grid.bin, walk_meta.json, foot_*.bin
 *         seka valinnaisesti transfers.txt (viralliset vahimmaisvaihtoajat)
 * Kirjoittaa: foot_start.bin, foot_to.bin, foot_sec.bin
 *
 * Jos pysakki ei osu kavelyverkkoon lainkaan, sen aiemmat linnuntievaihdot
 * sailytetaan. Verkkohaku voi vain parantaa, ei koskaan pudottaa yhteyksia.
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA = process.argv[2];
const GTFS = process.argv[3] || null;
if (!DATA) { console.error('Kaytto: node tools/build-transfers.mjs <data-dir> [gtfs-dir]'); process.exit(1); }

const FOOT_M = parseInt(process.env.FOOT_M || '400', 10);
const FOOT_MPS = parseFloat(process.env.FOOT_MPS || '1.2');
const MAX_SEC = Math.round(FOOT_M / FOOT_MPS);

const rd = n => { const b = fs.readFileSync(path.join(DATA, n)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const stops = JSON.parse(fs.readFileSync(path.join(DATA, 'stops.json'), 'utf8'));
const wm = JSON.parse(fs.readFileSync(path.join(DATA, 'walk_meta.json'), 'utf8'));
const ok = new Uint8Array(rd('walk_grid.bin'));
const oldStart = new Uint32Array(rd('foot_start.bin'));
const oldTo = new Uint32Array(rd('foot_to.bin'));
const oldSec = new Uint16Array(rd('foot_sec.bin'));

const nStops = stops.lat.length;
const { w: gw, h: gh, mercX0, mercY0, mercCell, cellM } = wm;
const R = 6378137;
const toX = lon => R * lon * Math.PI / 180;
const toY = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

console.log(`Pysakkeja ${nStops}, ruudukko ${gw}x${gh} (${cellM} m), raja ${FOOT_M} m = ${MAX_SEC} s`);

/* --- pysakki -> ruutu, ja ruutu -> pysakit --- */
const stopCell = new Int32Array(nStops).fill(-1);
const cellStops = new Map();
let snapped = 0;
for (let s = 0; s < nStops; s++) {
  let i = Math.round((toX(stops.lon[s]) - mercX0) / mercCell);
  let j = Math.round((toY(stops.lat[s]) - mercY0) / mercCell);
  if (i < 0 || i >= gw || j < 0 || j >= gh) continue;
  let c = -1;
  if (ok[j * gw + i]) c = j * gw + i;
  else outer: for (let r = 1; r <= 3; r++) {
    for (let dj = -r; dj <= r; dj++) {
      const jj = j + dj; if (jj < 0 || jj >= gh) continue;
      for (let di = -r; di <= r; di++) {
        const ii = i + di; if (ii < 0 || ii >= gw) continue;
        if (ok[jj * gw + ii]) { c = jj * gw + ii; break outer; }
      }
    }
  }
  if (c < 0) continue;
  stopCell[s] = c; snapped++;
  let a = cellStops.get(c);
  if (!a) cellStops.set(c, a = []);
  a.push(s);
}
console.log(`Kavelyverkkoon osuvia pysakkeja: ${snapped} (${(100 * snapped / nStops).toFixed(1)} %)`);

/* --- viralliset vahimmaisvaihtoajat --- */
const declared = new Map();
if (GTFS && fs.existsSync(path.join(GTFS, 'transfers.txt'))) {
  const idOf = new Map();     // stops.json ei sisalla id:ta -> luetaan stops.txt uudelleen
  const stxt = fs.readFileSync(path.join(GTFS, 'stops.txt'), 'utf8').split(/\r?\n/);
  const sh = stxt[0].replace(/^\ufeff/, '').split(',').map(x => x.trim());
  const si = sh.indexOf('stop_id'), sla = sh.indexOf('stop_lat'), slo = sh.indexOf('stop_lon');
  let k = 0;
  for (let r = 1; r < stxt.length; r++) {
    if (!stxt[r]) continue;
    const c = stxt[r].split(',');
    if (!Number.isFinite(parseFloat(c[sla])) || !Number.isFinite(parseFloat(c[slo]))) continue;
    idOf.set(c[si], k++);
  }
  const ttxt = fs.readFileSync(path.join(GTFS, 'transfers.txt'), 'utf8').split(/\r?\n/);
  const th = ttxt[0].replace(/^\ufeff/, '').split(',').map(x => x.trim());
  const fi = th.indexOf('from_stop_id'), tti = th.indexOf('to_stop_id'),
        ty = th.indexOf('transfer_type'), mt = th.indexOf('min_transfer_time');
  for (let r = 1; r < ttxt.length; r++) {
    if (!ttxt[r]) continue;
    const c = ttxt[r].split(',');
    const a = idOf.get(c[fi]), b = idOf.get(c[tti]);
    if (a === undefined || b === undefined || a === b) continue;
    if (ty >= 0 && c[ty] === '3') continue;
    const v = mt >= 0 ? parseInt(c[mt], 10) : NaN;
    declared.set(a + '>' + b, Number.isFinite(v) ? v : 60);
  }
  console.log(`transfers.txt: ${declared.size} maariteltya vaihtoa`);
}

/* --- rajattu Dial-haku per pysakki --- */
const cOrt = Math.max(1, Math.round(cellM / FOOT_MPS));
const cDia = Math.max(1, Math.round(cellM * Math.SQRT2 / FOOT_MPS));

const newStart = new Uint32Array(nStops + 1);
const nTo = [], nSec = [];
let netPairs = 0, keptPairs = 0;
const t0 = Date.now();

for (let s = 0; s < nStops; s++) {
  newStart[s] = nTo.length;
  const found = new Map();      // naapuripysakki -> sekuntia

  if (stopCell[s] >= 0) {
    const dist = new Map();
    const buckets = new Array(MAX_SEC + 1);
    const push = (c, d) => {
      if (d > MAX_SEC) return;
      const o = dist.get(c);
      if (o !== undefined && o <= d) return;
      dist.set(c, d);
      (buckets[d] || (buckets[d] = [])).push(c);
    };
    push(stopCell[s], 0);
    for (let d = 0; d <= MAX_SEC; d++) {
      const b = buckets[d];
      if (!b) continue;
      for (let bi = 0; bi < b.length; bi++) {
        const c = b[bi];
        if (dist.get(c) !== d) continue;
        const hit = cellStops.get(c);
        if (hit) for (const q of hit) {
          if (q === s) continue;
          const cur = found.get(q);
          if (cur === undefined || d < cur) found.set(q, Math.max(1, d));
        }
        const j = (c / gw) | 0, i = c - j * gw;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj; if (jj < 0 || jj >= gh) continue;
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ii = i + di; if (ii < 0 || ii >= gw) continue;
            const nc = jj * gw + ii;
            if (!ok[nc]) continue;
            push(nc, d + ((di && dj) ? cDia : cOrt));
          }
        }
      }
      buckets[d] = null;
    }
    netPairs += found.size;
  }

  // Sailyta vanhat parit joita verkko ei loytanyt (esim. pysakki verkon ulkona
  // tai transfers.txt:n maarittelema kaukainen vaihto).
  for (let j = oldStart[s]; j < oldStart[s + 1]; j++) {
    if (!found.has(oldTo[j])) { found.set(oldTo[j], oldSec[j]); keptPairs++; }
  }

  for (const [q, sec] of found) {
    const dec = declared.get(s + '>' + q);
    nTo.push(q);
    nSec.push(Math.min(65535, dec !== undefined ? Math.max(dec, sec) : sec));
  }
}
newStart[nStops] = nTo.length;

console.log(`Vaihtoja: ${nTo.length} (verkosta ${netPairs}, sailytettyja ${keptPairs}) ` +
            `${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`Vanha maara oli ${oldTo.length}`);

const wb = (n, ta) => fs.writeFileSync(path.join(DATA, n), Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength));
wb('foot_start.bin', newStart);
wb('foot_to.bin', Uint32Array.from(nTo));
wb('foot_sec.bin', Uint16Array.from(nSec));
console.log('foot_*.bin korvattu katuverkon mukaisilla ajoilla.');
