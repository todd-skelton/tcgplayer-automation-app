/**
 * One value per key, rebuilt whenever its identity or version changes. A
 * changed version serves the last value at once while the new one builds, so
 * only the first read of a key, or one whose identity changed, waits. One
 * build runs per key at a time; a version that moves during a build is picked
 * up by the next read. A failed rebuild keeps serving the last value and is
 * retried on the next read.
 */
export interface VersionedCache<Value> {
  read(
    key: string,
    identity: string,
    version: string,
    build: () => Promise<Value>,
  ): Promise<Value>;
}

interface Build<Value> {
  version: string;
  value: Promise<Value>;
}

interface Entry<Value> {
  identity: string;
  ready?: { version: string; value: Value };
  building?: Build<Value>;
}

export function createVersionedCache<Value>(
  name: string,
): VersionedCache<Value> {
  const entries = new Map<string, Entry<Value>>();

  function start(
    entry: Entry<Value>,
    version: string,
    build: () => Promise<Value>,
  ): Build<Value> {
    const building = { version, value: build() };
    entry.building = building;
    building.value
      .then(
        (value) => {
          entry.ready = { version, value };
        },
        (error) => {
          if (entry.ready) console.error(`${name} rebuild failed:`, error);
        },
      )
      .finally(() => {
        if (entry.building === building) entry.building = undefined;
      });
    return building;
  }

  return {
    read(key, identity, version, build) {
      let entry = entries.get(key);
      if (entry?.identity !== identity) {
        entry = { identity };
        entries.set(key, entry);
      }
      const { ready } = entry;
      if (ready?.version === version) return Promise.resolve(ready.value);
      const building = entry.building ?? start(entry, version, build);
      return ready ? Promise.resolve(ready.value) : building.value;
    },
  };
}
