// CPU-pool test worker: 'pptx' allocates without bound (a runaway parse); 'font' answers.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (m) => {
  if (m.kind === 'font') {
    parentPort.postMessage({ id: m.id, ok: true, result: { family: 'Echo', n: m.input.n } });
    return;
  }
  const hoard = [];
  for (;;) hoard.push(new Array(1e5).fill(hoard.length));
});
