// Kralveth Weather on Cloudflare (a Worker with static assets: `npx wrangler deploy`, wrangler.toml). The built site is served as it is
// (an unknown path gets index.html: the app's own routing); only our functions run here first: /api/ildn, /api/imd-lightning, /api/radar and
// /imd-radar/<file> (IMD's radar pictures), each the Netlify function in netlify/functions/ run through netlify/cloudflare.js.
import ildn from '../netlify/functions/ildn.js';
import imdLightning from '../netlify/functions/imd-lightning.js';
import radar from '../netlify/functions/radar.js';
import { runNetlify } from '../netlify/cloudflare.js';

const API = { ildn: ildn.handler, 'imd-lightning': imdLightning.handler, radar: radar.handler };

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET') {
      const api = /^\/api\/([a-z-]+)$/.exec(pathname);
      if (api && API[api[1]]) return runNetlify(API[api[1]], request, ctx);
      if (pathname.startsWith('/imd-radar/')) {
        return runNetlify(radar.handler, request, ctx, { queryStringParameters: { file: decodeURIComponent(pathname.slice('/imd-radar/'.length)) } });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
