// Netlify Serverless Function: the METAR reports of the airports of Tamil Nadu for the last 24 hours, as the app reads them (the same
// JSON as public/data/observations/metar/latest.json). aviationweather.gov does not allow cross-origin requests, so the server fetches
// them here. The app asks at 32 minutes past every hour; the answer is kept at the edge for ten minutes.
// A port of pipeline/obs_metar.py (parse_record, parse_all); keep the two in step.

const AIRPORTS = 'VOMM,VOCB,VOMD,VOTK,VOTR,VOSM,VOPC';
const KT_TO_MS = 0.514444;

function relativeHumidity(t, d) {
  const a = 17.625;
  const b = 243.04;
  const rh = 100 * Math.exp((a * d) / (b + d) - (a * t) / (b + t));
  return Math.round(Math.min(100, Math.max(0, rh)) * 10) / 10;
}

// a reported value as a number; text such as '10+' (visibility) is read as its number, anything else as missing
function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/\+$/, ''));
  return Number.isFinite(n) ? n : null;
}

function parseRecord(r) {
  if (r.obsTime === null || r.obsTime === undefined || r.temp === null || r.temp === undefined) return null;
  const temp = num(r.temp);
  const dewp = num(r.dewp);
  const wind = num(r.wspd);
  return {
    station: r.icaoId,
    name: r.name ?? null,
    lat: r.lat,
    lon: r.lon,
    time: new Date(r.obsTime * 1000).toISOString().replace('.000Z', 'Z'),
    temp_c: temp,
    dewp_c: dewp,
    rh_pct: temp !== null && dewp !== null ? relativeHumidity(temp, dewp) : null,
    wind_dir: r.wdir ?? null,
    wind_kt: wind,
    wind_ms: wind !== null ? Math.round(wind * KT_TO_MS * 100) / 100 : null,
    gust_kt: num(r.wgst),
    visibility_km: num(r.visib),
    pressure_hpa: num(r.altim),
    weather: r.wxString ?? null,
    raw: r.rawOb ?? null
  };
}

function parseAll(records) {
  const by = {};
  for (const r of records) {
    const p = parseRecord(r);
    if (p) (by[p.station] ??= {})[p.time] = p;
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Object.keys(v).sort().map(t => v[t])]));
}

exports.handler = async function () {
  try {
    const response = await fetch(`https://aviationweather.gov/api/data/metar?ids=${AIRPORTS}&format=json&hours=24`, {
      headers: { 'User-Agent': 'AtmosIQ-personal (non-commercial; METAR of Tamil Nadu airports, once an hour)' }
    });
    if (!response.ok) {
      return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: `aviationweather.gov answered ${response.status}` }) };
    }
    const stations = parseAll(await response.json());
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800'
      },
      body: JSON.stringify({ source: 'aviationweather.gov METAR (airport observations)', hours: 24, fetched: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), stations })
    };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: String(e) }) };
  }
};

exports.parseAll = parseAll;
exports.parseRecord = parseRecord;
