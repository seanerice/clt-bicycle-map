const { defineConfig } = require('vitest/config');

// Explicit include, rather than relying on vitest's default
// `**/*.{test,spec}.?(c|m)[jt]s?(x)` glob, so this suite never picks up the
// Playwright specs under e2e/ (which use @playwright/test's `test`/`expect`,
// not vitest's, and are run separately via `npm run test:e2e` — see
// playwright.config.js).
module.exports = defineConfig({
    test: {
        include: ['src/**/*.test.js']
    }
});
