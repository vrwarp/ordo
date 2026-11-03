// CPU-pool test worker: 'font' answers, 'pptx' never returns (a parser stuck in a loop), 'pro7' crashes.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (m) => {
  if (m.kind === 'font')
    parentPort.postMessage({ id: m.id, ok: true, result: { family: 'Echo', n: m.input.n } });
  else if (m.kind === 'pptx') for (;;) {}
  else process.exit(3);
});
