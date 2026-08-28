---
title: CLT Bicycle Map — Epics
created: 2026-08-17
updated: 2026-08-28
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
        ▼               extract-based)        │
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

Epic 4's first three stories (4.1–4.3) are an Overpass stopgap — ships this week, independently deliverable, on the same `data/cities.json` config and on-instance cron (a systemd timer on the EC2 box) the rest of the epic targets — but keeps the per-area `area(id:)` fetch, so it does not deliver SM-1's seam elimination. Stories 4.4–4.9 swap the fetch for the extract pipeline (acquire + `osmium` clip + `osm2pgsql` load-raw + ingestion SQL), which adds seam-free coverage and removes the Overpass runtime dependency. Everything the stopgap builds — config schema, both transform bug fixes, the `scripts/pipeline/` layout, the psycopg UPSERT loader, the one-shot `ingest` service, the EC2 timer — carries forward unchanged; only `overpass.py` is discarded (story 4.9). ASCII diagram unchanged.

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
- ~~**GeoJSON `Feature.id` encoding**~~ for `osm_type`/`osm_id` — **resolved 2026-08-20 (story 2.1): `Feature.id = "{osmType}/{osmId}"`**, e.g. `"way/123456"`/`"relation/98765"`, mirroring OSM's own convention and Contract B's natural key; `osmType`/`osmId` are explicitly not duplicated into `properties`. [api-layer.md §10](./layers/api-layer.md#10-open-questions-for-sean), [prd.md §8.1](./prd.md#8-open-questions).
- ~~**Clip route geometry to the query bbox, or return it whole?**~~ — **resolved 2026-08-20 (story 2.2): don't clip.** Closed with a real spike, not a guess, against the largest route relation in the currently-loaded data (Cross Charlotte Trail, `osm_id 11998284`, 5,039 vertices): unclipped `ST_AsGeoJSON` = 124,978 bytes vs. clipped (`ST_Intersection` against a bbox covering half its extent) = 63,601 bytes — a real ~2x saving, but not disproportionate enough to outweigh `cycling-route-symbols`' `symbol-placement: line` label-anchor-stability risk under Epic 3's per-`moveend` refetch-and-`setData()` pattern, which is sharper than the original "Mapbox already clips rendering" framing (that's about single-frame rendering, not a route's vertex sequence changing on every pan). **Evidence limit, stated honestly:** the byte counts are measured; the label-anchor-stability claim is mechanism-based reasoning, not a live visual pan-test — this repo has no browser/screenshot/Playwright tooling yet (that's Epic 3 stories 3.9/3.10), so story 2.2's acceptance-criteria visual check wasn't performable in this task's environment. Flagged as a follow-up sanity-check once that tooling exists, not a gap that changes the decision. [architecture.md §6](./architecture.md#6-reconciliation-with-the-prd), [api-layer.md §3](./layers/api-layer.md#3-query-implementation).
- ~~Bbox area cap value (~2 sq degrees placeholder) and rate-limit threshold (~60 req/min/IP placeholder)~~ — **resolved 2026-08-20 (stories 2.3, 2.5): shipped as-is.** Cap = `2` sq degrees (config `Features:MaxBboxAreaDegrees`), checked against the real loaded extent of the four current Coverage Areas (≈0.163 sq degrees, ~12x under the cap). Rate limit = ~60 req/min/IP, per-IP, fixed-window — value picked, middleware implementation deferred to Epic 6 (no code added by story 2.5). Both flagged for later tuning once real usage exists.
- ~~`application/geo+json` vs `application/json` content type~~ — **resolved 2026-08-20 (story 2.4): `application/geo+json`**, for both empty and non-empty `FeatureCollection` 200 responses.

**Dependencies:** Epic 1 (schema + data loaded).

---

### Epic 3 — Frontend viewport-based fetching

**Goal:** Replace the static S3 `geojson` source with a source created empty and kept in sync via `setData()` on `moveend`, fetching from Epic 2's API.

**Realizes:** FR-5 (viewport-scoped loading), and is the change that makes SM-1 (no City Boundary Seam on pan/zoom) checkable for the first time — against the existing 4 Coverage Areas.

**Scope:** Per [ui-layer.md](./layers/ui-layer.md) in full — `moveend`-triggered fetch with debounce + `AbortController` (§2), no client-side region caching (Option B, §3 — refetch padded viewport each time), loading/error states (§4), no changes needed to the five style layers or `layer-widget.js`/`location-search-menu.js`/`mapbox-navigation.js` (§5, §7 — verify this via regression tests rather than assume it), Playwright coverage (§8).

**Decisions to close:**
- ~~**Send a `zoom` hint alongside `bbox` from day one**, even before the API acts on it~~ — **resolved 2026-08-21 (story 3.1): yes.** Not a new ask of the API layer — `api-layer.md` §2 already reserves the param name and story 2.10's endpoint already accepts-and-ignores it, so the two layers were already designed to agree on this shape. [ui-layer.md §6](./layers/ui-layer.md#6-zoom-dependent-payload-size), [§9](./layers/ui-layer.md#9-open-questions-for-sean), [architecture.md §2/§5](./architecture.md#2-cross-layer-contracts).
- ~~Padding factor (~25-50%) and debounce interval (~200ms)~~ — **resolved 2026-08-21 (story 3.2): 35% padding, 200ms debounce**, shipped as named placeholder constants for 3.4/3.5 to reference, explicitly unmeasured pending real API latency data. [ui-layer.md §9](./layers/ui-layer.md#9-open-questions-for-sean).
- ~~`API_BASE_URL` config mechanism~~ — **resolved 2026-08-21 (story 3.3): webpack `DefinePlugin` fed by `.env`/`dotenv` or a shell env var**, local-dev default `http://localhost:5000` (the host port Epic 2's `docker-compose.yml` `api` service publishes). Production hosting stays undecided, per deployment being out of scope (§3 below). [ui-layer.md §9](./layers/ui-layer.md#9-open-questions-for-sean).

**Definition of done includes:** explicit regression pass on FR-4 (layer toggles), FR-7 (search), FR-8 (directions) — none of these should need code changes, but ui-layer.md §8 calls out verifying that, not assuming it, especially the new `moveend`↔navigation coupling.

**Dependencies:** Epic 2 (a live API to point at).

---

### Epic 4 — Ingestion pipeline refactor: config-driven, extract-based

**Goal:** Replace `fetch_data.py`'s per-area Overpass queries with a batch pipeline built from a static regional OSM extract — no Overpass anywhere in the automated pipeline. Download and cache the Geofabrik North Carolina `.osm.pbf`; `osmium extract --strategy=smart` it to each `data/cities.json` area's AOI (boundary polygon or bbox, overlaps expected); `osm2pgsql` (flex/Lua config, cycling tags only) the clips into a dedicated `osm2pgsql`-owned `osm_raw` schema (drop-and-reload, *not* EF-migration-managed); run an ingestion SQL query against `osm_raw` that reproduces the old Overpass QL's six selection clauses (minus `highway=proposed`); feed the rows through the existing, unchanged `transform_*` functions via a thin adapter that replaces `json2geojson`; and psycopg3 batch-UPSERT into `features` on `(osm_type, osm_id)`, whole run in one transaction. Update `osm-refresh.yml` to drop **both** the Overpass call **and** `aws s3 sync` — the workflow becomes acquire → clip → load-raw → ingestion-SQL + transform → UPSERT, then a data-quality check step.

**Realizes:** FR-6 (coverage grows via config change alone), SM-2, and — via the two bug fixes below — restores FR-1 and FR-3's testable consequences to actually holding. Stories 4.1–4.3 deliver the FR-6 / SM-2 and bug-fix consequences *in practice* immediately (coverage grows by adding a `data/cities.json` entry, no code change) — but not SM-1's seam elimination, which stories 4.4–4.9 add along with removing the third-party runtime dependency.

**Phase 1 (stories 4.1–4.3) delivers, Phase 2 (4.4–4.9) builds on:** the two transform bug fixes (`osmType`; `highway_roads` comma), `data/cities.json` (final schema + validator), the `scripts/pipeline/` package layout, the psycopg UPSERT loader (`ingest.py`), the one-shot `ingest` compose service, and the EC2 systemd timer. Phase 2 swaps only the fetch mechanism — Overpass query + `osm2geojson` → acquire + `osmium` clip + `osm2pgsql` load-raw + ingestion SQL + a thin adapter.

**Scope:** Per [application-layer.md](./layers/application-layer.md) in full — `data/cities.json` schema + local `data/aoi/<relationId>.geojson` boundary-polygon derivation from the extract (§2); acquire + cache the Geofabrik NC `.osm.pbf` (§3.1); `osmium extract --strategy=smart` clip per AOI (§3.2); `osmium merge` + `osm2pgsql` flex-config load into the `osm_raw` schema, drop-and-reload (§3.3); the ingestion SQL reproducing the six Overpass QL clauses, geometry out as EWKB (§3.4); overlap/dedup via merge-first + `DISTINCT ON` (§4); transform stage + the `json2geojson`-replacement adapter + the `osmType` extraction (§5, transforms otherwise unchanged); loader (psycopg3, opaque EWKB geometry passthrough, batch UPSERT, whole-run transaction, §6); acquire-step resilience + cached-`.pbf` fallback (§7); `osm-refresh.yml` rewrite dropping the Overpass call and `aws s3 sync` (§8); unit / ingestion-SQL / flex-config-spike / adapter / integration / data-quality / contract tests (§9).

**Must-fix, blocking (per [architecture.md §4](./architecture.md#4-status-of-the-detail-docs), not optional cleanup):**
1. **`transform_relation_feature` clobbers `properties.type`.** Every route relation's OSM tags include `type: "route"`, silently overwriting the original `"relation"` value the loader needs for Contract B's `(osm_type, osm_id)` UPSERT key. Fix: add an explicit `osmType` field (recommended in [application-layer.md §5](./layers/application-layer.md#5-transform-stage-unchanged-plus-one-extraction), option 2) to all three transform functions, not just the broken one, for symmetry. Blocks FR-6/SM-2 for *every* bike route, not just newly-added Coverage Areas.
2. **`highway_roads` list has a missing comma** between `"tertiary_link"` and `"living_street"`, silently merging them and dropping `living_street` ways from the map entirely. Blocks FR-1 — a rider on a `living_street` block with real cycleway tags currently sees nothing.

**Decisions to close:**
- **Deleted-OSM-feature handling** — still genuinely undecided, but the pivot makes it materially more tractable. Ingesting from a full regional extract, clipped to every configured AOI every run, gives an authoritative per-run picture of everything currently in OSM across the covered areas — the prior "an Overpass query might have returned empty or truncated, so a missing element doesn't reliably mean deleted" objection is gone. Recommend still deferring detect-and-delete for v1 (matches the "don't build what isn't needed yet" posture; `last_seen_at` keeps the door open), but get Sean's explicit sign-off rather than defaulting silently, and if it's "build it," confirm the scope-of-deletion rule (the run's AOI coverage). [application-layer.md §6.5](./layers/application-layer.md#65-deletions-features-removed-from-osm-since-the-last-run), [§10](./layers/application-layer.md#10-open-questions-for-sean).
- ~~**Ratify the recommended `scripts/pipeline/` module layout.**~~ Settled and built in story 4.1 — Epic 4 inherits the `scripts/pipeline/` package unchanged and only adds `acquire.py` / `clip_load_raw.py` / `adapter.py` alongside the existing `config.py` / `transform.py` / `ingest.py` / `__main__.py`.
- **Ratify [application-layer.md §10](./layers/application-layer.md#10-open-questions-for-sean)'s ingestion-mechanics recommendations as a group** — each already has a recommendation in §10; this is a sign-off, not five open designs: `osm2pgsql` flex/Lua config over the legacy C-transform output (flex only selects and minimally shapes; all rendering-property logic stays in Python); full nightly extract re-download over `.osc.gz` diff-updating for v1; `osm_raw` lifecycle = `osmium merge` all clips → one `osm2pgsql` load → single schema, drop-and-reload; geometry out of the ingestion SQL as `ST_AsEWKB` (skip the Shapely round-trip), a minor noted divergence from persistence-layer.md §5's illustrative `ST_GeomFromGeoJSON`; and commit `data/aoi/*.geojson` to the repo vs. treat it as a gitignored build cache (leaning commit).

**Dependencies:** Epic 1 (schema to load into). Independent of Epics 2/3 — see §1 sequencing note on parallelizing. **Internal risk, first in Phase 2's story order:** an early *blocking* spike (story 4.5) on `osm2pgsql` + `osmium` behavior — (a) `route=bicycle` relations land in `osm_raw` with assembled `(Multi)LineString` geometry under the flex config, and (b) `osmium extract --strategy=smart` retains route-relation member ways that cross the clip boundary — must land before the clip / load-raw stories (4.7 / 4.8), which depend on both holding. [application-layer.md §3.3](./layers/application-layer.md#33-load-the-clips-into-the-raw-schema), [§9](./layers/application-layer.md#9-testing-approach).

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

---

### Epic 8 — Deployment: db + api + frontend to AWS (Phase 1: Expand)

**Status: done, and then some — Phases 2 (Cutover) and 3 (Contract) also complete (2026-08-28).** This epic's own scope (below) was Phase 1 only, with cutover/contract explicitly deferred to "a follow-up epic once Epic 8 is verified stable" (§3 below). In practice, once Phase 1 verification passed, Sean made the call in the same session to proceed straight into cutover and contract rather than open that follow-up epic separately — real production DNS now points at the new infrastructure, and the legacy `t2.micro` box, its security group/key pair, and the retired `data.` CloudFront distribution are all decommissioned. See [deployment.md §4](./deployment.md#4-migration-plan-expand--cutover--contract) for the full phase-by-phase record. The goal/scope text below is left as originally written (Phase 1 only) since it's still an accurate description of what this epic's own stories (8.1-8.7) covered — the phases beyond it happened as informal, undocumented-in-advance follow-on work in the same session, not as a separate planned epic.

**Goal:** Stand up the new AWS infrastructure and deploy tooling for `db`+`api` (EC2 + docker-compose) and the frontend (S3+CloudFront), per [deployment.md](./deployment.md) — specifically its "Expand" phase ([deployment.md §4](./deployment.md#4-migration-plan-expand--cutover--contract)). Does not touch DNS and does not decommission the legacy EC2 box — this epic only gets new infrastructure stood up and verified in isolation; cutover and contract are deliberately separate, later work once this is proven. Internally split into two groups of stories, kept apart deliberately (see below), not two epics.

**Realizes:** No FR directly (infrastructure only) — unblocks Epics 1-3's work actually running in production, which today it isn't (the live site still runs pre-migration code against the old, undocumented EC2 box — [deployment.md §1](./deployment.md#1-current-state-account-audit-2026-08-25)).

**Scope:** Per [deployment.md §3](./deployment.md#3-target-architecture):

- **Stories 8.1-8.4 — write the tooling (code only, no AWS account touched, no money spent).** `infra/` aws-cli scripts for backend (IAM instance role, security group, `t4g.micro` EC2 launch, Elastic IP, SSM parameters) and frontend (S3 bucket, CloudFront distribution, ACM cert); the app-level deploy artifacts (`docker-compose.prod.yml`, `nginx` config, `db/Migrations/Dockerfile`'s `migrator` service — this piece *is* fully exercised, but entirely locally, no AWS involved); the GitHub Actions deploy workflow and its OIDC role script. Every acceptance criterion here is satisfied by static review or purely local execution — verifiable, and safe to run through `/execute-epic`'s normal autonomous flow.
- **Stories 8.5-8.7 — actually provision it.** Runs 8.1-8.4's output against the real AWS account: launches the real instance, creates the real S3 bucket/CloudFront distribution, issues the Cloudflare Origin CA cert by hand, and triggers the first real deploy, ending with Phase 1's end-to-end verification.
  > **⚠️ Stories 8.5-8.7 must not be run via `/execute-epic`'s autonomous flow.** That process's whole model is subagents that "execute directly... do not ask for approval" and prove acceptance criteria with real commands rather than static review (`.claude/commands/execute-epic.md` §0/§1b) — right for 8.1-8.4, wrong here: applied to 8.5-8.7 it means real, billable AWS resources get created autonomously with no human checkpoint before each one, which is exactly the risk Sean asked to keep out of the automated stack (2026-08-25). Run these interactively — Sean, or Claude Code in a normal (non-`/execute-epic`) conversation — with explicit confirmation before each command that creates or spends against a real resource.

**Decisions to close:** None — [deployment.md](./deployment.md) already resolved instance sizing, registry choice, secrets handling, TLS approach, and cost.

**Dependencies:** Epics 1-3 (there needs to be a working `docker-compose.yml` stack and a buildable frontend to deploy — both already done). Independent of Epics 4-7. Unblocks a future cutover-and-contract epic (deployment.md §4 Phases 2-3), which stays out of scope here per [§3 below](#3-explicitly-not-epics).

---

## 3. Explicitly not epics

- **FR-2 (paths by designation), FR-4 (layer toggles), FR-7 (search), FR-8 (directions)** — all confirmed to need zero code changes under this migration ([ui-layer.md §7](./layers/ui-layer.md#7-component-level-impact)). They show up only as regression-test line items inside Epic 3, not as epics of their own.
- ~~**Deployment cutover and contract** (deployment.md's Phase 2/3 — the DNS flip and decommissioning the legacy EC2 box) — deliberately not part of Epic 8, which only covers Phase 1 (Expand). Revisit as a follow-up epic once Epic 8 is verified stable.~~ **Done 2026-08-28, same session as Epic 8's Phase 1 — no separate follow-up epic was opened.** See Epic 8's own status note above and [deployment.md §4](./deployment.md#4-migration-plan-expand--cutover--contract).
- **ADR / doc automation** ([multi-city-expansion.md §4.4](./multi-city-expansion.md#44-documentation-automation)) — treated as a standing Definition-of-Done item for every epic above (update `CLAUDE.md`, drop an ADR for a real decision) rather than its own epic, per that section's own framing.
- **Infrastructure-aware routing (pgRouting)** — a non-goal per prd.md §5; not on this list at all.

## 4. Open-question tracker

Decisions each epic is blocked or shaped by, gathered in one place. Detail and rationale live at the links; this is just the checklist.

| # | Decision | Blocks | Doc |
|---|---|---|---|
| 1 | ~~Migration tooling: SQL files vs. EF Core~~ — **resolved: EF Core** | Epic 1 | [persistence-layer.md §4](./layers/persistence-layer.md#4-migration-tooling), [api-layer.md §10](./layers/api-layer.md#10-open-questions-for-sean) |
| 2 | ~~`feature_type` TEXT+CHECK vs. ENUM~~ — **resolved: ENUM** | Epic 1 | [persistence-layer.md §9](./layers/persistence-layer.md#9-open-questions-for-sean) |
| 3 | ~~Surrogate PK vs. compound PK~~ — **resolved: surrogate** | Epic 1 | same |
| 4 | ~~GeoJSON `Feature.id` encoding~~ — **resolved: `"{osmType}/{osmId}"`, not duplicated into `properties`** | Epic 2, Epic 3 | [api-layer.md §3](./layers/api-layer.md#3-query-implementation) |
| 5 | ~~Clip route geometry at the bbox, or return whole?~~ — **resolved: don't clip** (`ST_Intersects` only), per a real spike measuring 124,978 bytes unclipped vs. 63,601 bytes clipped for the largest currently-loaded route relation, plus mechanism-based (not live visual) reasoning about label-anchor stability — see [api-layer.md §3](./layers/api-layer.md#3-query-implementation) for the evidence-limits note | Epic 2 (blocks finalizing the route query) | [architecture.md §6](./architecture.md#6-reconciliation-with-the-prd) |
| 6 | ~~Send `zoom` hint from the UI now?~~ — **resolved: yes, from day one (story 3.1)** | Epic 2 ↔ Epic 3 (Contract A shape) | [ui-layer.md §6](./layers/ui-layer.md#6-zoom-dependent-payload-size) |
| 7 | Deleted-OSM-feature handling — still open, but the Epic 4 pivot makes it *buildable*: a full regional extract gives an authoritative per-run picture, so the "can't know what was removed" objection is gone. Recommend still deferring detect-and-delete for v1, with explicit sign-off. | Epic 4 | [application-layer.md §6.5](./layers/application-layer.md#65-deletions-features-removed-from-osm-since-the-last-run), [§10](./layers/application-layer.md#10-open-questions-for-sean) |
| 8 | ~~Split `fetch_data.py` into modules?~~ — **settled — `scripts/pipeline/` package, built in story 4.1** (`config`/`transform`/`overpass`/`ingest` + thin `__main__`; stories 4.6–4.9 add `acquire`/`clip_load_raw`/`adapter`). | Epic 4 (story 4.1) | [application-layer.md §10](./layers/application-layer.md#10-open-questions-for-sean) |
| 9 | `state = "proposed"` filtering location (UI vs. API/DB) | None currently — flagged as a responsibility question, current UI-side filter stays as-is unless revisited | [persistence-layer.md §9](./layers/persistence-layer.md#9-open-questions-for-sean) |
| 10 | Target Coverage Area list beyond the current four | Epic 5 (needs *a* town picked, not a list) | [multi-city-expansion.md §7](./multi-city-expansion.md#7-open-questions-for-sean) |

Items without an epic dependency (e.g. #9, and prd.md §8's item 5 on pgRouting interest) are informational — worth Sean's answer eventually, not gating anything above.
