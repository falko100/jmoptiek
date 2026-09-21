# Bezoekersmeting — hoeveel verschillende gezichten per dag

De spiegel telt zelf hoeveel mensen er voor gestaan hebben en stuurt die cijfers
naar een backend-endpoint. Dit document beschrijft wat er gemeten wordt en welk
HTTP-contract de backend moet bieden.

## Wat er gemeten wordt

- **Bezoek (`visit`)** — één aaneengesloten periode dat iemand voor de spiegel
  staat, dicht genoeg bij om brillen te kunnen passen (dezelfde regel als de
  "Ga op de voetstappen staan"-overlay: ≤ 95 cm, of het gezicht vult ≥ 22% van
  de hoogte van het beeld). Korte trackingdips worden overbrugd; 8 seconden weg
  sluit het bezoek af. Korter dan 1,2 seconde telt niet mee — dat is iemand die
  langsloopt.
- **Uniek gezicht** — een bezoek waarvan het gezicht niet gematcht kon worden aan
  een eerder bezoek binnen de laatste 10 minuten. Loopt iemand even weg en komt
  hij terug, dan telt dat als `returning` en niet als nieuw gezicht. Dat venster
  **schuift mee**: bij elke match wordt de klok opnieuw gestart, dus wie elke
  acht minuten terugkeert blijft onbeperkt hetzelfde gezicht. Pas na 10 minuten
  écht weg zijn levert een nieuwe telling op.
- **Dag** — lokale dag van de kiosk (`YYYY-MM-DD`), niet UTC. Om middernacht
  wordt de dag afgesloten en begint de telling opnieuw.

### Hoe "hetzelfde gezicht" bepaald wordt

Geen gezichtsherkenning. Per bezoek wordt uit de MediaPipe-landmarks een
meetkundige vingerafdruk berekend (onderlinge afstanden tussen ~12 stabiele
punten, geschaald op de oogafstand). Die is bruikbaar voor "is dit dezelfde
persoon als zojuist", niet voor het herkennen van iemand over dagen heen.

Belangrijk voor de verwachtingen én voor de AVG:

- De vingerafdrukken staan **alleen in het geheugen** van de kiosk, verdwijnen na
  10 minuten en gaan **nooit** naar de backend. Ze overleven dus ook geen
  herlaad of herstart van de browser — zie hieronder wat dat voor de telling
  betekent.
- Er worden geen beelden opgeslagen of verstuurd.
- "Uniek" betekent dus: **aantal bezoeken, ontdubbeld binnen 10 minuten**. Komt
  dezelfde klant 's ochtends en 's middags terug, dan telt dat als twee.
- De matching staat op `matchThreshold` 0.035. De afweging: twee verschillende
  mensen samenvoegen kost een echte bezoeker, een terugkerende bezoeker missen
  telt iemand dubbel die er ook echt stond. Die tweede fout is goedkoper, maar
  niet gratis — de drempel stond aanvankelijk op 0.02, de absolute ondergrens
  van wat dezelfde persoon scoort, waardoor vrijwel elke terugkeerder als nieuw
  gezicht werd geteld en de telling flink te hoog uitkwam.

Het aantal bezoeken (`visits`) is de harde meting; de verdeling
unieke/terugkerende is de schatting.

#### De tien minuten lopen van eind tot eind

Het venster wordt gemeten vanaf het **einde** van het ene bezoek tot het
**einde** van het volgende, niet tot het begin. `matchAndTrack` zet `lastSeenAt`
op het moment dat een bezoek wordt afgesloten, en vergelijkt bij het afsluiten
van het volgende bezoek tegen `now - revisitWindowMs`.

Gevolg: **een lang bezoek verbruikt zijn eigen duur uit het venster.** Wie twee
minuten voor de spiegel staat, heeft nog acht minuten over om gematcht te worden
aan wat er daarvóór was.

Dat is geen theorie; het is in de meetdata terug te zien:

- Bezoek 2 eindigde om 10:56:59. Bezoek 3 liep van 11:06:26 tot 11:08:25.
- Bij het afsluiten van bezoek 3 lag de grens op 10:58:27. Bezoek 2 was toen net
  verlopen en werd niet meer vergeleken.
- Was er vanaf de *start* van bezoek 3 gerekend, dan had de grens op 10:56:26
  gelegen en was bezoek 2 er nog binnen gevallen.

De twee minuten die bezoek 3 zelf duurde zijn dus precies wat de vergelijking
onmogelijk maakte.

#### Een herlaad wist het gezichtsgeheugen

`saveDay()` bewaart alleen de dagtelling in localStorage. De vingerafdrukken
staan uitsluitend in het geheugen en `tracked` begint bij elke herlaad leeg. Dat
is opzet: descriptoren persistent opslaan zou de belofte hierboven breken.

Het gevolg is wel dat **het eerste bezoek na elke herlaad gegarandeerd als nieuw
gezicht telt**, ook als dezelfde persoon tien seconden eerder nog voor de
spiegel stond. Er is simpelweg niets om mee te vergelijken.

Zo'n bezoek is te herkennen: uitkomst `new` met een **lege** `matchDistance`.
Die is alleen leeg als er geen enkel onthouden gezicht was — bij het allereerste
bezoek van de dag, of bij het eerste na een herstart.

Voor een winkel die dagen achtereen draait is dit verwaarloosbaar. Tijdens het
afstellen niet: wie vaak herlaadt, telt bij elke herlaad één uniek gezicht extra,
om een reden die niets met de drempel te maken heeft. Meet dus liever één ronde
in één sessie, of laat bij de analyse de rijen met een lege afstand buiten
beschouwing.

#### Alleen de kiosk, niet de backend

Dit geldt uitsluitend voor de kiosk. Het dashboard verversen, de backend
herstarten of de database opnieuw opstarten raakt de telling niet: de beslissing
"nieuw of terugkerend" valt op de kiosk vóór er iets verstuurd wordt, en de
backend slaat die uitkomst alleen op en telt hem op. Er wordt daar nergens zelf
uniekheid berekend — geen `DISTINCT`, geen groepering op gezicht — en
descriptoren komen er sowieso nooit aan.

**De kiosk beslist, de backend registreert.**

Andersom geldt er wél iets: de backend kan beïnvloeden wat je te zien krijgt,
niet wat er geteld is. Antwoordt hij met 400, 413 of 422, dan gooit de kiosk die
batch weg en zijn die bezoekregels kwijt. De dagstand wordt opnieuw gestuurd en
corrigeert de totalen, maar de losse regels komen niet terug. Datzelfde geldt
voor rijen die handmatig uit de database verwijderd worden.

## Beperkingen van de meting

Twee dingen die geen defect zijn, maar wel bepalen wat de cijfers waard zijn.

### Twee mensen tegelijk zijn één bezoek

`src/face-tracker.ts` draait met `numFaces: 1`: MediaPipe volgt uitsluitend het
meest prominente gezicht. Staan er twee mensen voor de spiegel, dan levert dat
één bezoek op, en degene die het dichtst bij komt kan de tracking halverwege
overnemen. De descriptor wordt dan een mengsel van twee gezichten en matcht
nergens op — zo'n bezoek telt dus als nieuw gezicht.

Voor een winkel waar mensen samen een bril uitzoeken is dat geen randgeval. Het
is ook de reden dat `visits` een hardere meting is dan de verdeling
uniek/terugkerend: het aantal keren dat er iemand stond klopt, wie dat waren is
de schatting.

### Meerdere tabbladen delen dezelfde opslag

De wachtrij (`jm.statsQueue.v1`), de dagtelling (`jm.visitorStats.v1`) en de
kiosk-id (`jm.kioskId`) staan in `localStorage` zonder enige coördinatie tussen
tabbladen. Twee open kiosk-tabbladen op dezelfde machine overschrijven elkaars
staat: een event dat het ene tabblad al afgeleverd heeft kan door het andere
teruggezet worden, en beide tellen onafhankelijk door op dezelfde dagtelling.

In productie draait één browser in kioskmodus, dus daar speelt dit niet. Tijdens
ontwikkelen wel — en het is een plausibele verklaring als de metingen niet
overeenkomen met wat je hebt zien gebeuren. Houd één tabblad open.

## Configuratie

Zet dit in `.env` (zie `.env.example`):

| Variabele | Betekenis |
| --- | --- |
| `VITE_STATS_ENDPOINT` | URL van de collector. Leeg = wel meten, niet versturen. |
| `VITE_STATS_TOKEN` | Optioneel; gaat mee als `Authorization: Bearer <token>`. |
| `VITE_KIOSK_ID` | Welke spiegel dit is. Leeg = willekeurige id in localStorage. |
| `VITE_VISIT_MATCH_THRESHOLD` | Optioneel; gevoeligheid van de hermatching. |

Zonder endpoint draait de app precies als voorheen — handig zolang de backend er
nog niet is. De telling loopt dan gewoon door en is zichtbaar in het debugpaneel
(toets **`v`** op de kiosk).

## HTTP-contract

Eén endpoint, `POST <VITE_STATS_ENDPOINT>`, `Content-Type: application/json`:

```json
{
  "kioskId": "jm-optiek-winkel-1",
  "sentAt": "2026-09-12T14:34:47.382Z",
  "events": [
    {
      "eventId": "37ecb6b3-5561-4ee3-95ef-4e6ad2812ec4",
      "queuedAt": "2026-09-12T14:34:47.032Z",
      "type": "visit",
      "kioskId": "jm-optiek-winkel-1",
      "visitId": "c2a1e5f0-1b6d-4f2e-9c31-0b9a7a1d4e88",
      "date": "2026-09-12",
      "startedAt": "2026-09-12T14:34:41.032Z",
      "endedAt": "2026-09-12T14:34:47.005Z",
      "durationMs": 5973,
      "returning": false,
      "sequence": 7
    }
  ]
}
```

Er zitten maximaal 50 events in één batch; beide typen kunnen door elkaar in
dezelfde batch zitten.

### `type: "visit"`

| Veld | Type | Betekenis |
| --- | --- | --- |
| `visitId` | uuid | Unieke id van het bezoek. |
| `date` | `YYYY-MM-DD` | Lokale dag waarop het bezoek begon. |
| `startedAt` / `endedAt` | ISO 8601 | Begin en eind van het bezoek. |
| `durationMs` | int | Hoe lang iemand voor de spiegel stond. |
| `returning` | bool | `true` = hetzelfde gezicht als kort daarvoor. |
| `sequence` | int | Hoeveelste bezoek van die dag (1-based). |
| `matchOutcome` | `returning`\|`new`\|`unknown` | Wat de teller besloot, zie hieronder. |
| `matchDistance` | float\|null | Afstand tot het dichtstbijzijnde onthouden gezicht. |
| `sampleCount` | int | Aantal samples; 0 betekent `unknown`. |
| `matchThreshold` | float | Drempel die op dat moment gold. |

De laatste vier velden zijn **optioneel**: een kiosk op een oudere build stuurt
ze niet mee en die batch moet gewoon geaccepteerd worden. Het zijn scalairen die
de beslissing beschrijven — nooit de descriptor zelf, dus er gaat nog steeds geen
biometrisch gegeven naar de backend.

`matchOutcome` onderscheidt twee dingen die onder `returning: false` op één hoop
lagen:

| Waarde | Betekenis |
| --- | --- |
| `returning` | Descriptor gematcht binnen de drempel. |
| `new` | Descriptor gebouwd, geen match in het venster. |
| `unknown` | Geen bruikbare descriptor — het gezicht was nooit frontaal genoeg. |

Een `unknown`-bezoek verhoogt `uniqueFaces` niet. Het wordt ook niet onthouden
voor latere vergelijkingen, want er is niets om te onthouden.

### `type: "daily"`

De lopende dagstand, verstuurd **zodra hij verandert** — dat is precies wanneer
een bezoek afloopt — plus elke 5 minuten als hartslag voor een dag waarop niets
gebeurt, en bij het afsluiten van de dag met `final: true`. Bedoeld als **upsert
op (`kioskId`, `date`)**: de laatste versie wint, `final: true` is de
definitieve.

Het bezoek en de bijgewerkte dagstand worden in dezelfde POST verstuurd
(`sendDebounceMs` in `src/stats-reporter.ts` verzamelt wat in hetzelfde moment
in de wachtrij komt). Dat is geen detail: de bezoekenlijst leest `kiosk_visits`
en het dashboard leest `kiosk_days`, dus zouden ze los aankomen, dan spreken die
twee schermen elkaar tegen zolang het verschil bestaat. Eerder ging de dagstand
alleen elke 5 minuten mee en liep het dashboard zichtbaar achter.

```json
{
  "type": "daily",
  "kioskId": "jm-optiek-winkel-1",
  "date": "2026-09-12",
  "uniqueFaces": 17,
  "unknownFaces": 2,
  "visits": 21,
  "returningVisits": 4,
  "totalDwellMs": 214000,
  "averageDwellMs": 10190,
  "firstVisitAt": "2026-09-12T08:12:03.881Z",
  "lastVisitAt": "2026-09-12T17:41:55.210Z",
  "final": false,
  "timezoneOffsetMinutes": 120
}
```

`uniqueFaces` is een **ondergrens** op het aantal mensen en
`uniqueFaces + unknownFaces` een **bovengrens**. Toon die twee samen; alleen de
ondergrens laten zien presenteert een schatting als een telling. Loopt
`unknownFaces` op, dan kijken mensen te schuin voor de camera en is de hele
telling die dag minder waard. Wil je het liever zelf
berekenen, dan kan dat ook uit de visit-events:

```sql
SELECT date, COUNT(*) FILTER (WHERE NOT returning) AS unique_faces,
       COUNT(*) AS visits
FROM kiosk_visits
WHERE kiosk_id = $1
GROUP BY date;
```

### Antwoorden die de kiosk verwacht

| Status | Wat de kiosk doet |
| --- | --- |
| `2xx` | Batch is klaar en wordt uit de wachtrij gehaald. |
| `400`, `413`, `422` | Batch wordt **weggegooid** — bedoeld voor payloads die nooit geaccepteerd worden, zodat één kapot event de rij niet blokkeert. |
| `401`, `403`, `404`, `5xx`, netwerkfout | Batch blijft staan en wordt opnieuw geprobeerd (5s, oplopend tot 5 min). |

De body van het antwoord wordt niet gelezen; een leeg `202` volstaat.

### Duplicaten

Bij een time-out kan een batch die de backend wél verwerkt heeft opnieuw
aangeboden worden. Maak de verwerking daarom idempotent op `eventId` (of op
`visitId` voor visits, en op `kioskId` + `date` voor daily). De wachtrij
overleeft herstarts van de browser — na een avond zonder internet komen de
events van die dag alsnog binnen, met hun oorspronkelijke tijdstempels.

### Minimale collector (Express, als schets)

```js
app.post('/kiosk/stats', express.json({ limit: '256kb' }), async (req, res) => {
    const { kioskId, events } = req.body ?? {};
    if (!kioskId || !Array.isArray(events)) return res.sendStatus(400);

    for (const e of events) {
        if (e.type === 'visit') {
            await db.query(
                `INSERT INTO kiosk_visits (visit_id, kiosk_id, date, started_at, ended_at,
                                           duration_ms, returning)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (visit_id) DO NOTHING`,
                [e.visitId, kioskId, e.date, e.startedAt, e.endedAt, e.durationMs, e.returning],
            );
        } else if (e.type === 'daily') {
            await db.query(
                `INSERT INTO kiosk_days (kiosk_id, date, unique_faces, visits, returning_visits,
                                         total_dwell_ms, final)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (kiosk_id, date) DO UPDATE SET
                   unique_faces = EXCLUDED.unique_faces, visits = EXCLUDED.visits,
                   returning_visits = EXCLUDED.returning_visits,
                   total_dwell_ms = EXCLUDED.total_dwell_ms, final = EXCLUDED.final`,
                [kioskId, e.date, e.uniqueFaces, e.visits, e.returningVisits,
                 e.totalDwellMs, e.final],
            );
        }
    }
    res.sendStatus(202);
});
```

CORS: de kiosk draait op een ander domein dan de API, dus sta `POST` en de
headers `Content-Type` en `Authorization` toe vanaf het kiosk-domein.

## Waar het in de code zit

| Bestand | Rol |
| --- | --- |
| `src/face-signature.ts` | Meetkundige vingerafdruk van een gezicht. |
| `src/visitor-counter.ts` | Bezoeken afbakenen, ontdubbelen, dagtelling. |
| `src/stats-reporter.ts` | Wachtrij, batching, retries, verzending. |
| `src/measurement.ts` | Koppelt teller aan verzending, bouwt de events. |
| `src/visitor-debug.ts` | Debugpaneel met de telling (toets `v`). |
| `src/visitor-match-debug.ts` | Debugpaneel met de matching zelf (toets `m`). |

## Afstellen

| Knop | Waar | Standaard |
| --- | --- | --- |
| Minimale bezoekduur | `minPresenceMs` | 1200 ms |
| Afwezigheid die bezoek afsluit | `absenceGapMs` | 8000 ms |
| Venster voor hermatching | `revisitWindowMs` | 10 min |
| Gevoeligheid hermatching | `matchThreshold` | 0.035 |
| Afstand tussen samples | `sampleIntervalMs` | 120 ms |
| Hartslag dagsnapshot | `DAILY_SNAPSHOT_MS` | 5 min |
| Samenvoegen van verzendingen | `sendDebounceMs` | 250 ms |

De eerste twee knoppen bepalen of passanten meetellen, de derde en vierde of
terugkerende klanten dubbel geteld worden.

`absenceGapMs` stond op 2500 ms en dat bleek de grootste bron van overtelling:
de spiegel verliest het gezicht regelmatig een paar seconden, waardoor één sessie
in drie bezoeken uiteenviel die elk opnieuw herkend moesten worden. Elke
herkenning is een kans om ernaast te zitten. Op 8000 ms worden haperingen van
5–9 seconden overbrugd en blijft een echt weggelopen bezoeker een nieuw bezoek.
Veel verder dan 10 seconden zou ik niet gaan: dan wordt een ánder persoon die
binnen dat gat aankomt bij het lopende bezoek getrokken, want MediaPipe volgt
maar één gezicht tegelijk (`numFaces: 1`).

Instelbaar met `VITE_VISIT_ABSENCE_GAP_MS`.

## De drempel afstellen (toets `m`)

De unieke-gezichtentelling is nooit beter dan `matchThreshold`, en die waarde
laat zich niet beredeneren — alleen meten. Het paneel achter toets `m` laat zien
wat er werkelijk gebeurt:

**Live** — loop weg, wacht vijf seconden, kom terug. Het getal onder "Live" is
wat een échte terugkeerder scoort. De drempel moet daarboven liggen. Laat daarna
een collega voor de spiegel staan: hun afstand tot jou moet er duidelijk onder
blijven. Zit er geen ruimte tussen die twee getallen, dan is de descriptor het
probleem, niet de drempel.

**Frontaal** — er wordt alleen bemonsterd bij een gezicht dat recht vooruit kijkt
(tot 15°). Staat hier vaak "nee", dan is het bezoek gebaseerd op weinig samples
en is de afstand navenant onbetrouwbaar. Let op: de descriptor is een verzameling
geprojecteerde afstanden, dus draaien comprimeert ze — op 15° al zo'n 3,4%, wat
op zichzelf meer is dan een krappe drempel toelaat.

**Wat-als** — speelt de matching opnieuw af over de bezoeken in het venster, bij
verschillende drempels. Zo zie je wat de telling gewéést zou zijn zonder op een
nieuwe middag bezoekers te wachten.

Let op dat ook dit paneel bij een herlaad leeg begint, om dezelfde reden als
hierboven: het geheugen waar het uit put is weg. Herlaad dus aan het begin van
een meetronde en daarna niet meer.

**Telling resetten** — een telling die onder de oude drempel is opgebouwd valt
niet te vergelijken met een telling onder de nieuwe, dus begin opnieuw na elke
wijziging. De knop onderaan het paneel wist de dagstand, de getrackte gezichten
en de nog niet verstuurde wachtrij, en duwt de nulstand meteen naar de backend —
anders blijft daar de oude telling staan tot de volgende bezoeker binnenloopt.
Eén klik bewapent de knop, de tweede voert uit.

De schuifregelaar past de drempel direct aan, maar geldt alleen vanaf dat moment
en telt niet met terugwerkende kracht. Zet de waarde die je vindt vast in
`VITE_VISIT_MATCH_THRESHOLD`, anders is hij na een herlaadbeurt weg.

De descriptoren die dit paneel bewaart staan alleen in het geheugen, gaan nergens
heen en verdwijnen na hetzelfde venster van 10 minuten als de rest.
