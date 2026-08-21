import { debounce } from './debounce.js';

// See docs/planning/layers/ui-layer.md §9 items 2/3 — resolved, not re-derived here.
const DEBOUNCE_INTERVAL_MS = 200;
const BBOX_PADDING_FACTOR = 0.35;
// A few seconds, per ui-layer.md §4 — timeout behaves identically to any
// other fetch error (same AbortController/signal path, not a special case).
const FETCH_TIMEOUT_MS = 8000;

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
    constructor(map, { sourceId = 'cycling-data' } = {}) {
        this._map = map;
        this._sourceId = sourceId;
        this._abortPreviousFetch = null;

        // Internal state only (ui-layer.md §4) — not wired into any UI yet;
        // that's story 3.8. Exposed as plain properties so a later PR can
        // read them without needing to change this class's shape.
        this._isLoadingFeatures = false;
        this._hasFetchError = false;

        this.scheduleFetch = debounce(() => this._fetchViewport(), DEBOUNCE_INTERVAL_MS);
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
     */
    async _fetchViewport() {
        const bbox = this._computeBbox();
        const zoom = this._map.getZoom();

        const controller = new AbortController();
        this._abortPreviousFetch?.();
        this._abortPreviousFetch = () => controller.abort();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

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
            if (err.name === 'AbortError') {
                // Superseded by a newer fetch (or timed out) — not a real error.
                return;
            }
            this._setErrorState(true);
            console.error('Failed to fetch cycling data for viewport', err);
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
        this._isLoadingFeatures = isLoading;
    }

    _setErrorState(hasError) {
        this._hasFetchError = hasError;
    }
}

export { EMPTY_FEATURE_COLLECTION };
