/// <reference lib="webworker" />

import {
  buildMicroclimateBaseGrids,
  MicroclimateGridInput
} from '../core/domain/math/microclimate-grid';

// Builds the 500 m microclimate base fields off the main thread.
// The terrain raster is sent once ('terrain'); every refresh then only sends the small node arrays.
let terrain: Uint16Array | null = null;

type InboundMessage =
  | { type: 'terrain'; data: Uint16Array }
  | { type: 'build'; id: number; input: MicroclimateGridInput };

addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  if (msg.type === 'terrain') {
    terrain = msg.data;
    return;
  }
  try {
    const grids = buildMicroclimateBaseGrids(msg.input, terrain);
    postMessage(
      { id: msg.id, grids },
      [grids.temp.buffer, grids.hum.buffer, grids.rain.buffer, grids.cape.buffer]
    );
  } catch (err: unknown) {
    postMessage({ id: msg.id, error: err instanceof Error ? err.message : 'Microclimate grid build failed' });
  }
});
