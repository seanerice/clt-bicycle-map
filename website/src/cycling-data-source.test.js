import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CyclingDataSource, FETCH_TIMEOUT_MS } from './cycling-data-source.js';

// API_BASE_URL is normally injected at build time by webpack's DefinePlugin
// (see webpack.config.js). Vitest doesn't go through webpack, so provide the
// same bare global the built code expects.
globalThis.API_BASE_URL = 'http://localhost:5000';

function createFakeMap() {
    return {
        getBounds: () => ({
            getWest: () => -81,
            getSouth: () => 35,
            getEast: () => -80,
            getNorth: () => 36
        }),
        getZoom: () => 10,
        getSource: vi.fn(() => ({ setData: vi.fn() }))
    };
}

/** A fetch() response that only ever settles if/when its signal is aborted — mirrors how a real in-flight request behaves. */
function neverResolvesUntilAborted(signal) {
    return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
        });
    });
}

describe('CyclingDataSource', () => {
    let fetchMock;

    beforeEach(() => {
        fetchMock = vi.fn();
        globalThis.fetch = fetchMock;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('aborts the first fetch\'s signal when a second fetch is issued before it resolves', async () => {
        const map = createFakeMap();
        const source = new CyclingDataSource(map);

        let firstSignal;
        fetchMock.mockImplementationOnce((url, { signal }) => {
            firstSignal = signal;
            return neverResolvesUntilAborted(signal);
        });
        fetchMock.mockImplementationOnce(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({ type: 'FeatureCollection', features: [] })
            })
        );

        const firstFetch = source._fetchViewport();
        expect(firstSignal.aborted).toBe(false);

        const secondFetch = source._fetchViewport();
        // The second call must abort the first's in-flight request immediately
        // (synchronously, via this._abortPreviousFetch), not wait for it to settle.
        expect(firstSignal.aborted).toBe(true);

        await Promise.all([firstFetch, secondFetch]);

        // The superseded first request is swallowed silently, not surfaced as an error.
        expect(source._hasFetchError).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('sets _hasFetchError on a genuine timeout, distinct from a superseded-request abort', async () => {
        vi.useFakeTimers();
        const map = createFakeMap();
        const source = new CyclingDataSource(map);

        fetchMock.mockImplementationOnce((url, { signal }) => neverResolvesUntilAborted(signal));

        const fetchPromise = source._fetchViewport();

        // No second fetch supersedes this one — let it run past FETCH_TIMEOUT_MS
        // so the request's own timeout is what aborts it.
        await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
        await fetchPromise;

        expect(source._hasFetchError).toBe(true);
        expect(source._isLoadingFeatures).toBe(false);
    });
});
