/**
 * One run at a time per key. A call while one runs gets that run's promise;
 * with `fresh` it gets one more run queued behind it instead (shared by every
 * fresh call meanwhile), since the running one may predate a change.
 */
export function singleFlight<K>() {
    const running = new Map<K, Promise<void>>();
    const queued = new Map<K, Promise<void>>();
    return function run(key: K, task: () => Promise<void>, fresh = false): Promise<void> {
        const current = running.get(key);
        if (current) {
            if (!fresh) return current;
            let next = queued.get(key);
            if (!next) {
                const rerun = () => {
                    queued.delete(key);
                    return run(key, task);
                };
                next = current.then(rerun, rerun);
                queued.set(key, next);
            }
            return next;
        }
        const request = task().finally(() => running.delete(key));
        running.set(key, request);
        return request;
    };
}
