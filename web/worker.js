import * as SV from './solver.js';

let D = null, meta = null, walk = null, ti = null, stopCell = null;
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
    stopCell = new Int32Array(D.nStops);
    for (let s = 0; s < D.nStops; s++) {
      stopCell[s] = SV.cellIndex(walk, D.lon[s], D.lat[s], 3);
    }
  } catch (e) {
    walk = null; stopCell = null;
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

/** Kavelyreitti kahden pisteen valilla katuverkkoa pitkin. */
function walkGeom(fromLL, toLL, maxSec, walkMps) {
  if (!walk) return [fromLL, toLL];
  const a = SV.cellIndex(walk, fromLL[0], fromLL[1], 4);
  const b = SV.cellIndex(walk, toLL[0], toLL[1], 4);
  if (a < 0 || b < 0) return [fromLL, toLL];
  const net = SV.walkNetwork(walk, a, Math.max(60, Math.round(maxSec * 1.6)), walkMps, true);
  const p = net && SV.walkPath(walk, net, b);
  if (!p || p.length < 2) return [fromLL, toLL];
  return [fromLL, ...p, toLL];
}

/** Koko matkan geometria: kavelyt verkkoa pitkin, ajo-osuudet pysakkiketjuna. */
function routeGeometry(legs, homeLL, workLL, walkMps) {
  const segs = [];
  const ll = s => [D.lon[s], D.lat[s]];
  let cursor = homeLL;

  for (const L of legs) {
    if (L.mode === 'walk') {
      const to = L.last ? workLL : ll(L.toStop);
      segs.push({ mode: 'walk', coords: walkGeom(cursor, to, L.sec || 300, walkMps) });
      cursor = to;
    } else {
      const pts = (L.path && L.path.length ? L.path : [L.fromStop, L.toStop]).map(ll);
      // kavely kursorista nousupysakille, jos valissa on matkaa
      const board = pts[0];
      if (cursor && (Math.abs(cursor[0] - board[0]) > 1e-6 || Math.abs(cursor[1] - board[1]) > 1e-6)) {
        segs.push({ mode: 'walk', coords: walkGeom(cursor, board, 900, walkMps) });
      }
      segs.push({ mode: 'transit', coords: pts, line: L.line, kind: L.kind });
      cursor = pts[pts.length - 1];
    }
  }
  return segs;
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
      // Pysäkittömyys ei ole virhe: työpaikalle voi päästä pelkästään kävellen.
      // Kävelyajat luetaan katuverkosta, ei linnuntietä.
      const sources = walk
        ? SV.stopWalkTimes(D, walk, stopCell, m.lat, m.lon, m.maxWalkSec, m.walkMps)
        : SV.nearbyStops(D, m.lat, m.lon, m.maxWalkSec, effMps);
      const win = SV.csaWindow(D, {
        arriveFrom: m.arriveFrom, arriveTo: m.arriveTo, step: m.step,
        sources, minTransfer: m.minTransfer, maxTravel: m.maxTravel
      });
      last = { win, maxTravel: m.maxTravel, walkMps: m.walkMps, maxWalkSec: m.maxWalkSec,
               grid: null, lat: m.lat, lon: m.lon };

      if (!walk) {
        self.postMessage({ type: 'result', empty: 'Kävelyrasteri puuttuu — aja build uudelleen.' });
        return;
      }
      const g = SV.buildGridWalk(D, win.transit, walk, {
        maxTravel: m.maxTravel, walkMps: m.walkMps, maxWalkSec: m.maxWalkSec,
        origin: { lat: m.lat, lon: m.lon }
      });
      if (!g) {
        self.postMessage({ type: 'result', empty: 'Mikään pysäkki ei ole saavutettavissa annetussa ajassa.' });
        return;
      }
      let reach = 0, walkers = 0;
      for (let i = 0; i < g.grid.length; i++) {
        if (!isFinite(g.grid[i])) continue;
        reach++; if (g.walkOnly[i]) walkers++;
      }
      // pidetään ruudukko työsäikeessä matkaehdotusta varten, kopio menee ulos
      last.grid = g;
      const outGrid = g.grid.slice();
      self.postMessage({
        type: 'result', grid: outGrid, road: g.road, w: g.w, h: g.h, bounds: g.bounds,
        mercX0: g.mercX0, mercY0: g.mercY0, mercCell: g.mercCell,
        reachableStops: g.reachableStops, cells: reach, runs: win.times.length,
        km2: +(reach * (walk.cellM / 1000) ** 2).toFixed(1), preview: !!m.preview,
        ms: Math.round(performance.now() - t0),
        walkOnlyCells: walkers, noStops: sources.length === 0
      }, [outGrid.buffer, g.road.buffer]);
      return;
    }

    if (m.type === 'itinerary') {
      if (!last) throw new Error('Aseta ensin työpaikka');
      const effMps = last.walkMps * 0.75;
      const W = last.win;

      // Pelkkä kävely: lue ruudukosta, jolloin aika on katuverkon mukainen.
      let walkTotal = -1;
      const G = last.grid;
      if (G) {
        const i = Math.floor((SV.lonToMerc(m.lon) - G.mercX0) / G.mercCell);
        const j = Math.floor((SV.latToMerc(m.lat) - G.mercY0) / G.mercCell);
        if (i >= 0 && i < G.w && j >= 0 && j < G.h) {
          const c = j * G.w + i;
          if (G.walkOnly[c] && isFinite(G.grid[c])) walkTotal = G.grid[c];
        }
      }

      const wt = walk
        ? SV.stopWalkTimes(D, walk, stopCell, m.lat, m.lon, last.maxWalkSec, last.walkMps)
        : SV.nearbyStops(D, m.lat, m.lon, last.maxWalkSec, effMps);
      const b = SV.bestOriginNet(W.transit, wt, last.maxTravel);

      if (walkTotal >= 0 && (!b || walkTotal <= b.total)) {
        const arr = W.times[W.times.length - 1];
        self.postMessage({
          type: 'itinerary', walkOnly: true,
          legs: [{ mode: 'walk', last: true, fromStop: -1, toStop: -1,
                   fromName: 'koti', toName: 'työpaikka',
                   dep: arr - walkTotal, arr, sec: walkTotal }],
          firstWalk: 0, firstStop: null,
          leave: arr - walkTotal, arriveBy: arr, total: walkTotal,
          geometry: [{ mode: 'walk',
            coords: walkGeom([m.lon, m.lat], [last.lon, last.lat], walkTotal, last.walkMps) }]
        });
        return;
      }

      if (!b) { self.postMessage({ type: 'itinerary', empty: 'Tänne ei ehdi annetussa ajassa.' }); return; }
      const k = W.winner[b.stop];
      const r = SV.reconstruct(D, W.runs[k], ti, b.stop, { arriveBy: W.times[k] });
      if (!r) { self.postMessage({ type: 'itinerary', empty: 'Matkan purku epäonnistui.' }); return; }
      const leave = r.departure - b.walkSec;
      const named = nameLegs(r.legs);
      self.postMessage({
        type: 'itinerary',
        legs: named,
        firstWalk: b.walkSec, firstStop: D.name[b.stop],
        leave, arriveBy: r.arrival, total: r.arrival - leave,
        geometry: routeGeometry(named, [m.lon, m.lat], [last.lon, last.lat], last.walkMps)
      });
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
