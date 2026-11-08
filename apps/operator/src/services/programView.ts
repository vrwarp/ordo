import type { RtcSignalIn } from '@ordo/client';
import type { OutputHealthEntry } from '@ordo/protocol';
import { create } from 'zustand';
import type { Controller } from './controller.ts';
import { log } from './log.ts';

export type ProgramEntry = { stream?: MediaStream; state: 'idle' | 'connecting' | 'live' | 'failed' };
export const useProgram = create<Record<string, ProgramEntry>>(() => ({}));

type Peer = {
  pc: RTCPeerConnection;
  timeout?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  pendingIce: RTCIceCandidateInit[];
  haveAnswer: boolean;
};

/**
 * Program view receiver (design/15): one receive-only RTCPeerConnection per output with host ICE only.
 * The operator offers through the hub's rtc.signal relay; the output answers with a 320x180 10 fps
 * canvas capture. Reconnects when the output reconnects or the connection fails.
 */
export class ProgramViews {
  private peers = new Map<string, Peer>();
  private lastConnected = new Map<string, boolean>();

  constructor(private ctl: Controller) {}

  dispose(): void {
    for (const id of [...this.peers.keys()]) this.close(id);
  }

  onHealth(h: Record<string, OutputHealthEntry>): void {
    for (const [id, e] of Object.entries(h)) {
      const was = this.lastConnected.get(id) ?? false;
      this.lastConnected.set(id, e.connected);
      if (e.connected && (!was || !this.peers.has(id))) void this.connect(id);
      if (!e.connected && was) this.close(id);
    }
  }

  async connect(outputId: string): Promise<void> {
    this.close(outputId);
    if (typeof RTCPeerConnection === 'undefined' || !this.ctl.hub.connected) return;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const peer: Peer = { pc, pendingIce: [], haveAnswer: false };
    this.peers.set(outputId, peer);
    this.set(outputId, { state: 'connecting' });
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.set(outputId, { stream, state: 'live' });
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.ctl.hub.send({ t: 'rtc.signal', to: outputId, ice: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(outputId)?.pc !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.set(outputId, { state: 'failed' });
        this.scheduleRetry(outputId, 3000);
      }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.ctl.hub.send({ t: 'rtc.signal', to: outputId, sdp: pc.localDescription?.toJSON() });
      peer.timeout = setTimeout(() => {
        if (!peer.haveAnswer) this.scheduleRetry(outputId, 0);
      }, 10_000);
    } catch (e) {
      log('warn', `program view ${outputId}: ${String(e)}`);
      this.set(outputId, { state: 'failed' });
      this.scheduleRetry(outputId, 5000);
    }
  }

  onSignal(m: RtcSignalIn): void {
    const peer = this.peers.get(m.from);
    if (!peer) return;
    const sdp = m.sdp as RTCSessionDescriptionInit | undefined;
    if (sdp?.type === 'answer') {
      peer.haveAnswer = true;
      clearTimeout(peer.timeout);
      void peer.pc
        .setRemoteDescription(sdp)
        .then(async () => {
          for (const c of peer.pendingIce) await peer.pc.addIceCandidate(c).catch(() => undefined);
          peer.pendingIce = [];
        })
        .catch((e) => log('warn', `program view answer: ${String(e)}`));
    }
    const ice = m.ice as RTCIceCandidateInit | undefined;
    if (ice) {
      if (peer.haveAnswer && peer.pc.remoteDescription)
        void peer.pc.addIceCandidate(ice).catch(() => undefined);
      else peer.pendingIce.push(ice);
    }
  }

  private scheduleRetry(outputId: string, ms: number): void {
    const peer = this.peers.get(outputId);
    if (!peer || peer.retry) return;
    peer.retry = setTimeout(() => {
      if (this.peers.get(outputId) === peer && this.lastConnected.get(outputId)) void this.connect(outputId);
    }, ms);
  }

  close(outputId: string): void {
    const p = this.peers.get(outputId);
    if (!p) return;
    clearTimeout(p.timeout);
    clearTimeout(p.retry);
    try {
      p.pc.close();
    } catch {
      /* closed */
    }
    this.peers.delete(outputId);
    this.set(outputId, { state: 'idle' });
  }

  private set(id: string, e: ProgramEntry): void {
    useProgram.setState({ [id]: e });
  }
}

export function installProgramViews(ctl: Controller): ProgramViews {
  const pv = new ProgramViews(ctl);
  ctl.hooks.onHealth = (h) => pv.onHealth(h);
  ctl.hooks.onRtc = (m) => pv.onSignal(m);
  return pv;
}
