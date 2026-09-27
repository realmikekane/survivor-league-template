import { getStore, getDeployStore } from "@netlify/blobs";

/* One store backs the whole app. Production traffic uses the global store;
   previews and branch deploys get an isolated deploy-scoped store so test
   data never mixes with real league data. Tests inject an in-memory store
   via globalThis.__SL_TEST_STORE. */
export function blobStore() {
  if (globalThis.__SL_TEST_STORE) return globalThis.__SL_TEST_STORE;
  const ctx = globalThis.Netlify?.context?.deploy?.context;
  const opts = { name: "survivor-league", consistency: "strong" };
  return ctx === "production" ? getStore(opts) : getDeployStore(opts);
}

export async function getJSON(store, key) {
  return store.get(key, { type: "json" });
}

export async function setJSON(store, key, value) {
  return store.setJSON(key, value);
}

/* Bounded-concurrency parallel fetch. The old sequential version made the
   snapshot rebuild O(total picks) round-trips in series, which is exactly
   the kind of thing that feels fine in week 1 and takes 30 seconds in
   week 18. */
const CONCURRENCY = 24;
export async function getManyJSON(store, keys) {
  const out = new Array(keys.length);
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const idx = next++;
      out[idx] = await store.get(keys[idx], { type: "json" }).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, worker));
  return out;
}

export async function listKeys(store, prefix) {
  const { blobs } = await store.list({ prefix });
  return blobs.map((b) => b.key).sort();
}

export async function listJSON(store, prefix) {
  const keys = await listKeys(store, prefix);
  const values = await getManyJSON(store, keys);
  return keys.map((key, i) => ({ key, value: values[i] }))
    .filter((e) => e.value !== null && e.value !== undefined);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Optimistic read-modify-write for shared documents (roster, payments,
   revivals, …). Uses etag-conditional writes when the runtime supports
   them so two simultaneous joins can't silently drop one; falls back to a
   plain write when preconditions aren't available, which is no worse than
   the behavior it replaces. `fn` receives a deep copy and returns the next
   value, or undefined to abort (the current value is returned). */
export async function mutateDoc(store, key, fallback, fn, tries = 4) {
  for (let attempt = 0; attempt < tries; attempt++) {
    let current = fallback;
    let etag;
    try {
      const meta = await store.getWithMetadata(key, { type: "json" });
      if (meta && meta.data !== null && meta.data !== undefined) {
        current = meta.data;
        etag = meta.etag;
      }
    } catch {
      current = (await getJSON(store, key)) ?? fallback;
    }
    const next = await fn(structuredClone(current));
    if (next === undefined) return current;
    try {
      const res = await store.setJSON(key, next, etag ? { onlyIfMatch: etag } : {});
      if (res && res.modified === false) {
        await sleep(20 + Math.random() * 80);
        continue; // someone else wrote first; re-read and retry
      }
      return next;
    } catch {
      if (attempt === tries - 1) {
        await store.setJSON(key, next); // last resort: unconditional
        return next;
      }
      await sleep(20 + Math.random() * 80);
    }
  }
  // retries exhausted on conditional conflicts: apply unconditionally rather than drop the write
  const current = (await getJSON(store, key)) ?? fallback;
  const next = await fn(structuredClone(current));
  if (next === undefined) return current;
  await store.setJSON(key, next);
  return next;
}
