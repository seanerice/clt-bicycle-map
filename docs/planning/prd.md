---
title: CLT Bicycle Map
created: 2026-08-16
updated: 2026-08-28
---

# PRD: CLT Bicycle Map
*Working title — confirm.*

## 0. Document Purpose

This PRD describes the CLT Bicycle Map product — what it does for a rider and why — as it exists today and as it will exist once the multi-city migration lands. It is written for whoever is deciding what the map should do next (Sean, and any future contributor or agent picking up the work), and it builds on, rather than duplicates, the technical decisions already made in [multi-city-expansion.md](./multi-city-expansion.md) (data/serving architecture), [testing-and-tooling.md](./testing-and-tooling.md) (containerization/testing), [architecture.md](./architecture.md) (layer plan and cross-layer contracts), and [deployment.md](./deployment.md) (hosting/deployment) — those answer *how*; this answers *what* and *for whom*. Features are grouped with Functional Requirements nested under them; FRs are numbered globally and stable even if features get reorganized. Terms from the Glossary (§3) are used verbatim throughout — no synonyms.

## 1. Vision

CLT Bicycle Map is a free, static web map showing where it's actually safe and pleasant to ride a bike in Charlotte, NC and the surrounding metro — bike lanes, dedicated paths, and named cycling routes, sourced from OpenStreetMap and rendered with enough detail (lane type, buffering, path designation) that a rider can tell the difference between a protected track and a painted shoulder before they leave the house.

Today it covers Charlotte plus three small neighboring towns (Belmont, Cramerton, McAdenville), loaded as one static file. The product goal for this phase is to grow that coverage across the rest of the Charlotte metro — and eventually other nearby cities — as new areas are added to a configuration file, without visible gaps at city boundaries and without forcing every visitor's browser to download an ever-larger blob of data it isn't looking at. The underlying architecture is changing substantially (§4.1 of multi-city-expansion.md); this document exists to keep that migration honest to what the rider actually experiences.

## 2. Target User

### 2.1 Jobs To Be Done

- Figure out, before a ride, whether a route has real bike infrastructure or just shares a lane with traffic.
- Compare lane types along a route (protected track vs. painted lane vs. shoulder vs. nothing) to judge comfort/safety, not just distance.
- Find and follow a named regional cycling route (e.g. a signed greenway or bike route) rather than piecing one together from raw OSM tags.
- Get turn-by-turn directions that account for where cycling infrastructure exists.
- Casually explore "what's near me" without first knowing what to search for.

### 2.2 Non-Users (v1)

- Riders wanting turn-by-turn routing that actually reasons over *our* bike-infrastructure graph (e.g. "route me only via protected lanes") — directions are Mapbox's general-purpose Directions API, not infrastructure-aware. See Non-Goals (§5).
- Anyone wanting to contribute, correct, or annotate map data directly through the product — all data comes from upstream OpenStreetMap edits, not from this app.
- Cities/areas not yet present in `data/cities.json` — coverage is explicitly config-driven and finite at any point in time, not "the whole world."

### 2.3 Key User Journeys

- **UJ-1. A commuter checks whether her ride to work has real protection before switching from driving.**
  - **Persona + context:** A Charlotte-area rider considering biking to work for the first time, nervous about riding next to traffic.
  - **Entry state:** No account, first visit, arrives via a search engine or a friend's link.
  - **Path:** Loads the map centered on Charlotte; pans/zooms toward her home and workplace; watches bike lanes and paths render as she moves, styled distinctly by type; zooms in on a stretch of her commute to check whether it's a protected track or just a painted lane.
  - **Climax:** She sees a continuous protected path for most of the route, with one gap where she'd share the road — a concrete, specific piece of information she couldn't get from a generic maps app.
  - **Resolution:** Decides to try the ride, mentally noting the one unprotected block.
  - **Edge case:** Her commute crosses from Charlotte into a neighboring town. The lane rendering doesn't visibly break or gap at that boundary — she can't tell where one city's data ends and the next begins. *Realizes the core multi-city goal (multi-city-expansion.md §3): no visible seams.*

- **UJ-2. A rider new to the area searches for a specific greenway and follows it.**
  - **Persona + context:** New to Charlotte, has heard of a named regional route (e.g. a signed greenway) but doesn't know where it runs.
  - **Entry state:** First visit, no prior context on the map's controls.
  - **Path:** Uses the search box to jump to a rough starting point; visually traces the highlighted route line and its symbol/name labels along its length; toggles other layers off to reduce clutter and focus on just the named route.
  - **Climax:** The full route is visible as one continuous, clearly labeled line, colored by its network, regardless of which underlying OSM relation segments or city-coverage boundaries it happens to cross.
  - **Resolution:** Has a clear mental picture of the route before riding it.

- **UJ-3. A rider gets turn-by-turn directions and cross-checks them against the infrastructure layer.**
  - **Persona + context:** Wants to get from A to B and is willing to let the app pick the route, but wants to eyeball it against real bike infrastructure first.
  - **Entry state:** Already has the map open, knows the layer widget exists.
  - **Path:** Enters a destination, gets a suggested cycling route from the directions feature; visually compares the suggested path against the bike lane/path layers already on screen.
  - **Climax:** Sees where the suggested route lines up with (or diverges from) real infrastructure — informing whether to follow it as-is or detour.
  - **Resolution:** Rides with more confidence than blind trust in a generic router.
  - **Edge case:** The directions feature (Mapbox's own Directions API) has no awareness of the bike-infrastructure layer and may route through a segment with no bike lane at all — a known, accepted limitation, not a bug. See Non-Goals (§5).

- **UJ-4. A rider casually explores the metro to see what's out there.**
  - **Persona + context:** No specific destination — just curious what cycling infrastructure exists nearby or in a part of the metro they don't normally visit.
  - **Entry state:** First or repeat visit.
  - **Path:** Pans and zooms broadly across the metro; infrastructure loads in for whatever's currently in view, including areas outside the original four; toggles layers on/off to compare road-level lanes vs. off-street paths vs. named routes.
  - **Climax:** Discovers a path or route they didn't know existed, in an area of the metro that wasn't covered before this migration.
  - **Resolution:** Bookmarks it for a future ride.

## 3. Glossary

- **Bike Lane** — An on-street cycling facility running alongside a road, distinguished by type: **Track** (physically separated/protected), **Lane** (painted, unprotected), **Buffered Lane** (painted with a painted buffer from traffic), **Shared Lane** (bikes and cars share the lane, marked), **Shoulder** (a paved shoulder used as a de facto lane, not a dedicated facility). Rendered per side of the road (`cyclewayLeft`/`cyclewayRight` in the underlying data).
- **Cycling Path** — An off-street, dedicated way for cycling (e.g. a greenway or multi-use trail), separate from any road. Carries a **Designation**: `designated` (bikes explicitly permitted/intended), `yes` (bikes permitted, not the primary intent), or `unknown`.
- **Bike Route** — A named, signed cycling route (e.g. a regional greenway or numbered bike route) composed of one or more underlying ways, rendered as a single continuous line with a label, colored by its **Cycling Network**.
- **Cycling Network** — The classification/system a Bike Route belongs to (e.g. regional vs. local), used to color-code routes.
- **Coverage Area** — A city or town whose cycling data is included in the map, defined by an entry in the ingestion configuration. Coverage grows by adding entries, not by writing code.
- **City Boundary Seam** — A visible gap, duplication, or rendering discontinuity in bike lanes/paths/routes at the line where two Coverage Areas meet. Explicitly something the product must not have.
- **Viewport** — The currently visible rectangular region of the map; what data gets fetched/rendered depends on this, not on the full extent of all Coverage Areas combined.
- **Layer** — A togglable category of rendered data (bike lanes, cycling paths, bike routes) controlled via the layer widget.
- **Proposed Facility** — A bike lane, path, or route tagged in OpenStreetMap as planned/proposed rather than built. Filtered out of the map — the product only shows infrastructure that exists today.

## 4. Features

### 4.1 Bike lane rendering (on-street)
**Description:** Displays on-street bike lanes as styled line overlays on roads, distinguishing lane type and which side of the road each applies to. Realizes UJ-1. This is the primary "is this actually safe to ride" signal the product provides.

**Functional Requirements:**

#### FR-1: Render bike lanes by type and side
A rider can see, for any road with bike infrastructure in the current Viewport, a distinct visual style per side of the road for each lane type (Track, Lane, Buffered Lane, Shared Lane, Shoulder). Realizes UJ-1.

**Consequences (testable):**
- A road with a Track on one side and a Lane on the other renders two visually distinct styles, correctly attributed to each side.
- A Buffered Lane is visually distinguishable from an unbuffered Lane of the same type.
- Roads with no bike infrastructure render with no lane overlay.

### 4.2 Cycling path rendering (off-street)
**Description:** Displays dedicated cycling paths (greenways, trails) separately from on-street lanes, colored by designation. Realizes UJ-1, UJ-4.

**Functional Requirements:**

#### FR-2: Render paths by designation
A rider can visually distinguish a `designated` cycling path from a `yes`/`unknown` one.

**Consequences (testable):**
- Paths render with a style keyed off their Designation value, distinct from the road/lane styling in FR-1.

### 4.3 Named bike routes
**Description:** Displays named, multi-segment Bike Routes as continuous labeled lines, colored by Cycling Network, with Proposed Facilities filtered out. Realizes UJ-2, UJ-4.

**Functional Requirements:**

#### FR-3: Render continuous, labeled routes
A rider can see a named Bike Route as one continuous line with a visible name/symbol label, regardless of how many underlying map segments or Coverage Area boundaries it crosses.

**Consequences (testable):**
- A route spanning two Coverage Areas renders as one visually continuous line with no seam at the boundary (realizes the City Boundary Seam requirement in §4.5).
- The route's line color reflects its Cycling Network.
- A route tagged as a Proposed Facility does not render.

**Out of Scope:**
- Route-level turn-by-turn narration (that's directions, §4.6).

### 4.4 Layer visibility controls
**Description:** Lets a rider toggle each Layer (bike lanes, cycling paths, bike routes) on or off independently to declutter the view. Realizes UJ-2, UJ-4.

**Functional Requirements:**

#### FR-4: Independent layer toggles
A rider can turn any one Layer on/off without affecting the others' visibility.

**Consequences (testable):**
- Toggling off "bike routes" while "bike lanes" stays on leaves lane rendering unaffected.

### 4.5 Seamless viewport-based map coverage
**Description:** As a rider pans/zooms, the map loads and renders whatever cycling infrastructure exists in the current Viewport — including Coverage Areas beyond the original four — with no City Boundary Seam and without requiring the whole combined dataset to be downloaded up front. This is the core capability this migration adds. Realizes UJ-1, UJ-4. `[ASSUMPTION: the rider never needs to see infrastructure outside the current Viewport at once — e.g. no "show me the whole metro's lanes in one static image" use case — consistent with multi-city-expansion.md §3's lazy-load goal.]`

**Functional Requirements:**

#### FR-5: Load data scoped to the current viewport
A rider panning or zooming sees bike lanes, paths, and routes appear for the newly visible area without a full-page reload.

**Consequences (testable):**
- Panning across a Coverage Area boundary shows continuous rendering with no gap, duplication, or flicker at the line where two areas meet.
- The amount of data transferred for a given interaction scales with the Viewport, not with the total number of Coverage Areas configured.

#### FR-6: Coverage grows without a code change
The set of Coverage Areas the map draws from can be expanded by editing configuration, not by modifying the frontend or ingestion code. `[ASSUMPTION: this FR is stated from the product's perspective — that coverage isn't hardcoded — without prescribing the mechanism; multi-city-expansion.md §4.3 and architecture.md own how it's actually implemented.]`

**Consequences (testable):**
- Adding a new Coverage Area does not require a `website/` or ingestion-pipeline code change.

### 4.6 Location search
**Description:** Lets a rider search for an address or place name and jump the map there. Realizes UJ-2.

**Functional Requirements:**

#### FR-7: Search and center on a location
A rider can enter a place name or address and have the map recenter on it.

**Consequences (testable):**
- A valid search result recenters/zooms the map to that location.

### 4.7 Turn-by-turn directions
**Description:** Lets a rider get a cycling route between two points via Mapbox's Directions API, rendered alongside the infrastructure layers so it can be visually cross-checked. Realizes UJ-3.

**Functional Requirements:**

#### FR-8: Get and display cycling directions
A rider can request directions between two points and see the suggested route rendered on the map at the same time as the bike lane/path/route layers.

**Consequences (testable):**
- The suggested route line and the infrastructure layers are both visible and distinguishable from each other simultaneously.

**Out of Scope:**
- Route suggestions that prefer or are aware of this product's own bike-infrastructure data (see Non-Goals, §5) — directions quality is entirely Mapbox's.

**Notes:** `[NOTE FOR PM]` If infrastructure-aware routing ever becomes a real goal, multi-city-expansion.md §4.1 already identifies pgRouting as the path that doesn't require a second database — revisit this FR's scope if that non-goal is ever reopened.

## 5. Non-Goals (Explicit)

- Turn-by-turn routing that reasons over our own bike-infrastructure graph — directions stay delegated to Mapbox's general-purpose Directions API indefinitely (multi-city-expansion.md §3).
- Live/real-time sync with OpenStreetMap edits. Daily-ish batch freshness is the target, not immediacy.
- User accounts, saved routes, or any user-submitted contributions/edits/corrections to the map data.
- Coverage of areas not present in the coverage configuration — this is not a "cover everywhere" product; it grows deliberately, one config entry at a time.

## 6. MVP Scope

### 6.1 In Scope
- All Features in §4 as described, for the current four Coverage Areas (Charlotte, Belmont, Cramerton, McAdenville) plus any areas added to configuration going forward.
- Seamless behavior (FR-5) across all configured Coverage Area boundaries, not just the original four.

### 6.2 Out of Scope for MVP
- A specific target list of additional cities to add beyond the current four — deliberately left open/config-driven rather than committed to up front (multi-city-expansion.md §7). `[NOTE FOR PM]` Revisit once it's time to actually populate the coverage configuration with new entries.
- Infrastructure-aware directions (§4.7 Out of Scope).
- Any new rider-facing feature not already described in §4 (e.g. elevation profiles, crowd-sourced condition reports, saved favorites) — not committed to for this phase; the scope of this migration is coverage growth and seamless loading, not new capability categories.

## 7. Success Metrics

**Primary**
- **SM-1**: Panning or zooming across any configured Coverage Area boundary shows continuous bike lane/path/route coverage — no visible gap, duplication, or flicker. Validates FR-5.
- **SM-2**: A new Coverage Area can go from "not on the map" to "rendering correctly" via a configuration change alone, with no `website/` or ingestion-pipeline code change required. Validates FR-6.

**Secondary**
- **SM-3**: The map keeps getting used for real ride planning (by Sean, and by whoever else finds it) without hitting missing-data dead ends at the edges of today's coverage. Validates FR-1–FR-4, FR-7, FR-8.

**Counter-metrics (do not optimize)**
- **SM-C1**: Don't shrink per-viewport payload size at the cost of introducing City Boundary Seams or stale-looking data near boundaries. Counterbalances SM-1.

## 8. Open Questions

1. GeoJSON `Feature.id` encoding for `osm_type`/`osm_id` — small, not blocking, but worth a one-line decision before the API's response shape is implemented (api-layer.md §10, ui-layer.md §9, architecture.md §5).
2. ~~Migration tooling for the persistence schema~~ — **resolved 2026-08-17: EF Core migrations** (architecture.md §5, persistence-layer.md §4).
3. Deleted-OSM-feature handling — still undecided; `last_seen_at` keeps the door open without committing to detection logic now (architecture.md §5, application-layer.md §10, persistence-layer.md §5). The Epic 4 ingestion redesign (multi-city-expansion.md) shifts this tradeoff: ingesting from a full regional OSM extract, rather than from upstream query results, gives each run an authoritative picture of what currently exists in OSM across the configured Coverage Areas — so detect-and-delete becomes substantially more tractable, and the "hard to know what was actually deleted" objection largely falls away. Whether to build it for v1 is still Sean's call.
4. Target Coverage Area list beyond the current four — no fixed list yet; revisit when it's time to actually populate `data/cities.json` (multi-city-expansion.md §7).
5. Whether there's any real interest in infrastructure-aware routing (pgRouting) down the line, or Mapbox Directions is fine indefinitely — doesn't change the current architecture decision, but worth confirming it's genuinely out of scope (multi-city-expansion.md §7).

## 9. Assumptions Index

- §4.5 (FR-5): assumed the rider never needs a whole-metro-at-once view of all lanes simultaneously — only viewport-scoped rendering matters, consistent with the lazy-load goal in multi-city-expansion.md §3.
- §4.5 (FR-6): stated coverage growth as a product-level FR ("no code change required") without prescribing the mechanism, deferring the *how* entirely to multi-city-expansion.md §4.3 and architecture.md.
