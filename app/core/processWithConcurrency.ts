export async function* processWithConcurrency<T, R>(
  items: Iterable<T>,
  limit: number,
  fn: (item: T) => Promise<R>
): AsyncGenerator<R> {
  const iterator = items[Symbol.iterator]();
  const inFlight = new Set<Promise<R>>();

  // Helper to start a new task if possible
  const startNext = () => {
    const next = iterator.next();
    if (next.done) return null;
    const p = fn(next.value);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    return p;
  };

  // Start initial batch
  for (let i = 0; i < limit; i++) startNext();

  while (inFlight.size > 0) {
    const result = await Promise.race(inFlight);
    yield result;
    startNext();
  }
}
