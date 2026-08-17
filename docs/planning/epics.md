---
title: CLT Bicycle Map — Epics
created: 2026-08-17
updated: 2026-08-17
---

# Epics: multi-city migration

Status: Draft for review
Owner: Sean Rice

Translates [prd.md](./prd.md) (Functional Requirements, Success Metrics) and [architecture.md](./architecture.md) (layer plan, cross-layer contracts) — plus the four detail docs it links to — into a sequenced set of epics. Doesn't relitigate any decision already made in those docs; where a decision is still open, the epic that needs it links back to where it's discussed rather than deciding it here.

Terms follow prd.md's Glossary (§3) verbatim — Coverage Area, Viewport, City Boundary Seam, Layer (the rendering-category sense, not the system-tier sense architecture.md §1 uses).

## 1. Sequencing

```
Epic 1: Persistence foundations (PostGIS + schema, containerized)
        │
        ├──────────────┬─────────────────────┐
        ▼              ▼                     ▼
Epic 2: Bbox API   Epic 4: Ingestion refactor │
        │              (config-driven,        │
        ▼               bbox-based)           │
Epic 3: Frontend       │                      │
viewport fetching      │                      │
        │              │                      │
        └──────┬────────┘                     │
               ▼                              │
   Epic 5: Add a Coverage Area end-to-end ◀────┘
   (validates FR-6/SM-2 for real)

Epic 6 (observability/hardening) and Epic 7 (test infra) are cross-cutting —
each lands in small pieces alongside 1-5, not as a separate phase.
```

Epics 2+3 (serve + render the *existing* 4-city data live) and Epic 4 (refactor how data gets *into* PostGIS) are logically independent once Epic 1's schema exists — both only need Epic 1. The recommended order still does 2→3 before 4, per multi-city-expansion.md §6: proving "no seams, lazy load" against known-good data isolates that mechanic from ingestion changes, so a bug found later is obviously on one side or the other. Parallelizing 2/3 and 4 across two workstreams is reasonable if you want the throughput; just know that Epic 5 (the real end-to-end validation) can't start until both sides are done.

## 2. Epics

### Epic 1 — Persistence foundations: containerized PostGIS + schema

**Goal:** Stand up PostgreSQL + PostGIS via docker-compose, implement the `features` table, and prove the schema against real data with a one-off loader that ingests the *existing* `data/export.geojson` — before touching the live pipeline or building the API.

**Realizes:** No FR directly (infrastructure only) — unblocks FR-5, FR-6.

**Scope:**
- `docker-compose.yml` `db` service (pinned `postgis/postgis` image, named volume) — [persistence-layer.md §6](./layers/persistence-layer.md#6-containerization).
- `features` table, indexes, constraints as specified in [persistence-layer.md §1-§2](./layers/persistence-layer.md#1-schema-design).
- Migration tooling stood up (see decision below) and the schema above expressed as its first migration.
- A throwaway/one-off loader script that reads today's `data/export.geojson` and UPSERTs it into the new schema — this is a validation tool, not the real ingestion loader (that's Epic 4), and can be deleted once Epic 4 lands.
- Integration tests per [persistence-layer.md §8](./layers/persistence-layer.md#8-testing-approach-persistence-layer): idempotent UPSERT, bbox query correctness, constraint rejection (invalid geometry, duplicate key).

**Decisions to close before/during this epic:**
- ~~**Migration tooling**~~ — **resolved 2026-08-17: EF Core**, per Sean's explicit call, overriding both layer docs' original SQL-files-for-v1 leaning. [architecture.md §5](./architecture.md#5-open-cross-cutting-questions), [persistence-layer.md §4](./layers/persistence-layer.md#4-migration-tooling). Consequence: this epic now needs to scaffold a minimal .NET migrations project early (just enough to host `dotnet ef`), ahead of Epic 2's full `api/` project.
- ~~`feature_type` as `TEXT + CHECK` vs. Postgres `ENUM`~~ — **resolved: ENUM**. `feature_type` is a real classification with no OSM-native equivalent, driving downstream branching in both the API and frontend — not informational passthrough. [persistence-layer.md §9](./layers/persistence-layer.md#9-open-questions-for-sean).
- ~~Surrogate `BIGSERIAL` PK vs. compound `(osm_type, osm_id)` PK~~ — **resolved: surrogate**, "first-class ids, old ids as reference." Same section.

**Dependencies:** None — this is the starting point.

---

### Epic 2 — Bbox API

**Goal:** Build the `GET /features?bbox=...` ASP.NET Core service (Contract A/C) reading from the schema Epic 1 produced, loaded via Epic 1's one-off loader against today's 4-city data.

**Realizes:** Groundwork for FR-5; the response shape it locks in also gates FR-3 (route continuity) and FR-1 (property fidelity).

**Scope:** Per [api-layer.md](./layers/api-layer.md) in full — minimal API project layout (§1), `bbox` validation + area cap (§2), the `&&`/`ST_Intersects` query (§3), CORS (§5), no-auth-but-rate-limited posture (§6), Docker/compose service (§7), health check + structured logging (§8), integration/contract/unit tests (§9).

**Decisions to close:**
- **GeoJSON `Feature.id` encoding** for `osm_type`/`osm_id` — leaning `Feature.id`. Small, not blocking, but the UI layer (Epic 3) is waiting on the answer. [api-layer.md §10](./layers/api-layer.md#10-open-questions-for-sean), [prd.md §8.1](./prd.md#8-open-questions).
- **Clip route geometry to the query bbox, or return it whole?** The real open one — trades payload size against untested `cycling-route-symbols` label-anchor stability. Needs a decision, or a quick experiment against a real long route, before the route query is finalized. This directly affects FR-3's "continuous, no seam" consequence and FR-5's "payload scales with viewport" consequence — worth resolving with an actual spike rather than a guess, since the two FRs pull in opposite directions here. [architecture.md §6](./architecture.md#6-reconciliation-with-the-prd), [api-layer.md §3](./layers/api-layer.md#3-query-implementation).
- Bbox area cap value (~2 sq degrees placeholder) and rate-limit threshold (~60 req/min/IP placeholder) — fine to ship as placeholders, flagged for later tuning once real usage exists.
- `application/geo+json` vs `application/json` content type — low-stakes, pick one.

**Dependencies:** Epic 1 (schema + data loaded).

---

### Epic 3 — Frontend viewport-based fetching

**Goal:** Replace the static S3 `geojson` source with a source created empty and kept in sync via `setData()` on `moveend`, fetching from Epic 2's API.

**Realizes:** FR-5 (viewport-scoped loading), and is the change that makes SM-1 (no City Boundary Seam on pan/zoom) checkable for the first time — against the existing 4 Coverage Areas.

**Scope:** Per [ui-layer.md](./layers/ui-layer.md) in full — `moveend`-triggered fetch with debounce + `AbortController` (§2), no client-side region caching (Option B, §3 — refetch padded viewport each time), loading/error states (§4), no changes needed to the five style layers or `layer-widget.js`/`location-search-menu.js`/`mapbox-navigation.js` (§5, §7 — verify this via regression tests rather than assume it), Playwright coverage (§8).

**Decisions to close:**
- **Send a `zoom` hint alongside `bbox` from day one**, even before the API acts on it — recommended yes, needs API-layer agreement so Contract A's shape is settled once, not twice. [ui-layer.md §6](./layers/ui-layer.md#6-zoom-dependent-payload-size), [§9.2](./layers/ui-layer.md#9-open-questions-for-sean).
- Padding factor (~25-50%) and debounce interval (~200ms) — placeholders, fine to ship and tune later.
- `API_BASE_URL` config mechanism — needs an answer before implementation; likely resolved alongside whatever Epic 2's deployment story ends up being (deployment itself is out of scope for these epics — see §3 below).

**Definition of done includes:** explicit regression pass on FR-4 (layer toggles), FR-7 (search), FR-8 (directions) — none of these should need code changes, but ui-layer.md §8 calls out verifying that, not assuming it, especially the new `moveend`↔navigation coupling.

**Dependencies:** Epic 2 (a live API to point at).

---

### Epic 4 — Ingestion pipeline refactor: config-driven, bbox-based

**Goal:** Replace the four hardcoded `fetch_data_for_area()` calls with `data/cities.json`, switch Overpass queries from admin-polygon to bbox+proximity-clustering, and replace `write_data()` with a real UPSERT loader into PostGIS. Update `osm-refresh.yml` to stop syncing to S3 and instead run the loader (and a data-quality check) against the database.

**Realizes:** FR-6 (coverage grows via config change alone), SM-2, and — via the two bug fixes below — restores FR-1 and FR-3's testable consequences to actually holding.

**Scope:** Per [application-layer.md](./layers/application-layer.md) in full — `data/cities.json` schema + relation→bbox resolution (§2), bbox Overpass query + proximity clustering (§3), in-memory dedup across overlapping cluster queries (§4), transform stage (§5, unchanged except the fix below), loader (psycopg3, batch UPSERT, whole-run transaction, §6), retry/backoff (§7, unchanged), workflow changes (§8), unit/integration/data-quality/contract tests (§9).

**Must-fix, blocking (per [architecture.md §4](./architecture.md#4-status-of-the-detail-docs), not optional cleanup):**
1. **`transform_relation_feature` clobbers `properties.type`.** Every route relation's OSM tags include `type: "route"`, silently overwriting the original `"relation"` value the loader needs for Contract B's `(osm_type, osm_id)` UPSERT key. Fix: add an explicit `osmType` field (recommended in [application-layer.md §5](./layers/application-layer.md#5-transform-stage-unchanged-plus-one-extraction), option 2) to all three transform functions, not just the broken one, for symmetry. Blocks FR-6/SM-2 for *every* bike route, not just newly-added Coverage Areas.
2. **`highway_roads` list has a missing comma** between `"tertiary_link"` and `"living_street"`, silently merging them and dropping `living_street` ways from the map entirely. Blocks FR-1 — a rider on a `living_street` block with real cycleway tags currently sees nothing.

**Decisions to close:**
- **Deleted-OSM-feature handling** — genuinely undecided. Recommend explicitly deferring for v1 (matches the "don't build what isn't needed yet" posture elsewhere) but get Sean's sign-off on that rather than defaulting silently, since it trades implementation effort now against silently-stale rows later. [application-layer.md §6](./layers/application-layer.md#deletions-features-removed-from-osm-since-the-last-run), [§10](./layers/application-layer.md#10-open-questions-for-sean).
- **Split `fetch_data.py` into fetch/transform/load modules?** Leaning yes (unit tests want to import transform functions without pulling in `psycopg`), but not mandated — a scoping call for whoever picks this up.
- Cluster-distance threshold (~15-20km placeholder) — fine as a starting heuristic given all four seed cities collapse to one query regardless of the exact number.

**Dependencies:** Epic 1 (schema to load into). Independent of Epics 2/3 — see §1 sequencing note on parallelizing.

---

### Epic 5 — Add a Coverage Area end-to-end

**Goal:** Add one real, currently-uncovered nearby town to `data/cities.json` and confirm the whole loop — config change → ingest → serve → render — works with zero `website/` or `scripts/` code changes.

**Realizes:** This *is* SM-2, run for real rather than asserted. Also the first real-world test of SM-1 (no City Boundary Seam) at a boundary that wasn't hand-verified during Epics 2-3 (which only proved it for the original four, already-adjacent-and-merged towns).

**Scope:** One config PR. No new code — if this epic requires a code change to succeed, that's a signal Epic 4 isn't actually done, not a reason to add scope here.

**Dependencies:** Epics 1-4 complete.

---

### Epic 6 — Observability, data quality & abuse protection (cross-cutting)

**Goal:** The non-functional pieces that let this run unattended, called out separately only so they don't get silently dropped while chasing the FRs above. Not a separate phase — lands in small pieces inside Epics 2 and 4.

**Scope:**
- API: structured request logging (bbox, area, feature count, duration), `GET /health` backed by a real `SELECT 1`, basic per-IP rate limiting. Lands inside Epic 2. [api-layer.md §6, §8](./layers/api-layer.md#6-auth).
- Ingestion: `scripts/check_data_quality.py` (feature-count-collapse sanity, geometry validity, duplicate-id tripwire) as its own `osm-refresh.yml` step after the loader, failing the workflow on a bad run. Lands inside Epic 4. [application-layer.md §9](./layers/application-layer.md#data-quality-checks-post-ingestion-validation-a-distinct-step-from-code-correctness-tests).
- The payload-size/latency log fields from Epic 2 are also what eventually answers "is `ST_Simplify` worth building" — no separate instrumentation, just make sure those fields exist from day one. [architecture.md §6](./architecture.md#6-reconciliation-with-the-prd).

**Dependencies:** Threaded through Epics 2 and 4; not independently sequenced.

---

### Epic 7 — Test infrastructure (cross-cutting)

**Goal:** The docker-compose stack doubling as the CI test harness (testing-and-tooling.md §1's "one definition, two uses"), so each epic's own tests (already listed in its scope above) actually run somewhere. Not a separate phase — the CI wiring itself is the deliverable here; the tests are each epic's.

**Scope:**
- CI job(s) that bring up the compose stack and run: persistence integration tests (Epic 1), API integration/contract/unit tests (Epic 2), Playwright E2E against a mocked-API frontend (Epic 3), ingestion unit/integration/data-quality tests (Epic 4).
- [testing-and-tooling.md §2](./testing-and-tooling.md#2-testing-strategy) is the category checklist; nothing here invents a new category.

**Dependencies:** Grows alongside Epics 1-4; there's no standalone "build the test infra first" step since each epic's tests only make sense once that epic's code exists.

## 3. Explicitly not epics

- **FR-2 (paths by designation), FR-4 (layer toggles), FR-7 (search), FR-8 (directions)** — all confirmed to need zero code changes under this migration ([ui-layer.md §7](./layers/ui-layer.md#7-component-level-impact)). They show up only as regression-test line items inside Epic 3, not as epics of their own.
- **Deployment/hosting** — explicitly deferred by Sean, parked in [testing-and-tooling.md §3](./testing-and-tooling.md#3-deployment-deferred). None of the epics above assume a hosting target; "containerized" is as far as any of them go. Pick this back up as its own conversation when Sean's ready, not folded in here.
- **ADR / doc automation** ([multi-city-expansion.md §4.4](./multi-city-expansion.md#44-documentation-automation)) — treated as a standing Definition-of-Done item for every epic above (update `CLAUDE.md`, drop an ADR for a real decision) rather than its own epic, per that section's own framing.
- **Infrastructure-aware routing (pgRouting)** — a non-goal per prd.md §5; not on this list at all.

## 4. Open-question tracker

Decisions each epic is blocked or shaped by, gathered in one place. Detail and rationale live at the links; this is just the checklist.

| # | Decision | Blocks | Doc |
|---|---|---|---|
| 1 | ~~Migration tooling: SQL files vs. EF Core~~ — **resolved: EF Core** | Epic 1 | [persistence-layer.md §4](./layers/persistence-layer.md#4-migration-tooling), [api-layer.md §10](./layers/api-layer.md#10-open-questions-for-sean) |
| 2 | ~~`feature_type` TEXT+CHECK vs. ENUM~~ — **resolved: ENUM** | Epic 1 | [persistence-layer.md §9](./layers/persistence-layer.md#9-open-questions-for-sean) |
| 3 | ~~Surrogate PK vs. compound PK~~ — **resolved: surrogate** | Epic 1 | same |
| 4 | GeoJSON `Feature.id` encoding | Epic 2, Epic 3 | [api-layer.md §3](./layers/api-layer.md#3-query-implementation) |
| 5 | Clip route geometry at the bbox, or return whole? | Epic 2 (blocks finalizing the route query) | [architecture.md §6](./architecture.md#6-reconciliation-with-the-prd) |
| 6 | Send `zoom` hint from the UI now? | Epic 2 ↔ Epic 3 (Contract A shape) | [ui-layer.md §6](./layers/ui-layer.md#6-zoom-dependent-payload-size) |
| 7 | Deleted-OSM-feature handling | Epic 4 | [application-layer.md §10](./layers/application-layer.md#10-open-questions-for-sean) |
| 8 | Split `fetch_data.py` into modules? | Epic 4 (scoping only, not blocking) | same |
| 9 | `state = "proposed"` filtering location (UI vs. API/DB) | None currently — flagged as a responsibility question, current UI-side filter stays as-is unless revisited | [persistence-layer.md §9](./layers/persistence-layer.md#9-open-questions-for-sean) |
| 10 | Target Coverage Area list beyond the current four | Epic 5 (needs *a* town picked, not a list) | [multi-city-expansion.md §7](./multi-city-expansion.md#7-open-questions-for-sean) |

Items without an epic dependency (e.g. #9, and prd.md §8's item 5 on pgRouting interest) are informational — worth Sean's answer eventually, not gating anything above.
