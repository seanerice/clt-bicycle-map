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
npm run start     # webpack dev server
npm run build     # production build to website/dist
npm test          # Vitest unit tests (website/src/**/*.test.js)
npm run test:e2e  # Playwright E2E suite (website/e2e/) — mocks the bbox API and
                   # Mapbox's own Geocoding/Directions APIs via page.route(), so it
                   # needs no docker-compose stack; runs against `npm run start`
```
`npm run test:e2e` requires Playwright's Chromium browser once per machine: `npx playwright install chromium` (downloads to a global cache, not the repo).

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

### Migrations (`db/Migrations/`)
```
cd db/Migrations
dotnet ef database update   # applies pending EF Core migrations to the `db` service
```
Run from `db/Migrations/` (the project directory) with the `db` service up and `POSTGRES_PASSWORD` set in the environment (`db/Migrations` reads it the same way docker-compose does — see `db/Migrations/README.md`). This is a minimal class library that exists only to host EF Core migration tooling (`BikeMapDbContext`) ahead of the future `api/` project — see `db/Migrations/README.md` for why it's scaffolded separately and early. `BikeMapDbContext` registers one entity, `Feature` (table `features`, mapped to `docs/planning/layers/persistence-layer.md` §1.1) — `feature_type` is a real Postgres enum (`feature_type_enum`), mapped to the `FeatureType` C# enum via Npgsql's `HasPostgresEnum`/`MapEnum`.

### Prod-like deploy, run locally (`docker-compose.prod.yml`)
```
bash nginx/generate-dev-cert.sh                                          # first time only; self-signed dev cert, see nginx/README.md
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d    # db + api + nginx
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm migrator   # one-shot: applies pending EF Core migrations
```
`docker-compose.prod.yml` (repo root, story 8.3) layers onto `docker-compose.yml` to approximate the EC2 target described in `docs/planning/deployment.md` §3: it clears `db`'s and `api`'s host port publishes (`ports: !reset []` — the Compose Specification's reset tag, since Compose otherwise concatenates `-f` files' `ports:` lists rather than replacing them) so only the new `nginx` service exposes 80/443, adds that `nginx` service (`nginx/` — reverse-proxies `bikemap-api.seanerice.dev` → `api:8080`, TLS via a cert bind-mounted from `nginx/certs/`, git-ignored), and adds the `migrator` service (`db/Migrations/Dockerfile`, new — a single-stage SDK image with `dotnet-ef` installed, entrypoint `dotnet ef database update`). `migrator` is meant to be run one-shot (`run --rm`), not left running — it has no restart policy, so it's harmless if it also starts and exits during a plain `up -d`. This compose file is what the future CI/CD workflow (story 8.4) deploys as-is; the only thing story 8.7 swaps is the self-signed cert in `nginx/certs/` for a real Cloudflare Origin CA cert (see `nginx/README.md`) — everything else here already matches prod.

### Persistence-layer integration tests (`scripts/tests/`)
```
cp .env.example .env       # first time only; sets POSTGRES_PASSWORD locally
pip install -r scripts/requirements.txt
POSTGRES_PASSWORD=<value from .env> pytest scripts/tests -m "not slow"   # fast path
POSTGRES_PASSWORD=<value from .env> pytest scripts/tests                # full path, includes slow tests
```
Runs against the docker-compose `db` service (per `docs/planning/layers/persistence-layer.md` §8) — a session-scoped fixture in `scripts/tests/conftest.py` runs `docker compose up -d db` and `dotnet ef database update` once, so a fresh `docker compose down -v` environment works with just the one `pytest` command above (both steps are idempotent, so it's also safe to run against a `db` that's already up and migrated). Each test truncates `features` first for isolation — no cross-test state. There is no test suite for the frontend or the `fetch_data.py` pipeline.

- `test_persistence_integration.py` — a small hand-written fixture set (not the full `data/export.geojson`) spanning `road`/`path`/`route` covers idempotent UPSERT (`first_seen_at` stable, `last_seen_at` advances on re-load), bbox query correctness (`&&` + `ST_Intersects`), and constraint rejection (`chk_features_geom_valid`, `ux_features_osm_key`) with assertions on the specific constraint name.
- `test_explain_index_usage.py` (story 1.9, optional per persistence-layer.md §8) — loads ~2000 synthetic rows scattered across a large lon/lat extent, runs `EXPLAIN (ANALYZE, FORMAT JSON)` on a selective bbox query, and asserts the plan uses an Index/Bitmap Index Scan on `idx_features_geom` rather than a `Seq Scan` on `features` — regression insurance against a future migration accidentally dropping/invalidating the spatial index. Marked `@pytest.mark.slow` (registered in `conftest.py`'s `pytest_configure` hook) since generating/loading thousands of rows is noticeably slower than the rest of the suite; excluded by `-m "not slow"` above, included by the plain `pytest scripts/tests` run.

## Architecture

### Data pipeline (`scripts/fetch_data.py`)
For each hardcoded OSM area ID, queries the public Overpass API (`overpass-api.de`) for ways/relations tagged as cycleways, bike lanes, or bike routes, with retry/exponential-backoff on rate limiting (429/504). Results per area are combined, converted from Overpass JSON to GeoJSON via `osm2geojson`, then passed through `transform_data`, which:
- Splits features into roads (`transform_road_feature`) vs. paths (`transform_path_feature`) based on the OSM `highway` tag, using the `highway_roads` / `highway_paths` tag lists.
- For roads, derives `cyclewayLeft`/`cyclewayRight` (and buffer flags) from the various `cycleway`, `cycleway:left`, `cycleway:right`, `cycleway:both` OSM tag variants — these drive how the frontend renders bike lane style (track/lane/buffered/shared/shoulder).
- For paths, derives a `bicycle` designation (`designated`/`yes`/`unknown`) and tags `highwayType: "path"`.

The GitHub Actions workflow (`osm-refresh.yml`) runs this daily via cron, on PRs to `main`, and on manual dispatch, then syncs `data/` to the `bikemap` S3 bucket (via `bikemap-staging` environment credentials).

`scripts/load_neo4j.py` is an in-progress experiment loading `export.geojson` LineStrings into Neo4j via APOC — not currently wired into the pipeline or the frontend.

`scripts/load_export_to_postgis.py` is a throwaway, one-off validation script (story 1.7) that UPSERTs `data/export.geojson` into the `features` table (`db/Migrations`) to validate the PostGIS schema ahead of the real ingestion loader. It is explicitly not the real ingestion loader — a future epic replaces `fetch_data.py`'s `write_data()` with that — and is not wired into `osm-refresh.yml`. Delete it once the real loader lands.

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
