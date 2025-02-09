/**
 * Get current time in milliseconds. Use it to measure time difference. Reference time may differ
 * on different platforms.
 *
 * @returns {number} The time in milliseconds.
 * @private
 */
const now = (typeof window !== 'undefined') && window.performance && window.performance.now && window.performance.timing ? function () {
    return window.performance.now();
} : Date.now;

/**
 * A Timer counts milliseconds from when start() is called until when stop() is called.
 *
 * @private
 */
class Timer {
    /**
     * Create a new Timer instance.
     *
     * @private
     */
    constructor() {
        this._isRunning = false;
        this._a = 0;
        this._b = 0;
    }

    /**
     * Start the timer.
     *
     * @private
     */
    start() {
        this._isRunning = true;
        this._a = now();
    }

    /**
     * Stop the timer.
     *
     * @private
     */
    stop() {
        this._isRunning = false;
        this._b = now();
    }

    /**
     * Get the number of milliseconds that passed between start() and stop() being called.
     *
     * @returns {number} The elapsed milliseconds.
     * @private
     */
    getMilliseconds() {
        return this._b - this._a;
    }
}

export { now, Timer };
