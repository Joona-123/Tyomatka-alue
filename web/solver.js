/**
 * Taaksepain ajettava Connection Scan Algorithm, matkan rekonstruointi ja
 * katuverkkoa seuraava saavutettavuusruudukko.
 * Ei riippuvuuksia, ei DOM:ia -> ajettavissa myos Nodessa testeissa.
 */

const R_EARTH = 6378137;

export const lonToMerc = lon => R_EARTH * lon * Math.PI / 180;
export const latToMerc = lat => R_EARTH * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
export const mercToLon = x => x / R_EARTH * 180 / Math.PI;
export const mercToLat = y => (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) * 180 / Math.PI;

/* ------------------------------------------------------------------ */
/* 1. CSA                                                              */
/* ------------------------------------------------------------------ */

/**
 * Taaksepain ajettava CSA, jossa nousujen lukumaara on OMA ULOTTUVUUTENSA.
 *
 * Aiempi versio piti kirjaa vain parhaan (myohaisimman) labelin nousumaarasta.
 * Se on ahne: jos pysakin paras label syntyi kolmella nousulla, kahden nousun
 * vaihtoehto katosi kokonaan eika rajaus toiminut oikein. Nyt jokaiselle
 * nousumaaralle 0..maxBoards pidetaan oma label, jolloin rajaus on tarkka.
 *
 * Taso b = "korkeintaan b nousua jaljella maaliin asti".
 * Kavely ei ole nousu.
 */
export function csaBackward(D, o) {
  const { DEP, ARR, FROM, TO, TRIP, footStart, footTo, footSec, nStops, nTrips } = D;
  const minTransfer = o.minTransfer ?? 120;
  const earliest = o.earliest ?? 0;

  const maxBoards = (o.maxTransfers == null || o.maxTransfers < 0)
    ? 6 : Math.max(1, Math.min(6, o.maxTransfers + 1));
  const nLevels = maxBoards + 1;

  // Kavelybudjetti koskee KOKO matkaa, ei yksittaista osuutta.
  const maxWalk = o.maxWalkSec == null ? 1e9 : o.maxWalkSec;

  const L = new Int32Array(nLevels * nStops).fill(-1);
  const VC = new Int32Array(nLevels * nStops).fill(-1);
  const VF = new Int32Array(nLevels * nStops).fill(-1);
  const WK = new Int32Array(nLevels * nStops).fill(0);   // kavelya talta pysakilta maaliin
  const onTripL = new Uint8Array(nLevels * nTrips);
  const isTarget = new Uint8Array(nStops);
  const targetWalk = new Int32Array(nStops).fill(-1);

  // Paivitys tasolle b leviaa aina ylospain: >=b nousua sallivat tasot
  // saavat saman vaihtoehdon ilmaiseksi. Katkaisu sailyttaa monotonisuuden.
  const put = (b, s, time, conn, foot, walk) => {
    if (walk > maxWalk) return;              // budjetti ylittyy -> label kelvoton
    for (let bb = b; bb < nLevels; bb++) {
      const off = bb * nStops + s;
      if (time <= L[off]) break;
      L[off] = time; VC[off] = conn; VF[off] = foot; WK[off] = walk;
    }
  };

  for (const [s, walkSec] of o.sources) {
    isTarget[s] = 1;
    if (targetWalk[s] < 0 || walkSec < targetWalk[s]) targetWalk[s] = walkSec;
    put(0, s, o.arriveBy - walkSec, -1, -1, walkSec);
  }
  for (const [s] of o.sources) {
    const base = L[s], bw = WK[s];
    for (let j = footStart[s], e = footStart[s + 1]; j < e; j++) {
      put(0, footTo[j], base - footSec[j], -1, s, bw + footSec[j]);
    }
  }

  const n = DEP.length;
  for (let i = 0; i < n; i++) {
    const dep = DEP[i];
    if (dep < earliest) break;
    const tr = TRIP[i], f = FROM[i], t = TO[i], arr = ARR[i];

    for (let b = 1; b < nLevels; b++) {
      const ti2 = b * nTrips + tr;
      let usable = onTripL[ti2] === 1;
      if (!usable) {
        const lt = L[(b - 1) * nStops + t];      // poistuminen: yksi nousu kaytetty
        usable = lt >= 0 && arr + minTransfer <= lt;
      }
      if (!usable) continue;
      onTripL[ti2] = 1;

      const wk = WK[(b - 1) * nStops + t];      // kavely poistumisen jalkeen
      if (wk > maxWalk) continue;
      if (dep > L[b * nStops + f]) {
        put(b, f, dep, i, -1, wk);
        for (let j = footStart[f], e = footStart[f + 1]; j < e; j++) {
          put(b, footTo[j], dep - footSec[j], -1, f, wk + footSec[j]);
        }
      }
    }
  }

  const top = maxBoards * nStops;
  return {
    latest: L.subarray(top, top + nStops),
    viaConn: VC.subarray(top, top + nStops),
    viaFoot: VF.subarray(top, top + nStops),
    walkUsed: WK.subarray(top, top + nStops),
    L, VC, VF, WK, nLevels, nStops,
    isTarget, targetWalk, arriveBy: o.arriveBy
  };
}

/* ------------------------------------------------------------------ */
/* 2. Matkan rekonstruointi                                            */
/* ------------------------------------------------------------------ */

/**
 * Vuoro -> sen yhteydet vuoron sisaisessa jarjestyksessa (CSR).
 *
 * HUOM: aiemmin tama luotti globaaliin lahtoaikajarjestykseen ja kaansi sen.
 * Se rikkoutuu heti kun kahdella saman vuoron perakkaisella valilla on sama
 * lahtoaika, koska lajittelun tasapelijarjestys on maarittelematon -> pysakit
 * tulivat vaaraan jarjestykseen. Nyt lajitellaan SEQ:n mukaan, joka on
 * kirjoitettu suoraan stop_sequence-jarjestyksesta.
 */
export function tripIndex(D) {
  const { TRIP, SEQ, DEP } = D;
  const n = TRIP.length, nTrips = D.nTrips;
  const start = new Uint32Array(nTrips + 1);
  for (let i = 0; i < n; i++) start[TRIP[i] + 1]++;
  for (let t = 0; t < nTrips; t++) start[t + 1] += start[t];
  const list = new Uint32Array(n);
  const fill = start.slice();
  for (let i = 0; i < n; i++) list[fill[TRIP[i]]++] = i;

  const key = SEQ ? (i => SEQ[i]) : (i => DEP[i]);
  const buf = [];
  for (let t = 0; t < nTrips; t++) {
    const a = start[t], b = start[t + 1];
    if (b - a < 2) continue;
    buf.length = 0;
    for (let i = a; i < b; i++) buf.push(list[i]);
    buf.sort((x, y) => key(x) - key(y));
    for (let i = 0; i < buf.length; i++) list[a + i] = buf[i];
  }
  return { start, list };
}

function footTime(D, a, b) {
  for (let j = D.footStart[a], e = D.footStart[a + 1]; j < e; j++) {
    if (D.footTo[j] === b) return D.footSec[j];
  }
  return 0;
}

/** Purkaa matkan pysakilta `from` maaliin. */
export function reconstruct(D, res, ti, from, o) {
  const { ARR, DEP, FROM, TO, TRIP } = D;
  const { L, VC, VF, nLevels, nStops, isTarget, targetWalk } = res;

  let level = nLevels - 1;
  if (L[level * nStops + from] < 0) return null;
  // pienin taso joka antaa saman ajan -> vahiten vaihtoja
  const best = L[level * nStops + from];
  for (let b = 0; b < nLevels; b++) {
    if (L[b * nStops + from] === best) { level = b; break; }
  }

  const level0 = level;                       // lahtotaso talteen
  const depart = L[level0 * nStops + from];
  if (depart < 0) return null;                // ei kelvollista lahtoa
  const legs = [];
  let s = from, t = depart, guard = 0;

  const finish = () => {
    const wsec = targetWalk[s] >= 0 ? targetWalk[s] : 0;
    legs.push({ mode: 'walk', last: true, fromStop: s, toStop: -1,
                dep: t, arr: t + wsec, sec: wsec });
    return { legs, departure: depart, arrival: t + wsec };
  };

  while (guard++ < 100) {
    if (isTarget[s]) return finish();
    const off = level * nStops + s;

    if (VF[off] >= 0) {
      const n2 = VF[off], sec = footTime(D, s, n2);
      legs.push({ mode: 'walk', fromStop: s, toStop: n2, dep: t, arr: t + sec, sec });
      s = n2; t += sec;
      continue;
    }

    const ci = VC[off];
    if (ci < 0 || level < 1) break;

    const trip = TRIP[ci];
    let k = ti.start[trip];
    while (k < ti.start[trip + 1] && ti.list[k] !== ci) k++;

    const lo = (level - 1) * nStops;           // poistumisen jalkeen yksi nousu vahemman
    const end = ti.start[trip + 1];

    // Kaydaan koko ajo lapi ja valitaan poistumispysakki joka minimoi
    // TODELLISEN perilletuloajan. Aiemmin poistuttiin ensimmaisella
    // maalipysakilla, jolloin isompi kavelyraja sai jaamaan pois liian
    // aikaisin ja kavelemaan turhaan -> matka-aika kasvoi rajaa nostamalla.
    let finIdx = -1, finBest = Infinity, xferIdx = -1;
    for (let m = k; m < end; m++) {
      const c = ti.list[m], q = TO[c], aq = ARR[c];
      // maalipysakki kelpaa vain jos silla on kelvollinen label tassa ajassa
      if (isTarget[q] && targetWalk[q] >= 0 && L[q] >= aq) {
        const fin = aq + targetWalk[q];
        if (fin < finBest) { finBest = fin; finIdx = m; }
      }
      if (xferIdx < 0 && L[lo + q] >= aq) {
        const nx = VC[lo + q];
        if (VF[lo + q] >= 0 || (nx >= 0 && TRIP[nx] !== trip)) xferIdx = m;
      }
    }
    // Perille asti pääsy voittaa vaihdon, kunhan määräaika pitää
    let stopAt = (finIdx >= 0 && finBest <= o.arriveBy) ? finIdx
               : (xferIdx >= 0 ? xferIdx : (finIdx >= 0 ? finIdx : end - 1));
    if (stopAt < k) stopAt = k;

    let alight = TO[ci], alightTime = ARR[ci], stops = 1;
    const path = [FROM[ci]];
    if (k >= end) path.push(TO[ci]);
    for (let m = k; m <= stopAt && m < end; m++) {
      const c = ti.list[m];
      alight = TO[c]; alightTime = ARR[c]; stops = m - k + 1;
      path.push(alight);
    }

    legs.push({
      mode: 'transit', trip,
      route: D.tripRoute ? D.tripRoute[trip] : -1,
      fromStop: FROM[ci], toStop: alight,
      dep: DEP[ci], arr: alightTime, stops, path
    });
    s = alight; t = alightTime; level--;
  }

  return { legs, departure: depart, arrival: o.arriveBy };
}

/* ------------------------------------------------------------------ */
/* 3. Saavutettavuusruudukko katuverkkoa pitkin (Dial)                 */
/* ------------------------------------------------------------------ */

/** @param transit Int32Array: joukkoliikenneosuus sekunteina per pysakki, -1 = ei saavutettavissa */
export function buildGridWalk(D, transit, walk, o) {
  const { maxTravel, walkMps, maxWalkSec, origin } = o;
  const used = o.walkUsed;    // matkan aikana jo kaytetty kavely per pysakki
  const { grid: ok, w: gw, h: gh, mercX0, mercY0, mercCell, cellM } = walk;

  const cOrt = Math.max(1, Math.round(cellM / walkMps));
  const cDia = Math.max(1, Math.round(cellM * Math.SQRT2 / walkMps));
  const CAP = maxTravel;

  const dist = new Int32Array(gw * gh).fill(-1);
  const seedT = new Int32Array(gw * gh);
  const seedR = new Int32Array(gw * gh);    // kavelybudjettia jaljella kotipaahan
  const buckets = new Array(CAP + 1);

  const push = (cell, d, st, rem) => {
    if (d > CAP) return;
    if (dist[cell] >= 0 && dist[cell] <= d) return;
    dist[cell] = d; seedT[cell] = st; seedR[cell] = rem;
    (buckets[d] || (buckets[d] = [])).push(cell);
  };

  let seeded = 0, originSeeded = false;

  if (origin) {
    const x = lonToMerc(origin.lon), y = latToMerc(origin.lat);
    let i = Math.round((x - mercX0) / mercCell);
    let j = Math.round((y - mercY0) / mercCell);
    if (i >= 0 && i < gw && j >= 0 && j < gh) {
      if (!(ok[j * gw + i] & 2)) {
        let found = false;
        for (let r = 1; r <= 5 && !found; r++) {
          for (let dj = -r; dj <= r && !found; dj++) for (let di = -r; di <= r; di++) {
            const jj = j + dj, ii = i + di;
            if (jj < 0 || jj >= gh || ii < 0 || ii >= gw) continue;
            if (ok[jj * gw + ii] & 2) { i = ii; j = jj; found = true; break; }
          }
        }
        if (found) { push(j * gw + i, 0, -1, maxWalkSec); originSeeded = true; }
      } else { push(j * gw + i, 0, -1, maxWalkSec); originSeeded = true; }
    }
  }

  for (let s = 0; s < D.nStops; s++) {
    if (transit[s] < 0 || transit[s] > maxTravel) continue;
    const x = lonToMerc(D.lon[s]), y = latToMerc(D.lat[s]);
    let i = Math.round((x - mercX0) / mercCell);
    let j = Math.round((y - mercY0) / mercCell);
    if (i < 0 || i >= gw || j < 0 || j >= gh) continue;
    if (!(ok[j * gw + i] & 2)) {
      let found = false;
      for (let r = 1; r <= 4 && !found; r++) {
        for (let dj = -r; dj <= r && !found; dj++) for (let di = -r; di <= r; di++) {
          const jj = j + dj, ii = i + di;
          if (jj < 0 || jj >= gh || ii < 0 || ii >= gw) continue;
          if (ok[jj * gw + ii] & 2) { i = ii; j = jj; found = true; break; }
        }
      }
      if (!found) continue;
    }
    const tr = transit[s];
    const rem = maxWalkSec - (used ? used[s] : 0);
    if (rem < 0) continue;               // kavelybudjetti loppui jo tyopaikan paassa
    push(j * gw + i, tr, tr, rem);
    seeded++;
  }
  if (!seeded && !originSeeded) return null;

  for (let d = 0; d <= CAP; d++) {
    const b = buckets[d];
    if (!b) continue;
    for (let bi = 0; bi < b.length; bi++) {
      const cell = b[bi];
      if (dist[cell] !== d) continue;
      const st = seedT[cell], rem = seedR[cell];
      const base = st > 0 ? st : 0;             // -1 = pelkka kavely, kaikki on kavelya
      if (d - base > rem) continue;
      const j = (cell / gw) | 0, i = cell - j * gw;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= gh) continue;
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di; if (ii < 0 || ii >= gw) continue;
          const nc = jj * gw + ii;
          if (!(ok[nc] & 2)) continue;          // vain oikeat tiet
          const nd = d + ((di && dj) ? cDia : cOrt);
          if (nd - base > rem) continue;
          push(nc, nd, st, rem);
        }
      }
    }
    buckets[d] = null;
  }

  // Korttelien sisäosat: yksi levityskierros tulokseen. Reititys pysyy
  // teillä, mutta talon ovelle pääsee tieltä pienellä lisäajalla.
  const spread = Math.round(cellM / walkMps) + 20;
  const base = dist.slice();
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const c = j * gw + i;
      if (base[c] >= 0 || !ok[c]) continue;
      let bestD = -1, bestS = 0, bestN = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= gh) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di; if (ii < 0 || ii >= gw) continue;
          const n = jj * gw + ii;
          if (base[n] < 0) continue;
          if (bestD < 0 || base[n] < bestD) { bestD = base[n]; bestS = seedT[n]; bestN = n; }
        }
      }
      if (bestD >= 0 && bestD + spread <= CAP) {
        const bb = bestS > 0 ? bestS : 0;
        if (bestD + spread - bb <= seedR[bestN]) {
          dist[c] = bestD + spread; seedT[c] = bestS; seedR[c] = seedR[bestN];
        }
      }
    }
  }

  let i0 = gw, i1 = -1, j0 = gh, j1 = -1;
  for (let j = 0; j < gh; j++) {
    const row = j * gw;
    for (let i = 0; i < gw; i++) {
      if (dist[row + i] < 0) continue;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    }
  }
  if (i1 < 0) return null;

  const w = i1 - i0 + 1, h = j1 - j0 + 1;
  const out = new Float32Array(w * h).fill(Infinity);
  const road = new Uint8Array(w * h);
  const walkOnly = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const src = (j + j0) * gw + (i + i0);
    const d = dist[src];
    if (d >= 0) {
      out[j * w + i] = d;
      if (seedT[src] < 0) walkOnly[j * w + i] = 1;
    }
    if (ok[src] === 2) road[j * w + i] = 1;
  }

  const bx0 = mercX0 + i0 * mercCell, bx1 = mercX0 + (i1 + 1) * mercCell;
  const by0 = mercY0 + j0 * mercCell, by1 = mercY0 + (j1 + 1) * mercCell;
  return {
    grid: out, road, walkOnly, w, h,
    bounds: [mercToLon(bx0), mercToLat(by1), mercToLon(bx1), mercToLat(by0)],
    mercX0: bx0, mercY0: by0, mercCell,
    reachableStops: seeded, originSeeded
  };
}

/* ------------------------------------------------------------------ */
/* 4. Apurit                                                           */
/* ------------------------------------------------------------------ */

export function nearbyStops(D, lat, lon, maxSec, effMps) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
  const maxM = maxSec * effMps;
  const out = [];
  for (let s = 0; s < D.nStops; s++) {
    const dx = (D.lon[s] - lon) * kx, dy = (D.lat[s] - lat) * ky;
    const d = Math.hypot(dx, dy);
    if (d <= maxM) out.push([s, Math.round(d / effMps)]);
  }
  return out;
}

/** Paras lahtopysakki kodin sijainnista: pienin ovelta ovelle -aika. */
export function bestOrigin(D, transit, lat, lon, o) {
  let best = null;
  for (const [s, walkSec] of nearbyStops(D, lat, lon, o.maxWalkSec, o.effMps)) {
    if (transit[s] < 0) continue;
    const total = transit[s] + walkSec;
    if (total > o.maxTravel) continue;
    if (!best || total < best.total) best = { stop: s, walkSec, total };
  }
  return best;
}

/**
 * Ajaa CSA:n usealle saapumisajalle ja poimii jokaiselle pysakille nopeimman.
 * @returns {{transit:Int32Array, winner:Int32Array, runs:Array}}
 */
export function csaWindow(D, o) {
  const times = [];
  for (let t = o.arriveFrom; t <= o.arriveTo; t += o.step) times.push(t);
  if (!times.length) times.push(o.arriveTo);

  const transit = new Int32Array(D.nStops).fill(-1);
  const walkUsed = new Int32Array(D.nStops).fill(0);
  const winner = new Int32Array(D.nStops).fill(-1);
  const runs = [];

  for (let k = 0; k < times.length; k++) {
    const arriveBy = times[k];
    const res = csaBackward(D, {
      arriveBy, sources: o.sources, minTransfer: o.minTransfer,
      maxTransfers: o.maxTransfers, maxWalkSec: o.maxWalkSec,
      earliest: arriveBy - o.maxTravel
    });
    runs.push(res);
    const L = res.latest;
    for (let s = 0; s < D.nStops; s++) {
      if (L[s] < 0) continue;
      const tt = arriveBy - L[s];
      if (tt < 0 || tt > o.maxTravel) continue;
      if (transit[s] < 0 || tt < transit[s]) {
        transit[s] = tt; winner[s] = k; walkUsed[s] = res.walkUsed[s];
      }
    }
  }
  return { transit, walkUsed, winner, runs, times };
}

/* ------------------------------------------------------------------ */
/* 5. Kävely katuverkkoa pitkin yksittäisestä pisteestä                */
/* ------------------------------------------------------------------ */

/** Ruudun indeksi koordinaateista, tarvittaessa lähimpään kuljettavaan napsautettuna. */
export function cellIndex(walk, lon, lat, snap = 3, grid = null, mask = 2) {
  const ok = grid || walk.grid;
  const { w: gw, h: gh, mercX0, mercY0, mercCell } = walk;
  let i = Math.round((lonToMerc(lon) - mercX0) / mercCell);
  let j = Math.round((latToMerc(lat) - mercY0) / mercCell);
  if (i < 0 || i >= gw || j < 0 || j >= gh) return -1;
  if (ok[j * gw + i] & mask) return j * gw + i;
  for (let r = 1; r <= snap; r++) {
    for (let dj = -r; dj <= r; dj++) {
      const jj = j + dj; if (jj < 0 || jj >= gh) continue;
      for (let di = -r; di <= r; di++) {
        const ii = i + di; if (ii < 0 || ii >= gw) continue;
        if (ok[jj * gw + ii] & mask) return jj * gw + ii;
      }
    }
  }
  return -1;
}

/**
 * Rajattu Dial-haku yhdestä ruudusta. Palauttaa Mapin ruutu -> sekuntia.
 * Harva esitys, koska säde on pieni (satoja ruutuja).
 */
export function walkNetwork(walk, startCell, maxSec, walkMps, withPrev = false, mask = 2) {
  const { grid: ok, w: gw, h: gh, cellM } = walk;
  if (startCell < 0) return null;
  const cOrt = Math.max(1, Math.round(cellM / walkMps));
  const cDia = Math.max(1, Math.round(cellM * Math.SQRT2 / walkMps));
  const dist = new Map();
  const prev = withPrev ? new Map() : null;
  const buckets = new Array(maxSec + 1);
  const push = (c, d, from) => {
    if (d > maxSec) return;
    const old = dist.get(c);
    if (old !== undefined && old <= d) return;
    dist.set(c, d);
    if (prev && from !== undefined) prev.set(c, from);
    (buckets[d] || (buckets[d] = [])).push(c);
  };
  push(startCell, 0);
  for (let d = 0; d <= maxSec; d++) {
    const b = buckets[d];
    if (!b) continue;
    for (let bi = 0; bi < b.length; bi++) {
      const c = b[bi];
      if (dist.get(c) !== d) continue;
      const j = (c / gw) | 0, i = c - j * gw;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= gh) continue;
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di; if (ii < 0 || ii >= gw) continue;
          const nc = jj * gw + ii;
          if (!(ok[nc] & mask)) continue;
          push(nc, d + ((di && dj) ? cDia : cOrt), c);
        }
      }
    }
    buckets[d] = null;
  }
  return { dist, prev, start: startCell };
}

/** Ruudun keskipiste asteina. */
export function cellLngLat(walk, c) {
  const j = (c / walk.w) | 0, i = c - j * walk.w;
  return [mercToLon(walk.mercX0 + (i + 0.5) * walk.mercCell),
          mercToLat(walk.mercY0 + (j + 0.5) * walk.mercCell)];
}

/** Kevyt pehmennys: keskiarvoistaa pisteita, sailyttaa paatepisteet. */
export function smooth(pts, passes = 2) {
  let a = pts;
  for (let p = 0; p < passes && a.length > 2; p++) {
    const b = [a[0]];
    for (let i = 1; i < a.length - 1; i++) {
      b.push([(a[i - 1][0] + 2 * a[i][0] + a[i + 1][0]) / 4,
              (a[i - 1][1] + 2 * a[i][1] + a[i + 1][1]) / 4]);
    }
    b.push(a[a.length - 1]);
    a = b;
  }
  return a;
}

/** Kavelyreitti verkkohaun alusta annettuun ruutuun. */
export function walkPath(walk, net, targetCell) {
  if (!net || !net.prev || !net.dist.has(targetCell)) return null;
  const cells = [targetCell];
  let c = targetCell, guard = 0;
  while (c !== net.start && guard++ < 100000) {
    const p = net.prev.get(c);
    if (p === undefined) break;
    cells.push(p); c = p;
  }
  cells.reverse();
  return smooth(cells.map(x => cellLngLat(walk, x)));
}

/**
 * Pysäkit joihin annetusta pisteestä pääsee kävellen, todellisen katuverkon
 * mukaisin ajoin. Korvaa nearbyStops()-linnuntiearvion.
 */
export function stopWalkTimes(D, walk, stopCell, lat, lon, maxSec, walkMps) {
  const start = cellIndex(walk, lon, lat, 4);
  const net = walkNetwork(walk, start, maxSec, walkMps);
  if (!net) return [];
  const out = [];
  for (let s = 0; s < D.nStops; s++) {
    const c = stopCell[s];
    if (c < 0) continue;
    const d = net.dist.get(c);
    if (d !== undefined) out.push([s, d]);
  }
  return out;
}

/** Paras lähtöpysäkki, kun kävelyajat on jo laskettu verkosta. */
export function bestOriginNet(transit, walkTimes, maxTravel, walkUsed, maxWalkSec) {
  let best = null;
  for (const [s, walkSec] of walkTimes) {
    if (transit[s] < 0) continue;
    const total = transit[s] + walkSec;
    if (total > maxTravel) continue;
    // koko matkan kavely, ei vain tama osuus
    if (walkUsed && maxWalkSec != null && walkUsed[s] + walkSec > maxWalkSec) continue;
    if (!best || total < best.total) best = { stop: s, walkSec, total };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 6. Eteenpäin ajettava CSA: "mihin asti pääsen kotoa"                */
/* ------------------------------------------------------------------ */

const INF32 = 0x7fffffff;

export function csaForward(D, o) {
  const { DEP, ARR, FROM, TO, TRIP, footStart, footTo, footSec, nStops, nTrips } = D;
  const minTransfer = o.minTransfer ?? 120;

  // Sama tasorakenne kuin taaksepain-versiossa: taso b = korkeintaan b nousua
  // kaytetty lahdosta. Kavely ei ole nousu.
  const maxBoards = (o.maxTransfers == null || o.maxTransfers < 0)
    ? 6 : Math.max(1, Math.min(6, o.maxTransfers + 1));
  const nLevels = maxBoards + 1;

  const maxWalk = o.maxWalkSec == null ? 1e9 : o.maxWalkSec;

  const E = new Int32Array(nLevels * nStops).fill(INF32);
  const VC = new Int32Array(nLevels * nStops).fill(-1);
  const VF = new Int32Array(nLevels * nStops).fill(-1);
  const WK = new Int32Array(nLevels * nStops).fill(0);
  const onTripL = new Uint8Array(nLevels * nTrips);
  const isSource = new Uint8Array(nStops);
  const sourceWalk = new Int32Array(nStops).fill(-1);

  const put = (b, s, time, conn, foot, walk) => {
    if (walk > maxWalk) return;
    for (let bb = b; bb < nLevels; bb++) {
      const off = bb * nStops + s;
      if (time >= E[off]) break;
      E[off] = time; VC[off] = conn; VF[off] = foot; WK[off] = walk;
    }
  };

  for (const [s, walkSec] of o.sources) {
    isSource[s] = 1;
    if (sourceWalk[s] < 0 || walkSec < sourceWalk[s]) sourceWalk[s] = walkSec;
    put(0, s, o.departAt + walkSec, -1, -1, walkSec);
  }
  for (const [s] of o.sources) {
    const base = E[s], bw = WK[s];
    for (let j = footStart[s], e = footStart[s + 1]; j < e; j++) {
      put(0, footTo[j], base + footSec[j], -1, s, bw + footSec[j]);
    }
  }

  const horizon = o.departAt + o.maxTravel;
  for (let i = DEP.length - 1; i >= 0; i--) {     // tallennus laskeva -> luku nouseva
    const dep = DEP[i];
    if (dep > horizon) break;
    if (dep < o.departAt) continue;
    const tr = TRIP[i], f = FROM[i], t = TO[i], arr = ARR[i];

    for (let b = 1; b < nLevels; b++) {
      const ti2 = b * nTrips + tr;
      let usable = onTripL[ti2] === 1;
      if (!usable) {
        const e = E[(b - 1) * nStops + f];
        if (e !== INF32) usable = isSource[f] ? e <= dep : e + minTransfer <= dep;
      }
      if (!usable) continue;
      onTripL[ti2] = 1;

      const wk = WK[(b - 1) * nStops + f];
      if (wk > maxWalk) continue;
      if (arr < E[b * nStops + t]) {
        put(b, t, arr, i, -1, wk);
        for (let j = footStart[t], e2 = footStart[t + 1]; j < e2; j++) {
          put(b, footTo[j], arr + footSec[j], -1, t, wk + footSec[j]);
        }
      }
    }
  }

  const top = maxBoards * nStops;
  return {
    earliest: E.subarray(top, top + nStops),
    walkUsed: WK.subarray(top, top + nStops),
    E, VC, VF, WK, nLevels, nStops,
    isSource, sourceWalk, departAt: o.departAt
  };
}
/** Ajaa eteenpain-CSA:n usealle lahtoajalle ja poimii nopeimman per pysakki. */
export function csaWindowForward(D, o) {
  const times = [];
  for (let t = o.departFrom; t <= o.departTo; t += o.step) times.push(t);
  if (!times.length) times.push(o.departFrom);

  const transit = new Int32Array(D.nStops).fill(-1);
  const walkUsed = new Int32Array(D.nStops).fill(0);
  const winner = new Int32Array(D.nStops).fill(-1);
  const runs = [];
  for (let k = 0; k < times.length; k++) {
    const res = csaForward(D, {
      departAt: times[k], sources: o.sources, maxTransfers: o.maxTransfers,
      minTransfer: o.minTransfer, maxTravel: o.maxTravel, maxWalkSec: o.maxWalkSec
    });
    runs.push(res);
    const E = res.earliest;
    for (let s = 0; s < D.nStops; s++) {
      if (E[s] === INF32) continue;
      const tt = E[s] - times[k];
      if (tt < 0 || tt > o.maxTravel) continue;
      if (transit[s] < 0 || tt < transit[s]) {
        transit[s] = tt; winner[s] = k; walkUsed[s] = res.walkUsed[s];
      }
    }
  }
  return { transit, walkUsed, winner, runs, times, forward: true };
}

/** Purkaa matkan lahtopaikasta annetulle pysakille. */
export function reconstructForward(D, res, ti, to, o) {
  const { DEP, ARR, FROM, TO, TRIP } = D;
  const { E, VC, VF, nLevels, nStops, isSource, sourceWalk } = res;

  let level = nLevels - 1;
  if (E[level * nStops + to] === INF32) return null;
  const best = E[level * nStops + to];
  for (let b = 0; b < nLevels; b++) {
    if (E[b * nStops + to] === best) { level = b; break; }   // vahiten vaihtoja
  }

  const rev = [];
  let s = to, guard = 0;
  while (guard++ < 100 && !isSource[s]) {
    const off = level * nStops + s;

    if (VF[off] >= 0) {
      const p = VF[off], sec = footTime(D, p, s);
      rev.push({ mode: 'walk', fromStop: p, toStop: s, sec,
                 dep: E[off] - sec, arr: E[off] });
      s = p; continue;
    }

    const ci = VC[off];
    if (ci < 0 || level < 1) break;
    const trip = TRIP[ci];
    let k = ti.start[trip];
    while (k < ti.start[trip + 1] && ti.list[k] !== ci) k++;

    // Ajon aikana KAIKKI valipysakit on saavutettu samalla tasolla tata vuoroa
    // pitkin; nousupysakki on se jolla nain ei ole. Aiemmin tassa katsottiin
    // tasoa level-1, jolloin ehto ei toteutunut koskaan -> jokainen pysakkivali
    // luettiin omaksi nousukseen, tasot loppuivat kesken ja purku katkesi
    // ennen kotia (alun kavely 0 min).
    const same = level * nStops;
    let m = k;
    while (m > ti.start[trip]) {
      const f = FROM[ti.list[m]];
      const vc = VC[same + f];
      if (vc >= 0 && TRIP[vc] === trip) m--; else break;
    }
    const bc = ti.list[m];
    const path = [FROM[bc]];
    for (let q = m; q <= k; q++) path.push(TO[ti.list[q]]);
    rev.push({
      mode: 'transit', trip, route: D.tripRoute ? D.tripRoute[trip] : -1,
      fromStop: FROM[bc], toStop: s, dep: DEP[bc], arr: ARR[ci],
      stops: k - m + 1, path
    });
    s = FROM[bc]; level--;
  }

  const legs = rev.reverse();
  const w0 = sourceWalk[s] >= 0 ? sourceWalk[s] : 0;
  return { legs, firstWalk: w0, firstStop: s,
           ok: isSource[s] === 1,       // false = purku katkesi kesken
           departure: res.departAt, arrival: E[(nLevels - 1) * nStops + to] };
}

/* ------------------------------------------------------------------ */
/* 7. Tarkka reititys viivageometrialla (ei rasteria)                  */
/* ------------------------------------------------------------------ */

/** Rakentaa vaylakokoelman ja vaylakohtaiset rajat nopeaa rajausta varten. */
export function makeWays(start, ax, ay, dx, dy, kind) {
  const n = ax.length;
  const bx0 = new Int32Array(n), bx1 = new Int32Array(n),
        by0 = new Int32Array(n), by1 = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    let x = ax[k], y = ay[k], mnx = 2e9, mny = 2e9, mxx = -2e9, mxy = -2e9;
    for (let j = start[k]; j < start[k + 1]; j++) {
      x += dx[j]; y += dy[j];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
    }
    bx0[k] = mnx; bx1[k] = mxx; by0[k] = mny; by1[k] = mxy;
  }
  // Karkea hakemistoruudukko. Ilman tata jokainen reitityskutsu kavisi lapi
  // kaikki sadattuhannet vaylat, mika tekee raahauksesta kaytannossa jumin.
  const GS = 4000;
  const idx = new Map();
  for (let k = 0; k < n; k++) {
    const ia = Math.floor(bx0[k] / GS), ib = Math.floor(bx1[k] / GS);
    const ja = Math.floor(by0[k] / GS), jb = Math.floor(by1[k] / GS);
    for (let i = ia; i <= ib; i++) for (let j = ja; j <= jb; j++) {
      const key = i * 100000 + j;
      let a = idx.get(key);
      if (!a) idx.set(key, a = []);
      a.push(k);
    }
  }
  return { start, ax, ay, dx, dy, kind, n, bx0, bx1, by0, by1, idx, GS };
}

/** Minimikeko Dijkstraa varten. */
function Heap() {
  const k = [], v = [];
  return {
    size: () => k.length,
    push(key, val) {
      k.push(key); v.push(val);
      let i = k.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= k[i]) break;
        [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p;
      }
    },
    pop() {
      const top = v[0], tk = k[0];
      const lk = k.pop(), lv = v.pop();
      if (k.length) {
        k[0] = lk; v[0] = lv;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < k.length && k[l] < k[m]) m = l;
          if (r < k.length && k[r] < k[m]) m = r;
          if (m === i) break;
          [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
        }
      }
      return [tk, top];
    }
  };
}

const WKEY = 20000000;

/**
 * Lyhin reitti kahden pisteen valilla TODELLISTA viivaverkkoa pitkin.
 * Rakentaa vain paikallisen aliverkon, joten muistinkaytto pysyy pienena.
 *
 * @param W        makeWays()-kokoelma
 * @param from,to  [mercX, mercY]
 * @param mask     kind-bittimaski (0 = kaikki)
 * @returns {{coords:[[lon,lat]], merc:number}|null}
 */
export function routeOnWays(W, from, to, mask = 0, tries = 2) {
  const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
  for (let attempt = 0; attempt < tries; attempt++) {
    const pad = Math.max(1500, span * (0.6 + attempt * 1.2));
    const qx0 = Math.min(from[0], to[0]) - pad, qx1 = Math.max(from[0], to[0]) + pad;
    const qy0 = Math.min(from[1], to[1]) - pad, qy1 = Math.max(from[1], to[1]) + pad;

    const id = new Map();
    const NX = [], NY = [], adj = [];
    const node = (x, y) => {
      const key = x * WKEY + y;
      let i = id.get(key);
      if (i === undefined) { i = NX.length; id.set(key, i); NX.push(x); NY.push(y); adj.push([]); }
      return i;
    };

    const cand = [];
    if (W.idx) {
      const seenW = new Set();
      const ia = Math.floor(qx0 / W.GS), ib = Math.floor(qx1 / W.GS);
      const ja = Math.floor(qy0 / W.GS), jb = Math.floor(qy1 / W.GS);
      for (let i = ia; i <= ib; i++) for (let j = ja; j <= jb; j++) {
        const a = W.idx.get(i * 100000 + j);
        if (!a) continue;
        for (const k of a) if (!seenW.has(k)) { seenW.add(k); cand.push(k); }
      }
    } else {
      for (let k = 0; k < W.n; k++) cand.push(k);
    }

    for (const k of cand) {
      if (mask && !(W.kind[k] & mask)) continue;
      if (W.bx1[k] < qx0 || W.bx0[k] > qx1 || W.by1[k] < qy0 || W.by0[k] > qy1) continue;
      let x = W.ax[k], y = W.ay[k], prev = -1;
      for (let j = W.start[k]; j < W.start[k + 1]; j++) {
        x += W.dx[j]; y += W.dy[j];
        const cur = node(x, y);
        if (prev >= 0 && prev !== cur) {
          const w = Math.hypot(NX[cur] - NX[prev], NY[cur] - NY[prev]);
          adj[prev].push(cur, w);
          adj[cur].push(prev, w);
        }
        prev = cur;
      }
    }
    if (NX.length < 2) continue;

    const near = p => {
      let best = -1, bd = Infinity;
      for (let i = 0; i < NX.length; i++) {
        const d = (NX[i] - p[0]) ** 2 + (NY[i] - p[1]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    const a = near(from), b = near(to);
    if (a < 0 || b < 0 || a === b) continue;

    const dist = new Float64Array(NX.length).fill(Infinity);
    const prevN = new Int32Array(NX.length).fill(-1);
    const done = new Uint8Array(NX.length);
    const h = Heap();
    dist[a] = 0; h.push(0, a);
    while (h.size()) {
      const [d, u] = h.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === b) break;
      const e = adj[u];
      for (let i = 0; i < e.length; i += 2) {
        const v = e[i], nd = d + e[i + 1];
        if (nd < dist[v]) { dist[v] = nd; prevN[v] = u; h.push(nd, v); }
      }
    }
    if (!isFinite(dist[b])) continue;

    const out = [];
    for (let c = b; c >= 0; c = prevN[c]) out.push([mercToLon(NX[c]), mercToLat(NY[c])]);
    out.reverse();
    return { coords: out, merc: dist[b] };
  }
  return null;
}

/**
 * Reitittaa KOKO pysakkiketjun yhdessa aliverkossa.
 *
 * routeOnWays rakentaa oman aliverkon joka kutsulla. Kun sita kutsuttiin
 * pysakkivali kerrallaan, kaksi ongelmaa seurasi:
 *   1. perakkaiset kutsut napsauttivat saman pysakin ERI solmuun (aliverkot
 *      erilaiset) -> viiva nykaisi muutaman metrin taaksepain
 *   2. jos yhden valin reitti ei mahtunut aliverkkoon, se korvautui suoralla
 *      viivalla -> pitka hyppy ilmassa
 * Yksi yhteinen aliverkko poistaa molemmat.
 *
 * @returns {{coords:Array, stopPos:Array}|null}
 *   coords  = yhtenainen viiva
 *   stopPos = jokaisen pysakin sijainti VERKOLLA (piste osuu viivalle)
 */
export function routeChainOnWays(W, pts, mask = 0, tries = 3) {
  if (!W || pts.length < 2) return null;
  let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
  for (const p of pts) {
    if (p[0] < ax0) ax0 = p[0];
    if (p[0] > ax1) ax1 = p[0];
    if (p[1] < ay0) ay0 = p[1];
    if (p[1] > ay1) ay1 = p[1];
  }
  const span = Math.max(ax1 - ax0, ay1 - ay0);

  for (let attempt = 0; attempt < tries; attempt++) {
    const pad = Math.max(4000, span * (0.4 + attempt * 0.7));
    const qx0 = ax0 - pad, qx1 = ax1 + pad, qy0 = ay0 - pad, qy1 = ay1 + pad;

    const id = new Map();
    const NX = [], NY = [], adj = [];
    const node = (x, y) => {
      const key = x * WKEY + y;
      let i = id.get(key);
      if (i === undefined) { i = NX.length; id.set(key, i); NX.push(x); NY.push(y); adj.push([]); }
      return i;
    };

    const cand = [];
    if (W.idx) {
      const seenW = new Set();
      const ia = Math.floor(qx0 / W.GS), ib = Math.floor(qx1 / W.GS);
      const ja = Math.floor(qy0 / W.GS), jb = Math.floor(qy1 / W.GS);
      for (let i = ia; i <= ib; i++) for (let j = ja; j <= jb; j++) {
        const a = W.idx.get(i * 100000 + j);
        if (!a) continue;
        for (const k of a) if (!seenW.has(k)) { seenW.add(k); cand.push(k); }
      }
    } else {
      for (let k = 0; k < W.n; k++) cand.push(k);
    }

    for (const k of cand) {
      if (mask && !(W.kind[k] & mask)) continue;
      if (W.bx1[k] < qx0 || W.bx0[k] > qx1 || W.by1[k] < qy0 || W.by0[k] > qy1) continue;
      let x = W.ax[k], y = W.ay[k], prev = -1;
      for (let j = W.start[k]; j < W.start[k + 1]; j++) {
        x += W.dx[j]; y += W.dy[j];
        const cur = node(x, y);
        if (prev >= 0 && prev !== cur) {
          const w = Math.hypot(NX[cur] - NX[prev], NY[cur] - NY[prev]);
          adj[prev].push(cur, w);
          adj[cur].push(prev, w);
        }
        prev = cur;
      }
    }
    if (NX.length < 2) continue;

    const SNAP_MAX = 900;          // mercator-yksikkoa, ~450 m todellista
    const near = p => {
      let best = -1, bd = Infinity;
      for (let i = 0; i < NX.length; i++) {
        const d = (NX[i] - p[0]) ** 2 + (NY[i] - p[1]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return (best >= 0 && Math.sqrt(bd) <= SNAP_MAX) ? best : -1;
    };

    // Kaikki pysakit napsautetaan SAMASSA aliverkossa -> ei epajatkuvuuksia
    const nodes = pts.map(near);
    if (nodes.some(n => n < 0)) continue;

    const path = (a, b) => {
      if (a === b) return [a];
      const dist = new Float64Array(NX.length).fill(Infinity);
      const prevN = new Int32Array(NX.length).fill(-1);
      const done = new Uint8Array(NX.length);
      const h = Heap();
      dist[a] = 0; h.push(0, a);
      while (h.size()) {
        const [d, u] = h.pop();
        if (done[u]) continue;
        done[u] = 1;
        if (u === b) break;
        const A = adj[u];
        for (let i = 0; i < A.length; i += 2) {
          const v = A[i], nd = d + A[i + 1];
          if (nd < dist[v]) { dist[v] = nd; prevN[v] = u; h.push(nd, v); }
        }
      }
      if (!isFinite(dist[b])) return null;
      const out = [];
      for (let c = b; c >= 0; c = prevN[c]) out.push(c);
      return out.reverse();
    };

    const ll = i => [mercToLon(NX[i]), mercToLat(NY[i])];
    const coords = [ll(nodes[0])];
    const stopPos = [ll(nodes[0])];
    let ok = true;
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1];
      const seg = path(a, b);
      if (!seg) { ok = false; break; }

      let len = 0;
      for (let j = 1; j < seg.length; j++) {
        len += Math.hypot(NX[seg[j]] - NX[seg[j - 1]], NY[seg[j]] - NY[seg[j - 1]]);
      }
      const straight = Math.hypot(NX[b] - NX[a], NY[b] - NY[a]);
      // rata kaartaa loivasti; moninkertainen mutka tarkoittaa vaaraa raidetta
      if (straight > 400 && len > straight * 2.5) { ok = false; break; }

      for (let j = 1; j < seg.length; j++) coords.push(ll(seg[j]));
      stopPos.push(ll(nodes[i + 1]));
    }
    if (!ok || coords.length < 2) continue;
    return { coords, stopPos };
  }
  return null;
}
