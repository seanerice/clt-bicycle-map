# API layer: design plan

Status: Draft for review
Owner: Sean Rice
Last updated: 2026-08-16

Detail doc for the API layer named in [architecture.md](../architecture.md) §1. That doc owns the cross-layer contracts (§2) and the four-layer split; this doc works out how the API layer — `GET /features?bbox=...` over PostGIS, ASP.NET Core + Npgsql + NetTopologySuite — actually gets built. It assumes, rather than relitigates, the decisions in [multi-city-expansion.md](../multi-city-expansion.md) §4.1/§4.2 (PostGIS over a graph DB; bbox API over Martin/MVT) and [testing-and-tooling.md](../testing-and-tooling.md) §1 (everything containerized).

This is the only layer that talks to both the UI and the database (architecture.md §1) — it owns Contract A (UI ↔ API) and is the read side of Contract C (API ↔ Persistence).

## 1. Project structure

**Minimal API, not controllers.** Given "easiest to implement, solo side project" (multi-city-expansion.md §1/§4.2) and the fact that this service has exactly one real endpoint plus a health check, the controller/MVC ceremony (attribute routing, `ControllerBase`, action filters split across files) buys nothing here. A minimal API keeps the whole route surface in `Program.cs` (or one `FeaturesEndpoints.cs` extension method registered from `Program.cs`), which is easier to read top-to-bottom for a service this small. Revisit if the endpoint count grows past a handful — that's the point where controllers start paying for themselves.

Proposed layout (new `api/` directory at repo root, sibling to `website/` and `scripts/`, matching the "each layer gets its own top-level directory" shape implied by architecture.md):

```
api/
  Api.csproj
  Program.cs                  # host setup, DI, middleware, endpoint registration
  Endpoints/
    FeaturesEndpoints.cs       # GET /features — request parsing, validation, calls FeaturesService
    HealthEndpoints.cs         # GET /health (see §8)
  Features/
    FeaturesService.cs         # query orchestration: validate bbox -> query repo -> shape response
    FeaturesRepository.cs      # Npgsql/NTS query against the features table (Contract C)
    BboxParser.cs              # parses/validates the `bbox` query param (see §2)
  Geo/
    GeoJsonOptions.cs          # System.Text.Json + NTS GeoJSON converter wiring
  appsettings.json
  appsettings.Development.json
  Dockerfile
Api.Tests/
  Api.Tests.csproj
  FeaturesEndpointsTests.cs    # WebApplicationFactory-style integration tests (see §9)
  ContractTests.cs             # Contract A property-shape assertions (see §9)
```

Keeping `Features/` as plain classes (not minimal-API-inline lambdas doing the DB work) matters for testability — the endpoint handler itself should be a thin adapter so `FeaturesService` can be integration-tested without spinning up Kestrel, and `BboxParser` can be unit-tested with no I/O at all.

### NetTopologySuite placement

- NTS types (`NetTopologySuite.Geometries.Geometry`, `LineString`, `MultiLineString`, `Point`) are what geometry columns deserialize into via `Npgsql.NetTopologySuite` (see §3) — they live at the repository boundary, not the endpoint boundary.
- For GeoJSON output, use `NetTopologySuite.IO.GeoJSON4STJ` (the actively maintained NTS package with `System.Text.Json` converters for `Geometry`, `Feature`, `FeatureCollection`) rather than hand-rolling geometry serialization. Register it once via `AddSingleton<GeoJsonConverterFactory>()` / `JsonSerializerOptions.Converters.Add(...)` and reuse the same `JsonSerializerOptions` for minimal API's built-in JSON result handling.
- `NetTopologySuite.Features.Feature` / `FeatureCollection` (NTS's own types, not to be confused with our domain model) are a reasonable response DTO shape — a `Feature` is just `(Geometry, IAttributesTable)`, and `IAttributesTable` maps naturally onto the properties bag described in §3.
- `Microsoft.Spatial` (the OData/EF spatial types) is *not* the right fit here — it's a different, incompatible geometry model from NTS and mixing the two adds a conversion layer for no benefit. NTS end-to-end (Npgsql → repository → GeoJSON serialization) is the simpler path and is what `Npgsql.NetTopologySuite` is built to pair with.

## 2. Endpoint design

### `GET /features?bbox=minLon,minLat,maxLon,maxLat`

**Request**
- `bbox` (required): four comma-separated floats, `minLon,minLat,maxLon,maxLat`, WGS84 degrees (matching GeoJSON/OSM convention — no CRS negotiation needed since everything in this system is already lon/lat).
- Validation, in order, each returning `400 Bad Request` with a small JSON error body (`{ "error": "..." }`) on failure:
  1. Parse: exactly 4 comma-separated values, all parse as floats. Malformed → 400.
  2. Range sanity: `-180 <= minLon < maxLon <= 180`, `-90 <= minLat < maxLat <= 90`. Catches swapped min/max and out-of-range coordinates.
  3. Area cap: reject bboxes above a configured max area (see below) → 400 with a message naming the limit, not a silent truncation. This is the "someone requests the whole planet" guard called out in the task — a public, unauthenticated, spatial-index-backed endpoint should not let one request force a full-table scan disguised as a range query.
  - Suggested initial cap: **~2 square degrees** (roughly a 1.4° x 1.4° box — comfortably larger than the whole Charlotte metro, small enough that no single request can accidentally ask for a continent). Exact number isn't load-bearing; make it a config value (`Features:MaxBboxAreaDegrees`) so it can be tuned without a code change once real usage patterns are known. Compute as `(maxLon-minLon) * (maxLat-minLat)` — good enough for a sanity cap; no need for a proper geodesic area calc at this stage.
- `zoom` (optional, **not implemented in v1** — see §4): reserved query param name so adding it later isn't a breaking change to the URL shape.

**Response**
- `200 OK` with a GeoJSON `FeatureCollection` (`Content-Type: application/geo+json`, per RFC 7946 §3 recommendation — `application/json` also acceptable and is what Mapbox GL's `geojson` source will accept regardless) for both the "features found" and "bbox valid but empty result" cases. An empty `FeatureCollection` (`"features": []`) is a normal, successful response, not a 404 — there's no single "resource" being fetched, just a query over a region that may legitimately contain nothing (e.g. panning out over a lake). This matches how the frontend already treats `moveend`-driven refetches (multi-city-expansion.md §4.2) — it just re-sets the source data each time, empty or not.
- `400 Bad Request` for anything caught by the validation above.
- `500 Internal Server Error` for anything else (DB unreachable, unexpected exception) — no custom body beyond ASP.NET Core's default problem-details shape; this is a solo side project, not a public API product, so a generic 500 plus server-side logging (§8) is enough to debug from.
- No `404` case for this endpoint — there's no resource identifier in the URL to "not find."

### Is `zoom` worth adding now?

**Deferred**, per the task guidance and multi-city-expansion.md §4.2's own framing of simplification as a fallback to reach for only if payload size actually bites. Reasons to defer rather than add a no-op param now:
- Nothing consumes it yet (no `ST_Simplify` wired up — see §4), so adding it today is speculative surface area with no behavior behind it, which is easy to get subtly wrong (e.g. bake in an assumption about the zoom→tolerance mapping before there's real data to validate it against).
- The URL shape (`?bbox=...&zoom=...`) is additive and backward-compatible whenever it does get added — no reason to reserve it early beyond noting the name here so nobody accidentally picks a different one later.

## 3. Query implementation

**Update 2026-08-16: schema assumption resolved.** This section originally assumed a single `properties jsonb` bag (see history note below) — `persistence-layer.md` §1, drafted in parallel, instead landed on a hybrid: dedicated columns for the exact properties Contract A lists, plus a separate `tags jsonb` column for raw OSM passthrough that the API doesn't need to read. The query and mapping below are updated to match that schema. The two docs converged independently on the same underlying signal (Contract A's property list is small and fixed, so it's worth naming in the schema) — no actual disagreement to reconcile, just an API-side assumption that was ahead of the persistence design at draft time.

Actual schema (from `persistence-layer.md` §1.1), abbreviated to the columns this query reads:

```
features (
    id                      bigserial primary key,
    osm_type                text not null,              -- 'way' | 'relation'
    osm_id                  bigint not null,
    feature_type            text not null,               -- 'road' | 'path' | 'route'
    geom                    geometry(Geometry, 4326) not null,
    cycleway_left           text,       cycleway_right          text,
    cycleway_left_buffer    boolean,    cycleway_right_buffer   boolean,
    bicycle                 text,
    route                   text,       cycle_network           text,
    ref                     text,       name                    text,       state text,
    tags                    jsonb not null,              -- raw OSM tags, not read by the API
    unique (osm_type, osm_id)                            -- Contract B's natural key
)
-- spatial index: CREATE INDEX ON features USING GIST (geom);
```

`highwayType` isn't a stored column — per persistence-layer.md §1.2, it's derived at read time as `"path"` whenever `feature_type = 'path'`, so the API adds it to the response properties rather than selecting it.

**Conceptual query** (Npgsql + NTS, via raw SQL — see note on Dapper vs. EF Core below):

```sql
SELECT osm_type, osm_id, feature_type, geom,
       cycleway_left, cycleway_right, cycleway_left_buffer, cycleway_right_buffer,
       bicycle, route, cycle_network, ref, name, state
FROM features
WHERE geom && ST_MakeEnvelope(@minLon, @minLat, @maxLon, @maxLat, 4326)
  AND ST_Intersects(geom, ST_MakeEnvelope(@minLon, @minLat, @maxLon, @maxLat, 4326));
```

- `&&` (bounding-box overlap) first is what actually hits the GiST index; `ST_Intersects` afterward gives exact geometry-level correctness for features whose bbox overlaps but whose actual geometry doesn't (common for anything non-axis-aligned). Postgres' planner will typically use the index for `&&` and apply `ST_Intersects` as a filter on the resulting rows, but writing both explicitly documents the intent and matches the two operators multi-city-expansion.md §4.1 names as the "core query pattern" — worth keeping both rather than relying on `ST_Intersects` alone to also drive the index (it can, but `&&` is the idiomatic PostGIS way to be explicit that the index scan is intended).
- `ST_MakeEnvelope(..., 4326)` builds the query rectangle in the same SRID as the stored geometry — matches the assumption that everything is WGS84 (SRID 4326), consistent with GeoJSON/OSM.
- **Clipping — open question, not decided (reopened during PRD reconciliation, see architecture.md §5/§6).** As written above, this query selects `geom` as stored and does not call `ST_Intersection` to clip a feature's geometry down to the requested bbox — a feature whose geometry intersects the bbox at all comes back with its *complete* geometry, potentially extending well outside the requested rectangle. This was originally recorded as the resolution to `ui-layer.md` §9's open question #1 (does a route get clipped at the viewport edge, or returned whole), on the reasoning that `cycling-route-symbols` label placement needs a route's full, stable geometry to anchor against rather than a bbox-dependent fragment. That reasoning is real but untested, and the framing that motivated it ("a clipped route will look chopped up") doesn't hold — Mapbox GL already clips rendering to the visible canvas regardless of whether the fetched geometry extends past it. For roads/paths, whether this query clips is inconsequential (OSM ways are already short segments). For route relations — long, stored as a single row's `MultiLineString` per persistence-layer.md §1.1 — it's a real cost either way: **not clipping** means a route far larger than the viewport contributes its full geometry to every intersecting request's payload (exactly the low-zoom/large-response case `ST_Simplify`, §4, exists to mitigate); **clipping** (`ST_Intersection` against the padded bbox) keeps payload viewport-scoped but risks the label-anchor jumping or duplicating across fetches. Needs a decision — or a quick experiment against a real long route — before this query is finalized for `feature_type = 'route'`.
- Data-access approach: **Dapper**, not EF Core, for this query. EF Core's LINQ-to-SQL translation of NTS spatial operators exists (`EF.Functions` spatial extensions via `Npgsql.EntityFrameworkCore.PostgreSQL.NetTopologySuite`) but is one more abstraction layer over a query that's simple, fixed, and performance-sensitive — a hand-written parameterized SQL string via Dapper (or even raw `NpgsqlCommand`) is easier to read, easier to `EXPLAIN ANALYZE` verbatim, and avoids surprises where the LINQ provider generates a materially different plan than the SQL above. This does **not** preclude EF Core being used for the migration-tooling question (§10) — that's a schema-management concern, independent of how this one read query is issued. If EF Core migrations are chosen for schema (§10), it's entirely reasonable to still hand-write this query with Dapper against the same `DbContext`'s connection.
- Mapping a row back to a GeoJSON `Feature`: `geom` deserializes directly to an NTS `Geometry` via the `Npgsql.NetTopologySuite` plugin (no manual WKB/WKT parsing). The response `properties` bag is assembled in code from the named columns (`cycleway_left` → `cyclewayLeft`, etc. — snake_case DB columns to the camelCase keys Contract A specifies), dropping any that are null/absent per the existing frontend convention (e.g. `fetch_data.py`'s transform functions omit `cyclewayLeft` entirely rather than emit it `null` when there's no cycleway — the API should match that, omit-if-null rather than emit-null, so `['has', 'cyclewayLeft']` filters in `bikemap-app.js` keep working unchanged), plus the derived `highwayType: "path"` when `feature_type = 'path'`. This is a small, explicit mapping function (`FeaturesRepository`'s job, per §1) rather than a pass-through — a deliberate trade against the original JSONB-passthrough assumption, in exchange for the schema-level self-documentation persistence-layer.md §1.2 argues for.
- Also worth including `osm_type`/`osm_id` in the response — either as GeoJSON `Feature.id` (RFC 7946 permits a top-level `id` per feature) or as properties (e.g. `osmType`/`osmId`) — since `ui-layer.md` §9 open question #4 asks for a stable feature id and this schema already carries one. Leaning `Feature.id` since that's what GeoJSON's own spec designates for this purpose rather than inventing a properties-bag convention; flagged as a small open item in §10 since it's a one-line addition either way.

## 4. Simplification / payload size

**Not built in v1.** Per multi-city-expansion.md §4.2, `ST_Simplify` with a zoom-derived tolerance is the accepted fallback if low-zoom payload size becomes a real problem — but it's explicitly "worth revisiting only if either actually bites at real usage levels," not something to pre-build.

To keep it a one-line addition later rather than a query rewrite, structure the repository query now so simplification slots into the existing `SELECT`:

```sql
SELECT osm_type, osm_id,
       ST_Simplify(geom, @tolerance) AS geom,   -- @tolerance = 0 (or omit clause) today
       properties
FROM features
WHERE geom && ST_MakeEnvelope(...) AND ST_Intersects(geom, ST_MakeEnvelope(...));
```

When it's time to build it for real:
- **Trigger on bbox area, not a client-supplied `zoom` param, at least initially.** The bbox itself already tells the server how "zoomed out" the request is (a wide bbox implies a low zoom, roughly), so simplification can key off the same area computed for the §2 sanity cap — e.g. apply `ST_Simplify` with a tolerance scaled to bbox width above some threshold, skip it below. This avoids trusting a client-supplied `zoom` value to correspond to what the map is actually showing, and avoids adding the `zoom` param to the contract at all if area-based triggering is good enough.
- If area-based triggering proves too coarse (e.g. wants to match Mapbox GL's actual zoom levels more precisely), *then* add `zoom` as an optional param and derive tolerance from it directly — additive to the URL shape per §2.
- Tolerance should be a config value or a small lookup table (bbox-area bucket → tolerance in degrees), not hardcoded inline, so it can be tuned without a redeploy-as-code-change once there's real payload-size data to tune against.
- Recommendation: don't build this speculatively. Add a payload-size log field (§8) now so there's real data (p50/p95 response bytes by bbox area) to decide *if and when* this is worth building, instead of guessing.

## 5. CORS

The frontend (`bikemap.seanerice.dev`, currently served from S3/CloudFront per multi-city-expansion.md §2) is a different origin than the API. CORS must be configured explicitly — ASP.NET Core denies cross-origin requests by default.

```csharp
builder.Services.AddCors(options =>
{
    options.AddPolicy("frontend", policy =>
        policy.WithOrigins(builder.Configuration["Cors:AllowedOrigin"] ?? "https://bikemap.seanerice.dev")
              .WithMethods("GET")
              .AllowAnyHeader());
});
// ...
app.UseCors("frontend");
```

- Origin comes from config (`Cors:AllowedOrigin`, env var `CORS__ALLOWEDORIGIN` in docker-compose), not hardcoded, so local dev (`http://localhost:8080` or whatever `npm run start` binds to) can point at a local API instance without a code change — likely a comma-separated list (`WithOrigins` accepts multiple) covering both the prod frontend origin and localhost dev origins.
- `GET`-only, no credentials (`AllowAnyHeader` but not `AllowCredentials`) — matches "no auth" (§6); there's no cookie/session to protect, so the permissive-but-GET-only policy is enough.

## 6. Auth

**None, explicitly** — confirming architecture.md §5's note directly: the S3 static file was public and unauthenticated; the bbox API replacing it is public and unauthenticated too. No API keys, no auth headers, nothing for the frontend to manage. This is a deliberate carry-forward, not an oversight.

**Lightweight abuse protection is worth it, given it's public:**
- **Max bbox area (§2)** is the primary defense — it directly bounds the worst-case query cost per request regardless of request volume, which matters more than rate limiting for a spatial-index range-scan endpoint (a single oversized bbox is a worse risk than many small ones).
- **Basic rate limiting** — ASP.NET Core's built-in `Microsoft.AspNetCore.RateLimiting` middleware (fixed-window, e.g. per-IP) is a few lines and worth adding as cheap insurance against accidental abuse (a buggy client stuck in a refetch loop) or casual scraping, not because a sophisticated adversary is expected. A generous limit (e.g. 60 req/min/IP) that a normal panning/zooming user would never hit is enough — this is not a security control, it's a "don't fall over" control.
- Explicitly **not** worth it in v1: WAF, CAPTCHA, API keys, or anything that adds operational overhead disproportionate to "solo side project public map." Revisit only if actual abuse is observed.

## 7. Docker / deployment shape

Fits into the docker-compose stack from testing-and-tooling.md §1 as one more service alongside PostGIS and the ingestion job:

```yaml
# docker-compose.yml (excerpt)
services:
  api:
    build: ./api
    environment:
      ConnectionStrings__Postgis: "Host=db;Database=bikemap;Username=bikemap;Password=${POSTGRES_PASSWORD}"
      Cors__AllowedOrigin: "https://bikemap.seanerice.dev,http://localhost:8080"
    ports:
      - "5000:8080"
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 10s
      timeout: 3s
      retries: 5
```

(Service named `db`, not `postgis` — matches [persistence-layer.md §6](./persistence-layer.md#6-containerization)'s canonical naming, reconciled after an earlier draft of this excerpt used `postgis` here while persistence-layer.md used `db`. Env var is `POSTGRES_PASSWORD` to match that doc's `POSTGRES_PASSWORD` container env var, not `POSTGIS_PASSWORD`.)

- **Dockerfile**: standard multi-stage ASP.NET Core build — `mcr.microsoft.com/dotnet/sdk:<version>` for `dotnet publish`, `mcr.microsoft.com/dotnet/aspnet:<version>` for the runtime image. Nothing project-specific beyond referencing `api/Api.csproj`; no native deps (NTS and Npgsql are pure-managed/no extra system libraries needed on the client side — PostGIS the extension lives in the `db` container, not here).
- **Config via env vars**: connection string via `ConnectionStrings__Postgis` (ASP.NET Core's standard `__` env var → config-section binding), CORS origin(s) via `Cors__AllowedOrigin`, bbox area cap via `Features__MaxBboxAreaDegrees`. No secrets belong in `appsettings.json` — `appsettings.Development.json` can default to a local-dev connection string for running outside Docker (`dotnet run` against a docker-composed PostGIS on `localhost`).
- **Health check endpoint**: `GET /health` — checked in §8, but noting the docker-compose angle here: it needs to reflect real DB reachability (`SELECT 1` against PostGIS), not just "the process is up," since the compose stack's `depends_on: condition: service_healthy` chains matter for the ingestion job / integration tests waiting on a fully-ready stack (testing-and-tooling.md §1's "bonus: the same compose stack is what integration tests spin up").

## 8. Observability

Proportionate to solo-side-project scale — no metrics stack, no tracing, no log aggregation service:

- **`GET /health`**: use ASP.NET Core's built-in `Microsoft.Extensions.Diagnostics.HealthChecks` with `AddNpgsql(...)` (from `AspNetCore.HealthChecks.NpgSql`) pointed at the same connection string — returns `200` when a real DB query succeeds, `503` otherwise. This is the endpoint docker-compose's healthcheck (§7) polls.
- **Structured logging** via the built-in `ILogger<T>` (no need for Serilog/Seq for this scale) to stdout — Docker's default log driver captures it, which is enough for a solo operator tailing `docker compose logs api`. Log at minimum: each `/features` request's bbox, area, result feature count, and duration; validation rejections (bad bbox, over-cap) at `Warning`; unhandled exceptions at `Error` with full exception detail.
- The request-duration/feature-count/payload-size logging doubles as the data source for the §4 "should we build simplification yet" decision — no separate instrumentation needed, just make sure those fields are actually in the log line from day one.
- Explicitly out of scope for v1: Application Insights / Prometheus / Grafana, distributed tracing, alerting. Add only if/when this stops being a one-person-checking-logs-occasionally operation.

## 9. Testing approach

Per testing-and-tooling.md §2 (backend integration tests: "DB upserts + spatial queries, bbox API responses for a given viewport"; contract tests: "guard the specific properties the frontend depends on").

- **Integration tests** (`Api.Tests/FeaturesEndpointsTests.cs`): use `WebApplicationFactory<Program>` (standard ASP.NET Core integration-test host) configured to point at the containerized PostGIS from the docker-compose stack (testing-and-tooling.md §1's "same compose stack ... integration tests spin up in CI"). Seed a small, fixed fixture dataset directly into `features` (a handful of hand-picked rows: one road with `cyclewayRight=lane`, one path with `bicycle=designated`, one route relation, one feature *outside* the test bbox to prove filtering works) before each test run, then assert on real HTTP responses:
  - Valid bbox containing known fixture features → 200, `FeatureCollection` with exactly the expected features (by `osm_id`).
  - Valid bbox containing nothing → 200, empty `FeatureCollection` (not 404 — see §2).
  - Malformed bbox (wrong arg count, non-numeric, swapped min/max) → 400.
  - Oversized bbox (above the configured cap) → 400.
  - `/health` → 200 when DB reachable.
- **Contract tests** (`Api.Tests/ContractTests.cs`): narrower and more surgical than the general integration tests above — assert specifically on the property *shape* Contract A promises, independent of which features happen to be in the fixture. For each fixture feature type (road, path, route relation), assert the response feature's `properties` contains exactly the keys/value-domains architecture.md §2 lists (e.g. a fixture road with a buffered right lane must round-trip as `cyclewayRight: "lane"`, `cyclewayRightBuffer: "yes"` — not `true`/`1`/absent). The goal: if a persistence schema change or a query refactor accidentally renames, drops, or changes the type of one of these keys, this test fails even if the "does the endpoint return 200 with the right count" integration test above would still pass. This is the test that stands in for "the UI layer's style layers didn't just silently break."
- **Unit tests**: `BboxParser` (parsing/validation logic from §2) is pure and I/O-free — straightforward unit tests for the boundary cases (exactly-4-values, non-numeric, out-of-range, swapped min/max, exactly-at-the-area-cap, just-over-the-area-cap) belong here rather than in the slower integration suite.
- All of the above run against the docker-compose stack in CI, consistent with testing-and-tooling.md §1's "one definition, two uses" (dev stack doubles as the test stack).

## 10. Open questions for Sean

- ~~Migration tooling~~ — **resolved 2026-08-17: EF Core migrations** (see persistence-layer.md §4). This doc's query implementation (§3) still uses Dapper for the actual `/features` *read* query, unaffected by this decision — the API project carries a `DbContext` purely for schema management/migrations, separate from the hand-written Dapper query path. That's a slightly unusual shape (a DbContext that exists for migrations but isn't used for reads) but a deliberate, accepted one now that both are decided independently.
- ~~Does the assumed `properties jsonb` schema (§3) match what the persistence layer actually lands on?~~ — **resolved**: persistence-layer.md §1 landed on dedicated columns + a separate `tags jsonb` passthrough; §3 above has been updated to match. No action needed.
- **GeoJSON `Feature.id` vs. a properties-bag key for `osm_type`/`osm_id`** (§3) — leaning `Feature.id`, needs a decision before implementation since it's part of Contract A's shape and `ui-layer.md` §9 is waiting on it.
- **Clip route geometry to the bbox, or return it whole?** (§3) — reopened during PRD reconciliation (architecture.md §5/§6); no longer treated as resolved. Needs a decision, or an experiment against a real long route, before finalizing the query for `feature_type = 'route'`.
- **Bbox area cap value (§2, ~2 sq degrees suggested)** — a placeholder, not a considered number. Worth a sanity check against the actual planned coverage area (multi-city-expansion.md §7 notes no fixed city list yet) once that's less abstract.
- **Rate limit threshold (§6, ~60 req/min/IP suggested)** — same status, a placeholder pending real traffic patterns.
- **Hosting target** — deferred per testing-and-tooling.md §3; this doc assumes docker-compose only and doesn't assume a specific host, per architecture.md §1's instruction not to.
- **`application/geo+json` vs. `application/json` content type (§2)** — minor, low-stakes; flagging only because it's a one-line decision that's easy to bikeshed later if not settled now. Leaning `application/geo+json` per RFC 7946 but happy to default to `application/json` if that's simpler for the Mapbox GL client side (it doesn't care either way).
