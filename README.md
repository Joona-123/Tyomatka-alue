# Työmatka-alue

Selainpohjainen työkalu asuinpaikan etsintään: valitse työpaikka kartalta ja näe,
mistä sinne ehtii joukkoliikenteellä annetussa ajassa.

Ei palvelinta. Aikataulut esiprosessoidaan GitHub Actionsissa kompaktiksi
binääripaketiksi, ja reititys ajetaan selaimessa Web Workerissa
(taaksepäin ajettava Connection Scan Algorithm).

## Rakenne

```
tools/build-data.mjs   GTFS -> binääripaketti (Node, ei riippuvuuksia)
tools/build-walk.mjs   OSM-kulkuväylät -> kävelykelpoisuusrasteri
web/index.html         käyttöliittymä (MapLibre)
web/worker.js          datan lataus + laskenta työsäikeessä
web/solver.js          CSA + saavutettavuusruudukko (puhdas, testattavissa)
.github/workflows/     viikoittainen build ja julkaisu Pagesiin
```

`web/data/` syntyy buildissa — **älä committaa sitä.**

## Käyttöönotto

1. Settings → Pages → Source: **GitHub Actions**
2. Actions → *Rakenna ja julkaise* → **Run workflow**

## Paikallisesti

```sh
curl -o hsl.zip https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip
unzip -q hsl.zip -d gtfs
node tools/build-data.mjs gtfs web/data hsl

curl -o hsl.osm.pbf https://karttapalvelu.storage.hsldev.com/hsl.osm/hsl.osm.pbf
osmium tags-filter hsl.osm.pbf w/highway -o hw.pbf
osmium export hw.pbf -f geojsonseq -i flex_mem --geometry-types=linestring -o hw.geojsonseq
node tools/build-walk.mjs hw.geojsonseq web/data "$(node -p "JSON.parse(require('fs').readFileSync('web/data/meta.json')).bbox.join(',')")"
npx serve web        # moduuliworker vaatii http:n, file:// ei riitä
```

## Rajoitukset

- Kävely lasketaan 50 m rasterilla jolle on merkitty OSM:n kulkukelpoiset
  väylät. Se seuraa katuverkkoa ja kiertää vedet, mutta ei ole
  käännöskohtainen reititys.
- Vaihtoaika on 120 s ellei transfers.txt määrittele muuta.
- Vaihtojen määrää ei rajoiteta.
- Yksi saapumisaika kerrallaan. Aikaikkunan yli laskeva luotettavuus-% puuttuu.
- Vain menosuunta. Ilta on usein pullonkaula.
- Vain HSL. VR:n kaukojunat ja Waltti-kaupungit puuttuvat.

## Lähteet ja lisenssit

- Aikataulut: © HSL, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fi)
- Karttapohja ja kävelyverkko: © OpenStreetMap-tekijät, ODbL.
  `walk_grid.bin` on OSM:stä johdettu tietokanta ja siten ODbL:n alainen.
- Koodi: MIT
