import { fileURLToPath } from 'node:url';
import { restoreBackup } from './backup.ts';
import { loadConfig } from './config.ts';
import { createHub } from './hub.ts';
import { HEARTBEAT_MS, isToChild, sendToParent } from './ipc.ts';
import { createLogger, LogRing } from './log.ts';
import { Supervisor } from './supervisor.ts';

export { createHub } from './hub.ts';
export { loadConfig } from './config.ts';

const USAGE = `ordo hub

  node main.js                 start the hub: a supervisor with a live and a library process
                               (configured by ORDO_* environment variables)
  node main.js --single        start the hub as one process (also ORDO_SINGLE_PROCESS=1)
  node main.js restore <ref>   restore a backup (file name, path or YYYY-MM-DD) into ORDO_DATA/ordo.db
                               add --force to restore even if media verification fails
                               stop the hub first`;

/** Exit on SIGTERM/SIGINT after `close()`, with a hard backstop. */
function onSignals(close: () => Promise<void>, log: (sig: string) => void, backstopMs = 5000): void {
  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    log(sig);
    const force = setTimeout(() => process.exit(1), backstopMs);
    force.unref();
    close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function runSingle(): Promise<void> {
  const hub = await createHub();
  await hub.listen();
  // hub.close() bounds every step itself (about 3 s worst case); the backstop is 5 s.
  onSignals(
    () => hub.close(),
    (sig) => hub.log.info({ sig }, 'shutting down'),
  );
  process.on('unhandledRejection', (e) => hub.log.error({ err: String(e) }, 'unhandled rejection'));
}

async function runSupervisor(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.logLevel, stdout: true, ring: new LogRing(200), proc: 'supervisor' });
  const sup = new Supervisor({ entry: fileURLToPath(import.meta.url), dataDir: cfg.dataDir, log });
  onSignals(
    () => sup.shutdown('signal'),
    (sig) => log.info({ sig }, 'shutting down'),
    8000,
  );
  await sup.start();
}

/** A child of the supervisor: `node main.js __child live|library`. */
async function runChild(name: string): Promise<void> {
  const secret = process.env.ORDO_INTERNAL_SECRET;
  if (!secret || (name !== 'live' && name !== 'library')) throw new Error('internal: bad child invocation');
  // Heartbeat from a timer: a stuck event loop stops it and the supervisor restarts this process.
  setInterval(() => sendToParent({ t: 'beat' }), HEARTBEAT_MS).unref();
  if (name === 'library') {
    const { createLibraryProcess } = await import('./libproc.ts');
    const p = await createLibraryProcess(
      {},
      { secret, onChanges: (changes) => sendToParent({ t: 'changes', changes }) },
    );
    if (process.env.ORDO_LIVE_URL) p.setLiveUrl(process.env.ORDO_LIVE_URL);
    try {
      if (process.env.ORDO_LIVE_LOCKS) p.setLocks(JSON.parse(process.env.ORDO_LIVE_LOCKS));
    } catch {
      /* ignore: the live process re-reports its locks */
    }
    process.on('message', (m) => {
      if (!isToChild(m)) return;
      if (m.t === 'locks') p.setLocks(m);
      else if (m.t === 'live') p.setLiveUrl(m.state === 'up' ? m.url : undefined);
      else if (m.t === 'status') p.setStatus(m.processes);
    });
    const close = () => p.close();
    onSignals(close, (sig) => p.log.info({ sig }, 'library process shutting down'), 4000);
    // The supervisor vanished (killed): stop cleanly but quickly; jobs are re-queued on the next start.
    process.on('disconnect', () => {
      setTimeout(() => process.exit(0), 2500).unref();
      void close().then(() => process.exit(0));
    });
    process.on('unhandledRejection', (e) => p.log.error({ err: String(e) }, 'unhandled rejection'));
    sendToParent({ t: 'ready', url: p.url });
    return;
  }
  const { createLiveProcess } = await import('./liveproc.ts');
  const p = await createLiveProcess({}, { secret, onLocks: (m) => sendToParent(m) });
  if (process.env.ORDO_LIBRARY_URL) p.setLibrary(process.env.ORDO_LIBRARY_URL, 'up');
  process.on('message', (m) => {
    if (!isToChild(m)) return;
    if (m.t === 'library') p.setLibrary(m.url, m.state);
    else if (m.t === 'changes') p.onLibraryChanges(m.changes);
    else if (m.t === 'status') p.setStatus(m.processes);
  });
  onSignals(
    () => p.close(),
    (sig) => p.log.info({ sig }, 'live process shutting down'),
    4000,
  );
  // The supervisor vanished (killed): behave like a crash (no goodbyes), but keep the newest snapshot.
  process.on('disconnect', () => {
    p.crash();
    process.exit(0);
  });
  process.on('uncaughtException', (e) => {
    p.log.fatal({ err: e.message, stack: e.stack }, 'uncaught exception; exiting for a clean restart');
    p.crash();
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => p.log.error({ err: String(e) }, 'unhandled rejection'));
  sendToParent({ t: 'ready', url: p.url });
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return;
  }
  if (cmd === '__child') return runChild(rest[0] ?? '');
  if (cmd === 'restore') {
    const ref = rest.find((a) => !a.startsWith('--'));
    if (!ref) {
      console.error(USAGE);
      process.exit(2);
    }
    const cfg = loadConfig();
    try {
      await restoreBackup(cfg.dataDir, ref, { force: rest.includes('--force') });
    } catch (e) {
      console.error(`restore failed: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }
  if (cmd === '--single' || (!cmd && process.env.ORDO_SINGLE_PROCESS === '1')) return runSingle();
  if (cmd) {
    console.error(`unknown command ${cmd}\n\n${USAGE}`);
    process.exit(2);
  }
  return runSupervisor();
}

const isEntry = (() => {
  const a = process.argv[1] ?? '';
  return /(?:^|[\\/])main\.(?:ts|js|mjs)$/.test(a);
})();
if (isEntry) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
