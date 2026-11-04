// Supervisor test child: `node child.mjs __child <name>`. Sends ready and heartbeats like the hub's
// children. FIXTURE_CRASH=<name> makes that child exit 50 ms after ready; FIXTURE_STALL=<name> stops its
// heartbeat. The library child reports locks it receives as a log line; the live child sends locks
// when told FIXTURE_LOCKS=1. FIXTURE_SLOW_START=<name>:<ms> keeps that child silent (no heartbeat, no
// ready) for <ms> first, like a cold boot on a slow disk.
const name = process.argv[3];
const send = (m) => process.connected && process.send(m);
const [slowName, slowMs] = (process.env.FIXTURE_SLOW_START ?? '').split(':');
const startDelay = slowName === name ? Number(slowMs) : 0;
const bootAt = Date.now();
const beat = setInterval(() => {
  if (Date.now() - bootAt < startDelay) return;
  if (process.env.FIXTURE_STALL !== name) send({ t: 'beat' });
}, 100);
process.on('message', (m) => {
  if (m.t === 'locks') send({ t: 'log', level: 'info', msg: `locks ${m.playlistId}` });
  if (m.t === 'library') send({ t: 'log', level: 'info', msg: `library ${m.state} ${m.url ?? ''}` });
});
process.on('SIGTERM', () => process.exit(0));
process.on('disconnect', () => process.exit(0));
setTimeout(() => {
  send({ t: 'ready', url: `http://127.0.0.1:1/${name}/${process.pid}` });
  if (process.env.FIXTURE_LOCKS === '1' && name === 'live')
    send({ t: 'locks', mode: 'live', playlistId: 'pl-1', presentations: [], media: [] });
  if (process.env.FIXTURE_CRASH === name) setTimeout(() => process.exit(1), 50);
}, 20 + startDelay);
void beat;
