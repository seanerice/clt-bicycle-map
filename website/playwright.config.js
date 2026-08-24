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
