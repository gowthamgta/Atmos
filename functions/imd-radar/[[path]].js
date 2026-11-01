// /imd-radar/<file> -> IMD's radar picture (Netlify did this with a rewrite; Cloudflare Pages' _redirects cannot fetch another site), through
// the same function as /api/radar: only picture files under mausam.imd.gov.in/Radar/, kept at the edge for a minute.
import fn from '../../netlify/functions/radar.js';
import { runNetlify } from '../../netlify/cloudflare.js';

export const onRequestGet = ctx => {
  const file = [].concat(ctx.params.path || []).join('/');
  return runNetlify(fn.handler, ctx.request, ctx, { queryStringParameters: { file } });
};
