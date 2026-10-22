// Clouds in 3D: the ten cloud genera at the heights they have over South India, drawn by ray marching through a 3D noise field, lit by the
// sun with single scattering and an approximation of the multiple scattering that makes thick cloud bright, with each genus's own optical
// thickness (a stratus deck is opaque grey, a cirrostratus a veil the sun shines through). Heights: the WMO International Cloud Atlas's
// tropical levels; temperatures: today's GFS profile over Chennai (Open-Meteo), with a standard tropical profile when it cannot be had.

const SPACING = 30;   // km between the clouds along the chart
const HALF = 13;      // half the width of each cloud's ground (km)
const NOISE = 96;     // the 3D noise texture's size

// The genera in the order of the chart, with the heights (km) they have over South India and what the panel says about them. The index is
// the shader's genus number.
const GENERA = [
  {
    id: 'St', name: 'Stratus', latin: 'stratus · “spread out, a layer”', level: 'Low', base: 0.25, top: 0.75,
    look: 'A flat, grey, featureless sheet, like fog that does not touch the ground. The sun, when it shows, has a sharp outline.',
    rain: 'Drizzle at most.',
    india: 'Low grey mornings in the cool season, and the low cloud that sits on the slopes of the Nilgiris and the Western Ghats in the monsoon.',
    view: { az: -20, el: 14, dist: 6, z: 1.5 },
  },
  {
    id: 'Sc', name: 'Stratocumulus', latin: 'stratus + cumulus · “layer” of “heaps”', level: 'Low', base: 0.6, top: 1.8,
    look: 'Grey and white rolls or rounded masses in a layer, with darker undersides and gaps of blue between them.',
    rain: 'Seldom more than light rain or drizzle.',
    india: 'The commonest cloud of the southwest monsoon over the sea and the west coast: a broken deck that keeps the day grey and mild.',
    view: { az: -25, el: 10, dist: 16, z: 1.1 },
  },
  {
    id: 'Cu', name: 'Cumulus', latin: 'cumulus · “a heap”', level: 'Low (grows upward)', base: 1.0, top: 4.5,
    look: 'Separate puffy heaps with sharp, cauliflower tops brilliant in the sun and flat, darker bases, all at one height: where the rising air cools to its dew point.',
    rain: 'None while small; the taller ones (congestus) can give showers.',
    india: 'Fair-weather cumulus pop up over Tamil Nadu by late morning almost every day; their flat bases sit about 1 km up.',
    view: { az: -30, el: 6, dist: 20, z: 2.2 },
  },
  {
    id: 'Ns', name: 'Nimbostratus', latin: 'nimbus + stratus · “rain cloud” in a “layer”', level: 'Middle (reaches low and high)', base: 0.9, top: 5.5,
    look: 'A thick, dark grey layer that hides the sun completely, its base ragged and blurred by falling rain.',
    rain: 'Steady rain for hours over a wide area.',
    india: 'The long rainy days of a depression over the Bay of Bengal in the northeast monsoon, when it rains from morning to night over the coast.',
    view: { az: -20, el: 9, dist: 9, z: 1.9 },
  },
  {
    id: 'As', name: 'Altostratus', latin: 'altus + stratus · “high” “layer”', level: 'Middle', base: 3.5, top: 6.5,
    look: 'A grey or bluish sheet covering the sky; the sun shows through as through ground glass, with no halo and no shadows on the ground.',
    rain: 'Thickening altostratus often comes before widespread rain.',
    india: 'Often spreads ahead of a depression approaching the Coromandel coast.',
    view: { az: -15, el: 8, dist: 14, z: 2.0, look: 'up' },
  },
  {
    id: 'Ac', name: 'Altocumulus', latin: 'altus + cumulus · “high” “heaps”', level: 'Middle', base: 3.8, top: 4.8,
    look: 'White or grey patches, rolls or rounded masses in rows, smaller than stratocumulus: each about the width of your thumb held at arm’s length.',
    rain: 'None.',
    india: 'Common on monsoon mornings; turreted altocumulus (castellanus) in the morning is a sign of thunderstorms by the afternoon.',
    view: { az: -10, el: 10, dist: 12, z: 2.1, look: 'up' },
  },
  {
    id: 'Cs', name: 'Cirrostratus', latin: 'cirrus + stratus · “curl” in a “layer”', level: 'High', base: 10.5, top: 12.5,
    look: 'A thin, milky veil over the whole sky, so thin the sun shines through it with shadows, and often a halo: a ring 22° from the sun, made by light bent in six-sided ice crystals.',
    rain: 'None, but it often comes a day ahead of a storm system.',
    india: 'Spreads ahead of cyclones in the Bay of Bengal, fed by their anvils hundreds of kilometres away.',
    view: { az: 0, el: -14, dist: 10, z: 1.0, look: 'sun' },
  },
  {
    id: 'Cc', name: 'Cirrocumulus', latin: 'cirrus + cumulus · “curl” of “heaps”', level: 'High', base: 9.8, top: 10.4,
    look: 'Tiny white grains or ripples high up, without shading, like fish scales (a “mackerel sky”); each smaller than your little finger at arm’s length.',
    rain: 'None.',
    india: 'Short-lived and uncommon: it soon turns into cirrus or cirrostratus.',
    view: { az: -10, el: 22, dist: 12, z: 4.5, look: 'up' },
  },
  {
    id: 'Ci', name: 'Cirrus', latin: 'cirrus · “a curl of hair”', level: 'High', base: 9.5, top: 13.0,
    look: 'White, silky strands and hooks of ice crystals; the hooks are crystals falling into slower air below and trailing behind.',
    rain: 'None (the crystals evaporate as they fall).',
    india: 'Seen in every season; in the monsoon it is mostly the spread-out remains of the anvils of thunderstorms.',
    view: { az: -15, el: -8, dist: 16, z: 6.5, look: 'up' },
  },
  {
    id: 'Cb', name: 'Cumulonimbus', latin: 'cumulus + nimbus · “heap” “rain cloud”', level: 'Through every level', base: 1.0, top: null,
    look: 'A towering mountain of cloud from about a kilometre up to the tropopause, where it can rise no more and spreads into a flat anvil of ice. Its base is dark, with rain shafts and lightning.',
    rain: 'Heavy showers, lightning, gusts, sometimes hail.',
    india: 'The afternoon and evening thunderstorms of the pre-monsoon and the northeast monsoon; over South India their tops reach 15–17 km, among the coldest clouds on Earth.',
    view: { az: -30, el: 7, dist: 52, z: 7.5 },
  },
];

// optical thickness of each genus at full density (extinction, 1/km): from about 40 per km in a dense water cloud to under 1 in a cirrus veil
const SIGMA = [22, 26, 36, 24, 2.2, 18, 0.05, 2.5, 2.2, 40];

// A standard tropical profile (km, °C), used when today's cannot be had
const FALLBACK_PROFILE = [[0, 27], [1, 21], [2, 15.5], [3, 10], [4, 4.5], [5, -1], [6, -7], [7, -13.5], [8, -20.5], [9, -28], [10, -35.5],
  [11, -43.5], [12, -51.5], [13, -59], [14, -66], [15, -72], [16, -77], [17, -79], [18, -75], [19, -70]];

// ──────────────────────────────────────────────────────────────────────────── today's temperatures over Chennai

const LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50];

async function loadProfile() {
  const vars = ['temperature_2m', ...LEVELS.flatMap(l => [`temperature_${l}hPa`, `geopotential_height_${l}hPa`])];
  const url = `https://api.open-meteo.com/v1/forecast?latitude=13.08&longitude=80.27&hourly=${vars.join(',')}&models=gfs_global&forecast_days=1&timezone=Asia%2FKolkata`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const j = await res.json();
  const h = j.hourly;
  const now = new Date();
  const hourIst = (now.getUTCHours() + 5 + (now.getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24;
  const i = Math.min(h.time.length - 1, hourIst);
  const pts = [[(j.elevation ?? 0) / 1000, h.temperature_2m[i]]];
  for (const l of LEVELS) {
    const z = h[`geopotential_height_${l}hPa`]?.[i];
    const t = h[`temperature_${l}hPa`]?.[i];
    if (z != null && t != null && z / 1000 > pts[pts.length - 1][0] + 0.05) pts.push([z / 1000, t]);
  }
  if (pts.length < 8) throw new Error('profile too short');
  return { pts, label: `Temperatures: today over Chennai, ${h.time[i].slice(11)} IST (NOAA GFS via Open-Meteo)` };
}

function tempAt(profile, z) {
  const p = profile.pts;
  if (z <= p[0][0]) return p[0][1];
  for (let k = 1; k < p.length; k++) {
    if (z <= p[k][0]) {
      const [z0, t0] = p[k - 1];
      const [z1, t1] = p[k];
      return t0 + ((z - z0) / (z1 - z0)) * (t1 - t0);
    }
  }
  return p[p.length - 1][1];
}

/** The height (km) where the profile first falls to `t` °C. */
function heightOf(profile, t) {
  const p = profile.pts;
  for (let k = 1; k < p.length; k++) {
    if (p[k][1] <= t && p[k - 1][1] > t) return p[k - 1][0] + ((t - p[k - 1][1]) / (p[k][1] - p[k - 1][1])) * (p[k][0] - p[k - 1][0]);
  }
  return null;
}

/** The tropopause: the coldest point between 12 and 19 km. */
function tropopause(profile) {
  let best = null;
  for (let z = 12; z <= 19; z += 0.1) {
    const t = tempAt(profile, z);
    if (!best || t < best.t) best = { z, t };
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────── GL

const canvas = document.getElementById('sky');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });

const FULLSCREEN_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Tileable noise for the 3D texture: R a Perlin-Worley mix (the billowy shape of cloud), G, B, A Worley at three scales (detail and erosion).
const NOISE_FS = `#version 300 es
precision highp float;
uniform float uZ;
in vec2 v_uv;
out vec4 o;
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float worley(vec3 p, float f) {
  vec3 q = p * f, id = floor(q), fr = fract(q);
  float d = 9.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 c = vec3(x, y, z);
    vec3 r = c + hash33(mod(id + c, f)) - fr;
    d = min(d, dot(r, r));
  }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}
float g3(vec3 cell, vec3 r, float f) { vec3 g = normalize(hash33(mod(cell, f)) * 2.0 - 1.0); return dot(g, r); }
float perlin(vec3 p, float f) {
  vec3 q = p * f, i = floor(q), fr = fract(q);
  vec3 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  float a = g3(i, fr, f), b = g3(i + vec3(1,0,0), fr - vec3(1,0,0), f);
  float c = g3(i + vec3(0,1,0), fr - vec3(0,1,0), f), d = g3(i + vec3(1,1,0), fr - vec3(1,1,0), f);
  float e = g3(i + vec3(0,0,1), fr - vec3(0,0,1), f), ff = g3(i + vec3(1,0,1), fr - vec3(1,0,1), f);
  float g = g3(i + vec3(0,1,1), fr - vec3(0,1,1), f), h = g3(i + vec3(1,1,1), fr - vec3(1,1,1), f);
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, ff, u.x), mix(g, h, u.x), u.y), u.z);
}
void main() {
  vec3 p = vec3(v_uv, uZ);
  float pf = perlin(p, 4.0) * 0.5 + perlin(p, 8.0) * 0.25 + perlin(p, 16.0) * 0.125 + perlin(p, 32.0) * 0.0625;
  pf = clamp(pf * 0.9 + 0.5, 0.0, 1.0);
  float w1 = worley(p, 4.0) * 0.625 + worley(p, 8.0) * 0.25 + worley(p, 16.0) * 0.125;
  float w2 = worley(p, 8.0) * 0.625 + worley(p, 16.0) * 0.25 + worley(p, 32.0) * 0.125;
  float w3 = worley(p, 16.0) * 0.625 + worley(p, 32.0) * 0.25 + worley(p, 64.0) * 0.125;
  float pw = clamp((pf - (1.0 - w1)) / (1.0 - (1.0 - w1) * 0.6) , 0.0, 1.0);
  o = vec4(clamp(mix(pf, pw, 0.6), 0.0, 1.0), w1, w2, w3);
}`;

const CLOUD_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;
uniform vec3 uCam, uRight, uUp, uFwd, uSun;
uniform float uTan, uAspect, uTime, uTrop, uFlash, uHalo, uSteps;
uniform vec3 uFlashPos;
in vec2 v_uv;
out vec4 o;

const float SP = ${SPACING.toFixed(1)};
const float HALFW = ${HALF.toFixed(1)};
const float SIGMA[10] = float[10](${SIGMA.map(s => s.toFixed(2)).join(', ')});

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
float sat(float v) { return clamp(v, 0.0, 1.0); }
vec3 sat3(vec3 v) { return clamp(v, 0.0, 1.0); }
float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec4 nz(vec3 p) { return texture(uNoise, p); }

// a layer between base and top with soft edges (0..1)
float band(float z, float b, float t, float soft) { return smoothstep(b, b + soft, z) * (1.0 - smoothstep(t - soft, t, z)); }
// each cloud keeps to its own ground on the chart, fading at the edge
float ground(vec3 q) { return (1.0 - smoothstep(HALFW - 6.0, HALFW, abs(q.x))) * (1.0 - smoothstep(14.0, 20.0, abs(q.y))); }

// the wind: the clouds drift east, faster aloft (in the noise's own frame, km)
vec3 drift(float z) { return vec3(uTime * (0.006 + z * 0.0025), uTime * 0.0015, uTime * 0.002); }

// shape (0..1 coverage) eroded by the noise into billows; d is the noise frequency (1/km)
float erode(float coverage, vec3 p, float f, float detail) {
  if (coverage <= 0.001) return 0.0;   // outside the shape: no noise to read
  vec4 n = nz(p * f);
  float base = remap(n.r, 1.0 - coverage, 1.0, 0.0, 1.0);
  float det = mix(n.g, n.b, 0.5);
  return sat(remap(base, det * detail, 1.0, 0.0, 1.0));
}

// returns (density 0..1, genus) at a point (km): only the cloud whose ground the point is on is looked at
vec2 cloudAt(vec3 p) {
  float g = floor(p.x / SP + 0.5);
  if (g < 0.0 || g > 9.0 || p.z > 19.5) return vec2(0.0, -1.0);
  vec3 q = vec3(p.x - g * SP, p.y, p.z);
  float gm = ground(q);
  if (gm <= 0.0) return vec2(0.0, g);
  float z = q.z;
  vec3 w = q + drift(z);
  float d = 0.0;
  int gi = int(g);
  if (gi == 0) {          // Stratus: one even grey layer
    float c = band(z, 0.25, 0.75, 0.15) * 0.85;
    d = erode(c, w * vec3(1.0, 1.0, 2.0), 0.035, 0.25);
  } else if (gi == 1) {   // Stratocumulus: lumps and rolls in a layer, gaps between
    float cells = nz(vec3(w.xy * 0.018, 0.3)).g;
    float c = band(z, 0.6, 1.8 - (1.0 - cells) * 0.5, 0.25) * smoothstep(0.35, 0.65, cells);
    d = erode(c, w, 0.09, 0.45);
  } else if (gi == 2) {   // Cumulus: separate heaps, flat bases at the condensation level, cauliflower tops
    vec2 cell = floor(w.xy / 6.0);
    float best = 0.0;
    for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) {
      vec2 id = cell + vec2(x, y);
      float r1 = hash12(id), r2 = hash12(id + 7.1), r3 = hash12(id + 3.7);
      if (r3 < 0.25) continue;                         // not every cell has a cloud
      vec2 c = (id + 0.25 + 0.5 * vec2(r1, r2)) * 6.0;
      float top = 1.0 + 0.9 + 2.6 * r3 * r3;           // humilis (wider than tall) to congestus
      float rad = 1.3 + 1.3 * r1;
      float hz = sat((z - 1.0) / (top - 1.0));
      // a flat base and a rounded, bulging top
      float wdt = rad * sqrt(max(0.0, 1.0 - pow(max(hz - 0.15, 0.0) / 0.85, 2.0))) * (0.92 + 0.12 * sin(hz * 5.0 + r2 * 6.0));
      float rr = length(w.xy - c) / max(wdt, 0.05);
      best = max(best, (1.0 - smoothstep(0.55, 1.0, rr)) * smoothstep(1.0, 1.08, z) * (1.0 - smoothstep(top - 0.35, top, z)));
    }
    d = erode(best, w, 0.32, 0.55) * smoothstep(0.98, 1.05, z);
  } else if (gi == 3) {   // Nimbostratus: deep, dark, raining
    float c = band(z, 0.9 + nz(vec3(w.xy * 0.04, 0.7)).r * 0.5, 5.5, 0.6) * 0.95;
    d = erode(c, w, 0.05, 0.3);
  } else if (gi == 4) {   // Altostratus: a smooth grey sheet
    // unbroken, its thickness varying only gently: the sun shows through it as a pale disc
    float c = band(z, 3.5 + nz(vec3(w.xy * 0.02, 0.3)).r * 0.6, 6.5, 0.7);
    d = c * (0.55 + 0.45 * nz(w * vec3(0.03, 0.03, 0.15)).r);
  } else if (gi == 5) {   // Altocumulus: rows of small rounded masses
    float rows = 0.5 + 0.5 * sin(w.y * 1.6 + nz(vec3(w.xy * 0.03, 0.1)).r * 4.0);
    float cells = nz(vec3(w.xy * 0.06, 0.55)).g;
    float c = band(z, 3.8, 4.8, 0.2) * smoothstep(0.45, 0.7, cells * 0.7 + rows * 0.45);
    d = erode(c, w, 0.4, 0.4);
  } else if (gi == 6) {   // Cirrostratus: a thin veil of ice over everything
    float c = band(z, 10.5, 12.5, 0.8);
    d = c * (0.55 + 0.45 * nz(w * vec3(0.01, 0.03, 0.2)).r);
  } else if (gi == 7) {   // Cirrocumulus: tiny grains in ripples
    float rip = 0.5 + 0.5 * sin(w.x * 4.2 + w.y * 1.1);
    float cells = nz(vec3(w.xy * 0.22, 0.4)).b;
    float c = band(z, 9.8, 10.4, 0.15) * smoothstep(0.55, 0.75, cells * 0.75 + rip * 0.35) * nz(vec3(w.xy * 0.02, 0.9)).r;
    d = sat(c * 1.6);
  } else if (gi == 8) {   // Cirrus: strands of ice, stretched by the wind, hooked where the crystals fall
    float shear = (z - 12.0) * 2.2;
    vec3 s = vec3((w.x + shear) * 0.012, w.y * 0.09, z * 0.25);
    float strands = nz(s).r * nz(s * vec3(1.0, 3.0, 1.0) + 0.37).b;
    float c = band(z, 9.5 + nz(vec3(w.xy * 0.02, 0.2)).r * 2.0, 13.0, 0.7) * smoothstep(0.16, 0.42, strands);
    d = c;
  } else {                // Cumulonimbus: the tower, the anvil at the tropopause, the overshooting top
    // the storm stays where it is (its shape is in q); only its billows move with the wind (the noise, in w)
    float top = uTrop;
    float r = length(q.xy);
    float hz = sat((z - 1.0) / (top - 1.0));
    float towerR = 6.5 * (1.0 - 0.25 * hz) + 1.3 * sin(hz * 9.0) * hz;
    float tower = (1.0 - smoothstep(0.6, 1.0, r / towerR)) * smoothstep(1.0, 1.15, z) * (1.0 - smoothstep(top - 0.3, top + 0.2, z));
    vec2 a = q.xy - vec2(1.5, -3.0);                             // the anvil spreads, more downwind
    float ar = length(a * vec2(1.05, 0.72));
    float anvilBase = top - 3.4 + 2.6 * smoothstep(0.0, 12.0, ar);
    float anvil = (1.0 - smoothstep(9.0, 12.5, ar)) * smoothstep(anvilBase, anvilBase + 0.6, z) * (1.0 - smoothstep(top - 0.4, top + 0.1, z));
    float over = (1.0 - smoothstep(0.0, 3.0, length(vec3(q.xy, (z - top) * 1.6)))) ;   // above the tropopause, briefly
    float c = sat(max(max(tower, anvil * 0.9), over) * 1.35);
    float billow = mix(0.32, 0.15, smoothstep(top - 4.0, top, z));   // billowy tower, smoother ice anvil
    d = erode(c, w, mix(0.22, 0.08, smoothstep(top - 4.0, top, z)), billow);
  }
  return vec2(d * gm, g);
}

// rain under nimbostratus and cumulonimbus: grey streaks, much thinner than the cloud
float rainAt(vec3 p) {
  float g = floor(p.x / SP + 0.5);
  if (g != 3.0 && g != 9.0) return 0.0;
  vec3 q = vec3(p.x - g * SP, p.y, p.z);
  float base = g == 3.0 ? 1.0 : 1.1;
  if (q.z > base) return 0.0;
  float area = g == 3.0 ? ground(q) * smoothstep(0.35, 0.6, nz(vec3(q.xy * 0.03, 0.8)).r) : (1.0 - smoothstep(2.5, 4.5, length(q.xy + vec2(0.0, 0.0))));
  float streak = nz(vec3(q.x * 0.35, q.y * 0.35, q.z * 0.02 + uTime * 0.004)).g;
  return area * smoothstep(0.35, 0.75, streak) * 0.5;
}

// the heights (km) each cloud's box spans, rain included; the cumulonimbus's top follows the tropopause
const vec2 ZR[10] = vec2[10](vec2(0.2, 0.8), vec2(0.55, 1.85), vec2(0.95, 4.6), vec2(0.0, 5.6), vec2(3.4, 6.6),
  vec2(3.7, 4.9), vec2(9.6, 12.6), vec2(9.7, 10.5), vec2(9.4, 13.1), vec2(0.0, 19.0));

// where a ray enters and leaves cloud g's box (entry > exit when it misses)
vec2 boxHit(int g, vec3 ro, vec3 rd) {
  float zTop = g == 9 ? uTrop + 1.6 : ZR[g].y;
  vec3 lo = vec3(float(g) * SP - HALFW, -20.0, ZR[g].x);
  vec3 hi = vec3(float(g) * SP + HALFW, 20.0, zTop);
  vec3 inv = 1.0 / (rd + vec3(equal(rd, vec3(0.0))) * 1e-6);
  vec3 a = (lo - ro) * inv, b = (hi - ro) * inv;
  vec3 tmin = min(a, b), tmax = max(a, b);
  return vec2(max(max(tmin.x, tmin.y), max(tmin.z, 0.0)), min(min(tmax.x, tmax.y), tmax.z));
}

float phaseHG(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

// how much of the sun reaches a point through the cloud above it (with a softer second term for light scattered many times)
// the optical depth from a point toward the sun (about 8 km of it; 2 samples are enough in a thin ice cloud)
float sunTau(vec3 p, bool thin) {
  float tau = 0.0;
  float step = thin ? 0.6 : 0.1;
  vec3 x = p;
  int n = thin ? 2 : 7;
  for (int i = 0; i < 7; i++) {
    if (i >= n) break;
    x += uSun * step;
    vec2 c = cloudAt(x);
    tau += c.x * (c.y >= 0.0 ? SIGMA[int(c.y)] : 0.0) * step;
    step *= 1.8;
  }
  return tau;
}

vec3 skyColor(vec3 d) {
  float mu = dot(d, uSun);
  float h = max(d.z, 0.0);
  vec3 zen = vec3(0.10, 0.30, 0.68);
  vec3 hor = vec3(0.62, 0.74, 0.88);
  vec3 c = mix(hor, zen, pow(h, 0.45));
  c += vec3(1.0, 0.82, 0.55) * 0.22 * pow(max(mu, 0.0), 6.0);
  c += vec3(1.0, 0.95, 0.85) * smoothstep(0.99975, 0.99992, mu) * 30.0;   // the sun's disc
  return c;
}

void main() {
  vec2 ndc = v_uv * 2.0 - 1.0;
  vec3 dir = normalize(uFwd + ndc.x * uTan * uAspect * uRight + ndc.y * uTan * uUp);
  vec3 sunCol = vec3(1.0, 0.96, 0.9) * 2.6;
  vec3 ambTop = vec3(0.30, 0.42, 0.62);
  vec3 ambBot = vec3(0.18, 0.21, 0.26);

  // where the ray meets the sea, and the slab of air the clouds are in
  float tSea = dir.z < 0.0 ? -uCam.z / dir.z : 1e9;
  float tTop = dir.z > 0.0 ? (19.5 - uCam.z) / dir.z : (uCam.z > 19.5 ? (19.5 - uCam.z) / dir.z : 1e9);
  float tEnd = min(min(tSea, tTop), 600.0);

  float T = 1.0;
  vec3 L = vec3(0.0);
  float tauVeil = 0.0;
  float jitter = hash12(gl_FragCoord.xy);
  float mu = dot(dir, uSun);
  // light scattered once, mostly forward (a silver lining toward the sun), then light scattered many times: each octave weaker, reaching
  // deeper and less forward, which is what makes the sunlit side of a thick cloud bright and its base dark grey rather than black
  const float FOURPI = 12.566;
  float ph0 = mix(phaseHG(mu, 0.65), phaseHG(mu, -0.2), 0.25) * FOURPI;
  float ph1 = mix(phaseHG(mu, 0.32), phaseHG(mu, -0.1), 0.25) * FOURPI;
  float ph2 = mix(phaseHG(mu, 0.16), phaseHG(mu, -0.05), 0.25) * FOURPI;
  int steps = int(uSteps);
  int n = 0;
  // the ray is marched only through the boxes the clouds are in, nearest first (they lie one after another along x), so a cloud 300 km away
  // costs no more steps than one nearby
  for (int k = 0; k < 10; k++) {
    int gb = dir.x >= 0.0 ? k : 9 - k;
    vec2 hit = boxHit(gb, uCam, dir);
    float te = min(hit.y, tEnd);
    if (hit.x >= te || T < 0.01 || n >= steps) continue;
    float t = hit.x + jitter * clamp(hit.x * 0.004, 0.03, 0.6);
    for (int i = 0; i < 300; i++) {
      if (t > te || T < 0.01 || n >= steps) break;
      n++;
      vec3 p = uCam + dir * t;
      float dt = clamp(t * 0.004, 0.05, 0.6);
      vec2 c = cloudAt(p);
      if (c.x > 0.002) {
        int g = int(c.y);
        float sigma = SIGMA[g] * c.x;
        float hzN = sat(p.z / 14.0);
        vec3 amb = mix(ambBot, ambTop, hzN) * (0.65 + 0.35 * c.x);
        // the full march toward the sun only where it shows: not in thin ice, far away, or deep in a cloud already hidden behind its front
        float tau = sunTau(p, SIGMA[g] < 5.0 || t > 45.0 || T < 0.35);
        if (c.x < 0.15) dt *= 1.6;   // the thin edges in longer steps
        vec3 lum = sunCol * (exp(-tau) * ph0 + 0.5 * exp(-0.3 * tau) * ph1 + 0.25 * exp(-0.1 * tau) * ph2) * 0.6
          + amb * (0.4 + 0.6 * exp(-0.05 * tau));   // less skylight deep in a thick cloud
        float flash = uFlash * exp(-length(p - uFlashPos) / 3.0) * 9.0;
        lum += vec3(0.85, 0.85, 1.0) * flash;
        if (SIGMA[g] < 5.0) dt *= 2.5;
        float a = exp(-sigma * dt);
        L += T * lum * (1.0 - a);
        T *= a;
        if (g == 6) tauVeil += sigma * dt;
      } else {
        float rain = rainAt(p);
        if (rain > 0.001) {
          dt = max(dt, 0.15);
          float sigma = 0.9 * rain;
          vec3 lum = mix(ambBot, ambTop, 0.3) * 0.9;
          float a = exp(-sigma * dt);
          L += T * lum * (1.0 - a);
          T *= a;
        } else {
          dt = max(dt * 2.0, 0.22);   // clear air inside the box: stride
        }
      }
      t += dt;
    }
  }

  vec3 bg;
  if (tSea < 600.0 && tSea <= tTop) {
    // the sea: dark blue with the sky reflected (more at a glancing angle), the sun's glint, and the clouds' shadows
    vec3 pSea = uCam + dir * tSea;
    vec3 refl = reflect(dir, vec3(0.0, 0.0, 1.0));
    float fres = 0.02 + 0.98 * pow(1.0 - max(-dir.z, 0.0), 5.0);
    float ripple = nz(vec3(pSea.xy * 0.4, uTime * 0.01)).r;
    vec3 sea = mix(vec3(0.02, 0.07, 0.11), skyColor(normalize(refl + vec3(0.0, 0.0, 0.02))), fres);
    sea += vec3(1.0, 0.9, 0.7) * pow(max(dot(refl, uSun), 0.0), 220.0) * (0.6 + ripple) * 2.0;
    float shade = 1.0;
    for (int i = 1; i <= 8; i++) {
      vec3 x = pSea + uSun * (float(i) * float(i) * 0.3);
      vec2 c = cloudAt(x);
      shade *= exp(-c.x * (c.y >= 0.0 ? SIGMA[int(c.y)] : 0.0) * 0.3 * float(2 * i - 1));
    }
    bg = sea * (0.35 + 0.65 * shade);
  } else {
    bg = skyColor(dir);
  }
  vec3 col = L + T * bg;
  // the 22 degree halo, in the cirrostratus veil
  float ang = degrees(acos(clamp(mu, -1.0, 1.0)));
  float halo = exp(-pow((ang - 22.0) / 0.7, 2.0));
  col += uHalo * sat(tauVeil * 6.0) * halo * vec3(1.0, 0.9, 0.8) * 0.9 * (1.0 + 0.4 * smoothstep(21.4, 22.6, ang));   // reddish inside, whiter outside
  // haze with distance
  float dist = min(min(tSea, tTop), 600.0);
  col = mix(col, vec3(0.62, 0.72, 0.84), (1.0 - exp(-dist * 0.0035)) * 0.5);
  // filmic tone map
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  o = vec4(pow(sat3(col), vec3(1.0 / 2.2)), 1.0);
}`;

/**
 * Compiles and links a program without holding up the page: the driver works on it in the background (KHR_parallel_shader_compile) and it is
 * only asked whether it is done between frames; asking straight away would make the page wait for the whole compile (a second or more for the
 * cloud shader on a phone).
 */
async function program(vs, fsrc) {
  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  const shader = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };
  const v = shader(gl.VERTEX_SHADER, vs);
  const f = shader(gl.FRAGMENT_SHADER, fsrc);
  const p = gl.createProgram();
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (parallel) {
    while (!gl.getProgramParameter(p, parallel.COMPLETION_STATUS_KHR)) await new Promise(r => requestAnimationFrame(r));
  }
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getShaderInfoLog(f) || gl.getShaderInfoLog(v) || gl.getProgramInfoLog(p));
  }
  return p;
}

async function makeNoise() {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, NOISE, NOISE, NOISE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT], [gl.TEXTURE_WRAP_R, gl.REPEAT]]) {
    gl.texParameteri(gl.TEXTURE_3D, k, v);
  }
  const prog = await program(FULLSCREEN_VS, NOISE_FS);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.useProgram(prog);
  gl.viewport(0, 0, NOISE, NOISE);
  const uZ = gl.getUniformLocation(prog, 'uZ');
  // a few slices a frame: the GPU gets through them between frames instead of the page waiting for all of them at its next GL question
  for (let z = 0; z < NOISE; z++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
    gl.uniform1f(uZ, (z + 0.5) / NOISE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (z % 6 === 5) {
      gl.flush();
      await new Promise(r => requestAnimationFrame(r));
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteProgram(prog);
  return tex;
}

// ──────────────────────────────────────────────────────────────────────────── slides and camera

const SLIDES = [
  { kind: 'overview' },
  ...GENERA.map((g, i) => ({ kind: 'genus', g: i })),
];

/**
 * All ten at their true heights, seen from the south: the chart (about 300 km long, the cumulonimbus 17 km tall) fills the width, beside the
 * panel on a wide screen (the panel is over the bottom on a phone).
 */
function overview() {
  const w = innerWidth;
  const h = innerHeight;
  const panel = w > 700 ? 400 : 0;
  const halfW = Math.tan((55 / 2) * Math.PI / 180) * (w / h);   // half the view's width at 1 km away
  const length = 10 * SPACING + 10;
  const dist = (length / 2) / (halfW * (w - panel - 24) / w);
  const kmPerPx = (2 * halfW * dist) / w;
  return { target: [4.5 * SPACING - (panel / 2) * kmPerPx, 0, 6], az: 90, el: 4, dist };
}

function slideView(s) {
  if (s.kind === 'overview') return overview();
  const g = GENERA[s.g];
  const v = g.view;
  return { target: [s.g * SPACING, 0, v.z], az: v.az, el: v.el, dist: v.dist, look: v.look };
}

/** The sun for a slide: behind the viewer and to the left (a lit side and a shaded side), or in front of the camera for the halo. */
function sunFor(s) {
  const toSun = s.kind === 'genus' && GENERA[s.g].view.look === 'sun';
  const viewAz = s.kind === 'genus' ? GENERA[s.g].view.az : 90;
  const el = toSun ? 32 : 36;
  const az = toSun ? 90 : viewAz + 130;
  const r = Math.PI / 180;
  return [Math.cos(el * r) * Math.cos(az * r), Math.cos(el * r) * Math.sin(az * r), Math.sin(el * r)];
}

const state = {
  slide: 0,
  cam: slideView(SLIDES[0]),
  from: null,
  to: null,
  t0: 0,
  user: { az: 0, el: 0, zoom: 1 },
  sun: sunFor(SLIDES[0]),
  sunFrom: null,
  playing: false,
  playTimer: 0,
  profile: { pts: FALLBACK_PROFILE, label: 'Temperatures: a standard tropical profile (today’s could not be loaded)' },
};

const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

function goTo(i) {
  state.slide = (i + SLIDES.length) % SLIDES.length;
  state.from = { ...state.cam, target: [...state.cam.target] };
  state.to = slideView(SLIDES[state.slide]);
  state.sunFrom = state.sun;
  state.t0 = performance.now();
  state.user = { az: 0, el: 0, zoom: 1 };
  renderPanel();
  renderDots();
}

function camera(now) {
  if (state.to) {
    const k = Math.min(1, (now - state.t0) / 2600);
    const e = ease(k);
    const f = state.from;
    const t = state.to;
    // a long move rises and falls back, so the camera does not skim the sea between two clouds
    const far = Math.abs(t.target[0] - f.target[0]) > 1 ? Math.sin(Math.PI * e) * 0.35 : 0;
    state.cam = {
      target: [0, 1, 2].map(i => lerp(f.target[i], t.target[i], e)),
      az: lerp(f.az, t.az, e), el: lerp(f.el, t.el, e) + far * 12, dist: lerp(f.dist, t.dist, e) * (1 + far), look: t.look,
    };
    const ts = sunFor(SLIDES[state.slide]);
    state.sun = state.sunFrom.map((v, i) => lerp(v, ts[i], e));
    if (k >= 1) state.to = null;
  }
  const c = state.cam;
  const r = Math.PI / 180;
  const az = (c.az + state.user.az) * r;
  const el = Math.max(-40, Math.min(70, c.el + state.user.el)) * r;
  const dist = c.dist * state.user.zoom;
  // the camera sits in front of the target, looking at it; for an up-looking slide, from below the cloud
  let pos = [c.target[0] - Math.cos(el) * Math.cos(az) * dist, c.target[1] - Math.cos(el) * Math.sin(az) * dist, c.target[2] - Math.sin(el) * dist];
  pos[2] = Math.max(0.03, pos[2]);
  let fwd = norm(sub(c.target, pos));
  if (c.look === 'up' && !state.to) fwd = norm([fwd[0], fwd[1], fwd[2] + 0.55]);
  if (c.look === 'sun' && !state.to) fwd = norm(add(scale(state.sun, 0.85), [fwd[0] * 0.15, fwd[1] * 0.15, 0]));
  const right = norm(cross(fwd, [0, 0, 1]));
  const up = cross(right, fwd);
  return { pos, fwd, right, up };
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map(v => v * s);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ──────────────────────────────────────────────────────────────────────────── panel, ruler

const panel = document.getElementById('panel');
const fmtT = t => `${t > 0 ? '+' : t < 0 ? '−' : ''}${Math.abs(Math.round(t))} °C`;
const tClass = t => (t >= 0 ? 'temp-warm' : 'temp-cold');

/** What a cloud is made of, from the temperatures through it: liquid above 0 °C, supercooled water and ice to −40 °C, only ice below. */
function phaseOf(tBase, tTop, level) {
  if (level === 'High') return 'Ice crystals (six-sided plates and columns): at −30 °C and colder up here, high cloud is almost all ice; the few supercooled droplets in cirrocumulus freeze within minutes.';
  if (tTop >= 0) return 'Water droplets (about 0.01–0.02 mm): warmer than 0 °C throughout.';
  if (tBase <= -40) return 'Ice crystals only: colder than −40 °C, where no droplet can stay liquid.';
  if (tBase <= 0) return 'Supercooled water droplets and ice crystals: below freezing, but droplets stay liquid down to about −40 °C.';
  if (tTop > -40) return 'Water droplets in its lower part, supercooled droplets and growing ice above the 0 °C level.';
  return 'Water droplets low down, supercooled water and ice in the middle, only ice above the −40 °C level (the anvil).';
}

function renderPanel() {
  const s = SLIDES[state.slide];
  const prof = state.profile;
  const trop = tropopause(prof);
  panel.classList.add('leaving');
  setTimeout(() => {
    if (s.kind === 'overview') {
      const f0 = heightOf(prof, 0);
      const f40 = heightOf(prof, -40);
      panel.innerHTML = `
        <div class="kicker">The ten cloud types</div>
        <h1>Clouds by height</h1>
        <div class="latin">From the sea to the tropopause over South India</div>
        <dl class="facts">
          <dt>Low clouds</dt><dd>0–2 km</dd>
          <dt>Middle clouds</dt><dd>2–8 km</dd>
          <dt>High clouds</dt><dd>6–18 km (in the tropics)</dd>
          ${f0 ? `<dt>Freezing level</dt><dd class="temp-cold">${f0.toFixed(1)} km today</dd>` : ''}
          ${f40 ? `<dt>All ice above</dt><dd class="temp-cold">${f40.toFixed(1)} km (−40 °C)</dd>` : ''}
          <dt>Tropopause</dt><dd class="temp-cold">${trop.z.toFixed(1)} km, ${fmtT(trop.t)}</dd>
        </dl>
        <p>Clouds are named by their shape (<em>cumulus</em> heaps, <em>stratus</em> layers, <em>cirrus</em> curls) and by their height (<em>alto-</em> for middle, <em>cirro-</em> for high), and <em>nimbus</em> for those that rain. In the tropics the air is warm and deep, so every level sits higher than at mid-latitudes: high clouds reach 18 km.</p>
        <p class="note">Drawn to scale: the chart is about 300 km long and the tallest storm 17 km high, so from here every cloud is a thin line. Visit each one to see it close.</p>
        <p class="note">Drag to look around, scroll or pinch to move closer. Use the arrows or the dots to visit each cloud.</p>
        <div class="src">Heights: <a href="https://cloudatlas.wmo.int/en/some-useful-concepts-levels.html" target="_blank" rel="noopener">WMO International Cloud Atlas</a> (tropical levels). ${prof.label}.</div>`;
    } else {
      const g = GENERA[s.g];
      const top = g.top ?? trop.z;
      const tb = tempAt(prof, g.base);
      const tt = tempAt(prof, top);
      panel.innerHTML = `
        <div class="kicker">${g.level} cloud · ${g.id}</div>
        <h1>${g.name}</h1>
        <div class="latin">${g.latin}</div>
        <dl class="facts">
          <dt>Base</dt><dd>${g.base.toFixed(1)} km · <span class="${tClass(tb)}">${fmtT(tb)}</span></dd>
          <dt>Top</dt><dd>${top.toFixed(1)} km · <span class="${tClass(tt)}">${fmtT(tt)}</span>${g.top == null ? ' (the tropopause today)' : ''}</dd>
          <dt>Thickness</dt><dd>${(top - g.base).toFixed(1)} km</dd>
          <dt>Rain</dt><dd>${g.rain}</dd>
        </dl>
        <p><strong>Made of:</strong> ${phaseOf(tb, tt, g.level)}</p>
        <p>${g.look}</p>
        <p class="note">${g.india}</p>
        <div class="src">${prof.label}. Typical heights over South India.</div>`;
    }
    panel.classList.remove('leaving');
  }, 220);
}

const dots = document.getElementById('dots');
function renderDots() {
  dots.innerHTML = SLIDES.map((s, i) => `<button type="button" class="${i === state.slide ? 'on' : ''}" data-i="${i}" aria-label="${s.kind === 'overview' ? 'All clouds' : GENERA[s.g].name}" title="${s.kind === 'overview' ? 'All clouds' : GENERA[s.g].name}"></button>`).join('');
}
dots.addEventListener('click', e => { const i = e.target?.dataset?.i; if (i != null) { stopTour(); goTo(Number(i)); } });

const ruler = document.getElementById('ruler');
/** The height scale beside the cloud on show (or the whole chart), with today's temperatures; the freezing level, −40 °C and the tropopause marked. */
function renderRuler(cam) {
  const s = SLIDES[state.slide];
  const x = s.kind === 'overview' ? 9 * SPACING + HALF + 2 : s.g * SPACING - HALF - 1;
  const side = s.kind === 'overview' ? ' r' : '';   // the overview's scale reads from the right of the chart
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const tan = Math.tan((55 / 2) * Math.PI / 180);
  const aspect = w / h;
  const project = p => {
    const d = sub(p, cam.pos);
    const z = dot(d, cam.fwd);
    if (z < 0.2) return null;
    const sx = dot(d, cam.right) / (z * tan * aspect);
    const sy = dot(d, cam.up) / (z * tan);
    if (Math.abs(sx) > 1.1 || Math.abs(sy) > 1.1) return null;
    return [(sx * 0.5 + 0.5) * w, (1 - (sy * 0.5 + 0.5)) * h];
  };
  const prof = state.profile;
  const trop = tropopause(prof);
  const marks = [];
  const f0 = heightOf(prof, 0);
  const f40 = heightOf(prof, -40);
  if (f0) marks.push({ z: f0, label: '0 °C', cls: 'freeze' });
  if (f40) marks.push({ z: f40, label: '−40 °C', cls: 'ice' });
  marks.push({ z: trop.z, label: 'tropopause', cls: 'trop' });
  let html = '';
  let last = -1e9;
  for (let z = 0; z <= 18; z += 2) {
    const p = project([x, 0, z]);
    if (!p || Math.abs(p[1] - last) < 18) continue;
    last = p[1];
    html += `<div class="tick${side}" style="left:${p[0]}px;top:${p[1]}px">${z} km<span class="t">${fmtT(tempAt(prof, z))}</span></div>`;
  }
  for (const m of marks) {
    const p = project([x + 0.01, 0, m.z]);
    if (p) html += `<div class="tick ${m.cls}${side}" style="left:${p[0] + (side ? 70 : -70)}px;top:${p[1]}px">${m.label} · ${m.z.toFixed(1)} km</div>`;
  }
  if (s.kind === 'overview') {
    GENERA.forEach((g, i) => {
      const top = g.top ?? trop.z;
      const p = project([i * SPACING, 0, top + (g.top == null ? 1.2 : 0.9)]);
      if (p) html += `<div class="tag" style="left:${p[0]}px;top:${p[1]}px">${g.id}</div>`;
    });
  }
  ruler.innerHTML = html;
}

// ──────────────────────────────────────────────────────────────────────────── input

let drag = null;
canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, az: state.user.az, el: state.user.el }; canvas.setPointerCapture(e.pointerId); stopTour(); });
canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  state.user.az = drag.az - (e.clientX - drag.x) * 0.25;
  state.user.el = drag.el + (e.clientY - drag.y) * 0.18;
});
canvas.addEventListener('pointerup', () => (drag = null));
canvas.addEventListener('wheel', e => { e.preventDefault(); state.user.zoom = Math.min(3, Math.max(0.3, state.user.zoom * Math.exp(e.deltaY * 0.0012))); }, { passive: false });
let pinch = null;
canvas.addEventListener('touchstart', e => { if (e.touches.length === 2) pinch = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), z: state.user.zoom }; });
canvas.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && pinch) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    state.user.zoom = Math.min(3, Math.max(0.3, pinch.z * (pinch.d / d)));
  }
});
document.getElementById('prev').addEventListener('click', () => { stopTour(); goTo(state.slide - 1); });
document.getElementById('next').addEventListener('click', () => { stopTour(); goTo(state.slide + 1); });
const playBtn = document.getElementById('play');
playBtn.addEventListener('click', () => (state.playing ? stopTour() : startTour()));
window.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight') { stopTour(); goTo(state.slide + 1); }
  if (e.key === 'ArrowLeft') { stopTour(); goTo(state.slide - 1); }
});
function startTour() { state.playing = true; playBtn.setAttribute('aria-pressed', 'true'); state.playTimer = setInterval(() => goTo(state.slide + 1), 11000); }
function stopTour() { if (!state.playing) return; state.playing = false; playBtn.setAttribute('aria-pressed', 'false'); clearInterval(state.playTimer); }

// ──────────────────────────────────────────────────────────────────────────── start

function fail(msg) {
  document.getElementById('loading').innerHTML = `<div class="fail"><strong>The 3D view cannot run here</strong>${msg}<br><br><a href="../" style="color:#60a5fa">Back to the map</a></div>`;
}

async function start() {
  if (!gl) return fail('This browser has no WebGL 2.');
  // one triangle over the whole screen, for the noise slices and the sky alike
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  let prog;
  let noise;
  try {
    // both at once: the cloud shader compiles while the noise is made
    const pending = program(FULLSCREEN_VS, CLOUD_FS);
    noise = await makeNoise();
    prog = await pending;
  } catch (e) {
    console.error(e);
    return fail(String(e.message || e).slice(0, 300));
  }
  const u = {};
  for (const n of ['uNoise', 'uCam', 'uRight', 'uUp', 'uFwd', 'uSun', 'uTan', 'uAspect', 'uTime', 'uTrop', 'uFlash', 'uFlashPos', 'uHalo', 'uSteps']) u[n] = gl.getUniformLocation(prog, n);

  // phones draw fewer pixels and fewer steps (the picture is scaled up smoothly)
  const phone = Math.min(screen.width, screen.height) < 700;
  let renderScale = phone ? 0.42 : 0.6;
  let steps = phone ? 100 : 160;
  let frames = 0;
  let measureStart = performance.now();

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr * renderScale));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr * renderScale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  let flash = { until: 0, pos: [9 * SPACING, 0, 6], next: performance.now() + 4000 };

  function frame(now) {
    resize();
    const cam = camera(now);
    const s = SLIDES[state.slide];
    // lightning in the cumulonimbus every few seconds while it is on show (or in the overview)
    if (now > flash.next) {
      flash = { until: now + 90 + Math.random() * 120, pos: [9 * SPACING + (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, 3 + Math.random() * 7], next: now + 2500 + Math.random() * 5000 };
    }
    const flashOn = now < flash.until ? 0.6 + 0.4 * Math.sin(now * 0.08) : 0;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, noise);
    gl.uniform1i(u.uNoise, 0);
    gl.uniform3fv(u.uCam, cam.pos);
    gl.uniform3fv(u.uRight, cam.right);
    gl.uniform3fv(u.uUp, cam.up);
    gl.uniform3fv(u.uFwd, cam.fwd);
    gl.uniform3fv(u.uSun, norm(state.sun));
    gl.uniform1f(u.uTan, Math.tan((55 / 2) * Math.PI / 180));
    gl.uniform1f(u.uAspect, canvas.clientWidth / canvas.clientHeight);
    gl.uniform1f(u.uTime, now / 1000);
    gl.uniform1f(u.uTrop, Math.max(14, Math.min(18, tropopause(state.profile).z)));
    gl.uniform1f(u.uFlash, flashOn);
    gl.uniform3fv(u.uFlashPos, flash.pos);
    gl.uniform1f(u.uHalo, s.kind === 'genus' && GENERA[s.g].id === 'Cs' ? 1 : 0);
    gl.uniform1f(u.uSteps, steps);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    renderRuler(cam);
    // keep a smooth frame rate: fewer pixels when the GPU cannot keep up, more when it can
    frames++;
    if (now - measureStart > 600) {
      const fps = (frames * 1000) / (now - measureStart);
      if (fps < 28) renderScale = Math.max(0.22, renderScale * Math.max(0.6, Math.sqrt(fps / 40)));
      else if (fps > 55 && renderScale < (phone ? 0.6 : 0.85)) renderScale *= 1.06;
      frames = 0;
      measureStart = now;
    }
    requestAnimationFrame(frame);
  }

  renderPanel();
  renderDots();
  requestAnimationFrame(t => { document.getElementById('loading').classList.add('done'); frame(t); });

  try {
    state.profile = await loadProfile();
  } catch (e) {
    console.warn('today’s profile could not be loaded:', e);
  }
  document.getElementById('sounding').textContent = `Heights for South India · ${state.profile.label}`;
  renderPanel();
}

start();
