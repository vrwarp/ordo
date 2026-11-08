import { createServer, type Server, type Socket, connect } from 'node:net';

type Pair = { client: Socket; hub: Socket };

/**
 * A TCP proxy in front of a hub so a test can make the hub "die silently" (freeze: nothing flows, no
 * FIN or RST, new connections refused), swallow traffic (blackhole: what the client sends is dropped) or
 * cut every connection (dropAll). The browser is pointed at the proxy's port, so the operator and the
 * output windows reach the hub only through it.
 */
export class TcpProxy {
  private server?: Server;
  private pairs = new Set<Pair>();
  mode: 'pass' | 'freeze' | 'blackhole' = 'pass';

  constructor(
    readonly port: number,
    readonly hubPort: number,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((client) => this.accept(client));
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  private accept(client: Socket): void {
    if (this.mode === 'freeze') {
      client.destroy();
      return;
    }
    const hub = connect(this.hubPort, '127.0.0.1');
    const pair: Pair = { client, hub };
    this.pairs.add(pair);
    const drop = () => {
      this.pairs.delete(pair);
      client.destroy();
      hub.destroy();
    };
    client.on('data', (d) => {
      if (this.mode === 'pass') hub.write(d);
    });
    hub.on('data', (d) => {
      if (this.mode === 'pass') client.write(d);
    });
    client.on('error', drop);
    hub.on('error', drop);
    client.on('close', drop);
    hub.on('close', drop);
    hub.on('connect', () => {
      if (this.mode === 'freeze') {
        client.pause();
        hub.pause();
      }
    });
  }

  /** The hub falls silent: existing connections carry nothing (no close either), new ones are refused. */
  freeze(): void {
    this.mode = 'freeze';
    for (const p of this.pairs) {
      p.client.pause();
      p.hub.pause();
    }
  }

  /** Data from either side is discarded (a command sent now is lost), connections stay open. */
  blackhole(): void {
    this.mode = 'blackhole';
  }

  /** Back to normal; frozen sockets are cut so both sides reconnect cleanly. */
  thaw(): void {
    this.mode = 'pass';
    this.dropAll();
  }

  dropAll(): void {
    for (const p of [...this.pairs]) {
      p.client.destroy();
      p.hub.destroy();
      this.pairs.delete(p);
    }
  }

  get connections(): number {
    return this.pairs.size;
  }

  stop(): Promise<void> {
    this.dropAll();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
