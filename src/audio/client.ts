import { Song } from '../tracker/song';
import type { WorkletEvent, WorkletMessage } from './worklet';
import workletUrl from './worklet.ts?worker&url';

/** Main thread side of the audio worklet. The context is created lazily on a user gesture. */
export class AudioClient {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private pending: WorkletMessage[] = [];
  private song: Song | null = null;
  onRow?: (order: number, row: number) => void;
  onScope?: (samples: Float32Array, frames: number) => void;

  get ready() {
    return this.node !== null;
  }

  /** Must be called from a user gesture (required by mobile browsers). */
  start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      return this.starting ?? Promise.resolve();
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    // Resume synchronously inside the gesture for iOS Safari.
    void ctx.resume();
    this.starting = ctx.audioWorklet.addModule(workletUrl).then(() => {
      const node = new AudioWorkletNode(ctx, 'gb-tracker', { numberOfInputs: 0, outputChannelCount: [2] });
      node.port.onmessage = (e: MessageEvent<WorkletEvent>) => {
        const msg = e.data;
        if (msg.type === 'row') this.onRow?.(msg.order, msg.row);
        else if (msg.type === 'scope') this.onScope?.(msg.samples, msg.frames);
      };
      node.connect(ctx.destination);
      this.node = node;
      if (this.song) node.port.postMessage({ type: 'song', song: this.song });
      for (const m of this.pending) node.port.postMessage(m);
      this.pending = [];
    });
    return this.starting;
  }

  setSong(song: Song) {
    this.song = song;
    this.node?.port.postMessage({ type: 'song', song });
  }

  send(msg: WorkletMessage) {
    if (this.node) this.node.port.postMessage(msg);
    else if (msg.type !== 'release') this.pending.push(msg);
  }
}
