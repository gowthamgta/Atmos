// ILDN lightning (netlify/functions/ildn.js) on Cloudflare Pages: /api/ildn
import fn from '../../netlify/functions/ildn.js';
import { runNetlify } from '../../netlify/cloudflare.js';

export const onRequestGet = ctx => runNetlify(fn.handler, ctx.request, ctx);
