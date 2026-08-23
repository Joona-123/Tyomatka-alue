# Työmatka-alue

Selainpohjainen työkalu asuinpaikan etsintään: valitse työpaikka kartalta ja näe,
mistä sinne ehtii joukkoliikenteellä annetussa ajassa.

Ei palvelinta. Aikataulut esiprosessoidaan GitHub Actionsissa kompaktiksi
binääripaketiksi, ja reititys ajetaan selaimessa Web Workerissa
(taaksepäin ajettava Connection Scan Algorithm).

## Rakenne

```
tools/build-data.mjs   GTFS -> binääripaketti (Node, ei riippuvuuksia)
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
npx serve web        # moduuliworker vaatii http:n, file:// ei riitä
```

## Rajoitukset

- Kävelysäteet ovat ympyröitä, oikaistu kertoimella 0,75. Vesistöt ja
  moottoritiet eivät katkaise niitä.
- Yksi saapumisaika kerrallaan. Aikaikkunan yli laskeva luotettavuus-% puuttuu.
- Vain menosuunta. Ilta on usein pullonkaula.
- Vain HSL. VR ja Waltti-kaupungit puuttuvat.

## Lähteet ja lisenssit

- Aikataulut: © HSL, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fi)
- Karttapohja: © OpenStreetMap-tekijät, ODbL
- Koodi: MIT
