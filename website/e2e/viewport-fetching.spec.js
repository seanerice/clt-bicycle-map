// Playwright coverage for stories 3.4-3.8's viewport-based fetching
// (story 3.9). Mocks the bbox API per docs/planning/layers/ui-layer.md §8 —
// no docker-compose stack required. One test per stories.md 3.9 AC.
const { test, expect } = require('@playwright/test');
const { mockFeaturesRoute, waitForMapReady, renderedFeatureCount } = require('./helpers');

test.describe('viewport-based cycling data fetching', () => {
    test('initial load renders data without any prior user gesture', async ({ page }) => {
        const { requests } = await mockFeaturesRoute(page);

        await page.goto('/');

        // No pan/zoom/click happened yet — this request only exists because
        // of story 3.6's explicit scheduleFetch() call right after map
        // 'load', covering the "moveend doesn't fire for the initial
        // viewport" gap ui-layer.md §2.1 flags.
        await expect.poll(() => requests.length).toBeGreaterThanOrEqual(1);

        const initialRequestUrl = new URL(requests[0]);
        expect(initialRequestUrl.pathname).toBe('/features');
        expect(initialRequestUrl.searchParams.get('bbox')).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
        expect(initialRequestUrl.searchParams.get('zoom')).not.toBeNull();

        await waitForMapReady(page);

        // Fixture covers one feature per style-layer filter condition —
        // confirm all render, and that the proposed route is excluded by
        // the `state != 'proposed'` clause in cycling-route-lines' filter.
        await expect.poll(() => renderedFeatureCount(page, 'cycling-route-lines')).toBe(1);
        // The symbol layer needs glyphs fetched from Mapbox's real style/
        // font APIs (not mocked here — only /features is) before it can
        // place a label, so give it more headroom than the line layers.
        await expect.poll(() => renderedFeatureCount(page, 'cycling-route-symbols'), { timeout: 15000 }).toBe(1);
        await expect.poll(() => renderedFeatureCount(page, 'cycling-paths')).toBe(1);
        await expect.poll(() => renderedFeatureCount(page, 'cycling-lanes-right')).toBe(1);
    });

    test('pan triggers a re-fetch with a different bbox', async ({ page }) => {
        const { requests } = await mockFeaturesRoute(page);
        await page.goto('/');
        await waitForMapReady(page);
        await expect.poll(() => requests.length).toBeGreaterThanOrEqual(1);
        const requestCountBeforePan = requests.length;
        const firstBbox = new URL(requests[0]).searchParams.get('bbox');

        await page.evaluate(() => {
            const map = document.querySelector('bikemap-app')._cyclingDataSource._map;
            map.panTo([-80.70, 35.15], { duration: 0 });
        });

        await expect.poll(() => requests.length).toBeGreaterThan(requestCountBeforePan);

        const secondBbox = new URL(requests[requests.length - 1]).searchParams.get('bbox');
        expect(secondBbox).not.toBe(firstBbox);
    });

    test('debounce collapses a burst of rapid moves into one re-fetch', async ({ page }) => {
        const { requests } = await mockFeaturesRoute(page);
        await page.goto('/');
        await waitForMapReady(page);
        await expect.poll(() => requests.length).toBeGreaterThanOrEqual(1);
        const requestCountBeforeBurst = requests.length;

        // Five immediate camera jumps back-to-back, no waiting between them
        // — each fires its own 'moveend', but CyclingDataSource's
        // scheduleFetch is debounced 200ms (DEBOUNCE_INTERVAL_MS,
        // cycling-data-source.js), so only the trailing one should survive.
        await page.evaluate(() => {
            const map = document.querySelector('bikemap-app')._cyclingDataSource._map;
            const centers = [
                [-80.83, 35.24],
                [-80.82, 35.23],
                [-80.81, 35.22],
                [-80.80, 35.21],
                [-80.79, 35.20]
            ];
            for (const center of centers) {
                map.jumpTo({ center });
            }
        });

        // Give the 200ms debounce window (plus margin) time to settle, then
        // confirm it collapsed to exactly one new request, not five.
        await page.waitForTimeout(600);
        expect(requests.length - requestCountBeforeBurst).toBe(1);
    });

    test('error path leaves previously-rendered features visible and shows the error notice', async ({ page }) => {
        const { requests, setFailing } = await mockFeaturesRoute(page);
        await page.goto('/');
        await waitForMapReady(page);
        await expect.poll(() => requests.length).toBeGreaterThanOrEqual(1);

        await expect.poll(() => renderedFeatureCount(page, 'cycling-route-lines')).toBe(1);
        await expect.poll(() => renderedFeatureCount(page, 'cycling-paths')).toBe(1);
        await expect.poll(() => renderedFeatureCount(page, 'cycling-lanes-right')).toBe(1);

        setFailing(true);
        await page.evaluate(() => {
            const map = document.querySelector('bikemap-app')._cyclingDataSource._map;
            map.panTo([-80.70, 35.15], { duration: 0 });
        });

        // hasFetchError flips true as soon as the mocked 500 response is
        // processed (story 3.8's _setErrorState) — no need to wait out the
        // full RETRY_DELAY_MS bounded retry for this assertion.
        await page.waitForFunction(() => document.querySelector('bikemap-app')._hasFetchError === true);

        await expect(page.locator('.fetch-error-notice')).toBeVisible();
        await expect(page.locator('.fetch-error-notice')).toContainText("Couldn't refresh map data");

        // The map must not have been blanked — last-good setData() output
        // (ui-layer.md §4) is still on screen.
        expect(await renderedFeatureCount(page, 'cycling-route-lines')).toBe(1);
        expect(await renderedFeatureCount(page, 'cycling-paths')).toBe(1);
        expect(await renderedFeatureCount(page, 'cycling-lanes-right')).toBe(1);
    });
});
