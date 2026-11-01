// IMD's lightning (netlify/functions/imd-lightning.js) on Cloudflare Pages: /api/imd-lightning
import fn from '../../netlify/functions/imd-lightning.js';
import { runNetlify } from '../../netlify/cloudflare.js';

export const onRequestGet = ctx => runNetlify(fn.handler, ctx.request, ctx);
