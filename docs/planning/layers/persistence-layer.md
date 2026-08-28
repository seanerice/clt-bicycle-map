# Persistence layer: detailed design

Status: Draft for review
Owner: Sean Rice
Last updated: 2026-08-28

Detail doc for the Persistence layer named in [../architecture.md](../architecture.md) §1: PostgreSQL + PostGIS, storing the OSM-derived cycling features and serving spatial range queries. Assumes the decisions already made in [../multi-city-expansion.md](../multi-city-expansion.md) (§4.1, PostGIS over a graph database; §4.3, UPSERT-keyed ingestion) and [../testing-and-tooling.md](../testing-and-tooling.md) (§1, containerized via docker-compose) — doesn't relitigate them. This database does not exist yet; everything below is a proposal to implement against, not a description of running infrastructure.

This doc is the persistence-layer side of two contracts defined in architecture.md §2:
- **Contract B (Application ↔ Persistence)** — the ingestion loader UPSERTs one row per OSM element keyed on `(osm_type, osm_id)`.
- **Contract C (API ↔ Persistence)** — the API only reads, via `ST_Intersects`/`&&` spatial-index range scans against a viewport bbox.

## 1. Schema design

### 1.1 One table, one row per OSM element

A single `features` table holds roads, paths, and route relations. All three are line geometry (ways: `LineString`; route relations resolved from possibly-disjoint member ways: `MultiLineString` — there are no point features in the current pipeline, per `scripts/fetch_data.py`), and all three ultimately feed the same `GET /features?bbox=...` read path (Contract C), so splitting them into separate tables would just mean the API unions three tables on every request for no benefit. A `feature_type` column distinguishes them for filtering and for the API to know which property family to populate.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE features (
    id                      BIGSERIAL PRIMARY KEY,

    -- Contract B natural key: identifies the source OSM element.
    osm_type                TEXT NOT NULL CHECK (osm_type IN ('way', 'relation')),
    osm_id                  BIGINT NOT NULL,

    -- Which Contract A property family this row feeds. `feature_type_enum`
    -- created separately: CREATE TYPE feature_type_enum AS ENUM ('road', 'path', 'route');
    -- (EF Core's migration tooling generates this DDL from the C# FeatureType enum — §4.)
    feature_type            feature_type_enum NOT NULL,

    -- WGS84 lon/lat — matches OSM and GeoJSON, no reprojection needed in
    -- or out. LineString for ways; MultiLineString for relations resolved
    -- from >1 disjoint member way.
    geom                    geometry(Geometry, 4326) NOT NULL,

    -- --- Roads (feature_type = 'road') ---
    cycleway_left           TEXT,               -- track | lane | share_busway | shared_lane | shoulder
    cycleway_right          TEXT,
    cycleway_left_buffer    BOOLEAN NOT NULL DEFAULT FALSE,
    cycleway_right_buffer   BOOLEAN NOT NULL DEFAULT FALSE,

    -- --- Paths (feature_type = 'path') ---
    bicycle                 TEXT,               -- designated | yes | unknown

    -- --- Routes (feature_type = 'route') ---
    route                   TEXT,               -- 'bicycle'
    cycle_network           TEXT,
    ref                     TEXT,
    name                    TEXT,
    state                   TEXT,               -- e.g. 'proposed'

    -- Full raw OSM tag bag, unfiltered. See §1.2.
    tags                    JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Ingestion bookkeeping. See §5.
    first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_features_osm_key UNIQUE (osm_type, osm_id),
    CONSTRAINT chk_features_geom_valid CHECK (ST_IsValid(geom)),
    CONSTRAINT chk_features_geom_type CHECK (GeometryType(geom) IN ('LINESTRING', 'MULTILINESTRING'))
);

CREATE INDEX idx_features_geom ON features USING GIST (geom);
CREATE INDEX idx_features_feature_type ON features (feature_type);
```

Notes on specific choices:
- **Surrogate `id BIGSERIAL` primary key**, with `(osm_type, osm_id)` as a separate unique constraint rather than the compound primary key. A surrogate key gives any future side table (a simplified-geometry cache, an ingestion-run audit table) a single-column FK target instead of a two-column one. The uniqueness guarantee Contract B actually needs comes from the `UNIQUE` constraint either way.
- **`osm_id BIGINT`**, not `INTEGER` — OSM identifiers grow monotonically and unboundedly; there's no reason to risk an overflow to save 4 bytes.
- **`feature_type` as a Postgres `ENUM`, not `TEXT` + `CHECK`.** Decided 2026-08-17: `feature_type` isn't a passthrough of an existing OSM field — it's the result of real classification logic (`transform_way_feature`'s dispatch on `highway`/`route` tag values, per application-layer.md §5) that has no OSM-native equivalent, and it drives real branching downstream in both the API's property-family mapping (§1.2 below) and the frontend's per-layer filter logic. That's the case for a proper enum type over a loosely-typed string: `Npgsql.EntityFrameworkCore.PostgreSQL` maps a Postgres enum directly to a C# enum (`FeatureType.Road`/`.Path`/`.Route`), giving compile-time-checked, autocomplete-friendly code wherever the API branches on it, and EF Core's migration tooling (per §4's EF Core decision) generates the `ALTER TYPE ... ADD VALUE` DDL automatically when a new C# enum member is added — the historical "enum evolution is awkward" downside is largely absorbed by that tooling rather than hand-written.
- **`geometry(Geometry, 4326)`, not a narrower typmod like `geometry(LineString, 4326)`.** Ways are always `LineString`; route relations can resolve to `MultiLineString` when the relation's member ways aren't end-to-end contiguous (a real possibility for signed bike routes). Constraining the column to `Geometry` and enforcing the allowed subtypes via the `chk_features_geom_type` CHECK gets type safety without rejecting legitimate `MultiLineString` routes.

### 1.2 Dedicated columns + JSONB hybrid, not one or the other

`fetch_data.py`'s transform functions spread the *entire* raw `tags` dict from OSM onto each feature, then layer computed properties (`cyclewayLeft`, `bicycle`, `highwayType`, etc.) on top. Two ways to carry that into the schema, both rejected in favor of a hybrid:

- **All dedicated columns** (one column per possible OSM tag key) — self-documenting and index-friendly, but OSM tagging is long-tail and inconsistent (arbitrary keys, freeform values); a real column per tag doesn't scale and every new tag variant becomes a migration.
- **Pure JSONB** (store `tags` and nothing else) — maximally flexible, matches "keep the raw bag around" from the background brief, but means every API query that needs `cycleway_left` or `route` does a JSONB key lookup instead of an indexed column read, and the schema stops documenting what the API/frontend actually depend on (Contract A's property list becomes implicit, discoverable only by reading `bikemap-app.js`).

**Recommendation: hybrid.** Dedicated columns for exactly the properties Contract A lists (`cycleway_left`, `cycleway_right`, `cycleway_left_buffer`, `cycleway_right_buffer`, `bicycle`, `route`, `cycle_network`, `ref`, `name`, `state`) — these are the ones the API must reliably expose and the ones a contract test (testing-and-tooling.md §2) should pin down. Everything else — the full, unfiltered `tags` JSONB — stays alongside as passthrough: it costs some storage duplication (the dedicated columns' values are also present inside `tags`) but means no ingested information is ever discarded, and a future Contract A addition (say, exposing `surface` or `lit`) is a query change in the API layer, not a schema migration or an ingestion-loader change to start capturing a tag it previously dropped. No GIN index on `tags` for v1 — nothing queries into it yet; add one (`CREATE INDEX ... USING GIN (tags)`) if and when a query pattern needs it.

`highwayType` from the pipeline is redundant with `feature_type = 'path'` (it's only ever set to `"path"`, unconditionally, inside `transform_path_feature`) and isn't stored as its own column — the API can emit `highwayType: "path"` for any row where `feature_type = 'path'` without persisting it separately. The raw `highway` tag value itself (`cycleway`, `footway`, `residential`, etc.) is preserved in `tags` if ever needed for debugging or a future property.

## 2. Spatial indexing

`CREATE INDEX idx_features_geom ON features USING GIST (geom)` is what makes Contract C's query pattern fast. Both operators the API needs are GiST-index-accelerated in PostGIS:

- `&&` (bounding-box overlap) — a pure index operation, no geometry math, cheapest possible bbox filter.
- `ST_Intersects(geom, envelope)` — PostGIS internally applies the `&&` index check first as a fast-path filter, then does exact geometry intersection only on the (usually small) candidate set the index returns. The idiomatic, safe form for the API's bbox query is therefore both together:

```sql
SELECT id, osm_type, osm_id, feature_type, ST_AsGeoJSON(geom) AS geometry,
       cycleway_left, cycleway_right, cycleway_left_buffer, cycleway_right_buffer,
       bicycle, route, cycle_network, ref, name, state
FROM features
WHERE geom && ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326)
  AND ST_Intersects(geom, ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326));
```

(The `&&` clause is technically redundant once `ST_Intersects` is present — Postgres's planner will use the GiST index off `ST_Intersects` alone — but writing both is a common, harmless idiom and makes the index usage obvious to a reader. Fine to drop the explicit `&&` if the API layer prefers a single predicate.)

`idx_features_feature_type` (plain B-tree) is there for the case the API also filters by category (e.g., a future "only show routes" query param) — Postgres can combine a GiST bitmap scan and a B-tree bitmap scan efficiently via `BitmapAnd`, so this doesn't need to be a composite index with `geom`.

**SRID/projection.** `geometry` (planar), SRID 4326, not `geography`. `geography` computes true great-circle distance/area and is more "correct" for real-world metric queries, but costs more per operation and isn't needed here — bbox-intersection is inherently an approximate, viewport-shaped query, not a precise distance query, and Charlotte's latitude (~35°N) doesn't introduce meaningful distortion at city scale. If a future feature needs precise metric distance (e.g. `ST_DWithin` in meters — "paths within 500m of X"), that's a per-query concern: either cast to `geography` for that one query, or compute against a local projected CRS (EPSG:32617, UTM zone 17N, covers the Charlotte metro) — not needed for v1 and not a reason to change the stored SRID.

## 3. Simplification strategy

multi-city-expansion.md §4.2 flags `ST_Simplify` with a zoom-derived tolerance as the accepted trade-off for not using Martin's automatic per-zoom simplification. Two ways to implement that at the persistence layer:

**Option A — query-time simplification (recommended for v1).** The API calls `ST_SimplifyPreserveTopology(geom, :tolerance)` inline, with `:tolerance` derived from the request's zoom level (coarser tolerance at low zoom, none/minimal at high zoom). No schema change, no extra storage, no write-path complexity — the simplification is just a parameter of the read query.

```sql
SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, :tolerance)) AS geometry, ...
```

Use `ST_SimplifyPreserveTopology`, not bare `ST_Simplify` — the topology-preserving variant avoids introducing self-intersections in a simplified line, which matters for rendering (a bare `ST_Simplify` can occasionally produce a visually broken line at aggressive tolerances).

**Option B — precomputed simplified geometry per zoom tier.** Add columns (or a side table) like `geom_simplified_low`, `geom_simplified_mid`, each its own `geometry(Geometry, 4326)` with its own GiST index, populated at ingestion time (or by a post-load job) via `ST_SimplifyPreserveTopology`. Faster reads (no per-request simplification cost) at the cost of more storage, more write-path complexity (every UPSERT now maintains N geometry variants), and a tuning problem (how many tiers, what tolerance each) that has to be revisited whenever real usage data comes in.

**Recommendation: Option A for v1.** multi-city-expansion.md §4.2 already frames simplification as something to revisit "only if low-zoom payload size becomes a real problem" — not a known problem yet. Precomputing tiers is real engineering effort (schema, write path, tuning) in service of a performance problem that hasn't been observed. Query-time simplification is trivially reversible and gives a real number (actual query latency, actual payload size at real zoom levels) to decide whether Option B is ever worth it. If it is, the schema in §1.1 doesn't block adding those columns later — nothing about the current design assumes single-geometry-per-row permanently.

## 4. Migration tooling

**Decided (2026-08-17): EF Core migrations.** Sean's call, overriding this doc's original SQL-files-for-v1 leaning.

Two real options were on the table:
- **EF Core migrations** — schema-as-C#-code, one toolchain shared with the API project (ASP.NET Core + Npgsql), `dotnet ef database update` applies migrations, and `Npgsql.EntityFrameworkCore.PostgreSQL` plus its NetTopologySuite plugin can map `geometry` columns directly to NTS types the API already uses (per multi-city-expansion.md §4.2, the API is Npgsql + NetTopologySuite). **This is the chosen option.**
- **Lightweight standalone SQL migration runner** — plain numbered files (`db/migrations/0001_init.sql`, `0002_add_state_index.sql`, ...) applied by a small script or an off-the-shelf tool (`dbmate`, `golang-migrate`), tracked via a `schema_migrations` table. Decoupled from the API project entirely. Not chosen.

**Phasing consequence, since this doc's original leaning was driven entirely by sequencing:** multi-city-expansion.md §6 Phase 1 stands up PostGIS and validates the schema with a one-off loader *before* the bbox API (and therefore the full ASP.NET Core project) exists. EF Core migrations need a .NET project to host `dotnet ef`, so Epic 1 now needs to scaffold a minimal .NET project *early* — just enough to run migrations — rather than waiting for Epic 2's full `api/` project. That minimal migrations project can later be absorbed into (or referenced by) the real `api/` project once Epic 2 starts; it doesn't need to be the final shape from day one. The Phase-1 one-off validation loader (loading today's `data/export.geojson`) can stay a separate Python script regardless — only schema migrations move to EF Core, not that throwaway tool.

## 5. Idempotent UPSERT support

`ux_features_osm_key UNIQUE (osm_type, osm_id)` from §1.1 is the exact constraint Contract B's `INSERT ... ON CONFLICT` target needs:

```sql
INSERT INTO features (
    osm_type, osm_id, feature_type, geom,
    cycleway_left, cycleway_right, cycleway_left_buffer, cycleway_right_buffer,
    bicycle,
    route, cycle_network, ref, name, state,
    tags
) VALUES (
    %(osm_type)s, %(osm_id)s, %(feature_type)s, ST_GeomFromGeoJSON(%(geometry_json)s),
    %(cycleway_left)s, %(cycleway_right)s, %(cycleway_left_buffer)s, %(cycleway_right_buffer)s,
    %(bicycle)s,
    %(route)s, %(cycle_network)s, %(ref)s, %(name)s, %(state)s,
    %(tags)s
)
ON CONFLICT (osm_type, osm_id) DO UPDATE SET
    feature_type           = EXCLUDED.feature_type,
    geom                    = EXCLUDED.geom,
    cycleway_left           = EXCLUDED.cycleway_left,
    cycleway_right          = EXCLUDED.cycleway_right,
    cycleway_left_buffer    = EXCLUDED.cycleway_left_buffer,
    cycleway_right_buffer   = EXCLUDED.cycleway_right_buffer,
    bicycle                 = EXCLUDED.bicycle,
    route                   = EXCLUDED.route,
    cycle_network           = EXCLUDED.cycle_network,
    ref                     = EXCLUDED.ref,
    name                    = EXCLUDED.name,
    state                   = EXCLUDED.state,
    tags                    = EXCLUDED.tags,
    last_seen_at            = now();
```

This is what makes re-running ingestion, and overlapping area clips across neighboring cities (multi-city-expansion.md §4.3), idempotent instead of duplicative — the same OSM way or relation appearing in two overlapping AOI clips collapses to one UPSERT, not two rows. Note `first_seen_at` is deliberately *not* touched in the `DO UPDATE SET` list, so it keeps its original `INSERT`-time value across every subsequent re-ingestion of the same element.

**`last_seen_at`, bumped on every UPSERT regardless of whether any tracked value actually changed.** This is the minimal thing the schema needs to leave the door open for the "what changed since last sync" and deleted-feature-detection use cases discussed in prd.md §8 (open question 3) and architecture.md §5, without building either now:
- *Deleted-feature detection*: a feature no longer present in OSM simply won't appear in the next ingestion run, so its row's `last_seen_at` stops advancing. A future job could treat `last_seen_at` older than "the start of the most recent successful run that covered this feature's area" as a removal candidate. That job needs to know which run covered which area to avoid false positives from a partial-coverage run — out of scope for this doc, but `last_seen_at` alone is the cheap, no-regret piece; it doesn't force anything else to be built now.
- *Content-change history*: this schema does **not** distinguish "re-ingested with identical content" from "re-ingested with actually-different content" — every UPSERT unconditionally overwrites and bumps `last_seen_at`. True change history (an audit log of what changed) would need either a trigger-based history table or an explicit diff in the loader before writing; neither is proposed here. Flagging it as a known gap rather than a silent one.

## 6. Containerization

Fits testing-and-tooling.md §1's docker-compose model directly:

```yaml
services:
  db:
    image: postgis/postgis:16-3.4
    environment:
      POSTGRES_DB: bikemap
      POSTGRES_USER: bikemap
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d:ro   # first-boot bootstrap only, see below
    ports:
      - "5432:5432"   # local dev convenience; not needed once the API talks to `db` over the compose network

volumes:
  pgdata:
```

- **Base image**: official `postgis/postgis`, pinned to a specific Postgres/PostGIS combo (e.g. `16-3.4`) rather than `latest`, so a `docker compose up` six months from now doesn't silently pick up a breaking major-version bump.
- **Volume**: a named volume (`pgdata`) mounted at Postgres's data directory so container recreation (`docker compose down && up`, image updates) doesn't lose data. Anonymous/ephemeral storage would be fine for CI integration tests (§7) but not for local dev or a real deploy.
- **Bootstrap vs. migrations — two different mechanisms, don't conflate them.** The official image only runs scripts in `/docker-entrypoint-initdb.d/` the *first* time a container starts against an empty data directory — it's a one-shot bootstrap (`CREATE EXTENSION IF NOT EXISTS postgis;` plus, if using the SQL-file migration approach from §4, the schema as of that point), not a repeatable migration mechanism. Ongoing schema changes need an explicit migration step (the runner from §4, whichever tool wins) run on deploy/startup, separate from this hook. Don't rely on `initdb.d` alone once the schema needs to evolve past its first version.
- **Extensions**: `postgis` only, for now. `pgRouting` is explicitly not needed (multi-city-expansion.md §3 non-goal), and adding it later doesn't require a schema redesign — `CREATE EXTENSION pgrouting;` operates over the same `features.geom` column (typically after building a routing topology with `pgr_createTopology` or similar over the existing line geometries). Worth knowing this door is open; not something to design for now. `postgis_topology` / `postgis_raster` aren't needed either — no polygon/raster data in this project.

## 7. Data-quality support

testing-and-tooling.md §2 wants post-ingestion checks for feature-count collapse, geometry validity, and duplicate OSM ids. Schema-level help for each:

- **Duplicate OSM ids**: structurally impossible, not just checked. `ux_features_osm_key UNIQUE (osm_type, osm_id)` means the loader's UPSERT can never produce two rows for the same OSM element — a would-be duplicate insert becomes an update instead. This check effectively moves from "a query that runs after ingestion and hopes to catch a bug" to "a constraint the database itself enforces on every write." Worth stating plainly since it's a stronger guarantee than the other two.
- **Geometry validity**: `chk_features_geom_valid CHECK (ST_IsValid(geom))` rejects an invalid geometry at write time rather than letting bad data land and be caught later. Trade-off worth being explicit about: this makes a single bad row fail its whole UPSERT statement/transaction loudly, rather than silently storing corrupt data — the right failure mode for a solo-maintained pipeline, but it means the loader needs to either fix up geometries it knows can be invalid (`ST_MakeValid` before insert, if `osm2pgsql`/`osmium` ever assembles a self-intersecting way or relation geometry) or be prepared to catch and log the constraint violation per-element instead of failing an entire batch. That decision (fail-batch vs. catch-and-skip-per-element) is an application-layer concern, not a persistence one — flagging the trade-off here since the CHECK constraint is what creates it.
- **Feature-count collapse**: inherently a cross-run comparison ("this run returned 12 features for a city that normally has 4,000") — not expressible as a single-row constraint, necessarily an application-level check. `last_seen_at` (§5) makes the comparison queryable at the DB level if wanted (`SELECT count(*) FROM features WHERE last_seen_at >= :run_start`), but the judgment of "is this count suspiciously low" belongs in the ingestion pipeline's data-quality step, not the schema.

## 8. Testing approach (persistence layer)

Per architecture.md §4, each layer doc covers its own testing angle; testing-and-tooling.md §2 already names the categories (integration tests, data-quality checks) this layer participates in:

- **Integration tests** run against the docker-compose `db` service (§6), same container in local dev and CI: apply migrations from empty, load a small fixture set of features, and assert (a) the UPSERT is idempotent — running the same fixture batch twice leaves row count and `first_seen_at` unchanged while `last_seen_at` advances; (b) a bbox query returns the expected features and excludes ones outside it; (c) an invalid or duplicate-key insert is rejected by the constraints in §1.1/§5 rather than silently succeeding.
- Optionally, `EXPLAIN (ANALYZE)` on a representative bbox query in CI against a realistically-sized fixture, asserting the plan uses `idx_features_geom` (a `Bitmap Index Scan` on the GiST index) rather than a sequential scan — cheap insurance against a future migration accidentally dropping or invalidating the index.
- Data-quality checks (§7) belong to the ingestion pipeline's own test/ops story (application-layer doc), not this layer's test suite — this layer's job is making sure the constraints that back those checks (uniqueness, validity) actually hold.

## 9. Open questions for Sean

- ~~Migration tooling~~ — **resolved 2026-08-17: EF Core migrations** (§4). Epic 1 now needs a minimal .NET migrations project scaffolded ahead of Epic 2's full `api/` project — see §4's phasing note.
- ~~`feature_type` as `TEXT + CHECK` vs. a Postgres `ENUM`~~ (§1.1) — **resolved 2026-08-17: ENUM**. `feature_type` is a real classification (no OSM-native equivalent) that drives downstream branching, not informational passthrough — the case for a typed enum over a loose string. EF Core's migration tooling (§4) generates the enum-evolution DDL, mitigating the classic "ENUM is awkward to extend" downside.
- ~~Surrogate `BIGSERIAL` primary key vs. `(osm_type, osm_id)` as a compound primary key directly~~ (§1.1) — **resolved 2026-08-17: surrogate `BIGSERIAL id`**, per Sean: "first class ids, keep the old ids as reference." `(osm_type, osm_id)` stays enforced via `ux_features_osm_key UNIQUE` as documented in §1.1, not promoted to the PK.
- **Should the API filter `state = 'proposed'` at the DB layer, or keep that a UI-layer concern?** Today the frontend applies `['!=', ['get', 'state'], 'proposed']` as a Mapbox style filter (`website/src/bikemap-app.js`) — the persistence/API layers currently just pass `state` through unfiltered, per Contract A. No schema change needed either way (an index on `state` would be cheap to add if the API ever wants to filter server-side), but flagging since it's a question of where the responsibility lives, not just performance.
- **Ingestion-run tracking (a dedicated `ingestion_runs` table: run id, started/finished timestamps, cities/bbox covered)** — not proposed for v1 (§5 keeps this to a single `last_seen_at` column on `features`), but prd.md §8 (open question 3) and architecture.md §5 gesture at wanting this kind of history eventually. Confirm that deferring it is fine, since it would change how deleted-feature detection could eventually be scoped correctly (avoiding false positives from partial-coverage runs).
- **GIN index on `tags`** (§1.2) — not created in v1 because nothing queries into the raw tag bag yet. Flag if there's a known near-term use case (e.g. an admin/debug view keyed on arbitrary OSM tags) that would justify adding it now instead of reactively.
- **Clip route geometry to the bbox (`ST_Intersection`) or return it whole (`ST_Intersects` only, §2's query as written)?** Reopened during PRD reconciliation (architecture.md §5/§6) — previously treated as settled in api-layer.md/ui-layer.md, now an open trade between payload size for long routes and untested risk to `cycling-route-symbols` label-anchor stability. This layer just needs to know which the API query will call; no schema impact either way.
