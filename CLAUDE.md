# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

CLT Bicycle Map is a static web map of Charlotte, NC (and a few nearby towns) showing bike lanes, cycleways, and bike routes sourced from OpenStreetMap. It has three parts:

- `website/` — a Lit + Mapbox GL frontend, built with webpack, that renders the map
- `scripts/` — a Python pipeline that queries the Overpass API for OSM cycling data, transforms it into GeoJSON, and is deployed to S3
- `.github/workflows/osm-refresh.yml` — a scheduled GitHub Action that runs the pipeline and syncs `data/` to S3 daily

There is no application server. The frontend fetches a single static GeoJSON file directly from `https://data.bikemap.seanerice.dev/export.geojson` (an S3 bucket populated by the pipeline) and loads it as one Mapbox GL GeoJSON source.

## Commands

### Frontend (`website/`)
```
npm run start   # webpack dev server
npm run build   # production build to website/dist
```

### Data pipeline (`scripts/`)
```
pip install -r requirements.txt
python fetch_data.py   # queries Overpass API per area, writes ../data/export.geojson
```
`fetch_data.py` has no CLI args — the list of OSM relation area IDs to query (Charlotte, Belmont, Cramerton, McAdenville) is hardcoded near the bottom of the file, as are the Overpass endpoint and retry/backoff behavior. Output is minified GeoJSON at `data/export.geojson`.

### Database (`db/`)
```
cp .env.example .env       # first time only; sets POSTGRES_PASSWORD locally
docker compose up db       # starts a PostGIS 16-3.4 container on localhost:5432
```
`.env` is gitignored — `docker compose up db` reads `POSTGRES_PASSWORD` from it. The named volume `pgdata` persists data across `docker compose down`/`up`. `db/init/` only runs on first boot against an empty volume (see `db/init/README.md`) — it is not a migration mechanism.

There is no test suite for either the frontend or the pipeline.

## Architecture

### Data pipeline (`scripts/fetch_data.py`)
For each hardcoded OSM area ID, queries the public Overpass API (`overpass-api.de`) for ways/relations tagged as cycleways, bike lanes, or bike routes, with retry/exponential-backoff on rate limiting (429/504). Results per area are combined, converted from Overpass JSON to GeoJSON via `osm2geojson`, then passed through `transform_data`, which:
- Splits features into roads (`transform_road_feature`) vs. paths (`transform_path_feature`) based on the OSM `highway` tag, using the `highway_roads` / `highway_paths` tag lists.
- For roads, derives `cyclewayLeft`/`cyclewayRight` (and buffer flags) from the various `cycleway`, `cycleway:left`, `cycleway:right`, `cycleway:both` OSM tag variants — these drive how the frontend renders bike lane style (track/lane/buffered/shared/shoulder).
- For paths, derives a `bicycle` designation (`designated`/`yes`/`unknown`) and tags `highwayType: "path"`.

The GitHub Actions workflow (`osm-refresh.yml`) runs this daily via cron, on PRs to `main`, and on manual dispatch, then syncs `data/` to the `bikemap` S3 bucket (via `bikemap-staging` environment credentials).

`scripts/load_neo4j.py` is an in-progress experiment loading `export.geojson` LineStrings into Neo4j via APOC — not currently wired into the pipeline or the frontend.

### Frontend (`website/src/`)
`bikemap-app.js` is the root Lit element. On `firstUpdated`, it creates the Mapbox GL map, adds `data/export.geojson` (fetched live from S3) as a single `cycling-data` GeoJSON source, and adds several style layers filtered/styled off the properties the pipeline computed:
- `cycling-route-lines` / `cycling-route-symbols` — named bike routes (relations), colored by `cycle_network`
- `cycling-paths` — dedicated paths/cycleways, colored by `bicycle` designation
- `cycling-lanes-right` / `cycling-lanes-left` — on-street bike lanes, styled (color/dash/offset) by `cyclewayRight`/`cyclewayLeft` type

Layer visibility is controlled by `layer-widget.js`; `location-search-menu.js` and `mapbox-navigation.js` provide search and turn-by-turn directions. The Mapbox map instance is shared with child components via `mapContext.js` (a `@lit/context` context).

`colors.js` centralizes the color palettes (`bicycleFacilityRatingColor`, `roadwayPalette`) referenced by the style layers above — change lane/path colors there rather than inline in `bikemap-app.js`.

## Docs

`docs/planning/` holds forward-looking design/architecture docs, reviewed and approved like code — check here before making architectural changes, since they capture decisions (and the *why* behind them) that aren't yet reflected in the code below:
- [`multi-city-expansion.md`](docs/planning/multi-city-expansion.md) — approved plan to replace the static-GeoJSON-from-S3 model above with PostGIS + a bbox-filtered API (`GET /features?bbox=...`, likely ASP.NET Core/Npgsql), fed by the same Overpass pipeline restructured around a `data/cities.json` config. **Not yet implemented** — the "Architecture" section above still describes current, pre-migration reality.
- [`testing-and-tooling.md`](docs/planning/testing-and-tooling.md) — companion plan: containerize the backend (PostGIS + API + pipeline) via docker-compose, a testing strategy by category, and standing AI-tooling practice (add a project-level `run` skill once containerized, add Playwright's run command here once it exists).

`docs/index.html` is unrelated — a GitHub Pages stub, not project documentation.
