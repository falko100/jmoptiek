# Bezoekersmeting — hoeveel verschillende gezichten per dag

De spiegel telt zelf hoeveel mensen er voor gestaan hebben en stuurt die cijfers
naar een backend-endpoint. Dit document beschrijft wat er gemeten wordt en welk
HTTP-contract de backend moet bieden.

## Wat er gemeten wordt

- **Bezoek (`visit`)** — één aaneengesloten periode dat iemand voor de spiegel
  staat, dicht genoeg bij om brillen te kunnen passen (dezelfde regel als de
  "Ga op de voetstappen staan"-overlay: ≤ 95 cm, of het gezicht vult ≥ 22% van
  de hoogte van het beeld). Korte trackingdips worden overbrugd; 2,5 seconde weg
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
  10 minuten en gaan **nooit** naar de backend.
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

### `type: "daily"`

De lopende dagstand, elke 5 minuten opnieuw gestuurd zolang er iets wijzigt, en
bij het afsluiten van de dag met `final: true`. Bedoeld als **upsert op
(`kioskId`, `date`)** — de laatste versie wint, `final: true` is de definitieve.

```json
{
  "type": "daily",
  "kioskId": "jm-optiek-winkel-1",
  "date": "2026-09-12",
  "uniqueFaces": 17,
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

Hiermee heb je het antwoord op "hoeveel verschillende gezichten vandaag" direct
als `uniqueFaces`, zonder zelf te hoeven aggregeren. Wil je het liever zelf
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
| Afwezigheid die bezoek afsluit | `absenceGapMs` | 2500 ms |
| Venster voor hermatching | `revisitWindowMs` | 10 min |
| Gevoeligheid hermatching | `matchThreshold` | 0.035 |
| Afstand tussen samples | `sampleIntervalMs` | 120 ms |
| Frequentie dagsnapshot | `DAILY_SNAPSHOT_MS` | 5 min |

De eerste twee knoppen bepalen of passanten meetellen, de derde en vierde of
terugkerende klanten dubbel geteld worden.

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
