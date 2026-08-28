# Application layer: ingestion pipeline

Status: Draft for review
Owner: Sean Rice
Last updated: 2026-08-28

Detail doc for the Application (ingestion) layer named in [../architecture.md](../architecture.md) §1. That doc's §2 defines the contracts this layer must honor (this layer owns the write side of **Contract B — Application ↔ Persistence**); §3 shows where this layer sits in the data flow (Geofabrik extract → clip → `osm2pgsql` raw schema → **this layer** → `features` via Contract B). This doc is the detail under [../multi-city-expansion.md](../multi-city-expansion.md) §4.3 ("Ingestion: keep batch, drop Overpass, build from a regional OSM extract") — that section's 7-step list is the shape; this works out the implementation. It also assumes [../multi-city-expansion.md](../multi-city-expansion.md) §4.1 (PostGIS) and [../testing-and-tooling.md](../testing-and-tooling.md) §1 (containerization) / §2 (backend testing categories).

**This is a top-to-bottom rework** (2026-08-28) reflecting the Epic 4 pivot: no Overpass anywhere in the automated pipeline. The prior version of this doc detailed a `fetch_data.py` refactor around bbox-scoped Overpass queries and proximity clustering — that approach is retired (see multi-city-expansion.md §4.3 for the why: the public Overpass instance rate-limits this project at ~4 sequential queries, and self-hosting Overpass is more stateful operational surface, not less). The transform stage and the psycopg loader design survive; everything upstream of them is replaced.

## 1. Scope

This layer owns everything between "OSM has the data" and "PostGIS has the data" — now in six stages:

1. **Acquire** — download and cache the Geofabrik North Carolina `.osm.pbf` regional extract.
2. **Clip** — `osmium extract --strategy=smart` from the NC extract to each configured area's AOI (bbox or boundary polygon).
3. **Load raw** — `osm2pgsql` (flex/Lua config) loads the clips into a dedicated, `osm2pgsql`-owned `osm_raw` schema, dropped and reloaded every run.
4. **Ingestion SQL** — a query against `osm_raw` that reproduces exactly what the old Overpass QL query selected (the six clauses, minus `highway=proposed`), emitting element type, OSM id, full tag set, and geometry.
5. **Transform** — feed those rows through the existing pure `transform_*` functions via a thin adapter, with the one already-planned `osmType`-extraction fix.
6. **Load `features`** — batch UPSERT into `features` keyed on `(osm_type, osm_id)`, whole run in one transaction.

It does not own the schema itself (persistence layer), how the data is read back out (API layer), or the `osm_raw` schema's shape (that follows `osm2pgsql` and the Lua config — architecture.md §3 places it explicitly *outside* Contracts B/C).

`scripts/load_neo4j.py` is out of scope — the parked Neo4j experiment (multi-city-expansion.md §2/§4.1), superseded by PostGIS. Nothing here builds on it.

## 2. `data/cities.json` schema

Replaces the four hardcoded `fetch_data_for_area(...)` calls in `fetch_data.py` (lines 93-96). One entry per Coverage Area; adding coverage becomes a PR that edits this file (plus, for a relation-based entry, a committed boundary polygon — see below).

```jsonc
{
  "cities": [
    { "name": "Charlotte",   "state": "NC", "osmRelationId": 3600177415, "bbox": null },
    { "name": "Belmont",     "state": "NC", "osmRelationId": 3600179740, "bbox": null },
    { "name": "Cramerton",   "state": "NC", "osmRelationId": 3600176891, "bbox": null },
    { "name": "McAdenville",  "state": "NC", "osmRelationId": 3600179731, "bbox": null }
  ]
}
```

Rules (unchanged from the prior version except where noted):
- Exactly one of `osmRelationId` / `bbox` per entry (the other `null` or omitted).
- `bbox`, when present, is `[minLon, minLat, maxLon, maxLat]` — matches Contract A's `GET /features?bbox=...` ordering, so parsing/validation can plausibly be shared.
- `name`/`state` are metadata for logging and data-quality reporting (§9), not consumed by the clip step.
- Keep the four existing cities as seed data — a lossless rename of the current hardcoded list.

### What an entry now *means*: an AOI clip boundary, not a query target

Under the old plan, `osmRelationId` could only be used to *derive a bbox* — never the admin polygon directly — because an Overpass `area(id:)` query scoped to an admin-boundary relation made boundary-hugging ways ambiguous (the seam risk in multi-city-expansion.md §2). **That constraint is gone.** There is no area query anymore; there is a file clip. A polygon clip is now fine and in fact *preferred* — it produces a tighter AOI with less redundant coverage of neighboring geography — and `--strategy=smart` (§3.2) still keeps route/multipolygon members that cross the clip line, so continuity (FR-3) doesn't depend on the clip being rectangular.

**Decision: an `osmRelationId` entry resolves to a GeoJSON boundary polygon file, not a bbox.**

- Resolution produces `data/aoi/<osmRelationId>.geojson` — a `(Multi)Polygon` of the admin boundary — **derived locally from the already-downloaded NC extract** (`osmium getid --recursive` to pull the boundary relation and its members, then assemble the multipolygon; a ~30-line script). The clip step (§3.2) runs `osmium extract --polygon data/aoi/<id>.geojson`.
- A `bbox` entry needs no resolution — the clip step runs `osmium extract --bbox minLon,minLat,maxLon,maxLat` directly. `bbox` stays valid for ad-hoc coverage rectangles that aren't a real municipality.
- **"Resolve once, cache" is preserved.** The `.geojson` is regenerated only when an entry is added or a `--force` flag is passed — an admin boundary changes essentially never. Unlike the old plan, resolution now involves *zero* third-party calls: it reads the same local `.pbf` the pipeline already has.

**Rejected:**
- *Resolve to a bbox instead of a polygon* — loses the tighter clip for no benefit now that the Overpass seam risk that motivated "bbox only" is gone.
- *Live polygon lookup per run from a service like `polygons.openstreetmap.fr` or Nominatim* — reintroduces exactly the third-party runtime dependency (and the per-city round-trip pattern) the pivot exists to remove.
- *Require every entry to hand-specify a bbox* — relation IDs are what's discoverable from OSM (search Nominatim, get an ID); forcing a contributor to compute a bounding box by hand is more friction than the config-PR workflow (multi-city-expansion.md §3) is going for.

Open sub-question for §10: commit `data/aoi/*.geojson` to the repo, or treat it as a gitignored build cache.

## 3. Acquire, clip, load raw, ingestion SQL

Replaces the prior version's "Overpass query strategy: bbox-based, batched by proximity" section wholesale.

### 3.1 Acquire the regional extract

- **Source.** Geofabrik North Carolina `.osm.pbf` (`https://download.geofabrik.de/north-america/us/north-carolina-latest.osm.pbf`, ~300 MB) plus its companion `.osm.pbf.md5`. A plain HTTPS file off a CDN — no query quota, no rate limit, no per-query flakiness.
- **Cache.** Store the extract in a stable location (`data/osm-cache/north-carolina-latest.osm.pbf`, gitignored) keyed by the day. In CI, back this with `actions/cache` keyed on the date so a same-day re-run (PR push, manual dispatch) reuses it instead of re-downloading. Locally, it persists in the cache dir (or a compose volume) between runs.
- **Refresh cadence.** Full re-download on the daily cron is the v1 approach — simplest, statelessly correct, cheap at this size. Keeping the local copy current with Geofabrik's daily `.osc.gz` diffs (`pyosmium-up-to-date`) is a fine optimization *if* the download ever becomes a nuisance, but it adds a stateful "is my local copy at the right sequence number" concern — deliberately not v1 (§10).
- **Integrity.** After download, verify the file against the `.md5`, and apply a size floor sanity check (a ~2 KB body is a CDN error page, not an extract). Resilience on failure is §7.

### 3.2 Clip to each AOI

For each `data/cities.json` entry, run `osmium extract --strategy=smart` against the NC extract, bounded by the entry's polygon (`--polygon data/aoi/<id>.geojson`) or bbox (`--bbox ...`).

- **`--strategy=smart` is required, not default.** It keeps the member ways and nodes of route relations and multipolygons even when they cross the clip boundary. Without it, a `route=bicycle` relation whose ways extend past the AOI edge is silently truncated at that edge — a direct FR-3 regression (a route rendered as a broken line at a Coverage Area boundary is the City Boundary Seam the whole migration exists to prevent).
- **Overlapping AOIs are fine and expected.** Adjacent Coverage Areas should have overlapping clips on purpose — a way running along a shared city line is then physically present in both clips, and the duplicate collapses on the `(osm_type, osm_id)` natural key (§4). The seam question becomes "clip generously, overlap deliberately, dedup on the natural key" rather than "did the query include this way."
- **Failure mode to watch — the outer edge.** `--strategy=smart` handles boundary-*crossing* members, but at the outermost edge of the outermost AOI there is no neighboring clip to overlap with. A route that leaves the outermost AOI entirely still ends there. This is inherent to bounded coverage (prd.md §5 Non-Goals; architecture.md §6 third bullet) and not a bug — flagged so it's a known limitation, not a surprise.

### 3.3 Load the clips into the raw schema

`osm2pgsql` with a **flex (Lua) config** loads the clips into a dedicated `osm_raw` schema in the same PostGIS instance as `features`.

- **Merge first, load once.** `osmium merge` the per-AOI clips into a single deduplicated `.osm.pbf` (it de-duplicates objects by `(type, id)`, last-wins), then run one `osm2pgsql` load against that. This keeps `osm_raw` dupe-free by construction and avoids relying on `osm2pgsql`'s append semantics (which are designed for diff updates, not clean multi-extract loads) — see §4.
- **Flex config selects, it does not transform.** The Lua config keeps only objects carrying a cycling-relevant tag (any `cycleway*` key, `highway=cycleway`, `bicycle` in `{designated,yes}`, or `route=bicycle` on a relation) and shapes them into a small number of tables — e.g. `osm_raw.ways(osm_id bigint, tags jsonb, geom geometry(LineString,4326))` and `osm_raw.route_relations(osm_id bigint, tags jsonb, geom geometry(MultiLineString,4326))`. It emits the **full tag bag as `jsonb`** (or `hstore`) — no per-tag columns — and does **no** rendering-property derivation. All of that stays in Python (§5). Rationale for flex over the legacy C-transform output is §10.
- **`osm_raw` is `osm2pgsql`-owned and drop-and-reloaded every run.** It is explicitly **not** managed by the EF Core migrations that own `features` (architecture.md §3). The two schemas never contend for ownership of the same tables. Blowing `osm_raw` away and reloading it never disturbs `features` history (`first_seen_at` / `last_seen_at`).
- **Relation geometry assembly ("way-walking").** `osm2pgsql` stitches a `route=bicycle` relation's member ways into a `(Multi)LineString` from its local node/way cache during the load. This is the **same single-level assembly** `osm2geojson` does today from the Overpass payload — just more robust, because with `--strategy=smart` every member way is physically present in the clip, so there are no gaps from a query response that happened to omit a skeleton element. **Nested relations / `route_master` super-relations are not handled today and are not handled after this pivot** — today's Overpass query uses single `>` recursion (not `>>`), and `transform_relation_feature` hard-gates on `tags.type == "route"`, which rejects `route_master`. The pivot neither regresses nor fixes this; nested-route support stays explicit future work. Two things here must be **verified by an early spike, not assumed** — see §9 and §10.

### 3.4 Ingestion SQL

A single query against `osm_raw` reproduces exactly what the old Overpass QL query (`fetch_data.py` lines 12-30) selected. The six positive clauses, `UNION`ed, minus the `highway=proposed` exclusion:

| Overpass clause | `osm_raw` predicate |
|---|---|
| `way[~"^cycleway:.*$"~"."]` | a `tags` key matching `^cycleway:` with a non-empty value |
| `way["cycleway"~"."]` | `tags ? 'cycleway' AND tags->>'cycleway' <> ''` |
| `way["highway"="cycleway"]` | `tags->>'highway' = 'cycleway'` |
| `way["bicycle"="designated"]` | `tags->>'bicycle' = 'designated'` |
| `way["bicycle"="yes"]` | `tags->>'bicycle' = 'yes'` |
| `relation["route"="bicycle"]` | `tags->>'route' = 'bicycle'` (from `osm_raw.route_relations`) |
| MINUS `way["highway"="proposed"]` | `AND coalesce(tags->>'highway','') <> 'proposed'` |

```sql
WITH selected AS (
    SELECT 'way'::text AS osm_type, osm_id, tags, geom
    FROM osm_raw.ways
    WHERE ( tags ? 'cycleway'
         OR tags->>'highway' = 'cycleway'
         OR tags->>'bicycle' IN ('designated', 'yes')
         OR EXISTS (SELECT 1 FROM jsonb_object_keys(tags) k
                    WHERE k LIKE 'cycleway:%' AND tags->>k <> '') )
      AND coalesce(tags->>'highway', '') <> 'proposed'
    UNION
    SELECT 'relation'::text AS osm_type, osm_id, tags, geom
    FROM osm_raw.route_relations
    WHERE tags->>'route' = 'bicycle'
)
SELECT DISTINCT ON (osm_type, osm_id)
       osm_type, osm_id, tags, ST_AsEWKB(geom) AS geom_ewkb
FROM selected
ORDER BY osm_type, osm_id;
```

- **`UNION` (not `UNION ALL`) / `DISTINCT ON`** collapses a way that matches more than one clause (e.g. both `cycleway:left` and bare `cycleway`) to one row — this dedup is needed regardless of clip overlap, and doubles as a second layer over §4.
- **Geometry out as EWKB** via `ST_AsEWKB(geom)` — see §6 for why (the pure transforms never touch geometry, so there is no reason to serialize it to GeoJSON and re-parse it).
- The output row shape — element type, OSM id, full tag set, geometry — is exactly what the adapter (§5) needs to build a transform-input feature dict. This SQL is a **testable artifact** (§9): given a seeded `osm_raw`, it must select the right elements and exclude `highway=proposed`.
- Tag filtering is split deliberately: the flex config does *coarse* selection at load time (keeps `osm_raw` small); this SQL does the *exact* six-clause reproduction (kept in SQL, adjacent to Python, unit-testable — not in Lua).

### 3.5 What's gone: proximity clustering

The prior version's proximity clustering — cluster-distance threshold, greedy grouping of nearby cities, union-bbox-per-cluster, "4 Overpass calls collapse to 1" — is **obsolete**. There are no per-area queries to batch. `epics.md` / `stories.md` carried decision items for the cluster-distance threshold (stories 4.2, 4.10); those are void (see §10 and the epic-rework notes at the end of this doc's companion report).

## 4. Overlap / dedup handling

Duplicates now arise from **overlapping AOI clips**: the same OSM element inside two clips → two entries in the merged input → potentially two `osm_raw` rows → the ingestion SQL could emit it twice. Three places to handle it:

1. **At raw load** — `osmium merge` the clips into one deduplicated `.osm.pbf` before `osm2pgsql` (it de-duplicates by `(type, id)`). One load, no dupes in `osm_raw`.
2. **In the ingestion SQL** — `DISTINCT ON (osm_type, osm_id)` (already present in §3.4 for the multi-clause-match case).
3. **The `(osm_type, osm_id)` UPSERT** — the cross-run idempotency guarantee (Contract B), correct on its own regardless.

**Recommendation: do (1), and get (2) for free.** Merge-first keeps `osm_raw` dupe-free by construction; the SQL's `DISTINCT ON` is already there for multi-clause matches and covers clip overlap as a cheap second layer. The UPSERT (§6) remains the source of truth for idempotency *across* runs (yesterday's run and today's; two CI runs racing) — merge-first and `DISTINCT ON` only ever see one run's data.

**Rejected:**
- *`osm2pgsql` multi-file append (`--append`) without merging first* — append semantics are built for applying diffs, not for cleanly loading several overlapping extracts; risk of inconsistent geometry assembly across appends. Merge-first is more predictable and is the model `osm2pgsql` docs recommend for combining extracts.
- *Rely solely on the UPSERT* — wastes 2× (or more, for overlap-heavy AOIs) transform and load work on the same element, and inflates the per-run feature counts the data-quality checks (§9) read as a sanity signal. Same reasoning the prior version gave for its in-memory dedup.

This does **not** introduce a new dedup key — `(osm_type, osm_id)` is Contract B's key and the only one used at every layer.

## 5. Transform stage: unchanged, plus an adapter and one extraction

`transform_road_feature`, `transform_path_feature`, `transform_relation_feature`, and their dispatcher `transform_way_feature` / `transform_data` (`fetch_data.py` lines 156-292) are pure functions — no I/O, no network, no dependency on how the input was fetched or where the output goes. They carry forward essentially unchanged. This is the code multi-city-expansion.md and testing-and-tooling.md flag as currently untested and highest-value to cover first (§9).

### 5.1 The adapter (replaces `json2geojson`)

Today the entry point is `json2geojson(fetch_data(), filter_used_refs=True)` → `transform_data(...)`. Post-pivot, a thin **adapter** maps each ingestion-SQL row into the feature dict shape the transforms expect:

```python
{
    "type": "Feature",
    "properties": {
        "tags": <dict from the row's jsonb tags>,
        "type": "way" | "relation",   # from the row's osm_type column
        "id":   <int from the row's osm_id column>,
    },
    "geometry": <the row's geometry, carried opaquely — see §6>,
}
```

`transform_data` dispatches on `feature["properties"]["type"]` (`"way"` → `transform_way_feature`, `"relation"` → `transform_relation_feature`). The adapter sets that field **directly from the `osm_raw` element-type column** — reliable in a way the Overpass path never fully was (no skeleton-element ambiguity). `osm2geojson` is no longer called; whether it stays a dependency at all depends on whether anything else imports it (nothing in the transforms does) — likely removable, confirm during the module split.

### 5.2 The `osmType` extraction fix (Epic 4 bug-fix, carried forward)

`transform_relation_feature` (lines 245-254) spreads `feature["properties"]["tags"]` over `feature["properties"]` *after* the base spread. Every route relation's tags include `type: "route"` (the convention `relation["route"="bicycle"]` relies on, asserted at line 246), so **the tag's `"type": "route"` silently overwrites the original `"type": "relation"`** in the output. Confirmed in the current `data/export.geojson`: route features show `"type": "route"`, not `"relation"`. `properties.id` is unaffected.

The loader (§6) UPSERTs keyed on `(osm_type, osm_id)` (Contract B). It must get the real OSM element type from something the tag spread can't clobber.

**Fix (settled — architecture.md §4, epics.md story 4.4): add an explicit `osmType` field inside all three transform functions.** `transform_relation_feature` sets `properties.osmType = "relation"`; `transform_road_feature` / `transform_path_feature` set `properties.osmType = "way"` (already safe there, but making it explicit removes the "is `properties.type` reliable here" question for the loader entirely). This is the field the loader keys on.

Note: post-pivot the adapter *also* sets `properties.type` reliably from the `osm_raw` column, so in principle the loader could read that. Keep the explicit `osmType` field anyway — it's the transform stage's contract with the loader, independent of how the input was built, and it's what the loader and the contract tests (§9) pin down. The prior version's "capture type/id before the clobber, zip pre- and post-transform lists by index" mechanic is dropped — no parallel-list bookkeeping needed.

No other structural change to the transform stage. `transform_data`'s `print("relation features: ...")` / `print("way features: ...")` counts are worth keeping (or folding into the data-quality check in §9).

Two pre-existing bugs found by reading the real code stay in scope (architecture.md §4 makes both blockers, not optional cleanup):
- **`highway_roads` missing comma** (lines 135-136): `"tertiary_link"` and `"living_street"` are string-concatenated into one invalid entry, so `highway=living_street` ways fall through to `unknown_features` and are dropped. One-character fix; blocks FR-1.
- The `osmType` clobber above; blocks FR-6/SM-2 for every route relation.

## 6. Loader design

Replaces `write_data()` (lines 111-120), which currently `json.dumps`s the transformed `FeatureCollection` to `../data/export.geojson`.

### 6.1 DB access

Python → PostGIS via [`psycopg`](https://www.psycopg.org/psycopg3/) (psycopg3). New dependency footprint: `psycopg[binary]` only.

### 6.2 Geometry handling

The prior version round-tripped geometry through Shapely: transform output geometry (a GeoJSON dict) → `shapely.geometry.shape(...).wkb_hex` → `ST_GeomFromWKB(%s, 4326)`.

Post-pivot, geometry **originates as a PostGIS `geom`** in `osm_raw`. The pure transforms never inspect or modify geometry (verified: `transform_*` only spread `**feature` and mutate `properties`). So:

**Recommendation: the ingestion SQL emits `ST_AsEWKB(geom)`; the loader passes those bytes straight into the UPSERT** as a bound parameter to `ST_GeomFromEWKB(%s)` (or `ST_GeomFromWKB(%s, 4326)` for plain WKB). The geometry is carried opaquely through the adapter and transforms as `feature["geometry"]` (the transforms' `**feature` spread copies it untouched) and never parsed in Python. This drops the Shapely `shape()` + `wkb_hex` step — and likely `shapely` from the loader's dependencies entirely (confirm during the split; keep it only if a geometry fix-up path is wanted, though `ST_MakeValid` in SQL is the better place for that).

Alternative kept on the table: emit `ST_AsGeoJSON(geom)` instead, matching persistence-layer.md §5's illustrative `ST_GeomFromGeoJSON(%(geometry_json)s)` UPSERT and keeping geometry human-readable mid-pipeline (useful if a data-quality check or log wants to see it). Minor divergence either way — see §10 and reconcile with persistence-layer.md.

### 6.3 Batch UPSERT

One statement shape, executed in batches (`psycopg`'s `executemany` / a multi-row `INSERT` per batch). Reconciled against persistence-layer.md §1.1/§5's actual schema (the prior version's illustrative `properties`/`updated_at` columns don't exist — it's a hybrid of dedicated columns + a `tags jsonb` bag, and the bookkeeping column is `last_seen_at`):

```sql
INSERT INTO features (
    osm_type, osm_id, feature_type, geom,
    cycleway_left, cycleway_right, cycleway_left_buffer, cycleway_right_buffer,
    bicycle,
    route, cycle_network, ref, name, state,
    tags
) VALUES (
    %(osm_type)s, %(osm_id)s, %(feature_type)s, ST_GeomFromEWKB(%(geom_ewkb)s),
    %(cycleway_left)s, %(cycleway_right)s, %(cycleway_left_buffer)s, %(cycleway_right_buffer)s,
    %(bicycle)s,
    %(route)s, %(cycle_network)s, %(ref)s, %(name)s, %(state)s,
    %(tags)s
)
ON CONFLICT (osm_type, osm_id) DO UPDATE SET
    feature_type          = EXCLUDED.feature_type,
    geom                  = EXCLUDED.geom,
    cycleway_left         = EXCLUDED.cycleway_left,
    cycleway_right        = EXCLUDED.cycleway_right,
    cycleway_left_buffer  = EXCLUDED.cycleway_left_buffer,
    cycleway_right_buffer = EXCLUDED.cycleway_right_buffer,
    bicycle               = EXCLUDED.bicycle,
    route                 = EXCLUDED.route,
    cycle_network         = EXCLUDED.cycle_network,
    ref                   = EXCLUDED.ref,
    name                  = EXCLUDED.name,
    state                 = EXCLUDED.state,
    tags                  = EXCLUDED.tags,
    last_seen_at          = now();
```

The loader maps transform output → this column set:
- `osm_type` / `osm_id` from the transforms' `osmType` field (§5.2) and `properties.id`.
- `feature_type` (the Postgres enum `road` / `path` / `route`, persistence-layer.md §1.1) derived from which transform produced the row: `transform_road_feature` → `road`, `transform_path_feature` → `path`, `transform_relation_feature` → `route`. This classification has no OSM-native equivalent — it's the `transform_way_feature` dispatch result.
- `cycleway_left_buffer` / `cycleway_right_buffer` are `BOOLEAN NOT NULL` in the schema; the transform emits `cyclewayLeftBuffer: "yes"` or the key absent → map to `true` / `false`.
- `highwayType` from the pipeline is **not** stored (persistence-layer.md §1.2 — redundant with `feature_type = 'path'`).
- The full raw tag dict goes into `tags` as well, unfiltered (persistence-layer.md §1.2's hybrid — dedicated columns *and* the raw bag).

`first_seen_at` is deliberately not in the `DO UPDATE SET` list — it keeps its original insert-time value across re-ingestion. Batch size: a few hundred to a thousand rows per call is reasonable for today's ~5-6k features; no need to tune until real volume is known.

### 6.4 Transaction scope

**Whole run in one transaction.** Open the connection/transaction once, run all batched UPSERTs (and, if §10's deletion decision goes that way, the delete pass) within it, commit once at the end or roll back entirely on any error.

- The failure mode to avoid is a partially-applied run — one AOI's data fresh, the rest stale/partial, served live through the API in between. A single transaction means a failed run leaves `features` exactly as it was before the run started ("today's cron failed, we'll get it tomorrow") — a safe, well-understood failure mode.
- Thousands of rows, not millions — one long-lived transaction is practical; lock contention isn't a real concern at this scale yet.
- Trade-off accepted: no partial credit. Given the daily cadence and that ingestion isn't in any request's critical path, that's the right trade for v1. Revisit only if per-AOI partial success becomes something Sean wants.

### 6.5 Deletions (features removed from OSM since the last run)

UPSERT alone never removes a row for a way OSM no longer shows (torn-out lane, retagged relation).

**The pivot makes detect-and-delete materially more tractable.** A full regional extract, clipped to every configured AOI every run, gives an **authoritative per-run picture** of everything currently in OSM across the covered areas. The prior version's core objection — "an Overpass query might have returned empty or truncated results, so a missing element doesn't reliably mean 'deleted'" — largely falls away: a Geofabrik extract is complete and static, not a rate-limited query result. After a successful whole-run load, any `features` row whose `(osm_type, osm_id)` lies within the union of this run's AOIs but was not in this run's result set is a genuine removal candidate.

Still **Sean's call for v1** — it trades implementation effort now against slowly accumulating stale rows. persistence-layer.md §5's `last_seen_at` already keeps the door open without committing to the logic. If "detect and delete" is chosen, scope the delete to the run's actual AOI coverage (a full-extract run touches every configured AOI, so in the common case that's "all configured AOIs" — the scoping only matters if partial runs are ever introduced). Cross-refs: prd.md §8 Q3, architecture.md §5, persistence-layer.md §5. See §10.

## 7. Acquire-step resilience (replaces the Overpass retry/rate-limit loop)

The old `fetch_data_for_area` exponential-backoff loop — 5 attempts, doubling backoff capped at 60s, explicit 429/504 handling with `Retry-After` support (`fetch_data.py` lines 32-90) — is **retired**. It existed to survive a rate-limited shared query service. There is no such service in the pipeline anymore.

What replaces it is much simpler, and applies only to the acquire step (§3.1):

- **HTTP retry on the `.pbf` download** — a few attempts with a modest fixed or linearly growing delay, for transient CDN/network errors only. No 429/`Retry-After` semantics — Geofabrik serves a static file, it doesn't rate-limit.
- **Integrity check** — verify the downloaded file against Geofabrik's companion `.osm.pbf.md5`; apply a size floor (a few-KB body is an error page).
- **Fall back to the cached previous `.pbf`.** If every retry fails, or the checksum doesn't match, **proceed with the last successfully cached extract** and log loudly that the data may be up to ~24h (or more) stale. Only hard-fail the run if there is no cached copy at all (first-ever run). "Proceed on yesterday's copy" is the whole point of building from a static file (multi-city-expansion.md §4.3).
- **`osmium` / `osm2pgsql` steps get no retry logic** — they're local, deterministic, CPU/IO-bound. A failure there (bad flex config, corrupt `.pbf`, disk full) is a real bug and should fail the run visibly, not be retried.

## 8. Orchestration change

### `osm-refresh.yml`

Current last two steps (`.github/workflows/osm-refresh.yml` lines 42-52): run `fetch_data.py`, then `aws s3 sync . s3://bikemap/`. Both go away. New shape:

1. **Setup Python + install `scripts/requirements.txt`** — as today.
2. **Install `osmium-tool` and `osm2pgsql`** — apt packages on `ubuntu-latest` (or a prebuilt image that carries them).
3. **Acquire** — download/refresh the Geofabrik NC `.osm.pbf` + `.md5`, verify (§3.1/§7). Back it with `actions/cache` keyed on the date.
4. **Clip** — `osmium extract --strategy=smart` per `data/cities.json` AOI (§3.2).
5. **Load raw** — `osmium merge` the clips → one `.pbf` → `osm2pgsql` (flex config) into `osm_raw`, drop-and-reload (§3.3).
6. **Ingest** — run the ingestion SQL + adapter + transforms + batch UPSERT into `features`, one transaction (§3.4–§6). DB connection from workflow secrets/environment (`DATABASE_URL` or discrete `PG*` vars).
7. **Data-quality check** — `scripts/check_data_quality.py` (Epic 6 owns the script; this is the workflow seam), immediately after the loader, failing the workflow on a bad run (§9).

- The `aws s3 sync` step and its `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are removed — there is no static file to publish; the API reads `features` live (Contract C).
- There are **no upstream credentials** anymore — no Overpass key, no third-party API secret. Just a public download URL and a DB connection string. The `bikemap-staging` environment still supplies the DB connection secrets (analogous to how it supplied the AWS keys).

### Local dev

Same pipeline, same env-var-driven DB config as CI — no special-cased local path (testing-and-tooling.md §1 parity goal):

```
docker compose up -d db                       # persistence-layer.md §6 service
dotnet ef database update                     # from db/Migrations — features schema
python -m scripts.pipeline.acquire            # or the orchestrator entry point
python -m scripts.pipeline.clip_load_raw
python -m scripts.pipeline.ingest             # DATABASE_URL / PG* pointed at localhost:5432
```

The `.pbf` is cached in a gitignored `data/osm-cache/` dir (or a compose volume) so local iteration doesn't re-download 300 MB. Because `osm_raw` is drop-and-reload and the ingestion SQL + transforms run against already-downloaded raw data, iterating on transform logic or feature shape is a re-run of the `ingest` step only — no re-acquire, no re-clip.

## 9. Testing approach

Mapping testing-and-tooling.md §2's backend categories onto the pivoted pipeline.

### Unit tests — pure transform functions (top-value item, unchanged)

Still the highest-value gap to close, and independent of everything upstream. Cases follow the actual tag logic in `fetch_data.py`:
- `transform_road_feature`: `cycleway:left`/`:right` set independently → both sides populated independently; `cycleway:both` → both inherit; bare `cycleway` → both fall back (precedence: specific side, then `:both`, then bare — lines 201-210); no cycleway tags → both keys absent (lines 234-237 delete them). `hasCyclewayBufferValue` (lines 181-194): `"yes"` → `True`; `"no"`/`"0"`/`None` → `False`; `"1.5 m"` → `True`; `"0 m"`/malformed → `False`; bare `"2"` doesn't throw.
- `transform_path_feature`: `highway=cycleway` → `bicycle: "designated"` regardless of a `bicycle` tag; `bicycle=designated` → `"designated"`; `bicycle=yes` alone → `"yes"`; neither → `"unknown"`; `highwayType: "path"` always set.
- `transform_relation_feature`: route relation with `tags.type == "route"` → **assert `properties.osmType == "relation"` survives** (the §5.2 collision — the case that must never silently regress); `properties.id` unaffected.
- `transform_way_feature` dispatcher: `highway` in `highway_roads` → road; in `highway_paths` → path; in neither, or no `tags` → `None` / `unknown_features` (lines 256-263). Regression test for the `highway_roads` missing-comma bug: `highway=living_street` with real `cycleway` tags → routes to `transform_road_feature`, not dropped.

### Ingestion SQL (new — now a testable artifact)

Seed a small `osm_raw` (a handful of ways + relations with known tags, including one `highway=proposed`, one way matching two clauses at once, one `route=bicycle` relation, one way with a `cycleway:left` key only). Run the §3.4 query. Assert the emitted `(osm_type, osm_id)` set is exactly the expected one, `highway=proposed` is excluded, and the multi-clause way appears once. Runs against the containerized `db`.

### Flex config / `osm2pgsql` load (new — spike, then regression test)

**Spike first (do not assume — see §3.3, §10):**
- (a) `route=bicycle` relations land in `osm_raw` with assembled `(Multi)LineString` geometry under the chosen flex config (not dropped, not emitted as bare member refs).
- (b) `osmium extract --strategy=smart` retains route-relation member ways that cross the clip boundary.

Then a **regression test**: a tiny checked-in fixture `.osm.pbf` (a few hand-built elements including a 2-member `route=bicycle` relation straddling a clip line), run through the real clip + `osm2pgsql` path, asserting geometry assembly and boundary-member retention. Insurance against a future flex-config or `osmium` change silently dropping route geometry.

### Adapter (new)

Given a raw row as `psycopg` returns it, assert the emitted dict has exactly the `{properties: {tags, type, id}, geometry}` shape the transforms consume; `tags` round-trips from `jsonb`; `type` is `"way"` / `"relation"` from the raw element-type column; geometry is carried through opaquely (§6.2).

### Integration tests (against containerized PostGIS)

- Loader UPSERT inserts a new `(osm_type, osm_id)` correctly (geometry + all mapped columns + `tags` round-trip intact).
- Re-running the loader with identical input is idempotent — same row count, `first_seen_at` stable, `last_seen_at` advances (Contract B's core guarantee).
- Re-running with a changed tag updates the row in place, no duplicate.
- **The same OSM element present in two overlapping AOI clips**, fed through the loader, results in exactly one row (validates §4 *and* the UPSERT's own idempotency).
- Spatial sanity: after loading, a bbox `ST_Intersects` query returns the expected features (also an early smoke test for the persistence-layer index design).

### Data-quality checks (post-ingestion, a distinct `osm-refresh.yml` step)

Run as a script step after the loader, failing the workflow on a bad run. Reworded for the pivot:
- **A clip produced zero features for a configured AOI** — after load, count `features` within each AOI and compare to a floor ("not zero", "not less than X% of last run for this area"). Catches a broken clip / a bad AOI polygon, not "an Overpass query silently returned empty."
- **The extract is stale** — the cached `.pbf` is older than N days, or older than the current Geofabrik-published timestamp by more than a threshold (the §7 fallback proceeded on an old copy and nothing recovered since).
- **Geometry validity** — `ST_IsValid(geom)` over newly-touched rows.
- **Duplicate `(osm_type, osm_id)` tripwire** — `GROUP BY (osm_type, osm_id) HAVING count(*) > 1` should always be empty given the unique constraint; cheap to run as a constraint-enforcement canary.

Build-out is `scripts/check_data_quality.py` (Epic 6 owns it — see epics.md); this doc only specifies the checks and that it's a separate, independently-runnable step from the loader.

### Contract tests (guarding Contract A's property shape)

Unchanged. For representative synthetic OSM input covering road / path / route, assert `transform_data`'s output features contain exactly the properties Contract A (architecture.md §2) lists — `cyclewayLeft`/`cyclewayRight` (values `track`/`lane`/`share_busway`/`shared_lane`/`shoulder` or absent), `cyclewayLeftBuffer`/`cyclewayRightBuffer`, `bicycle`, `highwayType`, `route`/`cycle_network`/`ref`/`name`/`state` — with values from the documented enumerations, never a raw OSM tag value the frontend has no style logic for. Its job is to fail loudly if a transform change would silently break `website/src/bikemap-app.js` / `website/src/colors.js`. Kept as its own named suite.

## 10. Open questions for Sean

- **`osm2pgsql` flex (Lua) vs. the legacy C-transform output.** *Recommendation: flex.* Load-time tag filtering keeps `osm_raw` small; flex lets us define exactly the minimal table shapes we want (`ways` / `route_relations`, `tags` as `jsonb`, geometry per object) instead of `osm2pgsql`'s default rendering-oriented schema. Cost: the Lua config is harder to unit-test than Python. Mitigation, and the design rule this doc follows: **keep all transform logic in Python** — flex only *selects and minimally shapes*, it derives no rendering properties. Confirm this split.
- **`osmium` clip input: relation boundary polygon vs. hand-drawn bbox per AOI.** *Recommendation: derive a GeoJSON boundary polygon locally from the NC extract, cached at `data/aoi/<osmRelationId>.geojson` (§2); `bbox` still allowed for ad-hoc rectangles.* Sub-question: **commit the derived `data/aoi/*.geojson` to the repo** (small, changes rarely, a boundary-polygon diff is a meaningful review signal when someone bumps coverage) **or treat it as a gitignored build cache** (smaller repo; a fresh checkout must re-derive before its first clip). Leaning commit.
- **Extract refresh cadence: full nightly re-download vs. `.osc.gz` diffs (`pyosmium-up-to-date`).** *Recommendation: full re-download for v1* — simplest, statelessly correct, ~300 MB off a CDN is cheap. Diffs add a stateful "local copy at the right sequence number" concern; adopt only if the download becomes a nuisance (multi-city-expansion.md §4.3 already frames it as optional).
- **Raw schema lifecycle.** *Recommendation: `osmium merge` all clips → one deduplicated `.osm.pbf` → one `osm2pgsql` load into a single `osm_raw` schema, drop-and-reload (`osm2pgsql`'s native model).* Confirm: (a) drop-and-reload vs. truncate-and-reload (truncate matters only if something holds an FK into `osm_raw` or `osm2pgsql` permissions make DROP awkward — neither expected); (b) one schema fed by all clips (recommended) vs. a schema/prefix per AOI (more moving parts, no benefit given merge-first dedup).
- **Geometry format out of the ingestion SQL: `ST_AsEWKB` vs. `ST_AsGeoJSON` (§6.2).** *Recommendation: EWKB* — the pure transforms never touch geometry, so the Shapely round-trip is pure overhead. This is a minor divergence from persistence-layer.md §5's illustrative `ST_GeomFromGeoJSON` UPSERT — flag for that doc to reconcile (both are one-line changes; no schema impact).
- **Deleted-OSM-feature handling (§6.5).** The pivot moves this from "hard to know what was removed" to "buildable" — a full regional extract is an authoritative per-run picture. *Recommendation: still defer detect-and-delete for v1* (matches the "don't build what isn't needed yet" posture), but get explicit sign-off rather than defaulting silently, and if "build it" is the answer, confirm the scope-of-deletion rule (run's AOI coverage). Cross-refs: prd.md §8 Q3, architecture.md §5, persistence-layer.md §5.
- **Module split — now clearly *yes*.** The prior version left "split `fetch_data.py`?" genuinely open. The pivot makes it obvious: three stages with genuinely different dependency footprints —
  - `acquire` — HTTP download + checksum; no DB, no `osmium`, no `psycopg`.
  - `clip_load_raw` — shells out to `osmium` / `osm2pgsql`; no `psycopg`, no transform imports.
  - `ingest` — `psycopg` + the adapter + the pure transforms; no `osmium`.
  *Recommended boundaries:* a `scripts/pipeline/` package with `acquire.py`, `clip_load_raw.py`, `adapter.py`, `ingest.py`, and **`transform.py` holding the pure `transform_*` functions with zero heavy imports** (the concrete testability driver — unit tests import it without pulling in `psycopg` or `osmium`). A thin `scripts/pipeline/__main__.py` (or the workflow itself) sequences the stages. `scripts/fetch_data.py` is deleted. Confirm the package layout / names.
