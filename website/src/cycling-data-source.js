import { debounce } from './debounce.js';

// See docs/planning/layers/ui-layer.md §9 items 2/3 — resolved, not re-derived here.
const DEBOUNCE_INTERVAL_MS = 200;
const BBOX_PADDING_FACTOR = 0.35;
// A few seconds, per ui-layer.md §4 — timeout behaves identically to any
// other fetch error (same AbortController/signal path, not a special case).
const FETCH_TIMEOUT_MS = 8000;
// Story 3.8: a single automatic retry is acceptable on a failed fetch, after
// a short delay; beyond that, wait for the next moveend rather than looping.
const RETRY_DELAY_MS = 1500;

const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };

/**
 * Keeps the `cycling-data` Mapbox GL source in sync with the live bbox API
 * (`GET /features?bbox=...&zoom=...`) as the map's viewport changes.
 *
 * Per docs/planning/layers/ui-layer.md §3 (Option B), this never merges or
 * caches: each successful response replaces the source's contents outright
 * via `setData()`. There is no client-side region tracking or feature dedup.
 */
export class CyclingDataSource {
    /**
     * @param {object} [options]
     * @param {string} [options.sourceId]
     * @param {(state: { isLoadingFeatures: boolean, hasFetchError: boolean, errorJustOccurred: boolean }) => void} [options.onStateChange]
     *   Invoked whenever `isLoadingFeatures`/`hasFetchError` change, so a Lit
     *   host (bikemap-app.js) can mirror them into its own reactive
     *   properties and re-render (story 3.8). This class stays framework-
     *   agnostic — it doesn't import Lit or drive rendering itself.
     *   `errorJustOccurred` is only true on the notification where
     *   `hasFetchError` just flipped false→true (a genuinely new failure) —
     *   see `_notifyStateChange` — so a host can use it to decide whether to
     *   re-surface an error notice the user previously dismissed, without
     *   the notice un-dismissing itself on every unrelated state change
     *   (e.g. a loading-state toggle) that happens to occur while an error
     *   is still active.
     */
    constructor(map, { sourceId = 'cycling-data', onStateChange } = {}) {
        this._map = map;
        this._sourceId = sourceId;
        this._abortPreviousFetch = null;
        this._retryTimeoutId = null;
        this._onStateChange = onStateChange;

        // Internal state (ui-layer.md §4), mirrored out via onStateChange
        // above; also readable directly (and via the getters below) for
        // tests/consumers that don't need reactivity.
        this._isLoadingFeatures = false;
        this._hasFetchError = false;

        this.scheduleFetch = debounce(() => this._fetchViewport(), DEBOUNCE_INTERVAL_MS);
    }

    get isLoadingFeatures() {
        return this._isLoadingFeatures;
    }

    get hasFetchError() {
        return this._hasFetchError;
    }

    /** Reads the current viewport and pads it by BBOX_PADDING_FACTOR. */
    _computeBbox() {
        const bounds = this._map.getBounds();
        const west = bounds.getWest();
        const south = bounds.getSouth();
        const east = bounds.getEast();
        const north = bounds.getNorth();

        const lonPad = (east - west) * BBOX_PADDING_FACTOR;
        const latPad = (north - south) * BBOX_PADDING_FACTOR;

        return [west - lonPad, south - latPad, east + lonPad, north + latPad];
    }

    /**
     * Fetches features for the current (padded) viewport and, on success,
     * replaces the source's data. Aborts any still-in-flight previous fetch
     * first, so a fast pan-back can't have a stale, larger response overwrite
     * a newer, correct one by resolving second.
     *
     * @param {boolean} [isRetry] Internal — true when this call is the single
     *   bounded retry (ui-layer.md §4) scheduled after a genuine failure, so
     *   that attempt doesn't schedule a further retry of its own.
     */
    async _fetchViewport(isRetry = false) {
        // A fresh fetch (a new moveend, debounced or not) supersedes any
        // retry that was scheduled after an earlier failure.
        if (this._retryTimeoutId !== null) {
            clearTimeout(this._retryTimeoutId);
            this._retryTimeoutId = null;
        }

        const bbox = this._computeBbox();
        const zoom = this._map.getZoom();

        const controller = new AbortController();
        this._abortPreviousFetch?.();
        this._abortPreviousFetch = () => controller.abort();

        // Both the "superseded by a newer moveend" abort and the timeout
        // abort below go through the same AbortController/signal (per §4 —
        // a timeout is not a special case), which means both surface as the
        // same `AbortError` in the catch block. `timedOut` is how we tell
        // them apart: a supersede is expected and silent, a timeout is a
        // real failure and must set _hasFetchError like any other error.
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, FETCH_TIMEOUT_MS);

        try {
            this._setLoadingState(true);
            // API_BASE_URL is injected at build time by webpack's DefinePlugin
            // (see webpack.config.js), sourced from website/.env or the shell.
            const url = `${API_BASE_URL}/features?bbox=${bbox.join(',')}&zoom=${zoom}`;
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) {
                throw new Error(`API returned ${res.status}`);
            }
            const geojson = await res.json();
            this._mergeAndSetData(geojson);
            this._setErrorState(false);
        } catch (err) {
            if (err.name === 'AbortError' && !timedOut) {
                // Superseded by a newer fetch — not a real error.
                return;
            }
            this._setErrorState(true);
            console.error('Failed to fetch cycling data for viewport', err);

            // Story 3.8: one bounded automatic retry after a short delay,
            // then give up until the next moveend — no retry loop.
            if (!isRetry) {
                this._retryTimeoutId = setTimeout(() => {
                    this._retryTimeoutId = null;
                    this._fetchViewport(true);
                }, RETRY_DELAY_MS);
            }
        } finally {
            clearTimeout(timeoutId);
            this._setLoadingState(false);
        }
    }

    /**
     * Option B (ui-layer.md §3): replace the source's contents outright with
     * each response. No caching, no feature-id dedup, no eviction logic.
     */
    _mergeAndSetData(geojson) {
        this._map.getSource(this._sourceId)?.setData(geojson);
    }

    _setLoadingState(isLoading) {
        if (this._isLoadingFeatures === isLoading) return;
        this._isLoadingFeatures = isLoading;
        this._notifyStateChange();
    }

    _setErrorState(hasError) {
        if (this._hasFetchError === hasError) return;
        this._hasFetchError = hasError;
        // This setter only ever runs when hasFetchError actually changed
        // (guarded above), so hasError === true here always means a genuine
        // false→true transition — a *new* failure, not a still-failing
        // state re-notifying because something else (loading) changed.
        this._notifyStateChange({ errorJustOccurred: hasError });
    }

    /**
     * @param {{ errorJustOccurred?: boolean }} [extra] `errorJustOccurred`
     *   is true only when this notification is the one where hasFetchError
     *   just flipped false→true — never merely "hasFetchError happens to be
     *   true right now" (e.g. a loading-state toggle during a still-failing
     *   retry must not report this as true). A host uses this to decide
     *   whether to re-surface a dismissed error notice.
     */
    _notifyStateChange(extra = {}) {
        this._onStateChange?.({
            isLoadingFeatures: this._isLoadingFeatures,
            hasFetchError: this._hasFetchError,
            errorJustOccurred: false,
            ...extra
        });
    }
}

export { EMPTY_FEATURE_COLLECTION, DEBOUNCE_INTERVAL_MS, BBOX_PADDING_FACTOR, FETCH_TIMEOUT_MS, RETRY_DELAY_MS };
