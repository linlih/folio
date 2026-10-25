import type { Peer } from "../engines/types";

/**
 * In-memory relay between replicas. While a peer is offline its local updates
 * stay queued; going online delivers the queue, and `fullSync` additionally
 * exchanges `exportSince(version)` both ways, like a reconnect handshake.
 * Delivery order is shuffled by the caller's rng to exercise reordering.
 */
export class Net {
  private online: boolean[];
  private outbox: Uint8Array[][];
  private unsub: (() => void)[];
  bytesSent = 0;
  messages = 0;

  constructor(
    private peers: Peer[],
    private rng: () => number = Math.random,
  ) {
    this.online = peers.map(() => true);
    this.outbox = peers.map(() => []);
    this.unsub = peers.map((p, i) => p.onLocalUpdate((u) => this.onLocal(i, u)));
  }

  private onLocal(from: number, update: Uint8Array) {
    // Copy: some bindings reuse buffers.
    this.outbox[from].push(update.slice());
    if (this.online[from]) this.flush(from);
  }

  private flush(from: number) {
    const batch = this.outbox[from];
    this.outbox[from] = [];
    for (let to = 0; to < this.peers.length; to++) {
      if (to === from || !this.online[to]) continue;
      for (const u of this.shuffled(batch)) this.deliver(to, u);
    }
    // Offline receivers catch up through fullSync when they reconnect.
  }

  private deliver(to: number, u: Uint8Array) {
    this.bytesSent += u.byteLength;
    this.messages++;
    this.peers[to].importUpdate(u);
  }

  private shuffled<T>(xs: T[]): T[] {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  setOnline(i: number, on: boolean) {
    this.online[i] = on;
    if (on) {
      this.outbox[i] = [];
      for (let j = 0; j < this.peers.length; j++) {
        if (j !== i && this.online[j]) this.handshake(i, j);
      }
    }
  }

  isOnline(i: number) {
    return this.online[i];
  }

  private handshake(a: number, b: number) {
    const toB = this.peers[a].exportSince(this.peers[b].version());
    const toA = this.peers[b].exportSince(this.peers[a].version());
    this.deliver(b, toB);
    this.deliver(a, toA);
  }

  /** Bring every pair up to date regardless of online flags. */
  fullSync() {
    this.online = this.online.map(() => true);
    this.outbox = this.outbox.map(() => []);
    for (let a = 0; a < this.peers.length; a++) {
      for (let b = a + 1; b < this.peers.length; b++) this.handshake(a, b);
    }
  }

  dispose() {
    this.unsub.forEach((u) => u());
  }
}
