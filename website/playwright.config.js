const { defineConfig, devices } = require('@playwright/test');

// Chromium only (per stories.md 3.9) — no need for the full browser matrix
// for this suite. Runs against the webpack dev server (`npm run start`),
// which serves the same build the app ships (webpack.config.js's
// DefinePlugin injects API_BASE_URL into it) rather than a separate test
// build, so there's nothing extra to keep in sync.
//
// Story 3.9/3.10 tests mock the `/features` bbox API and Mapbox's own
// Geocoding/Directions APIs via page.route() — no docker-compose stack, no
// live API, per testing-and-tooling.md's "one definition, two uses" (that
// stack is the API/Epic-7 test plan's job, not this one's). CI wiring for
// this suite is explicitly out of scope here too (Epic 7).
module.exports = defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'list',
    // Playwright's implicit default (5000ms) is tight enough to flake under
    // real local-dev conditions: full fullyParallel execution across 7
    // Chromium workers contends for CPU, and the map's own 'load' event
    // (mapbox-gl style/tile fetch, well before any /features mocking comes
    // into play) can take longer than 5s to fire as a result — reproduced
    // as an intermittent failure on "initial load renders data..." (its
    // first expect.poll, still on the implicit default, was the one
    // assertion in the suite not already given an explicit longer timeout
    // like the others in viewport-fetching.spec.js). Raising the suite-wide
    // default here, rather than special-casing that one assertion, guards
    // the same contention window for every other assertion still on the
    // implicit default too.
    expect: { timeout: 10000 },
    use: {
        baseURL: 'http://localhost:8080',
        trace: 'retain-on-failure'
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
    ],
    webServer: {
        command: 'npm run start',
        url: 'http://localhost:8080',
        reuseExistingServer: !process.env.CI,
        timeout: 120000
    }
});
