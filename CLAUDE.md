# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

CLT Bicycle Map is a static web map of Charlotte, NC (and a few nearby towns) showing bike lanes, cycleways, and bike routes sourced from OpenStreetMap. It has three parts:

- `website/` — a Lit + Mapbox GL frontend, built with webpack, that renders the map
- `scripts/pipeline/` — a Python package (`config` / `transform` / `overpass` / `ingest` + a thin `__main__`) that fetches OSM cycling data via the Overpass API per `data/cities.json` entry, transforms it, and UPSERTs it straight into the PostGIS `features` table
- `.github/workflows/osm-refresh.yml` — a scheduled GitHub Action; **currently broken — it still calls the deleted `python fetch_data.py` and is rewritten in story 4.3**

There is no application server yet. The frontend still fetches a single static GeoJSON file directly from `https://data.bikemap.seanerice.dev/export.geojson` (an S3 bucket); the API that reads `features` lands in a later epic. See `docs/planning/` for the in-progress PostGIS + API migration.

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

### Data pipeline (`scripts/pipeline/`)
```
pip install -r scripts/requirements.txt
# POSTGRES_PASSWORD must be set (repo-root .env) and `docker compose up -d db` running with migrations applied
python -m scripts.pipeline --area charlotte   # one data/cities.json entry (match on name or osmRelationId)
python -m scripts.pipeline --all              # every data/cities.json entry
```
Run from the repo root. Coverage areas live in `data/cities.json` (committed) — an array of `{name, state, osmRelationId, bbox}` objects, exactly one of `osmRelationId` (raw OSM relation id; `overpass.py` adds the `3600000000` Overpass area offset) / `bbox` (`[minLon, minLat, maxLon, maxLat]`) set per entry. Adding coverage is a PR that edits that file. Per area the flow is `overpass.fetch` → `transform.transform_data` → `ingest.upsert` (one transaction per area); there is no file output and no S3 sync — features go straight into the PostGIS `features` table. This is Epic 4 Phase 1: it keeps the per-area Overpass fetch; Phase 2 (stories 4.4–4.9) swaps that for a local OSM extract + `osm2pgsql` and deletes `scripts/pipeline/overpass.py`.

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
Runs against the docker-compose `db` service (per `docs/planning/layers/persistence-layer.md` §8) — a session-scoped fixture in `scripts/tests/conftest.py` runs `docker compose up -d db` and `dotnet ef database update` once, so a fresh `docker compose down -v` environment works with just the one `pytest` command above (both steps are idempotent, so it's also safe to run against a `db` that's already up and migrated). Each test truncates `features` first for isolation — no cross-test state. `scripts/tests/` also holds `test_transform.py` and `test_config.py` (pure — no DB, no network — covering `scripts/pipeline/transform.py` incl. the two Epic 4 bug fixes, and the `data/cities.json` validator) and `test_pipeline_ingest.py` (`ingest.upsert` idempotency against the live `db`). Note: the shared `conftest.py` still requires `POSTGRES_PASSWORD` and its autouse session fixture still brings up `db` + migrations even for the pure test files. There is no test suite for the frontend.

- `test_persistence_integration.py` — a small hand-written fixture set (not the full `data/export.geojson`) spanning `road`/`path`/`route` covers idempotent UPSERT (`first_seen_at` stable, `last_seen_at` advances on re-load), bbox query correctness (`&&` + `ST_Intersects`), and constraint rejection (`chk_features_geom_valid`, `ux_features_osm_key`) with assertions on the specific constraint name.
- `test_explain_index_usage.py` (story 1.9, optional per persistence-layer.md §8) — loads ~2000 synthetic rows scattered across a large lon/lat extent, runs `EXPLAIN (ANALYZE, FORMAT JSON)` on a selective bbox query, and asserts the plan uses an Index/Bitmap Index Scan on `idx_features_geom` rather than a `Seq Scan` on `features` — regression insurance against a future migration accidentally dropping/invalidating the spatial index. Marked `@pytest.mark.slow` (registered in `conftest.py`'s `pytest_configure` hook) since generating/loading thousands of rows is noticeably slower than the rest of the suite; excluded by `-m "not slow"` above, included by the plain `pytest scripts/tests` run.

## Architecture

### Data pipeline (`scripts/pipeline/`)
A Python package, driven by `python -m scripts.pipeline --area <name|id>` / `--all` (`scripts/pipeline/__main__.py`):
- **`config.py`** — loads/validates `data/cities.json` (committed). Exactly one of `osmRelationId` (raw OSM relation id) / `bbox` (`[minLon, minLat, maxLon, maxLat]`) per entry; validator rejects both-set / neither-set / malformed-bbox. `find_area` matches `--area` on name (case-insensitive) or `osmRelationId`.
- **`overpass.py`** — Phase 1, disposable (removed in story 4.9). Builds a per-entry Overpass QL query — `osmRelationId` → `area(id:3600000000 + id)` scoped, `bbox` → `[bbox:S,W,N,E]` global — runs the retry/exponential-backoff loop carried over from the old `fetch_data.py` (5 attempts, backoff doubling capped at 60s, explicit 429/504 + `Retry-After`), and converts the result via `osm2geojson`. If an `area(id:)` query returns 0 elements it warns and returns `None` so the caller skips that area (never UPSERT an empty result over good data).
- **`transform.py`** — the pure `transform_road_feature` / `transform_path_feature` / `transform_relation_feature` / `transform_way_feature` / `transform_data` functions, carried over verbatim from `fetch_data.py` except: a missing comma in `highway_roads` (which had silently dropped every `highway=living_street` way) is fixed; every output carries explicit `osmType` (`way`/`relation` — collision-proof, unlike `properties["type"]` which a route relation's `type=route` tag clobbers) and `featureType` (`road`/`path`/`route`) fields for the loader. Zero heavy imports. Splits roads vs paths by the OSM `highway` tag (`highway_roads` / `highway_paths` lists); derives `cyclewayLeft`/`cyclewayRight` (+ buffer flags) for roads and a `bicycle` designation (`designated`/`yes`/`unknown`) + `highwayType: "path"` for paths.
- **`ingest.py`** — psycopg3 batch UPSERT into the PostGIS `features` table (`INSERT ... ON CONFLICT (osm_type, osm_id) DO UPDATE SET ..., last_seen_at = now()`, `first_seen_at` left alone) — one transaction per area. `INSERT_SQL` and the `connection_kwargs()` env convention (`POSTGRES_PASSWORD` required; `POSTGRES_HOST`/`PORT`/`DB`/`USER` defaults) were carried forward from the deleted `scripts/load_export_to_postgis.py`; the persistence integration tests import `INSERT_SQL` from here.

There is no file output and no S3 sync anymore. `.github/workflows/osm-refresh.yml` still calls the deleted `python fetch_data.py` and is broken until story 4.3 rewrites it.

`scripts/load_neo4j.py` is an in-progress experiment loading GeoJSON LineStrings into Neo4j via APOC — not currently wired into the pipeline or the frontend.

### Frontend (`website/src/`)
`bikemap-app.js` is the root Lit element. On `firstUpdated`, it creates the Mapbox GL map, adds `data/export.geojson` (fetched live from S3) as a single `cycling-data` GeoJSON source, and adds several style layers filtered/styled off the properties the pipeline computed:
- `cycling-route-lines` / `cycling-route-symbols` — named bike routes (relations), colored by `cycle_network`
- `cycling-paths` — dedicated paths/cycleways, colored by `bicycle` designation
- `cycling-lanes-right` / `cycling-lanes-left` — on-street bike lanes, styled (color/dash/offset) by `cyclewayRight`/`cyclewayLeft` type

Layer visibility is controlled by `layer-widget.js`; `location-search-menu.js` and `mapbox-navigation.js` provide search and turn-by-turn directions. The Mapbox map instance is shared with child components via `mapContext.js` (a `@lit/context` context).

`colors.js` centralizes the color palettes (`bicycleFacilityRatingColor`, `roadwayPalette`) referenced by the style layers above — change lane/path colors there rather than inline in `bikemap-app.js`.

## Docs

`docs/planning/` holds forward-looking design/architecture docs, reviewed and approved like code — check here before making architectural changes, since they capture decisions (and the *why* behind them) that aren't yet reflected in the code below:
- [`multi-city-expansion.md`](docs/planning/multi-city-expansion.md) — approved plan to replace the static-GeoJSON-from-S3 model above with PostGIS + a bbox-filtered API (`GET /features?bbox=...`, likely ASP.NET Core/Npgsql), fed by a rebuilt ingestion pipeline that clips a regional OSM extract into PostGIS via `osmium`/`osm2pgsql` (no Overpass in the automated pipeline — decided 2026-08-28), driven by a `data/cities.json` config. **Partially implemented** — Epic 4 Phase 1 (`scripts/pipeline/`, `data/cities.json`, the psycopg UPSERT into `features`) is in; still pending are the API, the on-instance cron (story 4.3), and the Phase 2 extract pipeline that drops Overpass (stories 4.4–4.9). The frontend still reads GeoJSON from S3.
- [`testing-and-tooling.md`](docs/planning/testing-and-tooling.md) — companion plan: containerize the backend (PostGIS + API + pipeline) via docker-compose, a testing strategy by category, and standing AI-tooling practice (add a project-level `run` skill once containerized, add Playwright's run command here once it exists).

`docs/index.html` is unrelated — a GitHub Pages stub, not project documentation.
