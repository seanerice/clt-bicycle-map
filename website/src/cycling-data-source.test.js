import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CyclingDataSource, FETCH_TIMEOUT_MS, RETRY_DELAY_MS } from './cycling-data-source.js';

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

    it('retries once after a failed fetch, and recovers if the retry succeeds', async () => {
        vi.useFakeTimers();
        const map = createFakeMap();
        const source = new CyclingDataSource(map);
        const stateChanges = [];
        source._onStateChange = (state) => stateChanges.push({ ...state });

        fetchMock.mockImplementationOnce(() => Promise.reject(new Error('network down')));
        fetchMock.mockImplementationOnce(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({ type: 'FeatureCollection', features: [] })
            })
        );

        const fetchPromise = source._fetchViewport();
        await vi.advanceTimersByTimeAsync(0);
        await fetchPromise;

        // First attempt failed — error surfaced immediately, no retry yet.
        expect(source._hasFetchError).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // The retry fires ~RETRY_DELAY_MS later and this time succeeds.
        await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(source._hasFetchError).toBe(false);
    });

    it('does not schedule a second retry when the retry attempt also fails', async () => {
        vi.useFakeTimers();
        const map = createFakeMap();
        const source = new CyclingDataSource(map);

        fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));

        const fetchPromise = source._fetchViewport();
        await vi.advanceTimersByTimeAsync(0);
        await fetchPromise;

        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Let the single retry run (and fail too).
        await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(source._hasFetchError).toBe(true);

        // No further retries — even waiting well past another retry window,
        // the call count doesn't grow again until a fresh _fetchViewport().
        await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 5);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('cancels a pending retry when a new fetch is scheduled before it fires', async () => {
        vi.useFakeTimers();
        const map = createFakeMap();
        const source = new CyclingDataSource(map);

        fetchMock.mockImplementationOnce(() => Promise.reject(new Error('network down')));
        fetchMock.mockImplementationOnce(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({ type: 'FeatureCollection', features: [] })
            })
        );

        const firstFetch = source._fetchViewport();
        await vi.advanceTimersByTimeAsync(0);
        await firstFetch;
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // A new moveend-triggered fetch arrives before the retry timer fires.
        const secondFetch = source._fetchViewport();
        await vi.advanceTimersByTimeAsync(0);
        await secondFetch;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(source._hasFetchError).toBe(false);

        // The now-cancelled original retry must not fire a third fetch later.
        await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
