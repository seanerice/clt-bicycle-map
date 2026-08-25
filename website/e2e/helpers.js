const { CYCLING_DATA_FIXTURE } = require('./fixtures/cycling-data');

/**
 * Intercepts GET /features?bbox=...&zoom=... (the live bbox API
 * cycling-data-source.js calls — see ui-layer.md §8) and returns a fixed
 * fixture. Must be registered *before* page.goto() to also catch the
 * very first, no-user-gesture-required request bikemap-app.js#firstUpdated
 * fires on map 'load' (story 3.6).
 *
 * The glob `**\/features*` is verified (not assumed) to match the app's real
 * request URL — `${API_BASE_URL}/features?bbox=...&zoom=...`, where
 * API_BASE_URL is whatever website/webpack.config.js's DefinePlugin baked
 * in (local-dev default http://localhost:5000, per ui-layer.md §9 item 5) —
 * by the passing "initial load" test in viewport-fetching.spec.js, which
 * asserts on a captured request rather than just on rendered features.
 *
 * Returns `{ requests, setFailing }`:
 *   - `requests`: array of every intercepted request URL, in order, mutated
 *     live (not a snapshot) so callers can read `.length` at any point.
 *   - `setFailing(true)`: from then on, every intercepted request gets a 500
 *     instead of the fixture — used by the error-path test.
 */
function mockFeaturesRoute(page, fixture = CYCLING_DATA_FIXTURE) {
    const requests = [];
    let failing = false;

    return page.route('**/features*', async (route) => {
        requests.push(route.request().url());
        if (failing) {
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'mocked server error' })
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/geo+json',
            body: JSON.stringify(fixture)
        });
    }).then(() => ({
        requests,
        setFailing: (value) => {
            failing = value;
        }
    }));
}

/**
 * Waits until bikemap-app.js#firstUpdated's map 'load' handler has run
 * (CyclingDataSource constructed, all five layers added — see
 * bikemap-app.js) so in-page map access is safe.
 *
 * Reaches the mapboxgl.Map instance via
 * `document.querySelector('bikemap-app')._cyclingDataSource._map` —
 * both are plain (underscore-convention, not JS #-private) instance
 * properties already on BikeMapApp/CyclingDataSource, so this needs no
 * production code change or added test hook.
 */
async function waitForMapReady(page) {
    await page.waitForFunction(() => {
        const app = document.querySelector('bikemap-app');
        return !!(app && app._cyclingDataSource && app._cyclingDataSource._map);
    });
}

/**
 * In-page: number of *distinct* rendered features on `layerId` right now,
 * deduped by serialized `properties`. queryRenderedFeatures() returns one
 * result per render tile a feature's geometry touches — a short LineString
 * straddling a tile boundary at low zoom can legitimately come back twice
 * for the same logical feature, so a raw `.length` overcounts. Every fixture
 * feature (cycling-data.js) has unique properties, so dedup-by-properties
 * correctly collapses that without masking an actually-missing/duplicated
 * feature.
 */
function renderedFeatureCount(page, layerId) {
    return page.evaluate((id) => {
        const app = document.querySelector('bikemap-app');
        const features = app._cyclingDataSource._map.queryRenderedFeatures({ layers: [id] });
        const distinct = new Set(features.map((f) => JSON.stringify(f.properties)));
        return distinct.size;
    }, layerId);
}

module.exports = { mockFeaturesRoute, waitForMapReady, renderedFeatureCount, CYCLING_DATA_FIXTURE };
