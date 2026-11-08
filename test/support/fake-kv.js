// A small stand-in for Workers KV (the MEDIA binding), in memory. Used by the Worker's tests;
// KV itself is checked with `wrangler dev`.

export function fakeKV() {
  const items = new Map(); // key → { bytes, metadata }
  const bytesOf = async (value) => {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (typeof value === 'string') return new TextEncoder().encode(value);
    return new Uint8Array(await new Response(value).arrayBuffer());
  };
  const as = (item, type) => {
    if (!item) return null;
    if (type === 'stream') return new Response(item.bytes).body;
    if (type === 'arrayBuffer') return item.bytes.slice().buffer;
    return new TextDecoder().decode(item.bytes);
  };
  const typeOf = (opts) => (typeof opts === 'string' ? opts : opts?.type || 'text');
  return {
    items,
    async put(key, value, { metadata } = {}) {
      items.set(key, { bytes: await bytesOf(value), metadata: metadata ?? null });
    },
    async get(key, opts) {
      return as(items.get(key), typeOf(opts));
    },
    async getWithMetadata(key, opts) {
      const item = items.get(key);
      return { value: as(item, typeOf(opts)), metadata: item?.metadata ?? null };
    },
    async delete(key) {
      items.delete(key);
    },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const keys = [...items.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const done = start + limit >= keys.length;
      return {
        keys: page.map((name) => ({ name, metadata: items.get(name).metadata })),
        list_complete: done,
        cursor: done ? undefined : String(start + limit),
      };
    },
  };
}
