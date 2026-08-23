/**
 * Taaksepain ajettava Connection Scan Algorithm + saavutettavuusruudukko.
 * Ei riippuvuuksia, ei DOM:ia -> ajettavissa myos Nodessa testeissa.
 */

const R_EARTH = 6378137;

export function lonToMerc(lon) { return R_EARTH * lon * Math.PI / 180; }
export function latToMerc(lat) {
  const r = lat * Math.PI / 180;
  return R_EARTH * Math.log(Math.tan(Math.PI / 4 + r / 2));
}
export function mercToLon(x) { return x / R_EARTH * 180 / Math.PI; }
export function mercToLat(y) {
  return (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) * 180 / Math.PI;
}

/**
 * @param {object} D  { DEP, ARR, FROM, TO, TRIP, footStart, footTo, footSec, nStops, nTrips }
 * @param {object} o  { arriveBy, sources: [[stopIdx, walkSec], ...], minTransfer, earliest }
 * @returns {Int32Array} latest[stop] = myohaisin hetki jolloin pysakilta voi lahtea
 *                       ja ehtia perille. -1 = ei saavutettavissa.
 */
export function csaBackward(D, o) {
  const { DEP, ARR, FROM, TO, TRIP, footStart, footTo, footSec, nStops, nTrips } = D;
  const minTransfer = o.minTransfer ?? 120;
  const earliest = o.earliest ?? 0;

  const latest = new Int32Array(nStops).fill(-1);
  const onTrip = new Uint8Array(nTrips);

  // Lahtoehdot: kavely tyopaikalle
  for (const [s, walkSec] of o.sources) {
    const t = o.arriveBy - walkSec;
    if (t > latest[s]) latest[s] = t;
  }

  const relax = (stop, time) => {
    if (time <= latest[stop]) return;
    latest[stop] = time;
    for (let j = footStart[stop], e = footStart[stop + 1]; j < e; j++) {
      const n = footTo[j];
      const cand = time - footSec[j];
      if (cand > latest[n]) latest[n] = cand;
    }
  };

  // Kavelyvaihdot myos lahtoehdoista
  for (const [s] of o.sources) relax(s, latest[s]);

  const n = DEP.length;
  for (let i = 0; i < n; i++) {
    const dep = DEP[i];
    if (dep < earliest) break;              // yhteydet on jarjestetty laskevasti
    const tr = TRIP[i];
    let usable = onTrip[tr] === 1;
    if (!usable) {
      const lt = latest[TO[i]];
      usable = lt >= 0 && ARR[i] + minTransfer <= lt;
    }
    if (!usable) continue;
    onTrip[tr] = 1;
    relax(FROM[i], dep);
  }
  return latest;
}

/**
 * Ovelta ovelle -aikaruudukko Web Mercator -koordinaatistossa.
 * Arvo = matka-aika sekunteina (kavely + joukkoliikenne). Infinity = ei ehdi.
 */
export function buildGrid(D, latest, o) {
  const {
    arriveBy, maxTravel,          // s
    walkMps, detour,              // m/s, mutkittelevuuskerroin (0..1)
    maxWalkSec,                   // pisin sallittu kavely yhteen suuntaan
    lat0,                         // keskileveysaste mittakaavaa varten
    cellM = 100, maxCells = 1400
  } = o;

  const kMerc = 1 / Math.cos(lat0 * Math.PI / 180);   // merc-yksikkoa / todellinen metri
  const effMps = walkMps * detour;                     // tehollinen linnuntienopeus

  // Kerataan saavutettavat pysakit ja niiden kavelyvara
  const idx = [], slack = [];
  const departAfter = arriveBy - maxTravel;
  for (let s = 0; s < D.nStops; s++) {
    if (latest[s] < 0) continue;
    const sl = latest[s] - departAfter;
    if (sl <= 0) continue;
    idx.push(s);
    slack.push(Math.min(sl, maxWalkSec));
  }
  if (idx.length === 0) return null;

  // Rajat
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const sx = new Float64Array(idx.length), sy = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    const s = idx[k];
    const x = lonToMerc(D.lon[s]), y = latToMerc(D.lat[s]);
    sx[k] = x; sy[k] = y;
    const r = slack[k] * effMps * kMerc;
    if (x - r < x0) x0 = x - r;
    if (x + r > x1) x1 = x + r;
    if (y - r < y0) y0 = y - r;
    if (y + r > y1) y1 = y + r;
  }

  let cell = cellM * kMerc;
  let w = Math.ceil((x1 - x0) / cell), h = Math.ceil((y1 - y0) / cell);
  if (w > maxCells || h > maxCells) {
    const f = Math.max(w / maxCells, h / maxCells);
    cell *= f;
    w = Math.ceil((x1 - x0) / cell); h = Math.ceil((y1 - y0) / cell);
  }
  w = Math.max(w, 1); h = Math.max(h, 1);

  const g = new Float32Array(w * h).fill(Infinity);

  for (let k = 0; k < idx.length; k++) {
    const s = idx[k];
    const transit = arriveBy - latest[s];          // joukkoliikenneosuus sekunteina
    const rMerc = slack[k] * effMps * kMerc;
    const cx = (sx[k] - x0) / cell, cy = (sy[k] - y0) / cell;
    const rc = rMerc / cell;
    const i0 = Math.max(0, Math.floor(cx - rc)), i1 = Math.min(w - 1, Math.ceil(cx + rc));
    const j0 = Math.max(0, Math.floor(cy - rc)), j1 = Math.min(h - 1, Math.ceil(cy + rc));
    for (let j = j0; j <= j1; j++) {
      const dy = (j + 0.5 - cy) * cell / kMerc;
      const row = j * w;
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5 - cx) * cell / kMerc;
        const dist = Math.hypot(dx, dy);
        const walk = dist / effMps;
        if (walk > slack[k]) continue;
        const total = transit + walk;
        if (total < g[row + i]) g[row + i] = total;
      }
    }
  }

  return {
    grid: g, w, h,
    bounds: [mercToLon(x0), mercToLat(y1), mercToLon(x1), mercToLat(y0)], // W, N, E, S
    reachableStops: idx.length
  };
}

/** Lahimmat pysakit annetusta pisteesta, kavelyaika sekunteina. */
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
