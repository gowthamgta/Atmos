/**
 * AtmosIQ Radar Pipeline (Node.js Runner)
 *
 * Directly executes the exact same TypeScript radar processing pipeline as the frontend application:
 * 1. Parallel fetch of 44 IMD station sweeps (CAZ, PPI, PPZ).
 * 2. OCR timestamp extraction (radar-stamp.ts) and binary metadata inspection.
 * 3. 10-step heuristic classification & map removal (radar-process.ts).
 * 4. Bilinear resampling to standard 1024x1024 grid with peak intensity preservation.
 * 5. Concentric multi-ring stacking (PPI -> CAZ -> PPZ) and multi-station mosaic (radar-mosaic.ts).
 * 6. Beam elevation calculation and 4/3 Earth radius aloft fading (radar-beam.ts).
 * 7. Exports R8 intensity field (`field.bin`), shaded preview (`composite.png`), and `manifest.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  IMD_RADAR_STATIONS,
  type ProcessedRadarResult,
  type RadarProductKey,
  type RadarStationConfig,
  type RadarFieldData,
  type RadarObservationTiming,
} from '../src/app/core/domain/models/radar.model';
import {
  RADAR_FIELD_SIZE,
  decodeLastGifFrame,
  layoutMatches,
  looksLikeRadar,
  processRadarPixels,
} from '../src/app/core/services/radar-process';
import {
  composeRadarMosaic,
  ringKey,
  MOSAIC_KM_PER_PX,
  MAX_SCAN_AGE_MIN,
  isObservationEligible,
  type MosaicRing,
} from '../src/app/core/services/radar-mosaic';
import {
  stackRings,
} from '../src/app/core/services/radar.service';
import {
  lowestBeamHeights,
  withAloftFade,
} from '../src/app/core/services/radar-beam';
import {
  readStampTime,
  stampEpoch,
} from '../src/app/core/services/radar-stamp';
import {
  extractRadarIsoTimestamp,
  radarTimingFromDate,
} from '../src/app/core/services/radar-timing';
import {
  sampleRadarColorRamp,
} from '../src/app/core/services/radar-field';

const STACK_PRODUCTS: readonly RadarProductKey[] = ['ppi', 'caz', 'ppz'];
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface ParsedArgs {
  outDir: string;
  concurrency: number;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let outDir = 'public/data/radar';
  let concurrency = 10;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) outDir = args[++i];
    if (args[i] === '--concurrency' && args[i + 1]) concurrency = parseInt(args[++i], 10);
  }
  return { outDir, concurrency };
}

/** Fetch a single radar GIF from IMD */
async function fetchRadarGif(url: string): Promise<{ buffer: Buffer; lastModified: Date | null; isWriteTime: boolean } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'image/gif,image/*,*/*',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length < 1000 || buf[0] !== 0x47 || buf[1] !== 0x49 || buf[2] !== 0x46) {
      return null;
    }
    const lastModHeader = res.headers.get('last-modified');
    const lastModified = lastModHeader ? new Date(lastModHeader) : null;
    return { buffer: buf, lastModified, isWriteTime: !!lastModHeader };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Processes a station sweep exactly as RadarService.processStationSweep does */
async function processSweep(
  station: RadarStationConfig,
  productKey: RadarProductKey,
  fetchResult: { buffer: Buffer; lastModified: Date | null; isWriteTime: boolean }
): Promise<ProcessedRadarResult | null> {
  const productConfig = station.products[productKey];
  if (!productConfig || productConfig.unmeasured) return null;

  const rawBytes = new Uint8Array(fetchResult.buffer);
  const decoded = decodeLastGifFrame(rawBytes);
  if (!decoded || decoded.w < 50 || decoded.h < 50) return null;

  const { rgba, w, h } = decoded;

  // Extract observation timing
  let timing: RadarObservationTiming | null = extractRadarIsoTimestamp(rawBytes);

  if (!timing && productConfig.stampBox) {
    const stamp = readStampTime(rgba, w, h, productConfig.stampBox);
    if (stamp) {
      const served = fetchResult.lastModified && !isNaN(fetchResult.lastModified.getTime())
        ? fetchResult.lastModified.getTime()
        : Date.now();
      const scanned = stampEpoch(stamp, served);
      if (served - scanned < 20 * 3600_000) {
        timing = radarTimingFromDate(new Date(scanned), 'printed_stamp', false);
      }
    }
  }

  if (!timing && fetchResult.lastModified && !isNaN(fetchResult.lastModified.getTime())) {
    timing = radarTimingFromDate(fetchResult.lastModified, fetchResult.isWriteTime ? 'http_last_modified' : 'http_header', true);
  }

  const now = Date.now();
  let ageMinutes: number | undefined;
  let isDisplayed = false;

  if (timing?.epochMs && !isNaN(timing.epochMs)) {
    ageMinutes = Math.max(0, Math.floor((now - timing.epochMs) / 60000));
    isDisplayed = isObservationEligible(timing, now);
    timing.ageMinutes = ageMinutes;
    timing.freshness = isDisplayed ? (ageMinutes <= 20 ? 'fresh' : 'recent') : 'offline';
  }

  if (!isDisplayed || ageMinutes === undefined || ageMinutes > MAX_SCAN_AGE_MIN) {
    return null; // expired (> 45 min) or missing/future timestamp
  }

  const layoutOk = layoutMatches(productConfig.crop, w, h) && looksLikeRadar(rgba, w, h, productConfig.palette);
  if (!layoutOk) return null;

  const field = processRadarPixels(rgba, w, h, {
    crop: productConfig.crop,
    palette: productConfig.palette,
    isTransparent: true,
    isXBand: station.band === 'X-Band',
    square: productKey === 'ppi',
  });

  if (!field) return null;

  const outSize = RADAR_FIELD_SIZE;
  const fieldData: RadarFieldData = {
    field,
    cropW: outSize,
    cropH: outSize,
    cx: outSize / 2,
    cy: outSize / 2,
    radius: outSize / 2,
    bounds: productConfig.bounds,
  };

  return {
    stationId: station.id,
    dataUrl: '',
    fieldData,
    timing,
    coordinates: productConfig.maplibreCoordinates,
    isDisplayed,
  };
}

/** Encodes RGBA pixel array into a compressed PNG using Node zlib */
function encodePngDeflate(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Buffer {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0; // Filter type: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * rowBytes, rowBytes).copy(raw, y * (rowBytes + 1) + 1);
  }
  const idatData = zlib.deflateSync(raw, { level: 8 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // Compression
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace

  const makeChunk = (type: string, data: Buffer): Buffer => {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    const crc = crc32(chunk.subarray(4, 8 + data.length));
    chunk.writeUInt32BE(crc, 8 + data.length);
    return chunk;
  };

  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', idatData);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/** Standard CRC32 table */
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function main() {
  const { outDir, concurrency } = parseArgs();
  console.log(`[RadarPipeline] Starting AtmosIQ Radar Pipeline...`);
  console.log(`[RadarPipeline] Stations configured: ${IMD_RADAR_STATIONS.length}`);
  console.log(`[RadarPipeline] Output directory: ${outDir}`);

  fs.mkdirSync(outDir, { recursive: true });

  const nowMs = Date.now();
  const ringResults = new Map<string, ProcessedRadarResult>();

  type FetchJob = { station: RadarStationConfig; productKey: RadarProductKey };
  const jobs: FetchJob[] = [];

  for (const station of IMD_RADAR_STATIONS) {
    for (const p of STACK_PRODUCTS) {
      if (!station.products[p]?.unmeasured) {
        jobs.push({ station, productKey: p });
      }
    }
  }

  console.log(`[RadarPipeline] Queueing ${jobs.length} sweep fetch jobs...`);
  let completed = 0;
  let succeeded = 0;

  async function worker() {
    while (jobs.length > 0) {
      const job = jobs.shift();
      if (!job) break;
      const { station, productKey } = job;
      const productConfig = station.products[productKey];
      const url = productConfig.url;

      try {
        const fetchRes = await fetchRadarGif(url);
        if (fetchRes) {
          const res = await processSweep(station, productKey, fetchRes);
          if (res && res.fieldData) {
            ringResults.set(ringKey(station.id, productKey), res);
            succeeded++;
          }
        }
      } catch (err) {
        // Continue to next station
      } finally {
        completed++;
        if (completed % 15 === 0 || completed === jobs.length) {
          console.log(`[RadarPipeline] Progress: ${completed}/${completed + jobs.length} sweeps checked (${succeeded} active)`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[RadarPipeline] Fetch complete. Total valid sweeps: ${ringResults.size}`);

  if (ringResults.size === 0) {
    console.error(`[RadarPipeline] Error: No radar sweeps could be retrieved.`);
    process.exit(1);
  }

  // Compose concentric stacked mosaic (PPI inside, CAZ around, PPZ outside)
  console.log(`[RadarPipeline] Composing all-India concentric multi-ring mosaic...`);
  const sources: [string, ProcessedRadarResult][] = [];
  const rings: [string, MosaicRing][] = [];

  for (const station of IMD_RADAR_STATIONS) {
    const usable = (p: RadarProductKey) => {
      const r = ringResults.get(ringKey(station.id, p));
      return !!r?.fieldData && r.isDisplayed !== false && isObservationEligible(r.timing, nowMs);
    };
    for (const [p, ring] of stackRings(station, usable)) {
      const key = ringKey(station.id, p);
      const r = ringResults.get(key)!;
      sources.push([key, r]);
      rings.push([key, ring]);
    }
  }

  const ringsMap = new Map<string, MosaicRing>(rings);
  const composed = composeRadarMosaic(IMD_RADAR_STATIONS, sources, MOSAIC_KM_PER_PX, 2800, 'ppz', nowMs, ringsMap);

  if (!composed || !composed.fieldData || !composed.displayField) {
    console.error(`[RadarPipeline] Error: Mosaic composition produced no output.`);
    process.exit(1);
  }

  // Beam height calculation & aloft attenuation
  console.log(`[RadarPipeline] Computing lowest beam elevations and aloft attenuation...`);
  const { cropW: w, cropH: h } = composed.fieldData;
  const activeStationIds = [...new Set(sources.map(([k]) => k.slice(0, k.indexOf(':'))))];
  const activeConfigs = IMD_RADAR_STATIONS.filter(s => activeStationIds.includes(s.id));
  const beamHeights = lowestBeamHeights(activeConfigs, 'ppz', composed.coordinates, w, h);
  const fade = withAloftFade(composed.fieldData.field, beamHeights, composed.displayFade);

  // 1. Export intensity binary: [displayField: w*h bytes] + [fade: w*h bytes]
  const fieldBin = Buffer.alloc(w * h * 2);
  Buffer.from(composed.displayField.buffer).copy(fieldBin, 0);
  if (fade) {
    Buffer.from(fade.buffer).copy(fieldBin, w * h);
  } else {
    fieldBin.fill(255, w * h, w * h * 2);
  }
  fs.writeFileSync(path.join(outDir, 'field.bin'), fieldBin);
  console.log(`[RadarPipeline] Exported field.bin (${(fieldBin.length / 1024 / 1024).toFixed(2)} MB, ${w}x${h})`);

  // 2. Export pre-shaded Windy preview PNG (RGBA)
  console.log(`[RadarPipeline] Generating Windy-shaded preview PNG...`);
  const previewRgba = new Uint8ClampedArray(w * h * 4);
  const fieldRaw = composed.fieldData.field;

  for (let i = 0; i < w * h; i++) {
    const val = fieldRaw[i];
    if (val > 0) {
      const col = sampleRadarColorRamp(val);
      const alphaFactor = fade ? fade[i] / 255 : 1.0;
      const o = i * 4;
      previewRgba[o] = Math.round(col[0]);
      previewRgba[o + 1] = Math.round(col[1]);
      previewRgba[o + 2] = Math.round(col[2]);
      previewRgba[o + 3] = Math.round(col[3] * 255 * alphaFactor);
    }
  }

  const pngBuffer = encodePngDeflate(previewRgba, w, h);
  fs.writeFileSync(path.join(outDir, 'composite.png'), pngBuffer);
  console.log(`[RadarPipeline] Exported composite.png (${(pngBuffer.length / 1024).toFixed(1)} KB)`);

  // 3. Export manifest.json
  const stationsSummary = activeConfigs.map(s => {
    const cazRes = ringResults.get(ringKey(s.id, 'caz'));
    const ppzRes = ringResults.get(ringKey(s.id, 'ppz'));
    const ppiRes = ringResults.get(ringKey(s.id, 'ppi'));
    const primaryRes = cazRes || ppzRes || ppiRes;
    const hasEligibleProduct = [cazRes, ppzRes, ppiRes].some(r => r && isObservationEligible(r.timing, nowMs));
    return {
      id: s.id,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      band: s.band,
      timing: primaryRes?.timing || null,
      isDisplayed: hasEligibleProduct,
    };
  });

  const manifest = {
    updatedAtEpochMs: nowMs,
    updatedAtIso: new Date(nowMs).toISOString(),
    updatedAtIst: new Date(nowMs).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    bounds: composed.fieldData.bounds,
    coordinates: composed.coordinates,
    width: w,
    height: h,
    kmPerPx: MOSAIC_KM_PER_PX,
    activeStationCount: activeConfigs.length,
    totalStationCount: IMD_RADAR_STATIONS.length,
    stations: stationsSummary,
  };

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[RadarPipeline] Exported manifest.json (${activeConfigs.length}/${IMD_RADAR_STATIONS.length} stations active)`);

  // 4. Export index.html viewer for GitHub Pages
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AtmosIQ Preprocessed All-India Radar</title>
  <style>
    body { margin: 0; background: #0f1318; color: #e2e8f0; font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; padding: 24px; }
    h1 { margin: 0 0 8px 0; font-size: 22px; color: #38bdf8; }
    .meta { font-size: 14px; color: #94a3b8; margin-bottom: 20px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; background: #0369a1; color: #fff; font-weight: 600; font-size: 12px; margin-left: 8px; }
    .img-box { position: relative; background: #182230; border: 1px solid #334155; border-radius: 12px; overflow: hidden; max-width: 95vw; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    img { display: block; max-width: 100%; height: auto; }
    .grid { margin-top: 24px; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; width: 100%; max-width: 960px; font-size: 12px; }
    .st-card { background: #1e293b; padding: 8px 12px; border-radius: 6px; border-left: 3px solid #10b981; }
    .st-card.stale { border-left-color: #f59e0b; }
    .st-card.offline { border-left-color: #ef4444; opacity: 0.6; }
  </style>
</head>
<body>
  <h1>AtmosIQ Doppler Weather Radar Composite</h1>
  <div class="meta">
    Updated: <strong>${manifest.updatedAtIst}</strong>
    <span class="badge">${manifest.activeStationCount} / ${manifest.totalStationCount} Radars Active</span>
  </div>
  <div class="img-box">
    <img src="composite.png" alt="All-India Radar Composite" />
  </div>
  <div class="grid">
    ${manifest.stations.map(s => `
      <div class="st-card ${s.timing?.freshness || 'offline'}">
        <strong>${s.name}</strong><br/>
        Scan: ${s.timing?.timeFormatted || 'N/A'}<br/>
        Age: ${s.timing?.ageMinutes !== undefined ? s.timing.ageMinutes + 'm ago' : 'Offline'}
      </div>
    `).join('')}
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  console.log(`[RadarPipeline] Exported index.html`);
  console.log(`[RadarPipeline] Pipeline successfully finished.`);
}

main().catch(err => {
  console.error('[RadarPipeline] Fatal error:', err);
  process.exit(1);
});
