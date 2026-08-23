import * as SV from './solver.js';

let D = null, meta = null, walk = null, ti = null;
let last = null;   // viimeisin ratkaisu matkaehdotusta varten

async function bin(base, name, Type, tries = 4) {
  let err = '';
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise(r => setTimeout(r, 400 * 2 ** i));
    let r;
    try { r = await fetch(`${base}/${name}`); }
    catch (e) { err = String(e.message || e); continue; }
    if (r.ok) return new Type(await r.arrayBuffer());
    err = `HTTP ${r.status}`;
    if (r.status < 500 && r.status !== 429) break;
  }
  throw new Error(`${name}: ${err}`);
}
const json = (base, n) => fetch(`${base}/${n}`).then(r => {
  if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`);
  return r.json();
});

async function load(base) {
  const [dep, arr, from, to, trip, fst, fto, fsec, stops, m, routes, trips] = await Promise.all([
    bin(base, 'conn_dep.bin', Uint32Array), bin(base, 'conn_arr.bin', Uint32Array),
    bin(base, 'conn_from.bin', Uint32Array), bin(base, 'conn_to.bin', Uint32Array),
    bin(base, 'conn_trip.bin', Uint32Array), bin(base, 'foot_start.bin', Uint32Array),
    bin(base, 'foot_to.bin', Uint32Array), bin(base, 'foot_sec.bin', Uint16Array),
    json(base, 'stops.json'), json(base, 'meta.json'),
    json(base, 'routes.json'), json(base, 'trips.json')
  ]);
  meta = m;
  D = {
    DEP: dep, ARR: arr, FROM: from, TO: to, TRIP: trip,
    footStart: fst, footTo: fto, footSec: fsec,
    nStops: m.nStops, nTrips: m.nTrips,
    lat: stops.lat, lon: stops.lon, name: stops.name,
    tripRoute: trips.route, tripHead: trips.head,
    routeShort: routes.short, routeType: routes.type
  };
  ti = SV.tripIndex(D);

  // Kavelyrasteri on valinnainen: ilman sita ei piirreta mitaan alueita.
  try {
    const wm = await json(base, 'walk_meta.json');
    const wg = await bin(base, 'walk_grid.bin', Uint8Array);
    walk = { ...wm, grid: wg };
  } catch (e) {
    walk = null;
    meta.walkError = String(e.message || e);
  }
  return { ...meta, hasWalk: !!walk, walkCells: walk ? walk.w * walk.h : 0 };
}

// GTFS route_type. Perusarvot 0-12, laajennetut 100-1700.
const MODE = {
  0: 'Ratikka', 1: 'Metro', 2: 'Juna', 3: 'Bussi', 4: 'Lautta',
  5: 'Ratikka', 6: 'Gondoli', 7: 'Funikulaari', 11: 'Johdinauto', 12: 'Monorail',
  100: 'Juna', 109: 'Lähijuna', 400: 'Metro', 401: 'Metro',
  700: 'Bussi', 701: 'Bussi', 704: 'Bussi', 715: 'Kutsubussi',
  900: 'Ratikka', 1000: 'Lautta', 1300: 'Gondoli', 1400: 'Funikulaari'
};
const modeName = rt => MODE[rt] || (rt >= 700 && rt < 800 ? 'Bussi'
  : rt >= 900 && rt < 1000 ? 'Ratikka' : rt >= 100 && rt < 200 ? 'Juna' : 'Vuoro');

function nameLegs(legs) {
  return legs.map(L => L.mode === 'walk'
    ? { ...L, fromName: D.name[L.fromStop], toName: L.last ? 'työpaikka' : D.name[L.toStop] }
    : {
        ...L, fromName: D.name[L.fromStop], toName: D.name[L.toStop],
        line: L.route >= 0 ? (D.routeShort[L.route] || '?') : '?',
        kind: modeName(L.route >= 0 ? D.routeType[L.route] : 3),
        head: D.tripHead[L.trip] || ''
      });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      self.postMessage({ type: 'loaded', meta: await load(m.base) });
      return;
    }

    if (m.type === 'solve') {
      if (!D) throw new Error('Dataa ei ole ladattu');
      const t0 = performance.now();
      const effMps = m.walkMps * 0.75;
      const sources = SV.nearbyStops(D, m.lat, m.lon, m.maxWalkSec, effMps);
      if (!sources.length) {
        self.postMessage({ type: 'result', empty: 'Ei pysäkkejä kävelymatkan päässä työpaikasta.' });
        return;
      }
      const win = SV.csaWindow(D, {
        arriveFrom: m.arriveFrom, arriveTo: m.arriveTo, step: m.step,
        sources, minTransfer: m.minTransfer, maxTravel: m.maxTravel
      });
      last = { win, maxTravel: m.maxTravel, walkMps: m.walkMps, maxWalkSec: m.maxWalkSec };

      if (!walk) {
        self.postMessage({ type: 'result', empty: 'Kävelyrasteri puuttuu — aja build uudelleen.' });
        return;
      }
      const g = SV.buildGridWalk(D, win.transit, walk, {
        maxTravel: m.maxTravel, walkMps: m.walkMps, maxWalkSec: m.maxWalkSec
      });
      if (!g) {
        self.postMessage({ type: 'result', empty: 'Mikään pysäkki ei ole saavutettavissa annetussa ajassa.' });
        return;
      }
      let reach = 0;
      for (let i = 0; i < g.grid.length; i++) if (isFinite(g.grid[i])) reach++;
      self.postMessage({
        type: 'result', grid: g.grid, road: g.road, w: g.w, h: g.h, bounds: g.bounds,
        reachableStops: g.reachableStops, cells: reach, runs: win.times.length,
        km2: +(reach * (walk.cellM / 1000) ** 2).toFixed(1),
        ms: Math.round(performance.now() - t0)
      }, [g.grid.buffer, g.road.buffer]);
      return;
    }

    if (m.type === 'itinerary') {
      if (!last) throw new Error('Aseta ensin työpaikka');
      const effMps = last.walkMps * 0.75;
      const W = last.win;
      const b = SV.bestOrigin(D, W.transit, m.lat, m.lon, {
        maxWalkSec: last.maxWalkSec, effMps, maxTravel: last.maxTravel
      });
      if (!b) { self.postMessage({ type: 'itinerary', empty: 'Tänne ei ehdi annetussa ajassa.' }); return; }
      const k = W.winner[b.stop];
      const r = SV.reconstruct(D, W.runs[k], ti, b.stop, { arriveBy: W.times[k] });
      if (!r) { self.postMessage({ type: 'itinerary', empty: 'Matkan purku epäonnistui.' }); return; }
      const leave = r.departure - b.walkSec;
      self.postMessage({
        type: 'itinerary',
        legs: nameLegs(r.legs),
        firstWalk: b.walkSec, firstStop: D.name[b.stop],
        leave, arriveBy: r.arrival, total: r.arrival - leave
      });
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
