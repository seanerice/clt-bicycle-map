# System architecture: layer plan

Status: Draft for review
Owner: Sean Rice
Last updated: 2026-08-16

Top-level architecture document for the multi-city migration described in [multi-city-expansion.md](./multi-city-expansion.md) (data/serving decisions) and [testing-and-tooling.md](./testing-and-tooling.md) (containerization/testing). Those docs made the high-level calls; this doc organizes the system into layers and links out to a detailed design for each. It doesn't relitigate decisions already made — it assumes them and works out the details.

[prd.md](./prd.md) sits above all of these — it's the product-level description of what the rider gets (features, user journeys, success metrics) that this doc and the four layer docs exist to deliver. §6 below reconciles this doc against it: prd.md was written after the four layer docs, and cross-checking it surfaced a few places where a PRD-level commitment (a Functional Requirement, a Success Metric) changes the priority or framing of something a layer doc had left as "revisit later."

## 1. Layer map

| Layer | Tech stack | Responsibility | Detail doc |
|---|---|---|---|
| UI | Lit + Mapbox GL (`website/`) | Renders the map; fetches bbox-scoped data as the viewport moves; user interaction (search, directions, layer toggles) | [ui-layer.md](./layers/ui-layer.md) |
| API | ASP.NET Core + Npgsql + NetTopologySuite | `GET /features?bbox=...` over PostGIS; the only layer that talks to both the UI and the database | [api-layer.md](./layers/api-layer.md) |
| Application (ingestion) | Python (`scripts/`) | Batch-fetches OSM data from Overpass per `data/cities.json`, transforms tags into rendering properties, loads PostGIS | [application-layer.md](./layers/application-layer.md) |
| Persistence | PostgreSQL + PostGIS | Spatial storage, indexing, schema for the features table | [persistence-layer.md](./layers/persistence-layer.md) |

All four run containerized via docker-compose for local dev and as the deploy unit (testing-and-tooling.md §1). Hosting/deployment target is still deferred (testing-and-tooling.md §3) — these plans shouldn't assume a specific host.

*Terminology note:* "Layer" is overloaded across these docs — this table's "Layer" means a system/deployment tier (UI, API, Application, Persistence). prd.md's Glossary defines "Layer" separately, to mean a togglable map rendering category (bike lanes, cycling paths, bike routes). Both meanings are load-bearing in their own doc and neither is wrong; just don't assume "the UI layer" and "the bike-lanes layer" are the same kind of thing when reading across both documents.

## 2. Cross-layer contracts

These are the seams between layers. A detail doc can go deep on its own layer, but it can't change one of these without the doc on the other side of the seam agreeing — flagging that here so the four layer plans don't drift apart.

**Contract A — UI ↔ API.**
`GET /features?bbox=minLon,minLat,maxLon,maxLat` returns a GeoJSON `FeatureCollection`. Feature properties must keep the shape the frontend's style layers already key off (`website/src/bikemap-app.js`, `website/src/colors.js`):
- Roads: `cyclewayLeft`, `cyclewayRight` (values: `track`, `lane`, `share_busway`, `shared_lane`, `shoulder`, or absent), `cyclewayLeftBuffer`/`cyclewayRightBuffer` (`"yes"` or absent).
- Paths: `bicycle` (`designated` | `yes` | `unknown`), `highwayType: "path"`.
- Route relations: `route: "bicycle"`, `cycle_network`, `ref`, `name`, `state` (frontend filters out `state == "proposed"`).

No renaming or reshaping these without updating the UI layer's style layers in the same change.

**Contract B — Application ↔ Persistence.**
The ingestion loader UPSERTs one row per OSM element keyed on `(osm_type, osm_id)`. This is what makes re-running ingestion, and overlapping city bounding boxes (§4.3 of multi-city-expansion.md), idempotent instead of duplicative. The persistence schema must expose a stable natural key for this; the application layer must not invent its own dedup logic on top.

**Contract C — API ↔ Persistence.**
The API only reads from the features table (`ST_Intersects`/`&&` spatial index range scan). All writes come from the ingestion loader (Contract B). If the API layer ever wants a derived/materialized read path (e.g. pre-simplified geometries per zoom tier), that's a persistence-layer schema concern, not something the API computes ad hoc per request.

## 3. Data flow

```
 Overpass API (OSM)
        │  batch fetch (daily cron / manual dispatch), driven by data/cities.json
        ▼
 Application layer: fetch → transform → UPSERT  ──Contract B──▶  Persistence layer
 (scripts/, Python)                                              (PostgreSQL + PostGIS)
                                                                          │
                                                                  Contract C (read-only)
                                                                          ▼
                                                                    API layer
                                                          (ASP.NET Core + Npgsql + NTS)
                                                              GET /features?bbox=...
                                                                          │
                                                                  Contract A
                                                                          ▼
                                                                    UI layer
                                                    (Lit + Mapbox GL, fetch/update on moveend)
```

## 4. Status of the detail docs

All four detail docs in §1 are drafted. Each was written independently (parallel agents, no cross-visibility during drafting), then reconciled against each other in this pass — two real seams surfaced and were fixed directly in the docs rather than just noted:

- **Schema mismatch (API ↔ Persistence), now fixed.** `api-layer.md` §3 originally assumed a single `properties jsonb` bag for Contract A's rendering properties, drafted before `persistence-layer.md` existed. `persistence-layer.md` §1 independently landed on a hybrid schema — dedicated columns for the exact properties Contract A lists, plus a separate `tags jsonb` column for raw OSM passthrough. `api-layer.md` §3 has been rewritten to query the actual column list rather than a hypothetical JSONB bag. No remaining disagreement — this was a drafting-order gap, not a real conflict.
- **UI open question — originally reopened, now resolved.** `ui-layer.md` §9 asked whether route relations get clipped at the viewport edge. The layer docs originally landed on "no" (`ST_Intersects` without `ST_Intersection` — a route's full geometry returns whenever any part intersects the requested bbox), reasoning that clipping could make `cycling-route-symbols` label placement jump or duplicate across fetches. Revisited during PRD reconciliation (§6): Mapbox GL already clips *rendering* to the visible canvas regardless of whether the fetched geometry extends past it, so the original "line will look chopped up" framing doesn't hold — the real, narrower, untested cost of clipping is label-anchor stability, not line continuity. At that point it was deliberately left open rather than flipped, pending a real spike. That spike ran as story 2.2 and **resolved 2026-08-20: don't clip** — see §5/§6 for the decision and the measured evidence it rests on.
- **Stable feature id, now fully resolved.** `ui-layer.md` asked whether the API exposes a stable per-feature id; `api-layer.md` confirms yes (`osm_type`/`osm_id`, Contract B's own key), leaning toward GeoJSON `Feature.id`. The exact encoding was the one remaining open piece at the time this section was drafted; it's since been **resolved 2026-08-20 (story 2.1): `Feature.id = "{osmType}/{osmId}"`**, not duplicated into `properties` — see §5 below.

One genuinely cross-cutting question remains **not** resolved by this pass — migration tooling — because both docs converged on the same *leaning* (plain SQL files for v1) rather than actually disagreeing, but neither is positioned to make it final: see §5.

### Pre-existing bugs found while grounding these plans in the real pipeline

Not part of the architecture — flagging separately since they're real, currently-shipping issues in `scripts/fetch_data.py` that `application-layer.md` surfaced by reading actual output (`data/export.geojson`), not by reasoning about the design in the abstract:

1. **`transform_relation_feature` (line ~249) silently clobbers `properties.type`.** It spreads `tags` over `properties` after the base spread, and every route relation's OSM tags include `type: "route"` — this overwrites the original `properties.type: "relation"` in the output. Confirmed in the current `data/export.geojson`: route features show `"type": "route"`, not `"relation"`. Doesn't affect today's static-file pipeline (nothing reads `properties.type` downstream), but it matters for Contract B: the ingestion loader needs the real OSM element type to build the `(osm_type, osm_id)` UPSERT key, and can't get it by reading `properties.type` off a transformed relation feature. `application-layer.md` §5 recommends fixing this with an explicit `osmType` field.
2. **`highway_roads` list (`scripts/fetch_data.py` lines 133–134) has a missing comma** between `"tertiary_link"` and `"living_street"` — Python string-literal concatenation silently merges them into one invalid list entry, so `"living_street"` is not actually a member of `highway_roads` today. A `highway=living_street` way currently falls through to `unknown_features` and is dropped from `export.geojson` entirely, rather than being rendered as a road.

**Reconciled against prd.md (§6): both are now blockers, not optional cleanup.** When these were first flagged, the framing was "worth fixing independent of the migration, happy to patch if wanted." prd.md changes that:
- Bug 1 blocks **FR-6 / SM-2** (coverage grows via config change alone). Every route relation currently gets an unusable `osm_type` for Contract B's UPSERT key — the ingestion loader cannot correctly UPSERT a single route relation until this is fixed, which means SM-2 can't be met for the "bike routes" feature at all, for *any* coverage area, not just newly-added ones. Not something to defer past Phase 1 of multi-city-expansion.md §6.
- Bug 2 blocks **FR-1**'s testable consequence ("roads with no bike infrastructure render with no lane overlay" implies roads *with* infrastructure do render) — a `living_street` way with real `cycleway` tags is currently dropped from the map entirely, not just mis-styled. A rider on a `living_street` block (UJ-1) sees nothing where there should be a lane.

Both should be fixed as part of the migration work, not treated as a nice-to-have side patch.

## 5. Open cross-cutting questions

- ~~Migration tooling~~ — **resolved 2026-08-17: EF Core migrations**, per Sean's explicit call — overriding both layer docs' original SQL-files-for-v1 leaning (see persistence-layer.md §4, api-layer.md §10). Phasing consequence: Epic 1 now scaffolds a minimal .NET migrations project early, ahead of Epic 2's full `api/` project, so `dotnet ef` has somewhere to run against multi-city-expansion.md §6 Phase 1's PostGIS-before-API sequencing.
- ~~GeoJSON `Feature.id` encoding for `osm_type`/`osm_id`~~ (api-layer.md §10, ui-layer.md §9) — **resolved 2026-08-20 (story 2.1): `Feature.id = "{osmType}/{osmId}"`**, not duplicated into `properties`. See api-layer.md §3/§10.
- ~~Clip route geometry to the query bbox, or keep returning it whole?~~ (api-layer.md §3, persistence-layer.md §2, ui-layer.md §9) — **resolved 2026-08-20 (story 2.2): don't clip** (`ST_Intersects` only). Settled with a real spike against the largest route relation in the loaded data (Cross Charlotte Trail: 124,978 bytes unclipped vs. 63,601 bytes clipped for a half-extent bbox) rather than a guess — see §6 below and api-layer.md §3 for the full reasoning, weighing that measured payload saving against `cycling-route-symbols`' `symbol-placement: line` label-anchor-stability risk under Epic 3's per-`moveend` refetch pattern.
- API auth: currently none (S3 static file was public; bbox API would be too) — confirmed explicitly in `api-layer.md` §6, carried forward as a deliberate choice, not an oversight.
- **`state = "proposed"` filtering location** (persistence-layer.md §9) — currently a UI-side Mapbox filter (`bikemap-app.js`); persistence/API layers pass `state` through unfiltered. Fine to leave as-is; flagged only because it's a responsibility question, not a performance one.
- **Deleted-OSM-feature handling** (application-layer.md §10, persistence-layer.md §5) — genuinely undecided by design (both docs flag it rather than guess). `persistence-layer.md`'s `last_seen_at` column keeps the door open without committing to building detection now.
- **Payload-size/latency logging** — worth adding opportunistically (api-layer.md §8) so there's real data whenever simplification is revisited; not a launch gate. See §6.
- **Whether "outside configured coverage" needs its own UI treatment**, distinct from "queried but genuinely empty" — surfaced by reconciling against prd.md; see §6.
- None of this changes `mapbox-navigation.js`'s use of Mapbox's own Directions API — routing across our own data stays a non-goal (multi-city-expansion.md §3).

## 6. Reconciliation with the PRD

prd.md was drafted after the four layer docs above, working from the finished architecture rather than shaping it — so this pass checked the PRD's Features/FRs and Success Metrics against what the layer docs actually committed to, the same way §4 checked the four layer docs against each other. Three real gaps surfaced this way (not just documentation drift) and are recorded here rather than only in prd.md, since fixing them is architecture/implementation work, not a product-requirements edit:

- **Simplification stays deferred, per prd.md — not a launch gate.** api-layer.md §4 and persistence-layer.md §3 both frame `ST_Simplify`/`ST_SimplifyPreserveTopology` as "not built in v1... revisit only if it actually bites at real usage levels." prd.md's success metrics deliberately don't set a latency/load-time bar (Sean is tracking that separately, outside this doc), so nothing here overrides that posture — Option A (query-time `ST_SimplifyPreserveTopology`) stays unbuilt-by-default as designed. The one thing worth keeping regardless: api-layer.md §8's payload-size/latency logging is cheap to add now and is the only way to know later *whether* this is worth building — worth doing opportunistically, not because prd.md requires it.
- **Named routes create a real tension between FR-3 and FR-5 — resolved by story 2.2's spike, in FR-3's favor.** FR-3 wants continuous, unbroken route rendering; FR-5 wants payload scoped to the viewport. The originally-recorded "no clipping" answer satisfied FR-3 by always returning a route's full geometry once any part intersects the bbox — which api-layer.md §3 itself flags means "a route far larger than the viewport contributes its full geometry to every intersecting request's payload," directly working against FR-5 for any city-spanning route. Clipping to the query bbox would resolve the tension in FR-5's favor (payload actually stays viewport-scoped) without costing FR-3 anything visually, since Mapbox GL already clips rendering to the canvas regardless — the only real cost is the `cycling-route-symbols` label-stability risk noted above. **Decided 2026-08-20: don't clip.** Measured against the largest route relation currently in the dataset (Cross Charlotte Trail, 5,039 vertices): unclipped payload is 124,978 bytes vs. 63,601 bytes clipped for a bbox covering half its extent — a real ~2x saving, but not so disproportionate as to override the label-anchor risk, which is structurally worse than originally framed once Epic 3's per-`moveend` refetch-and-`setData()` pattern is accounted for (a route's start point and vertex sequence would change on every pan under clipping, not just at a single frame). FR-5's payload-scoping goal for routes is left to `ST_Simplify` (§4/api-layer.md §4) if/when real usage data shows it's needed, rather than to per-request clipping. See api-layer.md §3 for the full writeup.
- **"Seamless" coverage is scoped to configured, proximate Coverage Areas — not a gap-free metro.** application-layer.md §3 clusters cities by proximity (~15–20km) and unions each cluster's bbox for one Overpass query; a Coverage Area with no nearby cluster-mate only ever gets its own bbox ingested. prd.md UJ-4 ("infrastructure loads in for whatever's currently in view... including areas outside the original four") reads as broader than that — a rider panning into genuinely uncovered territory between two distant configured cities will correctly see nothing there, which is expected behavior (prd.md §5 Non-Goals already covers "coverage of areas not present in the configuration") but isn't obviously distinguishable, from the map alone, from a bug. Worth a one-line UI affordance decision (e.g., does the map visually distinguish "no data because nothing's here" from "no data because this area isn't configured yet"?) — flagged as an open question above rather than answered here, since it's a UI/product call, not an architecture one.

Also carried forward from §4's bug reconciliation above: both pre-existing pipeline bugs are now blockers for FR-1 and FR-6/SM-2 respectively, not optional cleanup — see §4.
