// Netlify Serverless Function: the SYNOP reports of the Tamil Nadu weather stations of the last 24 hours, as the app reads them (the
// same JSON as public/data/observations/synop/latest.json). Ogimet (www.ogimet.com) republishes the WMO reports as text and does not
// allow cross-origin requests, so the server fetches and decodes them here. The app asks at 32 minutes past every hour; the answer is
// kept at the edge for ten minutes, so Ogimet is asked about six times an hour at most, however many people look.
// A port of pipeline/obs_synop.py (decode and parse_listing); keep the two in step.

const KT_TO_MS = 0.514444;
// WMO station number: [name, latitude, longitude]
const STATIONS = {
  '43374': ['Kovalam', 8.08333, 77.25],
  '43377': ['Kanniyakumari', 8.08333, 77.5],
  '43376': ['Palayankottai', 8.73333, 77.75],
  '43379': ['Tuticorin New Port', 8.8, 78.15],
  '43363': ['Pamban', 9.28333, 79.21667],
  '43358': ['Kovilangulam', 9.55, 78.08333],
  '43361': ['Tondi', 9.73333, 79.03333],
  '43360': ['Madurai', 9.83451, 78.09338],
  '43359': ['Madurai (town)', 9.91667, 78.11667],
  '43327': ['Karaikudi', 10.0667, 78.8],
  '43339': ['Kodaikanal', 10.23333, 77.46667],
  '43341': ['Valparai', 10.28333, 77.0],
  '43348': ['Atiramapattinam', 10.33333, 79.38333],
  '43349': ['Vedaranniyam', 10.36667, 79.85],
  '43345': ['Kudimiamalai', 10.4, 78.66667],
  '43344': ['Tiruchirappalli', 10.76536, 78.70972],
  '43343': ['Tiruchirappalli (town)', 10.76667, 78.71667],
  '43347': ['Nagapattinam', 10.76667, 79.85],
  '43330': ['Thanjavur', 10.78333, 79.13333],
  '43346': ['Karaikal', 10.91667, 79.83333],
  '43342': ['K. Paramathy', 10.95, 78.08333],
  '43319': ['Coimbatore', 11.0, 76.96667],
  '43324': ['Ariyalur', 11.1813, 79.0],
  '43338': ['Erode', 11.48333, 77.76667],
  '43325': ['Salem', 11.65, 78.16667],
  '43326': ['Kallakurichi', 11.73333, 78.96667],
  '43329': ['Cuddalore', 11.76667, 79.76667],
  '43328': ['Puducherry', 11.91667, 79.83333],
  '43331': ['Puducherry (observatory)', 11.96667, 79.81667],
  '43301': ['Dharmapuri', 12.13333, 78.03333],
  '43302': ['Tiruppattur', 12.48333, 78.56667],
  '43308': ['Mahabalipuram', 12.617, 80.2],
  '43303': ['Vellore', 12.91667, 79.15],
  '43279': ['Chennai (Meenambakkam)', 12.99441, 80.18052],
  '43278': ['Chennai (Nungambakkam)', 13.06667, 80.2],
  '43277': ['Tiruttani', 13.15, 79.53333],
  '43207': ['Parangipettai', 11.5, 79.76667],
  '43318': ['Coonoor', 11.35, 76.8],
  '43317': ['Udhagamandalam', 11.4, 76.73333],
  '43340': ['Yercaud', 11.75, 78.16667],
};
const RAIN_HOURS = { 1: 6, 2: 12, 3: 18, 4: 24, 5: 1, 6: 2, 7: 3, 8: 9, 9: 15 };
const isDigits = s => /^\d+$/.test(s);

function relativeHumidity(t, d) {
  const a = 17.625;
  const b = 243.04;
  const rh = 100 * Math.exp((a * d) / (b + d) - (a * t) / (b + t));
  return Math.round(Math.min(100, Math.max(0, rh)) * 10) / 10;
}

function tenths(sign, digits) {
  if (!isDigits(digits) || (sign !== '0' && sign !== '1')) return null;
  const v = parseInt(digits, 10) / 10;
  return sign === '1' ? -v : v;
}

function rain(rrr) {
  if (!isDigits(rrr)) return null;
  const n = parseInt(rrr, 10);
  return n === 990 ? 0 : n > 990 ? (n - 990) / 10 : n;
}

function pressure(p) {
  if (!isDigits(p)) return null;
  const v = parseInt(p, 10) / 10;
  return Math.round((v < 500 ? v + 1000 : v) * 10) / 10;
}

function decode(report) {
  const tokens = report.trim().replace(/=+$/, '').split(/\s+/);
  if (tokens.length < 6 || tokens[0] !== 'AAXX') return null;
  const unitDigit = tokens[1].slice(4, 5);
  const inKnots = unitDigit === '3' || unitDigit === '4'; // the last digit of the day/hour group: wind units
  const body = [];
  const section3 = [];
  let current = body;
  for (const tok of tokens.slice(3)) {
    if (tok === '222' || tok === '444' || tok === '555') current = []; // sections this reader does not use
    else if (tok === '333') current = section3;
    else current.push(tok);
  }
  if (body.length < 2) return null;
  const out = { temp_c: null, dewp_c: null, rh_pct: null, wind_dir: null, wind_kt: null, msl_hpa: null, stn_hpa: null, rain_mm: null, rain_hours: null, rain24_mm: null, tmax_c: null, tmin_c: null };
  const rainInSection1 = body[0].slice(0, 1) === '0' || body[0].slice(0, 1) === '1';
  const wind = body[1];
  let rest = body.slice(2);
  if (wind.length === 5 && isDigits(wind.slice(1))) {
    const dd = parseInt(wind.slice(1, 3), 10);
    let ff = parseInt(wind.slice(3, 5), 10);
    if (ff === 99 && rest.length && rest[0].startsWith('00') && isDigits(rest[0].slice(2))) {
      ff = parseInt(rest[0].slice(2), 10);
      rest = rest.slice(1);
    }
    out.wind_dir = dd === 99 || ff === 0 ? null : dd * 10;
    out.wind_kt = Math.round((inKnots ? ff : ff / KT_TO_MS) * 10) / 10;
  }
  for (const g of rest) {
    if (g.length !== 5) continue;
    const k = g[0];
    if (k === '1') out.temp_c = tenths(g[1], g.slice(2, 5));
    else if (k === '2') {
      if (g[1] === '9') out.rh_pct = isDigits(g.slice(2, 5)) ? parseFloat(g.slice(2, 5)) : null;
      else out.dewp_c = tenths(g[1], g.slice(2, 5));
    } else if (k === '3') out.stn_hpa = pressure(g.slice(1, 5));
    else if (k === '4' && (g[1] === '0' || g[1] === '9')) out.msl_hpa = pressure(g.slice(1, 5));
    else if (k === '6' && rainInSection1) {
      out.rain_mm = rain(g.slice(1, 4));
      out.rain_hours = RAIN_HOURS[g[4]] ?? null;
    }
  }
  for (const g of section3) {
    if (g.length !== 5) continue;
    const k = g[0];
    if (k === '1') out.tmax_c = tenths(g[1], g.slice(2, 5));
    else if (k === '2') out.tmin_c = tenths(g[1], g.slice(2, 5));
    else if (k === '6' && out.rain_mm === null) {
      out.rain_mm = rain(g.slice(1, 4));
      out.rain_hours = RAIN_HOURS[g[4]] ?? null;
    } else if (k === '7' && isDigits(g.slice(1, 5))) out.rain24_mm = parseInt(g.slice(1, 5), 10) / 10;
  }
  if (out.rh_pct === null && out.temp_c !== null && out.dewp_c !== null) out.rh_pct = relativeHumidity(out.temp_c, out.dewp_c);
  if (['temp_c', 'dewp_c', 'wind_kt', 'msl_hpa', 'rain_mm'].every(k => out[k] === null)) return null;
  out.wind_ms = out.wind_kt !== null ? Math.round(out.wind_kt * KT_TO_MS * 100) / 100 : null;
  return out;
}

function parseListing(text) {
  const by = {};
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(',');
    if (parts.length < 7) continue;
    const id = parts[0];
    const info = STATIONS[id];
    if (!info) continue;
    const report = parts.slice(6).join(',');
    const t = Date.UTC(+parts[1], +parts[2] - 1, +parts[3], +parts[4], +parts[5]);
    if (Number.isNaN(t)) continue;
    const values = decode(report);
    if (!values) continue;
    const time = new Date(t).toISOString().replace('.000Z', 'Z');
    (by[id] ??= {})[time] = { station: id, name: info[0], lat: info[1], lon: info[2], time, ...values, raw: report.trim().replace(/=+$/, '') };
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Object.keys(v).sort().map(s => v[s])]));
}

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;

exports.handler = async function () {
  const end = new Date();
  const begin = new Date(end.getTime() - 24 * 3600 * 1000);
  try {
    const response = await fetch(`https://www.ogimet.com/cgi-bin/getsynop?block=43&begin=${stamp(begin)}&end=${stamp(end)}`, {
      headers: { 'User-Agent': 'AtmosIQ-personal (non-commercial; SYNOP of Tamil Nadu, once an hour)' }
    });
    if (!response.ok) {
      return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: `Ogimet answered ${response.status}` }) };
    }
    const stations = parseListing(await response.text());
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800'
      },
      body: JSON.stringify({ source: 'SYNOP reports of the Tamil Nadu weather stations, via Ogimet', hours: 24, fetched: end.toISOString().replace(/\.\d+Z$/, 'Z'), stations })
    };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: String(e) }) };
  }
};

exports.parseListing = parseListing;
exports.decode = decode;
