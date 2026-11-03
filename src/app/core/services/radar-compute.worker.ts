/// <reference lib="webworker" />
import { ComputeJob, replyTransfer, runJob } from './radar-compute';

/** The radar's mosaic, off the main thread (see radar-compute.ts). */
addEventListener('message', (event: MessageEvent<ComputeJob>) => {
  const reply = runJob(event.data);
  postMessage(reply, replyTransfer(reply));
});
