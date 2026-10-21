import { GifReader } from 'omggif';

/** The last frame of a GIF as RGBA, or null when it cannot be decoded. */
export async function decodeRadarGif(rawArrayBuf: ArrayBuffer): Promise<{ rgba: Uint8ClampedArray | Uint8Array; w: number; h: number } | null> {
  let w = 0;
  let h = 0;
  let rgba: Uint8ClampedArray | Uint8Array | null = null;

  if (rawArrayBuf) {
    try {
      const reader = new GifReader(new Uint8Array(rawArrayBuf));
      w = reader.width;
      h = reader.height;
      const numFrames = reader.numFrames();
      const frameIdx = Math.max(0, numFrames - 1);
      const decoded = new Uint8Array(w * h * 4);
      reader.decodeAndBlitFrameRGBA(frameIdx, decoded);
      rgba = decoded;
    } catch (gifErr) {
      console.warn('omggif decode error, attempting canvas fallback:', gifErr);
    }
  }

  // Fallback: HTMLImageElement via Blob
  if (!rgba && rawArrayBuf) {
    try {
      const blob = new Blob([rawArrayBuf], { type: 'image/gif' });
      const blobUrl = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (e) => reject(e);
        img.src = blobUrl;
      });

      w = img.naturalWidth || img.width;
      h = img.naturalHeight || img.height;
      const rawCanvas = document.createElement('canvas');
      rawCanvas.width = w;
      rawCanvas.height = h;
      const rawCtx = rawCanvas.getContext('2d', { willReadFrequently: true });
      if (rawCtx) {
        rawCtx.drawImage(img, 0, 0);
        rgba = rawCtx.getImageData(0, 0, w, h).data;
      }
      URL.revokeObjectURL(blobUrl);
    } catch (fallbackErr) {
      console.warn('Canvas GIF fallback error:', fallbackErr);
    }
  }

  return rgba ? { rgba, w, h } : null;
}
