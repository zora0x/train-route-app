# Board Anywhere

Enter a journey. Every train on it is fetched with its **full route**, then seat availability is
checked from **each station on that route** to your destination — not just the ones between
your two inputs.

Board further down the line and the fare drops; the waitlist often shortens too.

## Run it

Static site, no build step and no API key.

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Must be served over HTTP (`stations.json` is fetched), so `file://` won't work.

## Data sources

Both are called directly from your browser. No server, no key.

- **erail.in** — routes and station list. Sends `access-control-allow-origin: *`.
  - `/rail/getTrains.aspx?Station_From=X&Station_To=Y` — trains between stations
  - `/rail/getTrains.aspx?TrainNo=N` — metadata (field 27 is the internal train id)
  - `/data.aspx?Action=TRAINROUTE&Password=2012&Data1=<train_id>` — full route with
    coordinates, halt times, km and day counters
  - `/js/cmp/stations.js` — station list, vendored here as `stations.json` (9,234 stations)
- **cttrainsapi.confirmtkt.com** — live availability and confirmation predictions. Also `*`.
  - `POST /api/v1/availability/fetchAvailability` — query params in the URL,
    `dateOfJourney` must be `DD-MM-YYYY`

Availability changes constantly; results reflect the moment you search.
