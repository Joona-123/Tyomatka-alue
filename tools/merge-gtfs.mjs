#!/usr/bin/env node
/**
 * Yhdistaa useita GTFS-syotteita yhdeksi.
 *
 * Kaytto: node tools/merge-gtfs.mjs <ulos-dir> <etuliite>=<gtfs-dir> [...]
 *   esim. node tools/merge-gtfs.mjs tmp/merged hsl=tmp/hsl vr=tmp/vr
 *
 * Jokaisen syotteen tunnisteet (stop_id, route_id, trip_id, service_id,
 * shape_id) etuliitetaan, jotta eri operaattoreiden samannimiset tunnisteet
 * eivat toermaa. Pysakkien koordinaatit ja ajat sailyvat sellaisinaan.
 *
 * Puuttuvat tai tyhjat syotteet ohitetaan varoituksella - yhden operaattorin
 * katkennut lataus ei saa kaataa koko rakennusta.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [, , OUT, ...specs] = process.argv;
if (!OUT || !specs.length) {
  console.error('Kaytto: node tools/merge-gtfs.mjs <out-dir> <prefix>=<gtfs-dir> ...');
  process.exit(1);
}

// tiedosto -> sarakkeet joissa on tunniste joka pitaa etuliitteistaa
const IDCOLS = {
  'agency.txt': ['agency_id'],
  'stops.txt': ['stop_id', 'parent_station'],
  'routes.txt': ['route_id', 'agency_id'],
  'trips.txt': ['route_id', 'service_id', 'trip_id', 'shape_id', 'block_id'],
  'stop_times.txt': ['trip_id', 'stop_id'],
  'calendar.txt': ['service_id'],
  'calendar_dates.txt': ['service_id'],
  'transfers.txt': ['from_stop_id', 'to_stop_id', 'from_trip_id', 'to_trip_id'],
  'frequencies.txt': ['trip_id'],
  'shapes.txt': ['shape_id']
};

function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const esc = v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
const strip = s => s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;

const sources = [];
for (const spec of specs) {
  const eq = spec.indexOf('=');
  if (eq < 0) { console.error(`Virheellinen maarittely: ${spec}`); process.exit(1); }
  const prefix = spec.slice(0, eq), dir = spec.slice(eq + 1);
  if (!fs.existsSync(path.join(dir, 'stop_times.txt'))) {
    console.warn(`OHITETAAN ${prefix}: ${dir} ei sisalla GTFS:aa`);
    continue;
  }
  sources.push({ prefix, dir });
}
if (!sources.length) { console.error('VIRHE: yhtaan kelvollista syotetta ei loytynyt.'); process.exit(1); }
console.log(`Yhdistetaan ${sources.length} syotetta: ${sources.map(s => s.prefix).join(', ')}`);

fs.mkdirSync(OUT, { recursive: true });

const files = new Set();
for (const s of sources) {
  for (const f of fs.readdirSync(s.dir)) if (f.endsWith('.txt')) files.add(f);
}

for (const file of files) {
  const cols = IDCOLS[file] || [];
  const outPath = path.join(OUT, file);
  const ws = fs.createWriteStream(outPath);
  let header = null, headerIdx = null, total = 0;

  for (const { prefix, dir } of sources) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;

    const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
    let myHead = null, myIdx = null, n = 0;

    for await (const raw of rl) {
      if (!raw) continue;
      if (myHead === null) {
        myHead = splitCsv(strip(raw)).map(x => x.trim());
        myIdx = cols.map(c => myHead.indexOf(c)).filter(i => i >= 0);
        if (header === null) {
          header = myHead;
          headerIdx = myIdx;
          ws.write(header.join(',') + '\n');
        }
        continue;
      }
      const row = splitCsv(raw);
      // sarakkeet uudelleenjarjestetaan yhteisen otsikon mukaan
      const out = header.map(h => {
        const i = myHead.indexOf(h);
        return i >= 0 && row[i] !== undefined ? row[i] : '';
      });
      for (const c of cols) {
        const i = header.indexOf(c);
        if (i >= 0 && out[i] !== '') out[i] = prefix + ':' + out[i];
      }
      ws.write(out.map(esc).join(',') + '\n');
      n++; total++;
    }
    if (n) console.log(`  ${file.padEnd(20)} ${prefix.padEnd(8)} ${n} rivia`);
  }
  ws.end();
  if (total === 0) fs.unlinkSync(outPath);
}
console.log('Yhdistaminen valmis.');
