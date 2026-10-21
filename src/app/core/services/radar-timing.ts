import type { RadarObservationTiming } from '../domain/models/radar.model';

/* When IMD writes its radar pictures, when a station is due to be looked at again, and the times found in a picture. */

/**
 * True while a station's newest scan is too recent for another one to be due, so downloading it again would return the same
 * picture. Only a time that says when the scan was written counts (read off the picture, or the file's last-modified time); the
 * send time of the response (the server's date header, when there is no last-modified) says nothing about the scan.
 */
export function scanNotDue(timing: { epochMs?: number; source?: string } | null | undefined, nowMs: number, recheckMs: number): boolean {
  if (timing?.epochMs === undefined) return false;
  if (timing.source !== 'radar_metadata' && timing.source !== 'printed_stamp' && timing.source !== 'http_last_modified') return false;
  const age = nowMs - timing.epochMs;
  return age >= 0 && age < recheckMs;
}

/** IMD writes every radar picture (CAZ, PPZ and PPI alike) on the five-minute mark, a few seconds after it. */
export const IMD_WRITE_GAP_MS = 5 * 60_000;
/** A look is due this long before the next picture is written, so a refresh each minute lands just after the write. */
export const LOOK_LEAD_MS = 6_000;
/** A radar whose newest picture is over an hour old has stopped publishing: it is looked at every 15 minutes, not every minute. */
const STALE_PICTURE_MS = 60 * 60_000;
const STALE_RECHECK_MS = 15 * 60_000;

/**
 * True while a station's next picture is not due: its newest picture was written less than 4 min 54 s ago. Both times are
 * the file's own (its Last-Modified time, and when it was last asked for), not the time printed inside the picture, which
 * can trail the write by twenty minutes or more and would make every radar look overdue on every refresh.
 */
export function pictureNotDue(nowMs: number, writtenMs: number, fetchedMs: number): boolean {
  const age = nowMs - writtenMs;
  if (age >= STALE_PICTURE_MS) return nowMs - fetchedMs < STALE_RECHECK_MS;
  return age >= 0 && age < IMD_WRITE_GAP_MS - LOOK_LEAD_MS;
}

/** A scan time as the panel shows it (IST, UTC, date); `approximate` marks it with a tilde. */
export function radarTimingFromDate(date: Date, source: string, approximate: boolean): RadarObservationTiming {
  const tilde = approximate ? '~' : '';
  const ist = date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) + ' IST';
  const utc = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const day = date.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
  return { ist: tilde + ist, utc: tilde + utc, date: day, raw: date.toISOString(), epochMs: date.getTime(), source };
}

export function extractRadarIsoTimestamp(arrayBuffer: ArrayBuffer): RadarObservationTiming | null {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    // Scan for all embedded ISO timestamps (e.g. "2026-09-29T22:12:22")
    // In animated GIFs, multiple timestamps exist across frames; pick the latest one (maximum epochMs)
    let str = '';
    const step = Math.max(1, Math.floor(bytes.length / 50000));
    for (let i = 0; i < bytes.length; i += step) {
      str += String.fromCharCode(bytes[i]);
    }
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
    const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 65536)));
    const fullText = head + ' ' + str + ' ' + tail;

    const regex = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/g;
    const matches = [...fullText.matchAll(regex)];
    if (matches.length === 0) return null;

    let bestMatch = matches[0];
    let maxEpoch = 0;

    for (const m of matches) {
      const epoch = new Date(`${m[0]}+05:30`).getTime();
      if (!isNaN(epoch) && epoch > maxEpoch) {
        maxEpoch = epoch;
        bestMatch = m;
      }
    }

    const [full, yyyy, mm, dd, hh, min, ss] = bestMatch;
    const h = parseInt(hh, 10);
    const m = parseInt(min, 10);
    const s = parseInt(ss, 10);
    const h12 = h % 12 || 12;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const pad = (n: number) => String(n).padStart(2, '0');
    const istTime = `${pad(h12)}:${pad(m)}:${pad(s)} ${ampm} IST`;

    let totalMin = h * 60 + m - 330;
    if (totalMin < 0) totalMin += 1440;
    const utcH = Math.floor(totalMin / 60) % 24;
    const utcM = totalMin % 60;
    const utcTime = `${pad(utcH)}:${pad(utcM)}:${pad(s)} UTC`;
    const dateStr = `${dd}-${mm}-${yyyy}`;

    const sweepEpoch = new Date(`${full}+05:30`).getTime();
    const epochMs = maxEpoch > 0 ? maxEpoch : (!isNaN(sweepEpoch) ? sweepEpoch : undefined);

    return { ist: istTime, utc: utcTime, date: dateStr, raw: full, epochMs, source: 'radar_metadata' };
  } catch {
    // Ignore
  }
  return null;
}
