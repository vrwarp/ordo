import type { OutputLink, RtcSignalIn } from '@ordo/client';

/**
 * Program view sender: answers the operator's offer with a 320x180, 10 fps track captured from a small
 * canvas that the main thread paints from the render worker's periodic frame copies. Host candidates
 * only (one PC, no STUN/TURN).
 */
export class ProgramSender {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private pc?: RTCPeerConnection;
  private stream?: MediaStream;
  private pendingIce: RTCIceCandidateInit[] = [];
  onActiveChange?: (active: boolean) => void;

  constructor(private link: OutputLink) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 320;
    this.canvas.height = 180;
    this.canvas.className = 'program-canvas';
    this.ctx = this.canvas.getContext('2d');
    if (this.ctx) {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, 320, 180);
    }
    document.body.appendChild(this.canvas);
    link.on('rtc', (m) => void this.onSignal(m));
  }

  get active(): boolean {
    return !!this.pc && this.pc.connectionState !== 'closed' && this.pc.connectionState !== 'failed';
  }

  /** Paint the latest frame copy (called whenever one arrives). */
  paint(bitmap: ImageBitmap): void {
    if (!this.active || !this.ctx) return;
    this.ctx.drawImage(bitmap, 0, 0, 320, 180);
  }

  private send(body: { sdp?: unknown; ice?: unknown }): void {
    this.link.hub.send({ t: 'rtc.signal', to: 'operator', ...body });
  }

  private close(): void {
    try {
      this.pc?.close();
    } catch {
      /* closed */
    }
    this.pc = undefined;
    this.onActiveChange?.(false);
  }

  private async onSignal(m: RtcSignalIn): Promise<void> {
    if (m.from !== 'operator') return;
    try {
      const sdp = m.sdp as RTCSessionDescriptionInit | undefined;
      if (sdp?.type === 'offer') {
        this.close();
        const pc = new RTCPeerConnection({ iceServers: [] });
        this.pc = pc;
        this.pendingIce = [];
        this.stream ??= this.canvas.captureStream(10);
        for (const track of this.stream.getVideoTracks()) pc.addTrack(track, this.stream);
        pc.onicecandidate = (ev) => {
          if (ev.candidate) this.send({ ice: ev.candidate.toJSON() });
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            if (this.pc === pc) this.close();
          }
        };
        await pc.setRemoteDescription(sdp);
        for (const c of this.pendingIce) await pc.addIceCandidate(c).catch(() => undefined);
        this.pendingIce = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ sdp: pc.localDescription?.toJSON() ?? answer });
        this.onActiveChange?.(true);
      } else if (m.ice) {
        const c = m.ice as RTCIceCandidateInit;
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(c).catch(() => undefined);
        else this.pendingIce.push(c);
      } else if (sdp === null || (m as { bye?: boolean }).bye) {
        this.close();
      }
    } catch (err) {
      console.warn('[ordo] program view signalling failed', err);
    }
  }
}
