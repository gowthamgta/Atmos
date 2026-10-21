/**
 * The newest picture of each radar and product, kept in the browser (Cache API) so that when IMD cannot be reached (its server down, no
 * signal on the phone) the last good one is still shown, with its own scan time and age, after a reload too. A picture too old to show is
 * still left out by the service's age limits. Browsers without the Cache API (or a private window that refuses it) simply keep nothing.
 */
const CACHE_NAME = 'atmos-radar-v1';
const LAST_MODIFIED = 'x-last-modified';

/** What was last stored per key (its Last-Modified time), so an unchanged picture is not written again on every look. */
const stored = new Map<string, string>();

function request(key: string): Request {
  return new Request(`/__radar/${encodeURIComponent(key)}`);
}

/** Keeps `bytes` as the newest picture for `key` (station:product), with the file's Last-Modified time when there is one. */
export async function keepRadarPicture(key: string, bytes: ArrayBuffer, lastModified: string | null): Promise<void> {
  const stamp = lastModified ?? String(bytes.byteLength);
  if (stored.get(key) === stamp) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const headers: Record<string, string> = { 'content-type': 'image/gif' };
    if (lastModified) headers[LAST_MODIFIED] = lastModified;
    await cache.put(request(key), new Response(bytes, { headers }));
    stored.set(key, stamp);
  } catch {
    // no cache in this browser or window: nothing is kept
  }
}

/** The kept picture for `key` and its Last-Modified time, or null when there is none. */
export async function cachedRadarPicture(key: string): Promise<{ bytes: ArrayBuffer; lastModified: string | null } | null> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(request(key));
    if (!res) return null;
    return { bytes: await res.arrayBuffer(), lastModified: res.headers.get(LAST_MODIFIED) };
  } catch {
    return null;
  }
}
