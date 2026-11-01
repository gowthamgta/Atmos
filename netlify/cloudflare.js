// Runs one of our Netlify functions (netlify/functions/*.js) on Cloudflare (worker/index.js), so both hosts serve the same code: the request
// becomes Netlify's event, the answer a Response. Netlify's CDN cache time (Netlify-CDN-Cache-Control: s-maxage) is kept with Cloudflare's
// cache, so ILDN and IMD are asked no more often than on Netlify (5 s and 5 min, however many people look).

export async function runNetlify(handler, request, ctx, extra = {}) {
  const url = new URL(request.url);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const hit = cache && (await cache.match(request));
  if (hit) return hit;
  const r = await handler({
    rawQuery: url.search.slice(1),
    queryStringParameters: Object.fromEntries(url.searchParams),
    path: url.pathname,
    ...extra,
  });
  const headers = new Headers(r.headers || {});
  const edge = /s-maxage=(\d+)/.exec(headers.get('Netlify-CDN-Cache-Control') || headers.get('Cache-Control') || '');
  headers.delete('Netlify-CDN-Cache-Control');
  const body = r.isBase64Encoded ? Uint8Array.from(atob(r.body), c => c.charCodeAt(0)) : r.body;
  const response = new Response(body, { status: r.statusCode, headers });
  if (cache && edge && r.statusCode === 200) {
    // the copy kept at the edge carries the edge's time; the browser's own Cache-Control is left as the function gave it
    const kept = new Response(response.clone().body, response);
    kept.headers.set('Cache-Control', `public, s-maxage=${edge[1]}`);
    ctx.waitUntil(cache.put(request, kept));
  }
  return response;
}
