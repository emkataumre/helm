// src/main/engine/mutex.ts
// A keyed single-flight async lock: calls sharing a key run strictly one-at-a-time in arrival order
// (FIFO), while different keys are independent and run concurrently. This is the primitive behind
// at-most-one-merge-in-flight per project (key = projectId). Tiny and dependency-free by design.
export interface KeyedMutex {
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createKeyedMutex(): KeyedMutex {
    // One promise chain per key; the tail is the lock. A new call appends fn after the current tail.
    const tails = new Map<string, Promise<unknown>>();
    return {
        withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
            const prev = tails.get(key) ?? Promise.resolve();
            // Run fn once prev SETTLES — both branches call fn, so a prior rejection still releases
            // the lock rather than wedging the key forever.
            const result = prev.then(fn, fn);
            // Advance the tail on settle regardless of outcome (swallow here so one caller's rejection
            // never poisons the next waiter — each caller still sees its own rejection via `result`).
            tails.set(key, result.then(() => {}, () => {}));
            return result;
        },
    };
}
