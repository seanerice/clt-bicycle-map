import { describe, it, expect, vi, afterEach } from 'vitest';
import { debounce } from './debounce.js';

describe('debounce', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('collapses rapid-fire calls into a single trailing invocation', () => {
        vi.useFakeTimers();
        const fn = vi.fn();
        const debounced = debounce(fn, 200);

        debounced();
        debounced();
        debounced();

        // None of the rapid calls should have fired yet — each one resets the timer.
        expect(fn).not.toHaveBeenCalled();

        vi.advanceTimersByTime(200);

        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('forwards the arguments from the last call', () => {
        vi.useFakeTimers();
        const fn = vi.fn();
        const debounced = debounce(fn, 200);

        debounced('first');
        debounced('second');
        debounced('third');

        vi.advanceTimersByTime(200);

        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('third');
    });
});
