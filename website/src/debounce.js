/**
 * Returns a debounced wrapper around `fn`: calling the wrapper repeatedly only
 * invokes `fn` once, `delayMs` after the last call. Used to collapse a burst
 * of `moveend` events (e.g. a few quick scroll-zooms) into a single fetch of
 * the final viewport rather than one fetch per event.
 */
export function debounce(fn, delayMs) {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delayMs);
    };
}
