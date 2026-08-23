import { csaBackward, buildGrid, nearbyStops } from './solver.js';

let D = null;
let meta = null;

async function bin(base, name, Type) {
  const r = await fetch(`${base}/${name}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return new Type(await r.arrayBuffer());
}

async function load(base) {
  const [dep, arr, from, to, trip, fs_, ft, fsec, stopsRes, metaRes] = await Promise.all([
    bin(base, 'conn_dep.bin', Uint32Array),
    bin(base, 'conn_arr.bin', Uint32Array),
    bin(base, 'conn_from.bin', Uint32Array),
    bin(base, 'conn_to.bin', Uint32Array),
    bin(base, 'conn_trip.bin', Uint32Array),
    bin(base, 'foot_start.bin', Uint32Array),
    bin(base, 'foot_to.bin', Uint32Array),
    bin(base, 'foot_sec.bin', Uint16Array),
    fetch(`${base}/stops.json`).then(r => r.json()),
    fetch(`${base}/meta.json`).then(r => r.json())
  ]);
  meta = metaRes;
  D = {
    DEP: dep, ARR: arr, FROM: from, TO: to, TRIP: trip,
    footStart: fs_, footTo: ft, footSec: fsec,
    nStops: meta.nStops, nTrips: meta.nTrips,
    lat: stopsRes.lat, lon: stopsRes.lon, name: stopsRes.name
  };
  return meta;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const info = await load(m.base);
      self.postMessage({ type: 'loaded', meta: info });
      return;
    }

    if (m.type === 'solve') {
      if (!D) throw new Error('Dataa ei ole ladattu');
      const t0 = performance.now();
      const effMps = m.walkMps * m.detour;

      const sources = nearbyStops(D, m.lat, m.lon, m.maxWalkSec, effMps);
      if (sources.length === 0) {
        self.postMessage({ type: 'result', empty: 'Ei pysakkeja kavelymatkan paassa.' });
        return;
      }

      const latest = csaBackward(D, {
        arriveBy: m.arriveBy,
        sources,
        minTransfer: m.minTransfer,
        earliest: m.arriveBy - m.maxTravel
      });

      const g = buildGrid(D, latest, {
        arriveBy: m.arriveBy,
        maxTravel: m.maxTravel,
        walkMps: m.walkMps,
        detour: m.detour,
        maxWalkSec: m.maxWalkSec,
        lat0: m.lat
      });

      if (!g) {
        self.postMessage({ type: 'result', empty: 'Mikaan pysakki ei ole saavutettavissa annetussa ajassa.' });
        return;
      }

      self.postMessage({
        type: 'result',
        grid: g.grid, w: g.w, h: g.h, bounds: g.bounds,
        reachableStops: g.reachableStops,
        nearestStops: sources.length,
        ms: Math.round(performance.now() - t0)
      }, [g.grid.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
