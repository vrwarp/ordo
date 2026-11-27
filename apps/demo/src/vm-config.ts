/**
 * What the demo's VM hub is (docs/design/26-pages-demo.md, "The VM hub"), shared by the build (scripts/build-vm.ts)
 * and the page (vm-host.ts): the guest's hub runs exactly as in the container, configured only by its environment.
 */
const DATA_DIR = '/data/ordo';
const PORT = 8080;
/** The demo's published PIN (scripts/seed.ts sets it on the sample hub). It guards nothing: the hub is in the visitor's browser. */
const PIN = '246810';

const ENV: Record<string, string> = {
  NODE_ENV: 'production',
  ORDO_DATA: DATA_DIR,
  ORDO_APPS_DIR: '/app/apps',
  ORDO_PORT: String(PORT),
  ORDO_HOST: '127.0.0.1',
  ORDO_DOMAIN: 'localhost',
  // LibreOffice and Chromium are not in the image (ffmpeg and poppler are): the hub turns those features off, as on a
  // hub installed without them.
  ORDO_LIBREOFFICE: 'off',
  ORDO_FONTS_DIR: '/usr/share/fonts',
  // The guest's disk is the visitor's browser storage; the hub's free-space floor would measure the 4 GiB disk.
  ORDO_MIN_FREE_GB: '0',
  ORDO_DEV_PIN: PIN,
};

export const VM_GUEST = {
  /** The distro name written into the system image (the data disk keeps its changes in /data/distros/<name>). */
  distro: 'ordo',
  memoryMiB: 768,
  dataDir: DATA_DIR,
  port: PORT,
  pin: PIN,
  env: ENV,
  /** Starts the hub's supervisor in the background, as the container's entrypoint does. */
  startCommand: `cd /app/apps/hub && ${Object.entries(ENV)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')} nohup node dist/main.js >>${DATA_DIR}/hub.log 2>&1 </dev/null &`,
} as const;
