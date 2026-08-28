# Multi-city expansion: architecture plan

Status: Draft for review
Owner: Sean Rice
Last updated: 2026-08-28

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
- **Pipeline** (`scripts/fetch_data.py`, *as it stands today* — §4.3 replaces the fetch mechanism): queries the public Overpass API once per hardcoded OSM relation area ID (currently 4: Charlotte, Belmont, Cramerton, McAdenville), with retry/backoff on rate limiting. Combines all areas' results, converts to GeoJSON, derives rendering properties (`cyclewayLeft/Right`, `bicycle`, `highwayType`, etc.) from raw OSM tags, and writes one minified `data/export.geojson`. The transform stage (raw OSM tags → rendering properties) is kept as-is by the §4.3 plan; only the fetch and the output sink change.
- **Deploy** (`.github/workflows/osm-refresh.yml`): runs the pipeline daily via cron (plus on PR and manual dispatch) and `aws s3 sync`s the output to the `bikemap` bucket. No server, no database — S3 is a static file host.
- **Evidence the Overpass dependency is the wrong foundation to build on**: `data/overpass_area_*_resp.txt` in the working tree are Overpass *error* responses (`rate_limited`, `timeout`) captured by the script's own debug logging — at just 4 areas, sequential Overpass queries are already hitting the public instance's rate limits. This is the primary motivation for dropping Overpass from the automated pipeline entirely (§4.3), not merely for batching queries more cleverly: batching only slows how fast the ceiling is hit as coverage grows; it doesn't remove the dependency on a third party's query quota.
- There's also an **uncommitted, unfinished experiment** (`scripts/load_neo4j.py`) that loads `export.geojson` LineStrings into Neo4j via APOC, one `Feature` node per way with its coordinates as a point list. It isn't wired into the pipeline or the frontend. It's useful context (someone — future-you — was already reaching for a database and reached for a graph one first), but it predates this plan and shouldn't be read as a decision.

### Why "seams" are a real risk, not just a scaling concern

A cycleway that runs *along* a city line is a case where per-area extraction can behave surprisingly: whether the way is included depends on how its geometry relates to each area's boundary, and neighboring areas' boundaries aren't guaranteed to be exactly complementary. Today this is masked because all areas get merged into one feature collection before rendering, but it's a real correctness risk — not just a performance one — to carry forward into a world where data is extracted and served per region.

Under the old admin-polygon Overpass model this risk was acute: an area query is scoped to an OSM admin-boundary relation, so a boundary-hugging way was either returned by a given city's query or it wasn't, with no easy way to reason about which. The new extract-and-clip model (§4.3) changes the *mechanism* that addresses it: `osmium extract --strategy=smart` clips one full regional extract down to each area's AOI (bbox or polygon), AOIs are allowed to **overlap on purpose**, and any way caught by two overlapping clips is collapsed by the natural-key UPSERT on `(osm_type, osm_id)`. The seam question stops being "did the query include this way?" and becomes "clip generously, overlap deliberately, dedup on the natural key." The risk is still worth watching at the outer edge of the outermost AOIs — where there's no neighbor to overlap with — but it's no longer a per-query correctness puzzle.

## 3. Goals / non-goals

**Goals**
- Add new cities/regions with a config change, not a code change.
- Frontend only loads data for what's actually in view — not a monotonically growing blob.
- No visible or data gaps at city boundaries.
- Ingestion pipeline that doesn't depend on a rate-limited third-party query service at all — coverage growth must not be gated by someone else's API quota or by per-query flakiness.
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
- Still fully satisfies "no seams": the boundary-gap risk in §2 comes from *how data is scoped during ingestion* (§4.3), not from how data is served afterward — addressed by clipping one regional extract to deliberately-overlapping AOIs and deduping on the `(osm_type, osm_id)` natural key, independent of this decision.

### 4.3 Ingestion: keep batch, drop Overpass, build from a regional OSM extract

Two things are settled here; the rest of the section follows from them.

**Keep the batch model.** Just-in-time (fetch-on-request) ingestion is a bad fit: it puts third-party latency and failure directly in the critical path of a map interaction, and it can't do the cross-area dedup that a whole-run batch can. The daily GitHub Actions cron is a fine cadence (§3 non-goal: no real-time sync). A managed ingestion service solves a scale problem we don't have and adds cost and vendor surface for a solo side project.

**Drop Overpass from the automated pipeline entirely.** §2's `data/overpass_area_*_resp.txt` are captured `rate_limited`/`timeout` responses at just four areas — the public Overpass instance rate-limits this project at roughly four sequential queries. Batching into fewer, larger queries (what the previous version of this section proposed) only slows how fast that ceiling is hit as coverage grows; it doesn't remove the dependency. Two ways to actually remove it were considered:

- **Self-host an Overpass instance — rejected.** An Overpass server is a stateful service that ingests minutely/daily OSM diffs to stay current: it needs its own disk, its own update cron, and its own monitoring, and it can silently fall behind on diff application without anything obviously breaking. For a solo operator that is *more* operational surface to babysit at 3am, not less — and it buys nothing the extract approach lacks.
- **Build from a static regional OSM extract — chosen.** A [Geofabrik](https://download.geofabrik.de/) North Carolina `.osm.pbf` (~300 MB) is a plain HTTPS file served off a CDN. If a download fails, retry in an hour or proceed with the cached copy from the last successful run — no query timeouts, no rate limits, no per-query flakiness. Scale is a non-issue with the right tools: the cycling data of interest is MB-range as GeoJSON, a metro-clipped extract is tens of MB of `.pbf`, and `osmium`/`osm2pgsql` are the exact machinery behind OSM's own tile rendering — they ingest the entire planet this way. Processing a metro extract is seconds to low minutes on a laptop.

Overpass QL stays useful for *ad-hoc* exploration and debugging — this decision is about the automated pipeline's runtime dependencies, not about retiring the tool.

**The restructured pipeline:**

1. **Config file.** Replace the hardcoded area-ID list in `fetch_data.py` with `data/cities.json` — one entry per Coverage Area: a name, and an **AOI clip boundary** (an OSM relation ID to resolve to a boundary polygon, or an explicit bbox). Adding a Coverage Area becomes a PR that adds one entry, not a code change. Entries now describe *what to clip the extract to*, not *what to query Overpass for*.
2. **Download and cache the regional extract.** Fetch the Geofabrik North Carolina `.osm.pbf` over HTTPS, cached between runs. A full re-download each run is acceptable at this size; keeping the local copy current with Geofabrik's daily `.osc.gz` diffs (`pyosmium-up-to-date`) instead is a fine optimization if the download ever becomes a nuisance, not a requirement.
3. **Clip to the AOIs.** For each `data/cities.json` entry, run `osmium extract --strategy=smart` against the regional `.pbf` to produce a clip bounded by that entry's bbox/polygon. `--strategy=smart` keeps the member ways and nodes of route relations and multipolygons even when they cross the clip boundary — needed for FR-3 (continuous routes) so a route isn't truncated at an AOI edge. Overlapping AOIs are fine and expected (see the seams subsection in §2); duplicates wash out at UPSERT.
4. **Load the clips into a dedicated "raw" PostGIS schema** via `osm2pgsql` with a flex (Lua) config that selects only cycling-relevant ways and relations. This raw schema is **owned by `osm2pgsql`** — dropped and reloaded on every run — and is explicitly **not** managed by the EF Core migrations in `db/Migrations` that own the serving `features` table.
5. **Ingestion SQL.** A query against the raw schema that reproduces exactly what the old Overpass QL query selected — the six clauses (`way[~"^cycleway:.*$"~"."]`, `way["cycleway"~"."]`, `way["highway"="cycleway"]`, `way["bicycle"="designated"]`, `way["bicycle"="yes"]`, `relation["route"="bicycle"]`), minus `way["highway"="proposed"]`.
6. **Transform.** Feed those rows through the **existing, unchanged** pure transform functions (`transform_road_feature` / `transform_path_feature` / `transform_relation_feature`). The only change is the `osmType`-extraction fix already planned as an Epic 4 bug-fix story (see architecture.md §4 — `transform_relation_feature` currently clobbers `properties.type`, so the real OSM element type has to be extracted explicitly for the UPSERT key).
7. **UPSERT into the existing serving `features` table**, keyed on `(osm_type, osm_id)` — unchanged from the contract Epics 1–3 already build on. The bbox API (§4.2) reads live from PostGIS; there is no publish step, no S3 sync, and no growing static file. The GitHub Action's last step changes from "sync `data/` to S3" to "run the loader against the DB."

**Why two schemas (raw OSM owned by `osm2pgsql`; `features` owned by migrations).** Keeping the raw import separate from the serving table is independently worth doing:

- **Iterate on transform logic without re-fetching upstream.** Re-run the ingestion SQL and the transform functions against already-downloaded raw data to change feature shape or fix a tag mapping — no round-trip to Geofabrik (or Overpass) to try a change.
- **Clean rebuild boundary.** Blow away and reload the raw schema on every run without touching `features` history (`first_seen_at` / `last_seen_at` stay intact). `osm2pgsql`'s drop-and-reload model and the migration-managed serving schema never contend for ownership of the same tables.
- **Two different change disciplines, kept apart.** The raw schema's shape follows `osm2pgsql` and the Lua config; `features` changes only through reviewed EF Core migrations. Merging them would subject the serving contract to `osm2pgsql`'s conventions.

**Relation geometry ("way-walking") — no change from today, and no regression.** `osm2pgsql` assembles a `route=bicycle` relation's member ways into a MultiLineString from its local node/way cache. That is the **same single-level assembly** `osm2geojson` does today from the Overpass payload — just more robust, because with `--strategy=smart` every member way is physically present in the local extract, so there are no gaps from a query that happened to miss a skeleton element. **Nested relations / `route_master` super-relations are not handled today and are not handled after this pivot either:** today's Overpass query uses single `>` recursion (not `>>`), and `transform_relation_feature` hard-gates on `tags.type == "route"`, which rejects `route_master`. The pivot neither loses nor adds this capability — nested-route support remains explicit future work in either world. Stating this plainly so nobody reads the extract approach as having dropped a capability it never had.

Points 1 and 3–4 of the previous version of this section survive above (config file; load into PostGIS by UPSERT; API reads live, GitHub Action stops syncing to S3). Point 2 — "prefer large bounding-box Overpass queries" — is replaced wholesale by steps 2–5.

### 4.4 Documentation automation

Two concrete, low-effort pieces worth setting up now while the codebase is still small:
- **`docs/planning/`** (this directory) for forward-looking design docs like this one — checked in, reviewed like code.
- Lightweight **ADRs** (architecture decision records, one short markdown file per significant decision — e.g. "0001-postgis-over-neo4j.md") once implementation actually starts, so the *why* behind choices like §4.1/§4.2 survives independent of this planning doc, which will go stale. A `docs/adr/README.md` index is enough process — no tooling required. The Epic 4 pivot recorded in §4.3 (drop Overpass from the automated pipeline; build `features` from a Geofabrik regional extract via `osmium` + `osm2pgsql` into a separate raw schema) is itself an ADR-worthy decision — capture it as one (e.g. "0002-osm-extract-over-overpass.md", including the self-hosted-Overpass alternative and why it was rejected) when Epic 4 implementation starts.
- Keep `CLAUDE.md` (repo root, just created) current as architecture changes — it's the thing that gives future Claude Code sessions accurate context without re-deriving it, which is exactly the automation the user asked for. Treat "update CLAUDE.md" as part of the definition of done for any PR that changes architecture, the same way `README` updates are for human-facing docs.

## 5. Proposed target architecture

```
 Geofabrik North Carolina .osm.pbf         static HTTPS file off a CDN;
        │                                   cached, refreshed on the daily cron
        ▼
 osmium extract --strategy=smart           clip to each AOI in data/cities.json;
        │                                   overlapping AOIs are fine
        ▼
 osm2pgsql (flex / Lua config)  ──▶  raw OSM schema in PostGIS
        │                             owned by osm2pgsql: dropped + reloaded each run
        ▼
 ingestion SQL  ──▶  transform             SQL reproduces the old Overpass QL
        │                                   selection; existing transform_* functions
        ▼
 UPSERT on (osm_type, osm_id)  ──▶  features table
        │                             owned by EF Core migrations; history preserved
        ▼
 Bbox API (ASP.NET Core + Npgsql)          GET /features?bbox=...
        │
        ▼
 website/ (Mapbox GL `geojson` source, refetched/updated on `moveend`)
```

The daily cron / manual dispatch drives the whole chain; `data/cities.json` drives the clip step. Nothing in this pipeline makes a live query against a third-party service.

## 6. Suggested phasing

1. **Stand up PostGIS locally, containerized** (docker-compose per [testing-and-tooling.md](./testing-and-tooling.md) §1) and write a one-off loader that ingests the *existing* `export.geojson` into it — validates the schema before touching the pipeline. *(Done — Epic 1.)*
2. **Build the bbox API** (§4.2) against that PostGIS instance and **swap the frontend source** to fetch/update on `moveend`, pointed at the existing 4-city data. This alone proves out the "no seams, lazy load" mechanics without touching ingestion yet. *(Done — Epics 2–3.)*
3. **Replace `fetch_data.py`'s Overpass fetch with the extract pipeline** (§4.3): download and cache the Geofabrik NC `.osm.pbf`; `osmium extract --strategy=smart` to each `data/cities.json` AOI; `osm2pgsql` the clips into a dedicated raw PostGIS schema; run the ingestion SQL plus the existing transform functions; UPSERT into `features` on `(osm_type, osm_id)`. Update `osm-refresh.yml` to drop **both** the Overpass call and `aws s3 sync` — the workflow becomes download → clip → load-raw → ingest-SQL + transform → UPSERT. Includes the `osmType`-extraction fix and the `highway_roads` missing-comma fix flagged in architecture.md §4. Epic 4's first phase (stories 4.1–4.3) is an interim Overpass-based version that ships first to get data flowing on the same `data/cities.json` config and on-instance cron; the extract pipeline described here (stories 4.4–4.9) then replaces only its fetch step, wholesale — the config schema, both transform bug fixes, the `scripts/pipeline/` package, and the psycopg UPSERT loader all carry over unchanged.
4. **Add a city** end-to-end (a real nearby town not yet covered) as the validation that the whole loop — config change → ingest → serve → map — works without code changes.

## 7. Open questions for Sean

- ~~Hosting for PostgreSQL + Martin~~ — resolved: see [deployment.md](./deployment.md).
- ~~§4.2: Martin vs. bbox API~~ — decided: bbox API. See §4.2.
- ~~Target city list~~ — no fixed list for now; Sean's leaning toward keeping scope abstract/config-driven rather than naming specific cities up front. Revisit when it's time to actually populate `data/cities.json` — doesn't block Phase 1 or 2.
- Any interest in the pgRouting / turn-by-turn-on-our-own-data path (§3 non-goal), or is Mapbox Directions fine indefinitely? Only matters if it changes the DB decision — it doesn't, but worth confirming it's genuinely out of scope.
