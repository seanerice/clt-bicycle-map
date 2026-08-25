// Story 3.10 — explicit regression verification (not "no code changed so
// it's fine") that FR-4 (layer toggles), FR-7 (search), and FR-8
// (directions) still work against the new setData()-driven source, and
// that mapbox-navigation.js's camera moves correctly couple into exactly
// one cycling-data fetch each via the new moveend listener (story 3.6).
//
// None of layer-widget.js, location-search-menu.js, or mapbox-navigation.js
// were changed to make these tests pass — see the PR's report/commit for
// the explicit confirmation stories.md 3.10 calls for.
const { test, expect } = require('@playwright/test');
const { mockFeaturesRoute, waitForMapReady, renderedFeatureCount } = require('./helpers');

test.describe('FR-4/7/8 regression against the live-fetched source', () => {
    test('FR-4: toggling the "Routes" layer off/on leaves lane/path rendering unaffected', async ({ page }) => {
        await mockFeaturesRoute(page);
        await page.goto('/');
        await waitForMapReady(page);

        await expect.poll(() => renderedFeatureCount(page, 'cycling-route-lines')).toBe(1);
        await expect.poll(() => renderedFeatureCount(page, 'cycling-route-symbols'), { timeout: 15000 }).toBe(1);
        await expect.poll(() => renderedFeatureCount(page, 'cycling-paths')).toBe(1);
        await expect.poll(() => renderedFeatureCount(page, 'cycling-lanes-right')).toBe(1);

        // The menu (and layer-widget inside it) is translated off-screen
        // until #menu-checkbox is checked. Its <label> wrapper has zero
        // rendered area itself (its icon children are `position: fixed`,
        // taken out of flow — see bikemap-app.js's `label #menu-button`
        // rule), so click the icon directly; the click still bubbles
        // through the label ancestor and toggles the checkbox natively,
        // same as a real user clicking the visible menu button.
        await page.locator('#menu-button').click();

        // A plain `ser-checkbox#routes input#checkbox` CSS selector matches
        // every nested checkbox too (Greenway/Signed/Suggested Routes are
        // its slotted children, still descendants in the piercing-shadow
        // sense) — target the top-level one by its accessible role/name
        // instead, which ser-checkbox's own <label for="checkbox"> gives it.
        await page.getByRole('checkbox', { name: 'Routes', exact: true }).click();

        await expect.poll(() => renderedFeatureCount(page, 'cycling-route-lines')).toBe(0);
        await expect.poll(() => renderedFeatureCount(page, 'cycling-route-symbols')).toBe(0);
        // Untouched by the toggle — layer-widget.js only ever calls
        // setFilter/setLayoutProperty on the layer ids it owns.
        expect(await renderedFeatureCount(page, 'cycling-paths')).toBe(1);
        expect(await renderedFeatureCount(page, 'cycling-lanes-right')).toBe(1);

        await page.getByRole('checkbox', { name: 'Routes', exact: true }).click();

        await expect.poll(() => renderedFeatureCount(page, 'cycling-route-lines')).toBe(1);
        await expect.poll(() => renderedFeatureCount(page, 'cycling-route-symbols')).toBe(1);
    });

    test('FR-7: a location search recenters the map and triggers exactly one cycling-data fetch', async ({ page }) => {
        const { requests } = await mockFeaturesRoute(page);
        await page.route('https://api.mapbox.com/geocoding/**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    type: 'FeatureCollection',
                    features: [
                        {
                            text: 'Test Location',
                            place_name: 'Test Location Ave, Charlotte, NC 28202',
                            center: [-80.80, 35.20]
                        }
                    ]
                })
            });
        });

        await page.goto('/');
        await waitForMapReady(page);
        await expect.poll(() => requests.length).toBeGreaterThanOrEqual(1);
        const requestCountBeforeSearch = requests.length;

        await page.locator('#location-search-input').fill('Test Location');
        await page.locator('.search-bar button').click();

        await page.locator('a.menu-item', { hasText: 'Test Location Ave' }).click();

        // location-search-menu.js dispatches location-selected ->
        // bikemap-app.js's handler -> mapbox-navigation.js's _setCoord ->
        // map.flyTo(...) (duration 2000ms) -> exactly one moveend.
        await page.waitForFunction(() => {
            const map = document.querySelector('bikemap-app')._cyclingDataSource._map;
            const center = map.getCenter();
            return Math.abs(center.lng - -80.80) < 0.01 && Math.abs(center.lat - 35.20) < 0.01;
        }, { timeout: 10000 });

        await expect.poll(() => requests.length, { timeout: 10000 }).toBe(requestCountBeforeSearch + 1);
    });

    test('FR-8: requesting directions renders the route alongside cycling layers, with no stuck loading/error state', async ({ page }) => {
        const { requests } = await mockFeaturesRoute(page);
        await page.route('https://api.mapbox.com/directions/**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    routes: [
                        {
                            geometry: {
                                type: 'LineString',
                                coordinates: [
                                    [-80.85, 35.25],
                                    [-80.83, 35.23],
                                    [-80.81, 35.21]
                                ]
                            }
                        }
                    ]
                })
            });
        });

        await page.goto('/');
        await waitForMapReady(page);
        await expect.poll(() => requests.length).toBeGreaterThanOrEqual(1);
        const requestCountBeforeDirections = requests.length;

        // Drives mapbox-navigation.js's own public (underscore-convention,
        // not #-private) methods directly, the same in-page-hook pattern
        // used for map.panTo() elsewhere in this suite — sets a start point
        // first (triggers _setCoord's flyTo branch, since the end point
        // isn't set yet), then an end point (triggers the getRoute/
        // _fitScreenToPoints branch, since both are now set).
        await page.evaluate(() => {
            const nav = document.querySelector('bikemap-app').shadowRoot.getElementById('navigation');
            nav._inputFocusHandler(0)();
            nav._setCoord([-80.85, 35.25], 'Start Point');
        });

        // _setCoord's flyTo branch (duration 2000ms) -> exactly one moveend
        // -> exactly one new cycling-data fetch, independent of directions.
        await expect.poll(() => requests.length, { timeout: 10000 }).toBe(requestCountBeforeDirections + 1);
        const requestCountAfterFlyTo = requests.length;

        await page.evaluate(() => {
            const nav = document.querySelector('bikemap-app').shadowRoot.getElementById('navigation');
            nav._inputFocusHandler(1)();
            nav._setCoord([-80.81, 35.21], 'End Point');
        });

        // getRoute() (mocked Directions API) resolves, route layer/source
        // populated, then _fitScreenToPoints's fitBounds (duration 2000ms)
        // -> its own exactly-one moveend -> exactly one more fetch.
        await page.waitForFunction(() => {
            const map = document.querySelector('bikemap-app')._cyclingDataSource._map;
            return !!map.getLayer('route');
        }, { timeout: 10000 });

        await expect.poll(() => requests.length, { timeout: 10000 }).toBe(requestCountAfterFlyTo + 1);

        // Both the navigation route and the infrastructure layers are
        // visible simultaneously, and nothing races into an error/stuck
        // state as a result of the coupling.
        await expect.poll(() => {
            return page.evaluate(() => {
                const map = document.querySelector('bikemap-app')._cyclingDataSource._map;
                return map.queryRenderedFeatures({ layers: ['route'] }).length;
            });
        }).toBeGreaterThan(0);
        expect(await renderedFeatureCount(page, 'cycling-paths')).toBe(1);
        expect(await renderedFeatureCount(page, 'cycling-lanes-right')).toBe(1);

        await expect.poll(() => page.evaluate(() => document.querySelector('bikemap-app')._isLoadingFeatures)).toBe(false);
        expect(await page.evaluate(() => document.querySelector('bikemap-app')._hasFetchError)).toBeFalsy();
    });
});
