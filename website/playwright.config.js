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
    // Capped rather than left at Playwright's default (one worker per
    // logical core, e.g. 7 on this machine). A worker cap of 4 was chosen
    // by testing: 7 workers left `npm run start`'s webpack-dev-server (a
    // single-threaded Node process) fielding 7 simultaneous Chromium
    // instances' worth of asset/tile/style requests, which occasionally
    // delayed the map's own 'load' event past even a 10s expect.timeout —
    // an architectural contention problem a longer timeout only narrows,
    // not fixes (see the "initial load" test's history). Confirmed clean
    // across 10 consecutive full-suite runs at this cap — see the commit
    // introducing this comment for the exact per-run results.
    workers: process.env.CI ? 1 : 4,
    reporter: 'list',
    // Playwright's implicit default (5000ms) was tight enough to flake
    // under the pre-worker-cap parallel load described above: the map's own
    // 'load' event (mapbox-gl style/tile fetch, well before any /features
    // mocking comes into play) occasionally took longer than 5s to fire —
    // reproduced as an intermittent failure on "initial load renders
    // data..." (its first expect.poll, still on the implicit default, was
    // the one assertion in the suite not already given an explicit longer
    // timeout like the others in viewport-fetching.spec.js). Left raised
    // even after the workers cap above fixed the actual contention, as a
    // reasonable floor and a second line of defense — it's the suite-wide
    // default, so it also covers every other assertion still on the
    // implicit default, not just that one.
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
