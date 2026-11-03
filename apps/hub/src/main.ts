import { restoreBackup } from './backup.ts';
import { loadConfig } from './config.ts';
import { createHub } from './hub.ts';

export { createHub } from './hub.ts';
export { loadConfig } from './config.ts';

const USAGE = `ordo hub

  node main.js                 start the hub (configured by ORDO_* environment variables)
  node main.js restore <ref>   restore a backup (file name, path or YYYY-MM-DD) into ORDO_DATA/ordo.db
                               add --force to restore even if media verification fails
                               stop the hub first`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return;
  }
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
  if (cmd) {
    console.error(`unknown command ${cmd}\n\n${USAGE}`);
    process.exit(2);
  }
  const hub = await createHub();
  await hub.listen();
  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    hub.log.info({ sig }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    hub
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => hub.log.error({ err: String(e) }, 'unhandled rejection'));
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
