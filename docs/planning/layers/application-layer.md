# Application layer: ingestion pipeline

Status: Draft for review
Owner: Sean Rice
Last updated: 2026-08-16

Detail doc for the Application (ingestion) layer named in [../architecture.md](../architecture.md) §1. That doc's §2 defines the contracts this layer must honor; §3 shows where this layer sits in the data flow (Overpass → Application layer → Persistence layer via Contract B). This doc assumes the decisions already made in [../multi-city-expansion.md](../multi-city-expansion.md) (§4.1 PostGIS, §4.3 batch ingestion restructure) and [../testing-and-tooling.md](../testing-and-tooling.md) (§1 containerization, §2 backend testing categories) and works out the implementation details for `scripts/fetch_data.py` and its successors.

## 1. Scope

This layer owns everything between "OSM has the data" and "PostGIS has the data": fetching from Overpass, transforming OSM tags into the rendering properties Contract A depends on, and upserting into the features table. It does not own the schema itself (persistence layer) or how the data gets read back out (API layer). It runs batch, on the existing daily GitHub Actions cadence — no architectural change to *when* it runs, only to *what it reads from* and *where it writes to*.

`scripts/load_neo4j.py` is explicitly out of scope — it's the parked Neo4j experiment referenced in multi-city-expansion.md §2/§4.1, superseded by the PostGIS decision. Nothing in this plan builds on it, and it should not be resurrected as part of this work.

## 2. `data/cities.json` schema

Replaces the four hardcoded `fetch_data_for_area(...)` calls in `fetch_data.py` (lines 93-96). One entry per city/town; adding coverage becomes a PR that edits this file only.

```jsonc
{
  "cities": [
    {
      "name": "Charlotte",
      "state": "NC",
      "osmRelationId": 3600177415,
      "bbox": null
    },
    {
      "name": "Belmont",
      "state": "NC",
      "osmRelationId": 3600179740,
      "bbox": null
    },
    {
      "name": "Cramerton",
      "state": "NC",
      "osmRelationId": 3600176891,
      "bbox": null
    },
    {
      "name": "McAdenville",
      "state": "NC",
      "osmRelationId": 3600179731,
      "bbox": null
    }
  ]
}
```

Rules:
- Exactly one of `osmRelationId` / `bbox` must be set per entry (the other `null` or omitted) — a city is identified either by its OSM admin-boundary relation (used only to *derive* a bbox, per §3 below — never to build an area-scoped Overpass query, that's the seam risk multi-city-expansion.md §2 already identified) or by an explicit bbox for places with no clean OSM relation (e.g. an ad hoc coverage rectangle that isn't a real municipality).
- `bbox`, when present, is `[minLon, minLat, maxLon, maxLat]` (matches the ordering Contract A already uses for `GET /features?bbox=...`, so the same parsing/validation code can plausibly be shared later).
- `name`/`state` are metadata for logging and data-quality reporting (§8), not used in the query itself.
- Keep the four existing cities as the seed data — this is a lossless rename of the current hardcoded list, not a scope change.

### Resolving `osmRelationId` → bbox: cached, not per-run

multi-city-expansion.md §4.3 point 2 prefers bbox-based Overpass queries over admin-polygon queries. That means an entry expressed as `osmRelationId` needs a one-time (or infrequent) resolution step to a concrete bbox, rather than a live area-polygon lookup on every run:

- **Recommendation: resolve once, cache the result, re-resolve rarely.** Add a small resolution step — either a one-off script run manually when a city is added to `cities.json`, or a lazy resolve-and-cache-to-disk step at the start of `fetch_data.py` — that queries Overpass for the relation's bounding box (`area(id:...)->.a; out bb;` or equivalent, a cheap single-relation query, not the full cycling-data query) and writes the resolved bbox back into `data/cities.json` (or a sibling `data/cities.resolved.json`) as `"bbox": [...]`. Once resolved, `bbox` is what the fetch step reads — `osmRelationId` becomes provenance/documentation, not a live lookup.
- **Why not resolve on every run:** re-resolving on every cron invocation adds an extra Overpass round-trip per relation-based city on top of the actual data queries, for a value (a city's administrative boundary) that changes essentially never. It also reintroduces exactly the kind of "one query per city" pattern §4.3 is trying to move away from.
- **Why not require every city to specify an explicit bbox by hand:** relation IDs are what's discoverable from OSM (search Nominatim/OSM for a city, get a relation ID) — forcing a contributor to manually compute a bounding box to add a city is more friction than the config-PR workflow multi-city-expansion.md §3 is going for. Relation ID with one-time server-side resolution keeps the human-facing part of the config easy while still giving the fetch step a plain bbox to work with.
- Practical effect: `fetch_data_for_area`'s replacement never issues an `area(id:...)` Overpass query for the actual cycling-data fetch — only (rarely) for this one-time bbox resolution. This is the mechanism that satisfies §3 below and sidesteps the boundary-gap risk from multi-city-expansion.md §2.

## 3. Overpass query strategy: bbox-based, batched by proximity

### From area to bbox

Overpass QL supports a bbox filter two ways: a per-statement `(south,west,north,east)` filter appended to individual clauses, or a global `[bbox:south,west,north,east]` setting in the query header that applies to every statement without a more specific filter. The current query (`fetch_data.py` lines 12-30) uses `area(id:{area_id})->.searchArea` plus `(area.searchArea)` filters on each clause. The replacement swaps that for a global `[bbox:...]` header — simpler than repeating `(south,west,north,east)` on all six clauses, and functionally equivalent since every clause in the current query applies the same area filter:

```
[out:json][timeout:25][bbox:{south},{west},{north},{east}];
(
    way[~"^cycleway:.*$"~"."];
    way["cycleway"~"."];
    way["highway"="cycleway"];
    way["bicycle"="designated"];
    way["bicycle"="yes"];
    relation["route"="bicycle"];
)->.all;
(
    way["highway"="proposed"];
)->.proposed;
(.all; - .proposed;);
out body;
>;
out skel qt;
```

`fetch_data_for_area(area_id)` becomes something like `fetch_data_for_bbox(bbox)` — the retry/backoff loop (lines 32-90) is untouched; only the `query` string's first two lines change. Rate-limiting behavior is covered in §6.

### Combining cities into a small number of queries

multi-city-expansion.md §4.3 point 2 recommends "a small number of large bounding-box queries" over one-query-per-city, for two reasons: fewer round trips (helps rate limiting) and avoiding the boundary-gap risk. Concretely:

- **Recommendation: cluster cities whose bboxes are within some proximity threshold (e.g. within ~15-20 km of each other, or whose bboxes already overlap/are adjacent) and issue one query per cluster, using the union of the clustered bboxes.** For the current four-city seed set (Charlotte, Belmont, Cramerton, McAdenville — all in the same metro, within a few miles of each other), this collapses to a **single query** covering the union bbox of all four. That's the concrete recommendation for the seed data: one Overpass call instead of four.
- **Why cluster instead of one global query across all configured cities regardless of distance:** if `cities.json` eventually includes a city far from the Charlotte metro (a stated future possibility per multi-city-expansion.md §3 "grow coverage to... eventually other nearby cities"), unioning its bbox with Charlotte's would create one enormous bbox spanning mostly-empty geography between them — Overpass would scan and return data for a huge rectangle to serve two small areas of actual interest, which is worse than two focused queries. Clustering by proximity gets the round-trip savings where cities are genuinely close (where a shared query's overhead is nearly free) without paying for it when they're not.
- **Implementation shape:** a simple greedy clustering (sort cities by bbox center, group any whose bbox — expanded by a small margin — intersects or is within the distance threshold of another in the same group, take the union bbox of each group) is sufficient; this doesn't need anything more sophisticated than that for a handful of cities. Revisit only if `cities.json` grows large enough that even clustering produces many groups.
- Each cluster becomes one `fetch_data_for_bbox(union_bbox)` call. `fetch_data()`'s job changes from "call `fetch_data_for_area` four times by name" (current lines 93-96, hardcoded) to "read `cities.json`, resolve bboxes (§2), cluster, call `fetch_data_for_bbox` once per cluster, combine `elements` arrays" — structurally the same combine-then-return shape as today (lines 98-108), just with a data-driven loop instead of four named calls.

### Union bbox growing the query beyond a city's own boundary

Using a bbox instead of an admin polygon means each city's query area is now its rectangular bounding box, not its actual (often irregular) boundary — this necessarily includes some area outside the city limits (and, per the clustering above, a modest amount of area between nearby cities too). That's an accepted trade-off, not an oversight: it's exactly what fixes the boundary-gap risk in multi-city-expansion.md §2 (a way that crosses a city line is no longer subject to "which polygon does this belong to" ambiguity — bboxes overlapping is fine, see §4), and the extra coverage is strictly additive data, not a correctness problem. It does mean the fetch is no longer scoped to "exactly Charlotte" — flagged here so it's a known, intentional shift, not a silent one.

## 4. Boundary/dedup handling

Bbox queries — whether from adjacent-city clustering (§3) or just genuinely overlapping cities — can return the same OSM way/relation more than once in a single run, unlike the old admin-polygon-per-city queries where (leaving aside the boundary-gap risk) each element nominally belonged to one area's result.

**Recommendation: dedup in-memory before transform, not left solely to the UPSERT.** Concretely, in `fetch_data()` (or the function that replaces it), dedup `combined_elements` by `(type, id)` before handing the list to `json2geojson`/`transform_data` — a simple dict keyed on `(element["type"], element["id"])`, last-write-wins (or first-write-wins; the payload for a given OSM element is identical regardless of which cluster query returned it, so it doesn't matter which copy survives).

Reasoning:
- The UPSERT (§5) *would* handle it correctly either way — that's the whole point of Contract B's `(osm_type, osm_id)` key, and it's not being second-guessed here as the source of truth for idempotency across *runs*.
- But deduping in-memory within a single run avoids doing 2x (or more, for overlap-heavy clusters) redundant transform work and UPSERT statements for the same element, and keeps `transform_data`'s printed counts (lines 285-286: `relation features:`, `way features:`) meaningful as a per-run sanity signal instead of inflated by duplicates — relevant to the data-quality checks in §8.
- It's also cheap and local: a dict keyed on `(type, id)` over a few thousand elements, no I/O, no new dependency.

This in-memory dedup is a convenience/efficiency measure, not a substitute for the UPSERT's idempotency guarantee — the UPSERT still must be correct on its own for the cross-run case (a way present in yesterday's run and today's run, or two separate CI runs racing) since in-memory dedup only ever sees one run's data.

## 5. Transform stage: unchanged, plus one extraction

`transform_road_feature`, `transform_path_feature`, `transform_relation_feature`, and their dispatcher `transform_way_feature`/`transform_data` (`fetch_data.py` lines 156-292) are pure functions — no I/O, no network, no dependency on how the input was fetched (area vs. bbox) or how the output will be persisted (file vs. DB). They carry forward essentially unchanged. This is also exactly the code multi-city-expansion.md and testing-and-tooling.md flag as currently untested and highest-value to cover first (§8).

### The one thing that does need attention: `osm_type`/`osm_id` extraction for the UPSERT key

Contract B requires the loader to UPSERT keyed on `(osm_type, osm_id)`. Reading the actual transform output (confirmed against `data/export.geojson`) surfaces a real collision the loader needs to work around, not just a formality:

- For a **way** feature, `feature["properties"]["type"]` is `"way"` and `feature["properties"]["id"]` is the OSM way id (e.g. `16662875`) — and this survives transform untouched, because way tags don't contain a `type` key. So `properties.type` / `properties.id` are directly usable as `osm_type`/`osm_id` for ways.
- For a **relation** (route) feature, the *original* `properties.type` is `"relation"` — but `transform_relation_feature` (lines 243-252) spreads `feature["properties"]["tags"]` over `feature["properties"]` in building `new_feature`, and every route relation's tags include `"type": "route"` (that's the OSM convention this repo's own Overpass query relies on — `relation["route"="bicycle"]` implies `tags.type == "route"`, also asserted at line 244). Tag spread happens *after* the base properties spread, so **the tag's `"type": "route"` silently overwrites the original `"type": "relation"`** in the final output. Confirmed in the current `data/export.geojson`: route features show `"type": "route"`, not `"relation"`. `properties.id` is unaffected (no route relation tag is named `id`) and correctly holds the relation id.

Net effect: `properties.type` cannot be trusted as `osm_type` for relations once it's gone through `transform_relation_feature`. The loader needs the real OSM element type captured **before** this overwrite, not read back out of the transformed output. Two ways to do this, either is fine:
1. Capture `osm_type = feature["properties"]["type"]` and `osm_id = feature["properties"]["id"]` in the loader/orchestration step immediately after `json2geojson` and before calling `transform_data`, carrying them alongside (not merged into) each feature through the transform call — e.g. the loader zips the pre-transform `(osm_type, osm_id)` pairs with the post-transform feature list by index, since `transform_data` doesn't reorder or drop elements other than the `unknown_features` bucket (lines 263-286) which are excluded from the returned `FeatureCollection` already.
2. Or, small surgical change to `transform_relation_feature`: explicitly set `new_feature["properties"]["osmType"] = "relation"` (a name that doesn't collide with the `type` tag) before/after the properties spread, so the field survives under a name the tag data can't clobber. This is the cleaner long-term fix but does touch `transform_relation_feature`'s output shape, so it should be called out to whoever owns Contract A/the persistence schema as a (minor, additive) property addition, not a breaking rename.

**Recommendation: option 2** — add an explicit, tag-collision-proof field (`osmType`, distinct from the pass-through `type` tag value) inside `transform_relation_feature`, and for symmetry add the same to `transform_road_feature`/`transform_path_feature` (where it happens to already be safe, but making it explicit removes the "is `properties.type` reliable here" question entirely for the loader). This is a small, additive, well-scoped change to otherwise-unchanged functions, and it's much less error-prone for the loader than reconstructing type/id pairs by parallel-list bookkeeping across the transform call boundary. Either way, this needs a unit test specifically asserting `osm_type`/`osm_id`-equivalent fields survive `transform_relation_feature` correctly (§8) — this is exactly the kind of silent-collision bug that only shows up by reading actual output, as it did here.

No other structural change to the transform stage. `transform_data`'s existing `print("relation features: ...")` / `print("way features: ...")` logging is worth keeping (or upgrading into the data-quality check in §8) as-is.

## 6. Loader design

Replaces `write_data()` (lines 110-118), which currently just `json.dumps`s the transformed `FeatureCollection` to `../data/export.geojson`.

### DB access

Python → PostGIS via [`psycopg`](https://www.psycopg.org/psycopg3/) (psycopg3), the standard modern choice. Geometry handling: the transform stage's output geometries are GeoJSON-shaped dicts (from `osm2geojson`/Shapely under the hood) — convert to WKB/EWKB for the insert using `shapely.geometry.shape(feature["geometry"]).wkb_hex` (the repo already depends on `shapely` per `scripts/requirements.txt`) and let PostGIS's `ST_GeomFromWKB(%s, 4326)` (or `ST_GeomFromEWKB`) do the conversion server-side, rather than pulling in a heavier ORM/geometry-adapter layer. This keeps the new dependency footprint to `psycopg[binary]` on top of what's already installed.

### Batch UPSERT strategy

One statement shape, executed in batches (`psycopg`'s `executemany`/`execute_batch`, or building a single multi-row `INSERT` per batch for fewer round trips):

```sql
INSERT INTO features (osm_type, osm_id, feature_type, geom, properties)
VALUES (%s, %s, %s, ST_GeomFromWKB(%s, 4326), %s)
ON CONFLICT (osm_type, osm_id)
DO UPDATE SET
    feature_type = EXCLUDED.feature_type,
    geom = EXCLUDED.geom,
    properties = EXCLUDED.properties,
    updated_at = now();
```

(Column names illustrative — the persistence layer owns the actual schema; this shows the query shape the loader needs the schema to support, which is the thing to reconcile with `persistence-layer.md`.) Batch size: a few hundred to a thousand rows per `executemany` call is a reasonable starting point for ~5-6k features (today's total feature count, per `data/export.geojson`) — no need to tune this until real volume is known.

### Transaction scope

**Recommendation: whole run in one transaction.** Open the connection/transaction once at the start of the loader, execute all batched UPSERTs within it, commit once at the end (or roll back entirely on any error). Reasoning:
- The failure mode to avoid is a partially-applied run — e.g. Charlotte's cluster loads fine, but the process crashes or Overpass times out mid-way through a second cluster, leaving PostGIS with new Charlotte data but stale-or-partial data for the rest. A single transaction means a failed run leaves PostGIS exactly as it was before the run started (last night's good data), which is a safe, well-understood failure mode — "today's cron failed, we'll get it tomorrow" — rather than a half-updated dataset serving live traffic through the API layer in between.
- The dataset size (thousands of rows, not millions) makes one long-lived transaction practical — this isn't a scale where transaction duration/lock contention is a real concern yet.
- Trade-off being accepted: no partial credit for a run that fetches Charlotte fine but fails on a later cluster — everything-or-nothing. Given the daily cadence and that this isn't in any request's critical path (§2 of multi-city-expansion.md already ruled out JIT ingestion for that reason), that's the right trade for now. Revisit only if per-cluster partial success becomes something Sean actually wants (e.g. per-cluster transactions with a summary of which clusters succeeded) — flagged as a possible future refinement, not needed for v1.

### Deletions (features removed from OSM since the last run)

Open question — flagged explicitly rather than assumed either way. UPSERT alone only ever adds/updates rows; it never removes a row for a way that OSM no longer shows (torn out bike lane, relation retagged, etc.). Two options:
1. **Leave it out of scope for now** — matches the "don't build what isn't needed yet" posture elsewhere in these docs (e.g. multi-city-expansion.md explicitly deferring routing, live sync). Stale rows for genuinely-removed infrastructure would accumulate slowly and silently.
2. **Detect and delete**: track which `(osm_type, osm_id)` pairs were seen in a given run (already computed for the UPSERT batch) and, at the end of the run, delete any row in the features table whose city/bbox falls within the run's query coverage but whose key wasn't in this run's result set. This is a "diff against what should still be there" pass, not a full-table wipe — has to be scoped to the run's actual query coverage or it would incorrectly delete data belonging to cities not touched in that run (relevant once clustering means not every run necessarily touches every city, if partial/incremental runs are ever introduced).

No recommendation here — see §9. This is squarely a "needs Sean's call" item since it trades off implementation effort now against silently-stale data later, and the right answer may depend on how often OSM data for this area actually gets torn out in practice (probably rare, but unverified).

## 7. Retry/rate-limit behavior

The existing exponential backoff in `fetch_data_for_area` (soon `fetch_data_for_bbox`) — 5 attempts, doubling backoff capped at 60s, explicit 429/504 handling with `Retry-After` header support (`fetch_data.py` lines 32-90) — is already solid and carries forward unchanged; this plan doesn't redesign it, per the task brief.

**Does bbox-based querying change the rate-limiting risk profile? Yes, it should reduce it, and the reasoning holds up:** multi-city-expansion.md §2 already documented that the current *area*-based approach hits Overpass rate limits at just 4 sequential queries (`data/overpass_area_*_resp.txt` are captured `rate_limited`/`timeout` error responses from exactly this). The bbox+clustering strategy in §3 reduces the seed-city case from 4 sequential Overpass calls to 1, which directly reduces request volume against the same public instance — fewer round trips is the mechanism, and it's the same mechanism multi-city-expansion.md §4.3 point 2 cites as the reason to prefer this approach. This isn't a new claim, just confirming the existing recommendation's stated reasoning checks out against the actual number of calls each approach makes (4 → 1 for today's data, growing sub-linearly with clustering as more cities are added, vs. linearly with one-query-per-city). The retry logic remains necessary regardless — Overpass is a shared public resource and can rate-limit any client regardless of query count — but the steady-state load this pipeline places on it goes down.

## 8. Orchestration change

### `osm-refresh.yml`

Current last two steps (`.github/workflows/osm-refresh.yml` lines 42-52): run `fetch_data.py`, then `aws s3 sync . s3://bikemap/` from `./data`. New shape:
- `Run fetch_data.py` step stays (renamed/adjusted if the entry-point script is renamed, e.g. if `fetch_data.py` is split into fetch/transform/load modules — a reasonable refactor given the new loader responsibility, but not required by this plan).
- `Upload to s3 bikemap container` step is **removed** — there is no longer a static file to sync; PostGIS is read live by the API layer (Contract C).
- New final step: **run the loader against the DB** — the script connects to PostGIS using connection details from GitHub Actions secrets/environment (analogous to how `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are wired today via the `bikemap-staging` environment) — e.g. `DATABASE_URL` or discrete `PG*` env vars pointing at wherever PostGIS is hosted (deferred per testing-and-tooling.md §3, but the workflow step itself doesn't need that decision made yet — just an env var name).
- Optionally, a data-quality-check step (§9) runs after the loader step and fails the workflow (non-zero exit) if checks don't pass — surfacing ingestion problems as a red CI run instead of silent bad data reaching the API/frontend.

### Local dev

Per testing-and-tooling.md §1, the same pipeline runs locally against the docker-compose PostGIS instance: `docker compose up -d postgis` (or whatever service name the compose file uses, owned by persistence-layer.md), then `python fetch_data.py` (or its renamed successor) with `DATABASE_URL`/`PG*` env vars pointed at the compose-exposed Postgres port (typically `localhost:5432` with compose's default port mapping). This is the same script, same env-var-driven connection config, as CI — no special-cased local path — which is the local-dev-parity goal testing-and-tooling.md §1 states explicitly.

## 9. Testing approach

Mapping testing-and-tooling.md §2's four backend categories onto this pipeline specifically:

### Unit tests (transform functions — pure, no I/O, currently zero coverage)

Realistic cases given the actual tag logic in `fetch_data.py`:
- `transform_road_feature`: `cycleway:left`/`cycleway:right` set independently → both `cyclewayLeft`/`cyclewayRight` populated correctly and independently; `cycleway:both` set → both sides inherit its value; bare `cycleway` (no `:left`/`:right`/`:both`) → both sides fall back to it (current precedence: `:right`/`:left` specific value, then `:both`, then bare `cycleway` — lines 199-208); no cycleway tags at all → both `cyclewayLeft`/`cyclewayRight` keys absent from output (lines 232-235 explicitly delete them, not just leave falsy); buffer detection (`hasCyclewayBufferValue`, lines 179-192) — `"yes"` → `True`; `"no"`/`"0"`/`None` → `False`; a distance-with-unit string like `"1.5 m"` → `True` (positive numeric); a `"0 m"` or malformed string → `False`; confirm the regex-based numeric parsing doesn't throw on tags with no unit suffix (e.g. bare `"2"`).
- `transform_path_feature`: `highway=cycleway` → `bicycle: "designated"` regardless of a `bicycle` tag's own value; `bicycle=designated` (highway not cycleway) → `"designated"`; `bicycle=yes` alone → `"yes"`; neither → `"unknown"`; confirm `highwayType: "path"` is always set.
- `transform_relation_feature`: a route relation with `tags.type == "route"` → passes through with tags spread over properties; **specifically assert the `osm_type`/`osmType` extraction from §5 survives correctly** — this is the collision found while reading the current output and is exactly the kind of case a unit test should pin down so it can't regress.
- `transform_way_feature`/dispatcher: a `highway` value in `highway_roads` routes to `transform_road_feature`; a value in `highway_paths` routes to `transform_path_feature`; a `highway` value in neither list, or a way with no `tags` at all, → `None`/filtered out (matches current `unknown_features` bucketing, lines 254-261, 268-280). Also worth a regression test for the existing bug at line 133-134 (`"tertiary_link"` and `"living_street"` are concatenated into one string with no comma, so `"living_street"` is currently *not* actually in `highway_roads` as its own entry) — flagged here as a pre-existing bug found while reading the file, not something to silently fix as a side effect of this doc, but worth a test that documents current behavior either way and lets Sean decide whether to fix it.

### Integration tests (against containerized PostGIS, per testing-and-tooling.md §1)

- Loader UPSERT inserts a new `(osm_type, osm_id)` correctly (geometry, properties round-trip intact).
- Re-running the loader with the same input is idempotent — same row count after two runs of identical data (this is Contract B's core guarantee, worth a direct test rather than just trusting the SQL).
- Re-running with a changed property (e.g. a way's `cycleway` tag changed between runs) updates the existing row in place rather than duplicating it.
- Two overlapping-bbox clusters both containing the same OSM element, fed through the loader, result in exactly one row (validates §4's in-memory dedup *and* the UPSERT's own idempotency as a belt-and-suspenders check).
- Spatial query sanity: after loading, a basic `ST_Intersects`/bbox range query against the loaded data returns the expected features (this also doubles as an early smoke test for whatever the persistence-layer schema/index design lands on).

### Data-quality checks (post-ingestion validation, a distinct step from code-correctness tests)

Concrete, run as a script step after the loader in `osm-refresh.yml` (§8) — not part of the pytest suite, since these check *this run's data*, not the code:
- **Feature-count sanity per city**: after loading, query PostGIS for a rough feature count within each configured city's bbox and compare against a sane floor (e.g. "not zero," or "not less than X% of last run's count for this city") — catches an Overpass query silently returning empty/truncated results for one city without failing the whole run.
- **Geometry validity**: `ST_IsValid(geom)` over newly-touched rows — catches malformed geometries from `osm2geojson`/Shapely conversion before they reach the API layer.
- **Duplicate OSM id check**: a `GROUP BY (osm_type, osm_id) HAVING COUNT(*) > 1` query against the features table should always return zero rows given the UPSERT's unique constraint — this is really a constraint-enforcement smoke test (if it ever returns rows, the UPSERT/schema contract itself is broken, which is a bigger problem than data quality), but cheap enough to run every time as a tripwire.
- Where this runs: a small standalone script (e.g. `scripts/check_data_quality.py`) invoked as its own GitHub Actions step after the loader, exiting non-zero (failing the workflow) if any check fails. Keeping it a separate step (not folded into the loader itself) makes it independently runnable locally and keeps "load the data" and "validate the data" as distinct, individually-debuggable failures in CI logs.

### Contract tests (guarding Contract A's property shape)

Contract A (architecture.md §2) lists the exact properties the frontend keys off: `cyclewayLeft`/`cyclewayRight` (enumerated values), `cyclewayLeftBuffer`/`cyclewayRightBuffer`, `bicycle`, `highwayType`, `route`/`cycle_network`/`ref`/`name`/`state`. A contract test suite asserts, for representative synthetic OSM input, that `transform_data`'s output features contain exactly these properties with values from the documented enumerations — e.g. `cyclewayLeft` is always one of `track`/`lane`/`share_busway`/`shared_lane`/`shoulder` or the key is absent, never some other raw OSM tag value the frontend doesn't have style logic for. This overlaps with the unit tests in intent but is worth keeping as its own named suite (rather than folded into "unit tests") specifically because its job is to fail loudly if a transform change would silently break the UI layer — the property shape is the thing that must never drift without a coordinated change to `website/src/bikemap-app.js`, `website/src/colors.js`, and this doc together.

## 10. Open questions for Sean

- **Persistence-layer natural key (Contract B dependency)**: this doc assumes the features table has a unique constraint on `(osm_type, osm_id)` (or two separate columns forming a composite key) that the `ON CONFLICT` clause in §6 can target. Flagging explicitly for `persistence-layer.md` to confirm/own — this doc does not invent an alternate dedup scheme per Contract B's instruction, but the persistence schema needs to actually expose this key for the SQL in §6 to work as written.
- **Deleted/removed OSM features (§6)**: does a bike lane OSM shows as removed need to be deleted from PostGIS, or is stale-row accumulation acceptable for now? No recommendation made — genuinely undecided, and the right answer may hinge on how often this actually happens in practice (unverified). If "delete" is the answer, it also needs a decision on scope-of-deletion (only within the run's query coverage, to avoid deleting untouched cities' data — see §6 option 2).
- **`osm_type` extraction approach (§5)**: recommended the additive `osmType` field inside `transform_relation_feature` (and, for symmetry, the road/path transforms) over parallel-list bookkeeping in the loader. This is a small change to a function this doc otherwise says should carry forward unchanged — flagging for explicit sign-off since "unchanged" was the brief, and this is a deliberate, narrow exception to it.
- **Splitting `fetch_data.py`**: this doc doesn't mandate splitting the single script into fetch/transform/load modules, but the loader is a genuinely new responsibility (network + DB I/O) being added alongside fetch (network I/O) and transform (pure). Worth a lightweight decision on whether to keep it one file (matches today's structure, simplest diff) or split for testability (unit tests in §9 want to import transform functions without pulling in `psycopg`/DB connection code at import time) — leaning toward splitting, but calling it out rather than assuming.
- **Cluster-distance threshold (§3)**: proposed "~15-20 km or adjacent/overlapping bboxes" as a starting heuristic for clustering cities into shared Overpass queries. This is a reasonable default, not a researched number — fine to tune once `cities.json` actually has more than the current four (all mutually close) entries to test against.
