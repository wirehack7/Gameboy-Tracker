import { Engine } from '../audio/engine';
import { Song } from '../tracker/song';

/** Encode stereo float samples as a 16-bit PCM WAV file. */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
  const frames = left.length;
  const dataSize = frames * 4;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // stereo
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < frames; i++) {
    v.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), true);
    v.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), true);
  }
  return new Uint8Array(buf);
}

export interface RenderOptions {
  sampleRate?: number;
  /** How many times the song is played (it ends when it loops). */
  loops?: number;
  /** Safety limit in seconds. */
  maxSeconds?: number;
  /** Seconds of tail after the end. */
  tail?: number;
  onProgress?: (seconds: number) => void;
}

/** Render a song to stereo buffers. Yields to the event loop between chunks. */
export async function renderSong(song: Song, opts: RenderOptions = {}) {
  const sampleRate = opts.sampleRate ?? 44100;
  const loops = opts.loops ?? 1;
  const maxFrames = (opts.maxSeconds ?? 600) * sampleRate;
  const engine = new Engine(song, sampleRate);
  engine.play(0, 0);
  const chunk = 512;
  const chunksL: Float32Array[] = [];
  const chunksR: Float32Array[] = [];
  let frames = 0;
  let tailFrames = -1;
  while (frames < maxFrames) {
    if (tailFrames < 0 && engine.player.loops >= loops) {
      engine.stop();
      tailFrames = Math.round((opts.tail ?? 0.5) * sampleRate);
    }
    if (tailFrames === 0) break;
    const n = tailFrames > 0 ? Math.min(chunk, tailFrames) : chunk;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    engine.render(l, r, n);
    chunksL.push(l);
    chunksR.push(r);
    frames += n;
    if (tailFrames > 0) tailFrames -= n;
    if (chunksL.length % 256 === 0) {
      opts.onProgress?.(frames / sampleRate);
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let o = 0;
  chunksL.forEach((c, i) => {
    left.set(c, o);
    right.set(chunksR[i], o);
    o += c.length;
  });
  return { left, right, sampleRate };
}
