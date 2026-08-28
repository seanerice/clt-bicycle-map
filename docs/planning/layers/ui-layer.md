# UI layer: detailed design

Status: Draft for review
Owner: Sean Rice
Last updated: 2026-08-16

Detail doc for the UI layer named in [../architecture.md](../architecture.md) §1. Covers `website/` (Lit + Mapbox GL): how it consumes Contract A (`GET /features?bbox=...`) instead of the current static S3 file, while keeping the existing style layers, layer-toggle UI, search, and directions intact. Assumes the decisions in [../multi-city-expansion.md](../multi-city-expansion.md) (§4.2, bbox API over Martin/MVT) and [../testing-and-tooling.md](../testing-and-tooling.md) (§2, Playwright as the E2E backbone) — doesn't relitigate them.

## 1. Current state, precisely

`website/src/bikemap-app.js#firstUpdated` does all of this once, inside the map's `load` handler:

```js
map.addSource('cycling-data', {
    type: 'geojson',
    data: 'https://data.bikemap.seanerice.dev/export.geojson'
});
```

Mapbox GL fetches that URL once, parses the whole `FeatureCollection`, and never touches it again — there's no code path that re-fetches or updates `cycling-data` after this. Five style layers are then added against that one source: `cycling-route-lines`, `cycling-route-symbols`, `cycling-paths`, `cycling-lanes-right`, `cycling-lanes-left` (all defined inline, lines 41–256). `layer-widget.js` only ever calls `setFilter`/`setLayoutProperty` on these layer ids — it never touches the source.

This doc's job is to replace the `data: <url>` string with a source that's created empty and kept in sync via `source.setData()` as the viewport moves, without changing anything about the five layer definitions.

## 2. Fetch/update strategy

### 2.1 Trigger: `moveend`

Per multi-city-expansion.md §4.2 and §5's data-flow diagram, the fetch is wired to `moveend`, not `move` or `zoom`. `moveend` already fires once per user gesture settling (pan release, zoom finish, `flyTo`/`fitBounds` completion) — it's the natural place, and Mapbox GL fires it consistently across mouse, touch, and programmatic camera changes (`mapbox-navigation.js`'s `_fitScreenToPoints` and `flyTo` calls will each trigger exactly one `moveend`, which is what we want — see §6).

```js
map.on('load', () => {
    // ... existing setValue, addControl, addSource, addLayer x5 ...
    map.on('moveend', () => this._scheduleFetch());
    this._scheduleFetch(); // initial load — moveend doesn't fire on its own for the initial view
});
```

Note the initial-load gap: `moveend` only fires after a *move*, so the very first viewport needs an explicit fetch right after the layers are added (or on `map.on('load')` itself, before any user interaction). Easy to miss — call it out explicitly in the implementation so the map doesn't start empty until the user first pans.

### 2.2 Debouncing

`moveend` itself already only fires once a gesture settles (Mapbox GL doesn't fire it repeatedly mid-drag), so a single `moveend` isn't the redundancy risk — a *sequence* of quick, separate gestures is (e.g. someone scroll-zooming three times in under a second, each producing its own `moveend`). Debounce the handler with a short trailing-edge delay (150–250ms is a reasonable starting point) so a burst of `moveend` events collapses to one fetch of the final viewport, not one fetch per event:

```js
_scheduleFetch = debounce(() => this._fetchViewport(), 200);
```

Use a small local debounce helper (or a one-function dependency) rather than pulling in lodash for this alone — it's ~10 lines. In-flight-request handling matters more than the debounce window itself: if a new `moveend` fires while a previous fetch is still pending, abort the stale one (`AbortController`) rather than letting both resolve and racing to call `setData()` — otherwise a fast pan-back can have an older, larger response overwrite a newer, correct one if it happens to resolve second.

### 2.3 Computing the bbox

Mapbox GL exposes the current viewport directly:

```js
const bounds = map.getBounds(); // mapboxgl.LngLatBounds
const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
```

This maps directly onto Contract A's `GET /features?bbox=minLon,minLat,maxLon,maxLat`.

**Padding.** Request a bbox somewhat larger than the exact viewport (e.g. expand by 25–50% of the viewport's width/height, or a fixed-fraction pad on each side) so that a small subsequent pan is likely to be fully covered by data already on hand and doesn't need to hit the API again immediately. This trades a larger response now for fewer round-trips soon after — a reasonable bet given panning tends to be locally clustered (someone scrolling around one neighborhood). Recommend implementing this as a simple padding factor on the raw bounds rather than anything fancier; tune the factor empirically once real API latency is known (out of scope for this doc — API-layer concern).

### 2.4 Getting data into the source

Create the source empty (or with an initial empty `FeatureCollection`) at `addSource` time, and populate/update it with `setData()`:

```js
map.addSource('cycling-data', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
});
```

```js
async _fetchViewport() {
    const bbox = this._computeBbox(); // padded, per §2.3
    const controller = new AbortController();
    this._abortPreviousFetch?.();
    this._abortPreviousFetch = () => controller.abort();

    try {
        this._setLoadingState(true); // §4
        const res = await fetch(`${API_BASE_URL}/features?bbox=${bbox.join(',')}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const geojson = await res.json();
        this._mergeAndSetData(geojson); // §3
        this._setErrorState(false);
    } catch (err) {
        if (err.name === 'AbortError') return; // superseded by a newer fetch, not a real error
        this._setErrorState(true); // §4 — leave existing setData() output on screen
        console.error('Failed to fetch cycling data for viewport', err);
    } finally {
        this._setLoadingState(false);
    }
}
```

`setData()` fully **replaces** the source's feature set — it is not additive. That means whatever object gets passed to it must already contain the union of everything that should currently render (the delta-merge design in §3, if adopted, has to build that union client-side before calling `setData()`; it is never simply "append the new response").

## 3. Caching / avoiding redundant fetches — recommendation: don't track fetched regions, refetch viewport each time (with padding)

Two real options, per the prompt:

**Option A — track fetched regions, request only the delta.** Maintain a client-side record of bbox(es) already fetched (e.g. a list of rectangles, or a coarser occupancy grid), and on each `moveend` compute the geometric difference between the new viewport and the union of what's already covered, requesting only that delta from the API. Merge the delta response into a running in-memory feature set (deduped by a stable feature id — see below) and call `setData()` with the union.

**Option B — always refetch the (padded) current viewport, accept overlap.** No client-side region bookkeeping. Every `moveend` (debounced) issues one `GET /features?bbox=<padded current viewport>` and the response **replaces** the source outright via `setData()`.

**Recommendation: Option B.** Reasons:
- Rectangle-difference bookkeeping (turning "new viewport minus already-covered region" into a small number of new rectangles to fetch) is a non-trivial geometry problem in the general case — a viewport that's moved diagonally doesn't subtract cleanly into one rectangle, it can require several. That's real client-side complexity for what's fundamentally a caching optimization, not a correctness requirement.
- It also brings a second problem: without a stable feature identity to dedupe on, a client-side "union of everything ever fetched" set grows monotonically and never sheds data for areas panned away from — which recreates exactly the "ever-larger blob" failure mode multi-city-expansion.md §3 is trying to escape, just moved from a static file to browser memory. Avoiding that requires an eviction policy (e.g. LRU by region), which is more state to design and test.
- Contract A doesn't currently guarantee a stable per-feature id in the response shape (§7's open question). Reliable de-duplication for a merge strategy depends on that; building Option A now would be building on a contract that isn't nailed down yet.
- The padding strategy in §2.3 already captures most of Option A's benefit (fewer refetches on small subsequent pans) with a fraction of the complexity, and it composes cleanly with the debounce in §2.2.
- Redundant re-fetching of an already-seen viewport is the same tradeoff explicitly accepted in multi-city-expansion.md §4.2 for the bbox-API-over-Martin decision ("weaker HTTP caching... every distinct bbox is effectively a unique query") — Option B is consistent with a choice already made, not a new tradeoff.

If real usage shows this genuinely costing too much (e.g. the API layer's own perf numbers say viewport-sized queries are expensive even with a spatial index, or users on slow connections are visibly refetching on every scroll-tick), revisit with actual data rather than pre-optimizing here. Standard HTTP caching (`Cache-Control`/ETag on the API response, browser/CDN cache) is a cheaper first lever to pull before building client-side region tracking — flag that as an API-layer lever, not a UI-layer one.

## 4. Loading and error states

- **In flight:** leave the current `setData()` output on screen — do not clear the source or blank the map while a fetch is pending. A brief, unobtrusive loading indicator (e.g. a small spinner near the existing menu button, or a subtle top-of-map progress bar) communicates "fetching" without disrupting the view. Exact placement/visual is a UI-polish decision, not architecturally load-bearing; a Lit reactive property (e.g. `_isLoadingFeatures`) driving a conditional class/element in `bikemap-app.js#render` is enough.
- **On error (network failure, non-2xx, timeout):** leave the last-good `setData()` result on screen (stale-but-present beats empty) and surface a small, dismissible non-blocking notice (e.g. "Couldn't refresh map data — showing last known view"). Do not silently retry in a loop — that risks hammering the API on a real outage. A single automatic retry after a short delay is reasonable; beyond that, wait for the next `moveend` (the user panning again naturally retries).
- **Timeout:** set an explicit fetch timeout (via `AbortController` + `setTimeout`, since `fetch` has no built-in timeout) — a few seconds is reasonable given this is meant to feel like "the map data quietly follows you." A timeout should behave identically to a network error (§ above), not a special case.
- This is a case where a tiny bit of local component state earns its keep despite the "no state framework beyond Lit reactivity" stack note in the architecture doc's UI row — `_isLoadingFeatures`/`_hasFetchError` as plain reactive properties on `BikeMapApp` (or a small dedicated data-source controller/mixin, see §6) is proportionate; no need for anything heavier.

## 5. Layer/style compatibility

All five existing layer definitions (`cycling-route-lines`, `cycling-route-symbols`, `cycling-paths`, `cycling-lanes-right`, `cycling-lanes-left`) key purely off feature `properties` via `['get', ...]` expressions and `filter` arrays — none of them reference how the source was populated. Swapping the source from "loaded once from a URL" to "replaced repeatedly via `setData()`" is transparent to them: Mapbox GL re-evaluates paint/layout/filter expressions against whatever the source currently holds, every time `setData()` runs. **No changes needed to the layer definitions in `bikemap-app.js` or the palettes in `colors.js`.**

One real correctness wrinkle, flagged rather than solved here (this is the ingestion/API layers' problem, not the UI's):

**Route relations spanning outside the viewport.** `cycling-route-lines`/`cycling-route-symbols` render OSM route *relations* (`route: "bicycle"`), which can be geographically long (e.g. a greenway or a numbered signed route crossing much of Charlotte). A bbox query by definition returns only the portion of a route's geometry that intersects the current viewport. Two visible consequences:
1. A route rendered as several disjoint on-screen segments as you pan, cut off exactly at the viewport edge — with `cycling-route-symbols`' label (`ref`/`name`) potentially appearing on every partial segment that happens to have a rendering opportunity, versus once per logical route today.
2. Zooming out to see a whole long route at once still works, since the bbox at low zoom naturally covers more of it — it's specifically the *symbol placement / segment continuity* that changes character, not full omission.

Today's static-file model sidesteps this because the whole feature collection (and thus each route's full geometry) is always present. This is worth an explicit open question (§8) and likely an API/persistence-layer decision (e.g. does `/features` return complete route geometries when *any part* intersects the bbox, vs. clipping to the bbox like it presumably does for roads/paths) — flagging it here because it's a real, user-visible regression risk if not addressed, not because the UI layer can fix it alone.

## 6. Zoom-dependent payload size

At low zoom (e.g. the app's default `zoom: 10`, city-wide), the viewport bbox — even unpadded — covers a large geographic area, and could return a large `FeatureCollection` even before the §2.3 padding is applied. This doc doesn't design the server-side mitigation (that's persistence/API-layer territory — `ST_Simplify` with a zoom-derived tolerance is exactly the mechanism multi-city-expansion.md §4.2 names as the accepted-for-now gap versus Martin's automatic per-tile simplification). The UI-side implication worth deciding now, since it changes the request shape (Contract A):

**Should the UI pass a zoom hint alongside `bbox`?** If the API/persistence layers implement zoom-tiered simplification, they'll need *some* signal for which tolerance to apply. The natural, cheap option is adding an optional `zoom` (or `simplify`) query param the UI always sends (`map.getZoom()`, already available at fetch time) — trivial to add to the fetch call in §2.4, and inert until the API layer chooses to read it. Recommend the UI send `zoom` from day one (even before the API acts on it) so the API/persistence layer doesn't need a UI-layer change later to start using it. This needs sign-off from the API/persistence detail docs before being treated as settled — recorded as an open question in §8, and worth reconciling in architecture.md §5 alongside the other cross-cutting items once those docs land.

## 7. Component-level impact

- **`layer-widget.js`** — no changes. It only calls `setFilter`/`setLayoutProperty` against the five layer ids; it has no awareness of the source or how it's populated, and none of its filter logic (route/lane/path property-based filters) changes shape under Contract A, which preserves the same property names.
- **`location-search-menu.js`** — no changes. It talks exclusively to Mapbox's own Geocoding API (`api.mapbox.com/geocoding/...`) and dispatches a `location-selected` event; it never touches `cycling-data`.
- **`mapbox-navigation.js`** — no changes. It talks exclusively to Mapbox's own Directions API and manages its own `start`/`end`/`route` sources/layers, entirely separate from `cycling-data`. Worth double-checking one interaction, though: `_fitScreenToPoints` calls `map.fitBounds(...)`, and `_setCoord` calls `map.flyTo(...)` — both are camera moves and both will trigger `moveend`, which under this design now also kicks off a `cycling-data` fetch (§2.1). That's *desired* behavior (the visible cycling layers should update to match wherever navigation just flew the camera to), not a bug, but call it out so it's not mistaken for an unintended side effect during implementation/testing.
- **`bikemap-app.js`** — this is where the actual work lands: replacing the static `addSource` call with the empty-source-plus-`setData()`-lifecycle from §2, adding the `moveend` listener, and adding the loading/error state (§4) to `render()`. Given the amount of new logic (debounce, abort handling, bbox computation, retry), consider factoring it out of the already-large `firstUpdated()` into a small dedicated helper — either a plain class (`CyclingDataSource`, instantiated with the `map` instance) or a Lit reactive controller — rather than inlining it further into `firstUpdated`. Not a hard requirement, but `firstUpdated()` is already ~230 lines of layer definitions; adding fetch/retry/state logic inline would make it substantially harder to follow.

## 8. Testing approach (Playwright)

Per testing-and-tooling.md §2, Playwright is the E2E backbone for the frontend. For this specific change:

- **Mock the bbox API response.** Use Playwright's `page.route('**/features?*', ...)` to intercept `GET /features` calls and return a small, fixed GeoJSON `FeatureCollection` fixture (a handful of features covering each of the five layers' filter conditions — one route, one designated path, one `track` lane, etc.) rather than depending on a live API/PostGIS instance for these tests. This keeps the UI-layer test suite runnable without the full docker-compose stack (§1 of testing-and-tooling.md) — though an integration-style variant against the real containerized API is worth having too, per that doc's "integration tests... run against the containerized stack" category; that one belongs more to the API-layer's own test plan than duplicated here.
- **Initial load renders data.** Load the app, wait for the mocked `/features` call the initial fetch (§2.1) triggers, and assert the expected layers/features are present (e.g. via `map.queryRenderedFeatures()` executed in-page, or simpler: assert the mock route was hit with the expected initial bbox).
- **Pan triggers a re-fetch.** Simulate a pan (drag the map, or call `map.panTo(...)` in-page) and assert a second `/features` request fires after `moveend` with a bbox reflecting the new viewport — this is the core new behavior this doc introduces and the one most likely to regress silently.
- **Debounce collapses rapid moves.** Simulate several quick consecutive pans/zooms and assert only one `/features` request results (or a bounded small number), not one per gesture — validates §2.2.
- **Error path leaves stale data visible.** Mock `/features` to return a 500 (or abort the route) on the second call, pan the map, and assert the previously-rendered features are still present and some error affordance is shown (§4), rather than the map going blank.
- **Layer toggles still work against the live-updated source.** Re-run (or extend) whatever existing/planned Playwright coverage exercises `layer-widget.js` checkbox toggling, but now against a source that's been populated via `setData()` rather than the static URL — confirms §5's "layers are transparent to source-population method" claim isn't just true in theory.
- **No regression to search/directions.** Existing/planned E2E coverage for `location-search-menu.js` and `mapbox-navigation.js` (per testing-and-tooling.md §2's "exercise search/directions" item) should keep passing unmodified — worth running as a smoke check after this change specifically because §7 notes navigation's camera moves now also trigger cycling-data fetches, which is new coupling worth confirming doesn't introduce timing flakiness (e.g. a route-fitting `fitBounds` animation and its resulting data fetch both resolving fine independently).

## 9. Open questions for Sean

1. **Route relations clipped at bbox edges (§5) — reopened, not resolved.** Previously recorded as resolved in favor of "no clipping" (`api-layer.md` §3: a route's full stored geometry, a single `MultiLineString` row per `persistence-layer.md` §1.1, returned whenever any part intersects the requested bbox), reasoning that `cycling-route-symbols` labels needed a stable, whole geometry to anchor against. Revisited during PRD reconciliation (architecture.md §5/§6): the original framing ("a clipped route will look chopped up") doesn't actually hold, since Mapbox GL already clips *rendering* to the visible canvas regardless of what geometry was fetched — the real, untested cost of clipping is that a route's label anchor point could shift or duplicate across fetches as its clipped fragment changes shape while panning, not that the line itself would look broken. Left open rather than decided; worth a quick experiment against a real long route once this layer is being built.
2. ~~Zoom hint to the API (§6).~~ **Resolved 2026-08-21 (story 3.1): yes, send `zoom` from day one.** `_fetchViewport()` sends `GET /features?bbox=...&zoom=...`, with `zoom` valued from `map.getZoom()` at fetch time, alongside `bbox` — even though the API doesn't act on it yet. This settles Contract A's request shape once rather than requiring a later UI change when zoom-tiered `ST_Simplify` lands server-side. API-layer sign-off isn't a new ask here: `api-layer.md` §2 already reserves the `zoom` param name and explicitly defers only *acting* on it, and story 2.10's `FeaturesEndpoints` already accepts-and-ignores an incoming `zoom` param for exactly this reason — the two layers were already designed to agree on this shape. Recorded in `architecture.md` §2 (Contract A) and §5, and `epics.md` §4 tracker row 6.
3. ~~Padding factor and debounce interval (§2.2, §2.3)~~ **Resolved 2026-08-21 (story 3.2): 200ms debounce, 35% padding**, shipped as named placeholder constants (e.g. `DEBOUNCE_INTERVAL_MS = 200`, `BBOX_PADDING_FACTOR = 0.35`) for 3.4/3.5 to reference rather than re-derive per-PR. 200ms is the exact midpoint of this doc's suggested debounce range (150–250ms per §2.2); 35% is a round number within, not the exact midpoint of, the suggested padding range (25–50% per §2.3, whose midpoint is 37.5%). Neither is a measurement — explicitly flagged as unmeasured placeholders, to be revisited once there's a real deployed API to profile latency against.
4. **Stable feature id in the API response — mostly resolved.** `api-layer.md` §3/§10 confirms `osm_type`/`osm_id` (Contract B's natural key) will be in the response, leaning toward GeoJSON `Feature.id` rather than a properties key. Only the exact encoding (a single id value vs. exposing `osm_type`/`osm_id` separately) remains open — not blocking for this layer's implementation either way.
5. ~~API base URL / environment config.~~ **Resolved 2026-08-21 (story 3.3): webpack `DefinePlugin`, sourced from a `.env` file (via `dotenv`) or a shell env var, local-dev default `http://localhost:5000`.** `website/webpack.config.js` has no existing env-var/`DefinePlugin` convention to match (checked directly — `website/package.json` has only `start`/`build` scripts and no `dotenv` dependency, so it'll need adding in the implementation PR). `API_BASE_URL` is injected as a build-time constant via `webpack.DefinePlugin`, read from `process.env.API_BASE_URL` (populated by `dotenv` from a gitignored `website/.env`, falling back to whatever the shell environment already has) with a documented local-dev default of `http://localhost:5000` — the host port Epic 2's `docker-compose.yml` `api` service actually publishes (`"5000:8080"`, confirmed directly against the compose file, not guessed). Production hosting wasn't decided as part of this story (out of scope per `epics.md` §3 at the time); it's since been settled in [`deployment.md`](../deployment.md) (`https://bikemap-api.seanerice.dev`) — this entry only records how the frontend *build* resolves the value, which stories 3.4+ build on unchanged.
