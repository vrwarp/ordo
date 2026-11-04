import base from './playwright.config.ts';
const DATA = '/tmp/claude-0/w3/data/.e2e-data';
const ws = base.webServer as { command: string; env: Record<string, string> };
export default {
  ...base,
  webServer: { ...ws, command: `rm -rf ${DATA} && node apps/hub/dist/main.js`, env: { ...ws.env, ORDO_DATA: DATA } },
};
