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

export function csaBackward(D, o) {
  const { DEP, ARR, FROM, TO, TRIP, footStart, footTo, footSec, nStops, nTrips } = D;
  const minTransfer = o.minTransfer ?? 120;
  const earliest = o.earliest ?? 0;

  const latest = new Int32Array(nStops).fill(-1);
  const viaConn = new Int32Array(nStops).fill(-1);
  const viaFoot = new Int32Array(nStops).fill(-1);
  const isTarget = new Uint8Array(nStops);
  const targetWalk = new Int32Array(nStops).fill(-1);
  const onTrip = new Uint8Array(nTrips);

  for (const [s, walkSec] of o.sources) {
    const t = o.arriveBy - walkSec;
    if (t > latest[s]) { latest[s] = t; viaConn[s] = -1; viaFoot[s] = -1; }
    isTarget[s] = 1;
    if (targetWalk[s] < 0 || walkSec < targetWalk[s]) targetWalk[s] = walkSec;
  }
  for (const [s] of o.sources) {
    for (let j = footStart[s], e = footStart[s + 1]; j < e; j++) {
      const n = footTo[j], cand = latest[s] - footSec[j];
      if (cand > latest[n]) { latest[n] = cand; viaConn[n] = -1; viaFoot[n] = s; }
    }
  }

  const n = DEP.length;
  for (let i = 0; i < n; i++) {
    const dep = DEP[i];
    if (dep < earliest) break;
    const tr = TRIP[i];
    let usable = onTrip[tr] === 1;
    if (!usable) {
      const lt = latest[TO[i]];
      usable = lt >= 0 && ARR[i] + minTransfer <= lt;
    }
    if (!usable) continue;
    onTrip[tr] = 1;

    const f = FROM[i];
    if (dep > latest[f]) {
      latest[f] = dep; viaConn[f] = i; viaFoot[f] = -1;
      for (let j = footStart[f], e = footStart[f + 1]; j < e; j++) {
        const nb = footTo[j], cand = dep - footSec[j];
        if (cand > latest[nb]) { latest[nb] = cand; viaConn[nb] = -1; viaFoot[nb] = f; }
      }
    }
  }
  return { latest, viaConn, viaFoot, isTarget, targetWalk, arriveBy: o.arriveBy };
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
  const { latest, viaConn, viaFoot, isTarget } = res;
  if (latest[from] < 0) return null;

  const { targetWalk } = res;
  const legs = [];
  let s = from, t = latest[s], guard = 0;

  const finish = () => {
    const wsec = targetWalk[s] >= 0 ? targetWalk[s] : 0;
    legs.push({ mode: 'walk', last: true, fromStop: s, toStop: -1,
                dep: t, arr: t + wsec, sec: wsec });
    return { legs, departure: latest[from], arrival: t + wsec };
  };

  while (guard++ < 100) {
    if (isTarget[s]) return finish();

    if (viaFoot[s] >= 0) {
      const n = viaFoot[s], sec = footTime(D, s, n);
      legs.push({ mode: 'walk', fromStop: s, toStop: n, dep: t, arr: t + sec, sec });
      s = n; t += sec;
      continue;
    }

    const ci = viaConn[s];
    if (ci < 0) break;


    const trip = TRIP[ci];
    let k = ti.start[trip];
    while (k < ti.start[trip + 1] && ti.list[k] !== ci) k++;

    let alight = TO[ci], alightTime = ARR[ci], stops = 1;
    const path = [FROM[ci]];
    if (k >= ti.start[trip + 1]) path.push(TO[ci]);   // varmistus: vuoroa ei loytynyt
    for (let m = k; m < ti.start[trip + 1]; m++) {
      const c = ti.list[m];
      alight = TO[c]; alightTime = ARR[c]; stops = m - k + 1;
      path.push(alight);
      if (isTarget[alight]) break;
      if (latest[alight] >= alightTime) {
        const nx = viaConn[alight];
        if (viaFoot[alight] >= 0 || (nx >= 0 && TRIP[nx] !== trip)) break;
      }
    }

    legs.push({
      mode: 'transit', trip,
      route: D.tripRoute ? D.tripRoute[trip] : -1,
      fromStop: FROM[ci], toStop: alight,
      dep: DEP[ci], arr: alightTime, stops, path
    });
    s = alight; t = alightTime;
  }
  if (isTarget[s]) return finish();
  return { legs, departure: latest[from], arrival: o.arriveBy };
}

/* ------------------------------------------------------------------ */
/* 3. Saavutettavuusruudukko katuverkkoa pitkin (Dial)                 */
/* ------------------------------------------------------------------ */

/** @param transit Int32Array: joukkoliikenneosuus sekunteina per pysakki, -1 = ei saavutettavissa */
export function buildGridWalk(D, transit, walk, o) {
  const { maxTravel, walkMps, maxWalkSec, origin } = o;
  const { grid: ok, w: gw, h: gh, mercX0, mercY0, mercCell, cellM } = walk;

  const cOrt = Math.max(1, Math.round(cellM / walkMps));
  const cDia = Math.max(1, Math.round(cellM * Math.SQRT2 / walkMps));
  const CAP = maxTravel;

  const dist = new Int32Array(gw * gh).fill(-1);
  const seedT = new Int32Array(gw * gh);
  const buckets = new Array(CAP + 1);

  const push = (cell, d, st) => {
    if (d > CAP) return;
    if (dist[cell] >= 0 && dist[cell] <= d) return;
    dist[cell] = d; seedT[cell] = st;
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
        if (found) { push(j * gw + i, 0, -1); originSeeded = true; }
      } else { push(j * gw + i, 0, -1); originSeeded = true; }
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
    push(j * gw + i, tr, tr);
    seeded++;
  }
  if (!seeded && !originSeeded) return null;

  for (let d = 0; d <= CAP; d++) {
    const b = buckets[d];
    if (!b) continue;
    for (let bi = 0; bi < b.length; bi++) {
      const cell = b[bi];
      if (dist[cell] !== d) continue;
      const st = seedT[cell];
      if (st >= 0 && d - st > maxWalkSec) continue;
      const j = (cell / gw) | 0, i = cell - j * gw;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= gh) continue;
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di; if (ii < 0 || ii >= gw) continue;
          const nc = jj * gw + ii;
          if (!(ok[nc] & 2)) continue;          // vain oikeat tiet
          const nd = d + ((di && dj) ? cDia : cOrt);
          if (st >= 0 && nd - st > maxWalkSec) continue;
          push(nc, nd, st);
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
      let bestD = -1, bestS = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= gh) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di; if (ii < 0 || ii >= gw) continue;
          const n = jj * gw + ii;
          if (base[n] < 0) continue;
          if (bestD < 0 || base[n] < bestD) { bestD = base[n]; bestS = seedT[n]; }
        }
      }
      if (bestD >= 0 && bestD + spread <= CAP) { dist[c] = bestD + spread; seedT[c] = bestS; }
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
  const winner = new Int32Array(D.nStops).fill(-1);
  const runs = [];

  for (let k = 0; k < times.length; k++) {
    const arriveBy = times[k];
    const res = csaBackward(D, {
      arriveBy, sources: o.sources, minTransfer: o.minTransfer,
      earliest: arriveBy - o.maxTravel
    });
    runs.push(res);
    const L = res.latest;
    for (let s = 0; s < D.nStops; s++) {
      if (L[s] < 0) continue;
      const tt = arriveBy - L[s];
      if (tt < 0 || tt > o.maxTravel) continue;
      if (transit[s] < 0 || tt < transit[s]) { transit[s] = tt; winner[s] = k; }
    }
  }
  return { transit, winner, runs, times };
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
export function bestOriginNet(transit, walkTimes, maxTravel) {
  let best = null;
  for (const [s, walkSec] of walkTimes) {
    if (transit[s] < 0) continue;
    const total = transit[s] + walkSec;
    if (total > maxTravel) continue;
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

  const earliest = new Int32Array(nStops).fill(INF32);
  const viaConn = new Int32Array(nStops).fill(-1);
  const viaFoot = new Int32Array(nStops).fill(-1);
  const isSource = new Uint8Array(nStops);
  const sourceWalk = new Int32Array(nStops).fill(-1);
  const onTrip = new Uint8Array(nTrips);

  for (const [s, walkSec] of o.sources) {
    const t = o.departAt + walkSec;
    if (t < earliest[s]) { earliest[s] = t; viaConn[s] = -1; viaFoot[s] = -1; }
    isSource[s] = 1;
    if (sourceWalk[s] < 0 || walkSec < sourceWalk[s]) sourceWalk[s] = walkSec;
  }
  for (const [s] of o.sources) {
    for (let j = footStart[s], e = footStart[s + 1]; j < e; j++) {
      const n = footTo[j], cand = earliest[s] + footSec[j];
      if (cand < earliest[n]) { earliest[n] = cand; viaConn[n] = -1; viaFoot[n] = s; }
    }
  }

  const horizon = o.departAt + o.maxTravel;
  // yhteydet on tallennettu laskevasti -> lopusta alkuun = nouseva lahtoaika
  for (let i = DEP.length - 1; i >= 0; i--) {
    const dep = DEP[i];
    if (dep > horizon) break;
    if (dep < o.departAt) continue;
    const tr = TRIP[i], f = FROM[i];
    let usable = onTrip[tr] === 1;
    if (!usable) {
      const e = earliest[f];
      if (e !== INF32) usable = isSource[f] ? e <= dep : e + minTransfer <= dep;
    }
    if (!usable) continue;
    onTrip[tr] = 1;

    const t = TO[i];
    if (ARR[i] < earliest[t]) {
      earliest[t] = ARR[i]; viaConn[t] = i; viaFoot[t] = -1;
      for (let j = footStart[t], e2 = footStart[t + 1]; j < e2; j++) {
        const n = footTo[j], cand = ARR[i] + footSec[j];
        if (cand < earliest[n]) { earliest[n] = cand; viaConn[n] = -1; viaFoot[n] = t; }
      }
    }
  }
  return { earliest, viaConn, viaFoot, isSource, sourceWalk, departAt: o.departAt };
}

/** Ajaa eteenpain-CSA:n usealle lahtoajalle ja poimii nopeimman per pysakki. */
export function csaWindowForward(D, o) {
  const times = [];
  for (let t = o.departFrom; t <= o.departTo; t += o.step) times.push(t);
  if (!times.length) times.push(o.departFrom);

  const transit = new Int32Array(D.nStops).fill(-1);
  const winner = new Int32Array(D.nStops).fill(-1);
  const runs = [];
  for (let k = 0; k < times.length; k++) {
    const res = csaForward(D, {
      departAt: times[k], sources: o.sources,
      minTransfer: o.minTransfer, maxTravel: o.maxTravel
    });
    runs.push(res);
    const E = res.earliest;
    for (let s = 0; s < D.nStops; s++) {
      if (E[s] === INF32) continue;
      const tt = E[s] - times[k];
      if (tt < 0 || tt > o.maxTravel) continue;
      if (transit[s] < 0 || tt < transit[s]) { transit[s] = tt; winner[s] = k; }
    }
  }
  return { transit, winner, runs, times, forward: true };
}

/** Purkaa matkan lahtopaikasta annetulle pysakille. */
export function reconstructForward(D, res, ti, to, o) {
  const { DEP, ARR, FROM, TO, TRIP } = D;
  const { earliest, viaConn, viaFoot, isSource, sourceWalk } = res;
  if (earliest[to] === INF32) return null;

  const rev = [];
  let s = to, guard = 0;
  while (guard++ < 100 && !isSource[s]) {
    if (viaFoot[s] >= 0) {
      const p = viaFoot[s], sec = footTime(D, p, s);
      rev.push({ mode: 'walk', fromStop: p, toStop: s, sec, dep: earliest[s] - sec, arr: earliest[s] });
      s = p; continue;
    }
    const ci = viaConn[s];
    if (ci < 0) break;
    const trip = TRIP[ci];
    let k = ti.start[trip];
    while (k < ti.start[trip + 1] && ti.list[k] !== ci) k++;
    // peruutetaan vuoroa taaksepain nousupysakille asti
    let m = k;
    while (m > ti.start[trip]) {
      const f = FROM[ti.list[m]];
      const vc = viaConn[f];
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
    s = FROM[bc];
  }

  const legs = rev.reverse();
  const w0 = sourceWalk[s] >= 0 ? sourceWalk[s] : 0;
  return {
    legs, firstWalk: w0, firstStop: s,
    departure: res.departAt, arrival: earliest[to]
  };
}
