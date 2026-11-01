// The IMD radar picture fallback (netlify/functions/radar.js) on Cloudflare Pages: /api/radar?file=caz_kkl.gif
import fn from '../../netlify/functions/radar.js';
import { runNetlify } from '../../netlify/cloudflare.js';

export const onRequestGet = ctx => runNetlify(fn.handler, ctx.request, ctx);
