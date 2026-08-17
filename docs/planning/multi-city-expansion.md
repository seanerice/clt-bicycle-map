# Multi-city expansion: architecture plan

Status: Draft for review
Owner: Sean Rice
Last updated: 2026-07-27

## 1. Problem statement

The map currently covers Charlotte plus three small neighboring towns (Belmont, Cramerton, McAdenville). We want to grow coverage to more of the Charlotte metro area — and eventually other nearby cities — without visible seams at city boundaries, without a manual, error-prone process for adding each new city, and without the frontend having to download an ever-larger single file on every page load.

Raw ideas from the initial conversation, captured here for the record:

- Stream features from a server backed by a database, rather than shipping one static file to the client.
- Since data is geospatial, the database should have real geospatial support — open question: graph database vs. traditional SQL database.
- Ingestion strategy is a separate, still-open problem: ingest ahead of time (batch), just-in-time per request, or via a third-party service.
- No strong server-side language preference — comfortable with Python, Node.js, and (most of all) .NET — pick whatever's easiest to implement.
- Documentation and spec-writing should be partially automated, since good docs are load-bearing for agent context (Claude Code) going forward.

## 2. Current state (as of this doc)

- **Frontend** (`website/`): a static Lit + Mapbox GL app. On load, it adds one Mapbox GL `geojson` source pointed at `https://data.bikemap.seanerice.dev/export.geojson` (an S3 object) and layers everything client-side by feature properties. See `website/src/bikemap-app.js`.
- **Pipeline** (`scripts/fetch_data.py`): queries the public Overpass API once per hardcoded OSM relation area ID (currently 4: Charlotte, Belmont, Cramerton, McAdenville), with retry/backoff on rate limiting. Combines all areas' results, converts to GeoJSON, derives rendering properties (`cyclewayLeft/Right`, `bicycle`, `highwayType`, etc.) from raw OSM tags, and writes one minified `data/export.geojson`.
- **Deploy** (`.github/workflows/osm-refresh.yml`): runs the pipeline daily via cron (plus on PR and manual dispatch) and `aws s3 sync`s the output to the `bikemap` bucket. No server, no database — S3 is a static file host.
- **Evidence the current approach is already straining**: `data/overpass_area_*_resp.txt` in the working tree are Overpass *error* responses (`rate_limited`, `timeout`) captured by the script's own debug logging — at just 4 areas, sequential Overpass queries are already hitting the public instance's rate limits. That will only get worse as more cities are added.
- There's also an **uncommitted, unfinished experiment** (`scripts/load_neo4j.py`) that loads `export.geojson` LineStrings into Neo4j via APOC, one `Feature` node per way with its coordinates as a point list. It isn't wired into the pipeline or the frontend. It's useful context (someone — future-you — was already reaching for a database and reached for a graph one first), but it predates this plan and shouldn't be read as a decision.

### Why "seams" are a real risk, not just a scaling concern

Overpass area queries are scoped to an OSM admin-boundary relation. A cycleway that runs *along* a city line is a case where relation-based per-city queries can behave surprisingly — inclusion depends on how the way's geometry relates to each city's polygon, which isn't guaranteed to be exactly complementary between neighbors. Today this is masked because all areas get merged into one feature collection before rendering, but it's a real correctness risk to carry forward into a tiled, per-region-query world, not just a performance one.

## 3. Goals / non-goals

**Goals**
- Add new cities/regions with a config change, not a code change.
- Frontend only loads data for what's actually in view — not a monotonically growing blob.
- No visible or data gaps at city boundaries.
- Ingestion pipeline that doesn't fight Overpass rate limits as coverage grows.
- Server piece should be genuinely easy to stand up and operate solo (this is a side project).
- Backend services (DB, tile/API server, ingestion) run containerized — same stack for local dev and deploy. See [testing-and-tooling.md](./testing-and-tooling.md).
- Lean into documentation/spec automation now, while the surface area is still small.

**Non-goals (for this phase)**
- Turn-by-turn routing across the graph of bike infrastructure (`mapbox-navigation.js` currently delegates routing to Mapbox's own Directions API, not our data). Worth flagging because it's the one sub-problem that *would* argue for graph-native queries — see §4.1.
- Live/real-time OSM sync. Daily-ish freshness (current cadence) is fine.
- User accounts, contributions, or edits to the data.

## 4. Research & recommendation

### 4.1 Database: PostGIS (PostgreSQL), not a graph database

For the core need — "given a viewport bounding box (and possibly a zoom level), return the line/point features that intersect it" — this is a textbook spatial-index range query, which is what PostGIS is purpose-built for:

- Native `geometry`/`geography` types, R-tree-over-GiST spatial indexes, and a mature function library (`ST_Intersects`, `ST_DWithin`, `ST_Simplify`, bounding-box operators like `&&`) that map directly onto "what's in this viewport."
- Neo4j's spatial support is comparatively thin: point-only indexing in practice, bounding-box and distance search but no native polygon/intersection queries, and no purpose-built simplification/generalization functions for rendering at varying zoom levels. Graph databases earn their keep when the *query itself* is a traversal — "find a path through connected edges," "what's reachable within 3 hops" — not when it's a spatial range scan. Our current problem is 100% the latter.
- If/when routing across the bike network becomes an actual goal (a real non-goal today, see §3), that doesn't require introducing a second database engine — [pgRouting](https://pgrouting.org/) extends PostGIS with graph-traversal functions (Dijkstra, A*, etc.) over the same tables. That keeps one database for both jobs instead of syncing data between two.
- PostGIS also happens to be the substrate every vector-tile server in §4.2 expects, which matters for "easy to implement."

**Recommendation:** PostgreSQL + PostGIS. Retire the Neo4j experiment (or keep the script around as a historical note, but don't build on it) — it was a reasonable thing to try, but it's solving for a query pattern (graph traversal) we don't have.

### 4.2 Serving: bbox-filtered API — decided

Sean's call: a plain `GET /features?bbox=...` endpoint over Martin/MVT vector tiles. Both were on the table (see §6 history — this was deferred once, then decided here); recording the *why*, not just the *what*, since that's what survives once this doc goes stale (§4.4):

- Returns GeoJSON scoped to the current viewport rect, fed into a Mapbox GL `geojson` source updated in place on `moveend` — the same rendering model the app already uses today (§2), just scoped to the visible area instead of the whole dataset, rather than a switch to a `vector` source.
- Zero new infra to run — one endpoint (ASP.NET Core + Npgsql + NetTopologySuite is the natural fit given the .NET strength noted in §1) against the same PostGIS instance, instead of standing up and operating a second service (Martin) purely for tile generation. This is the deciding factor — it matches the stated "easiest to implement" priority more directly than Martin's better caching/simplification characteristics do.
- Trade-off being knowingly accepted: weaker HTTP caching (every distinct bbox is effectively a unique query, vs. MVT tiles being byte-identical across viewers on a shared grid) and no built-in per-zoom geometry simplification (Martin does this automatically; here it means calling `ST_Simplify` with a zoom-derived tolerance ourselves if low-zoom payload size becomes a real problem). Worth revisiting only if either actually bites at real usage levels — not something to pre-optimize for now.
- Still fully satisfies "no seams": the boundary-gap risk in §2 comes from *how Overpass is queried during ingestion* (§4.3), not from how data is served afterward — fixed by preferring bbox-based Overpass queries over per-city admin-polygon queries, independent of this decision.

### 4.3 Ingestion: keep batch, restructure around cities-as-config

Just-in-time (fetch-on-request) ingestion is a bad fit here: Overpass is already rate-limiting us at 4 areas (see §2), and per-request latency to a third-party API is not something to put in the critical path of a map tile request. A managed ingestion service is possible but is solving a problem we don't have yet at this scale — it's added cost/complexity for a solo side project.

**Recommendation:** Keep the batch model (it already works, and the daily GitHub Actions cron is a fine cadence) but change its shape:
1. Replace the hardcoded area-ID list in `fetch_data.py` with a config file (e.g. `data/cities.json` — name, OSM relation ID or explicit bbox). Adding a city becomes a PR that adds one entry, not a code change.
2. Prefer a small number of large bounding-box Overpass queries over one-query-per-city where possible — fewer round trips (helps with rate limiting) and sidesteps the admin-polygon boundary-gap risk in §2.
3. Load the transformed features into PostGIS (`UPSERT` keyed on OSM id) instead of writing one `export.geojson`. Keeps history/diffing possible later (e.g., "what changed since last sync") without extra work now.
4. The bbox API (§4.2) reads live from PostGIS — no separate "publish" step, no S3 sync, no growing static file. The GitHub Action's last step changes from "sync data/ to S3" to "run the loader against the DB."

### 4.4 Documentation automation

Two concrete, low-effort pieces worth setting up now while the codebase is still small:
- **`docs/planning/`** (this directory) for forward-looking design docs like this one — checked in, reviewed like code.
- Lightweight **ADRs** (architecture decision records, one short markdown file per significant decision — e.g. "0001-postgis-over-neo4j.md") once implementation actually starts, so the *why* behind choices like §4.1/§4.2 survives independent of this planning doc, which will go stale. A `docs/adr/README.md` index is enough process — no tooling required.
- Keep `CLAUDE.md` (repo root, just created) current as architecture changes — it's the thing that gives future Claude Code sessions accurate context without re-deriving it, which is exactly the automation the user asked for. Treat "update CLAUDE.md" as part of the definition of done for any PR that changes architecture, the same way `README` updates are for human-facing docs.

## 5. Proposed target architecture

```
 Overpass API (OSM)
        │  batch fetch (daily cron / manual dispatch), driven by data/cities.json
        ▼
 scripts/fetch_data.py  →  transform  →  UPSERT into PostGIS
                                              │
                                              ▼
                                    PostgreSQL + PostGIS
                                    (features table, spatial index)
                                              │
                                              ▼
                                  Bbox API (ASP.NET Core + Npgsql)
                                  GET /features?bbox=...
                                              │
                                              ▼
                                  website/ (Mapbox GL `geojson` source,
                                  refetched/updated on `moveend`)
```

## 6. Suggested phasing

1. **Stand up PostGIS locally, containerized** (docker-compose per [testing-and-tooling.md](./testing-and-tooling.md) §1) and write a one-off loader that ingests the *existing* `export.geojson` into it — validates the schema before touching the pipeline.
2. **Build the bbox API** (§4.2) against that PostGIS instance and **swap the frontend source** to fetch/update on `moveend`, pointed at the existing 4-city data. This alone proves out the "no seams, lazy load" mechanics without touching ingestion yet.
3. **Refactor `fetch_data.py`** to read from `data/cities.json` and load into PostGIS instead of writing the static file; update the GitHub Action accordingly.
4. **Add a city** end-to-end (a real nearby town not yet covered) as the validation that the whole loop — config change → ingest → serve → map — works without code changes.

## 7. Open questions for Sean

- ~~Hosting for PostgreSQL + Martin~~ — deferred; see [testing-and-tooling.md](./testing-and-tooling.md) §3. Revisit together later.
- ~~§4.2: Martin vs. bbox API~~ — decided: bbox API. See §4.2.
- ~~Target city list~~ — no fixed list for now; Sean's leaning toward keeping scope abstract/config-driven rather than naming specific cities up front. Revisit when it's time to actually populate `data/cities.json` — doesn't block Phase 1 or 2.
- Any interest in the pgRouting / turn-by-turn-on-our-own-data path (§3 non-goal), or is Mapbox Directions fine indefinitely? Only matters if it changes the DB decision — it doesn't, but worth confirming it's genuinely out of scope.
