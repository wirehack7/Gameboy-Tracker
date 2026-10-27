/**
 * Video export (WebM: VP9 or VP8 with Opus) and compressed audio export
 * (Ogg Opus). The song is rendered offline one video frame at a time: the
 * emulator produces the frame's audio and per-channel output, a canvas draws
 * the scopes and the pattern at the row being played, and the browser's
 * WebCodecs encoders compress both. Faster than real time on most machines.
 */
import { Engine } from '../audio/engine';
import { CHANNEL_KINDS, Song } from '../tracker/song';
import { formatCell } from '../ui/editor';
import { scopeTrace } from '../ui/scope';
import { muxOggOpus, opusHead } from './ogg';
import { WebmFrame, WebmTrack, muxWebm } from './webm';

export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
export const VIDEO_FPS = 30;
/** Opus always runs at 48 kHz. */
export const OPUS_RATE = 48000;
/** libopus look-ahead at 48 kHz, used when the encoder does not report its OpusHead. */
const DEFAULT_PRE_SKIP = 312;

export interface TimelineFrame {
  left: Float32Array;
  right: Float32Array;
  /** Per-channel output, 4 interleaved values per sample. */
  channels: Float32Array;
  order: number;
  row: number;
  /** Seconds from the start to the end of this frame. */
  time: number;
}

/**
 * Steps the emulator one video frame at a time. Sample counts per frame are
 * rounded so that the total always matches the elapsed time exactly.
 */
export class Timeline {
  readonly engine: Engine;
  private frame = 0;
  private samples = 0;
  private tailLeft = -1;
  private order = 0;
  private row = 0;

  constructor(
    song: Song,
    readonly sampleRate: number,
    readonly fps: number,
    readonly loops = 1,
    readonly tail = 0.5,
    readonly maxSeconds = 600,
  ) {
    this.engine = new Engine(song, sampleRate, true);
    this.engine.player.onRow = (order, row) => {
      this.order = order;
      this.row = row;
    };
    this.engine.play(0, 0);
  }

  get seconds() {
    return this.samples / this.sampleRate;
  }

  /** The next frame, or null once the song (and its tail) has ended. */
  next(): TimelineFrame | null {
    if (this.tailLeft < 0 && (this.engine.player.loops >= this.loops || this.seconds >= this.maxSeconds)) {
      this.engine.stop();
      this.tailLeft = Math.round(this.tail * this.sampleRate);
    }
    if (this.tailLeft === 0) return null;
    let n = Math.round(((this.frame + 1) * this.sampleRate) / this.fps) - this.samples;
    if (this.tailLeft > 0) {
      n = Math.min(n, this.tailLeft);
      this.tailLeft -= n;
    }
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    const channels = new Float32Array(n * 4);
    this.engine.render(left, right, n, channels);
    this.frame++;
    this.samples += n;
    return {
      left,
      right,
      channels,
      order: this.order,
      row: this.row,
      time: this.seconds,
    };
  }
}

export interface VideoColors {
  bg: string;
  surface: string;
  line: string;
  ink: string;
  inkSoft: string;
  navy: string;
  accent: string;
  stripeA: string;
  stripeB: string;
  patBg: string;
  patBeat: string;
  patBar: string;
  play: string;
  playInk: string;
  num: string;
  fields: string[];
  off: string;
  empty: string;
  lcdBg: string;
  lcdInk: string;
}

/** Light theme colours (src/theme.css), used when no page styles are available. */
export const DEFAULT_COLORS: VideoColors = {
  bg: '#e4e0d7',
  surface: '#f1eee8',
  line: '#c7c1b4',
  ink: '#26262e',
  inkSoft: '#6b6873',
  navy: '#2b2f86',
  accent: '#a3224f',
  stripeA: '#8e2e5c',
  stripeB: '#2e3080',
  patBg: '#f8f6f1',
  patBeat: '#efebe2',
  patBar: '#e5e0d4',
  play: '#a3224f',
  playInk: '#fbf2f5',
  num: '#9a958b',
  fields: ['#23288a', '#a3224f', '#2d7a31', '#b25700', '#7a4a12', '#7a4a12'],
  off: '#8b8790',
  empty: '#c9c4b9',
  lcdBg: '#b4c27c',
  lcdInk: '#1f2b17',
};

/** Colours of the current theme, read from the page's CSS variables. */
export function themeColors(style: CSSStyleDeclaration): VideoColors {
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const d = DEFAULT_COLORS;
  const param = v('--c-param', d.fields[4]);
  return {
    bg: v('--bg', d.bg),
    surface: v('--surface', d.surface),
    line: v('--line', d.line),
    ink: v('--ink', d.ink),
    inkSoft: v('--ink-soft', d.inkSoft),
    navy: v('--navy', d.navy),
    accent: v('--accent', d.accent),
    stripeA: v('--stripe-a', d.stripeA),
    stripeB: v('--stripe-b', d.stripeB),
    patBg: v('--pat-bg', d.patBg),
    patBeat: v('--pat-beat', d.patBeat),
    patBar: v('--pat-bar', d.patBar),
    play: v('--pat-play', d.play),
    playInk: v('--pat-play-ink', d.playInk),
    num: v('--c-num', d.num),
    fields: [
      v('--c-note', d.fields[0]),
      v('--c-inst', d.fields[1]),
      v('--c-vol', d.fields[2]),
      v('--c-fx', d.fields[3]),
      param,
      param,
    ],
    off: v('--c-off', d.off),
    empty: v('--c-empty', d.empty),
    lcdBg: v('--lcd-bg', d.lcdBg),
    lcdInk: v('--lcd-ink', d.lcdInk),
  };
}

const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const EMPTY_GLYPH = ['···', '·', '·', '·', '·', '·'];
/** Field widths in characters (note, instrument, volume, effect, param hi, param lo) and the gaps before them. */
const FIELD_CHARS = [3, 1, 1, 1, 1, 1];
const FIELD_GAP = [0, 1, 1, 1, 0, 0];
const VISIBLE_ROWS = 17;

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** Draw one video frame: title bar, four channel scopes and the pattern around the playing row. */
export function drawFrame(
  g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  song: Song,
  frame: TimelineFrame,
  c: VideoColors,
) {
  const W = VIDEO_WIDTH;
  const H = VIDEO_HEIGHT;
  g.fillStyle = c.bg;
  g.fillRect(0, 0, W, H);

  // Title bar.
  g.fillStyle = c.surface;
  g.fillRect(0, 0, W, 76);
  g.fillStyle = c.stripeA;
  g.fillRect(0, 76, W, 4);
  g.fillStyle = c.stripeB;
  g.fillRect(0, 80, W, 4);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = c.navy;
  g.font = `italic 800 30px ${SANS}`;
  g.fillText(song.title || 'Untitled', 32, 42, 760);
  g.fillStyle = c.inkSoft;
  g.font = `400 18px ${SANS}`;
  g.fillText(song.author || '', 32, 66, 760);
  g.textAlign = 'right';
  g.fillStyle = c.ink;
  g.font = `700 26px ${MONO}`;
  g.fillText(clock(frame.time), W - 32, 42);
  g.font = `400 16px ${MONO}`;
  g.fillStyle = c.inkSoft;
  const pat = song.order[frame.order] ?? 0;
  g.fillText(
    `${song.model.toUpperCase()}  ORD ${hex2(frame.order)}  PAT ${hex2(pat)}  ROW ${hex2(frame.row)}`,
    W - 32,
    66,
  );

  // Scopes.
  const gap = 16;
  const sw = (W - 64 - 3 * gap) / 4;
  const sy = 104;
  const sh = 150;
  const n = frame.channels.length / 4;
  for (let ch = 0; ch < 4; ch++) {
    const x = 32 + ch * (sw + gap);
    g.fillStyle = c.surface;
    g.fillRect(x, sy, sw, sh + 34);
    g.textAlign = 'left';
    g.fillStyle = c.ink;
    g.font = `700 16px ${MONO}`;
    g.fillText(`CH${ch + 1}`, x + 10, sy + 22);
    g.fillStyle = c.inkSoft;
    g.font = `400 16px ${MONO}`;
    g.fillText(CHANNEL_KINDS[ch].toUpperCase(), x + 54, sy + 22);
    const ly = sy + 32;
    const lh = sh - 6;
    g.fillStyle = c.lcdBg;
    g.fillRect(x + 8, ly, sw - 16, lh);
    const trace = scopeTrace(frame.channels, n, ch, Math.min(n, 800));
    g.strokeStyle = c.lcdInk;
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < trace.length; i++) {
      const px = x + 8 + (i / Math.max(1, trace.length - 1)) * (sw - 16);
      const py = ly + lh / 2 - trace[i] * (lh / 2 - 4);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  }

  // Pattern around the playing row.
  const py = sy + sh + 50;
  const ph = H - py - 24;
  const rh = ph / VISIBLE_ROWS;
  g.fillStyle = c.patBg;
  g.fillRect(32, py, W - 64, ph);
  g.font = `400 ${Math.round(rh * 0.72)}px ${MONO}`;
  const cw = g.measureText('0').width;
  const chW = (W - 64 - 5 * cw) / 4;
  const rows = song.patterns[pat]?.rows ?? [];
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  for (let i = 0; i < VISIBLE_ROWS; i++) {
    const r = frame.row + i - (VISIBLE_ROWS >> 1);
    if (r < 0 || r >= rows.length) continue;
    const y = py + i * rh;
    const playing = r === frame.row;
    if (playing || r % 4 === 0) {
      g.fillStyle = playing ? c.play : r % 16 === 0 ? c.patBar : c.patBeat;
      g.fillRect(32, y, W - 64, rh);
    }
    const mid = y + rh / 2;
    g.fillStyle = playing ? c.playInk : c.num;
    g.fillText(hex2(r), 32 + cw, mid);
    for (let ch = 0; ch < 4; ch++) {
      const cell = rows[r][ch];
      const fields = formatCell(cell);
      const x0 = 32 + 4 * cw + ch * chW;
      g.fillStyle = c.line;
      g.fillRect(x0 - cw * 0.6, y, 1, rh);
      let x = x0 + cw * 0.4;
      fields.forEach((text, f) => {
        x += FIELD_GAP[f] * cw;
        const empty = text.startsWith('-');
        g.fillStyle = playing ? c.playInk : empty ? c.empty : f === 0 && text === '===' ? c.off : c.fields[f];
        g.fillText(empty ? EMPTY_GLYPH[f] : text, x, mid);
        x += FIELD_CHARS[f] * cw;
      });
    }
  }
}

export interface MediaExportOptions {
  loops: number;
  onProgress?: (seconds: number) => void;
}

/** Whether this browser has the WebCodecs encoders the exports need. */
export function canEncode(kind: 'video' | 'audio'): boolean {
  return typeof AudioEncoder !== 'undefined' && (kind === 'audio' || typeof VideoEncoder !== 'undefined');
}

async function settle(...encoders: { encodeQueueSize: number }[]) {
  while (encoders.some((e) => e.encodeQueueSize > 8)) await new Promise((r) => setTimeout(r, 1));
}

/** Opus encoder that collects its packets and reports the pre-skip. */
async function opusEncoder(onError: (e: Error) => void) {
  const config: AudioEncoderConfig = {
    codec: 'opus',
    sampleRate: OPUS_RATE,
    numberOfChannels: 2,
    bitrate: 160000,
  };
  if (!(await AudioEncoder.isConfigSupported(config)).supported) throw new Error('Opus encoding is not supported.');
  const packets: { data: Uint8Array; timestampUs: number; samples: number }[] = [];
  let preSkip = DEFAULT_PRE_SKIP;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const desc = meta?.decoderConfig?.description;
      if (desc) {
        const head = ArrayBuffer.isView(desc)
          ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
          : new Uint8Array(desc);
        if (head.length >= 12) preSkip = head[10] | (head[11] << 8);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const samples = Math.round(((chunk.duration ?? 20000) * OPUS_RATE) / 1e6);
      packets.push({ data, timestampUs: chunk.timestamp, samples });
    },
    error: onError,
  });
  encoder.configure(config);
  let written = 0;
  return {
    encoder,
    packets,
    get preSkip() {
      return preSkip;
    },
    get samples() {
      return written;
    },
    encode(left: Float32Array, right: Float32Array) {
      const data = new Float32Array(left.length * 2);
      data.set(left);
      data.set(right, left.length);
      const audio = new AudioData({
        format: 'f32-planar',
        sampleRate: OPUS_RATE,
        numberOfFrames: left.length,
        numberOfChannels: 2,
        timestamp: Math.round((written * 1e6) / OPUS_RATE),
        data,
      });
      encoder.encode(audio);
      audio.close();
      written += left.length;
    },
  };
}

/** Ogg Opus file of the song. */
export async function exportOpus(song: Song, opts: MediaExportOptions): Promise<{ data: Uint8Array; seconds: number }> {
  let failure: Error | null = null;
  const opus = await opusEncoder((e) => (failure = e));
  const timeline = new Timeline(song, OPUS_RATE, VIDEO_FPS, opts.loops);
  for (let f = timeline.next(), i = 0; f; f = timeline.next(), i++) {
    if (failure) throw failure;
    opus.encode(f.left, f.right);
    await settle(opus.encoder);
    if (i % VIDEO_FPS === 0) opts.onProgress?.(f.time);
  }
  await opus.encoder.flush();
  opus.encoder.close();
  if (failure) throw failure;
  const data = muxOggOpus({
    packets: opus.packets,
    channels: 2,
    preSkip: opus.preSkip,
    inputSampleRate: OPUS_RATE,
    totalSamples: opus.samples,
    tags: { TITLE: song.title, ARTIST: song.author, ENCODER: 'GB Tracker' },
  });
  return { data, seconds: timeline.seconds };
}

/** WebM video of the song with scopes and the scrolling pattern. */
export async function exportVideo(
  song: Song,
  opts: MediaExportOptions & { colors: VideoColors },
): Promise<{ data: Uint8Array; seconds: number }> {
  let failure: Error | null = null;
  const onError = (e: Error) => (failure = e);
  const opus = await opusEncoder(onError);

  let codec = '';
  let trackCodec: WebmTrack['codec'] = 'V_VP9';
  for (const [c, t] of [
    ['vp09.00.31.08', 'V_VP9'],
    ['vp8', 'V_VP8'],
  ] as const) {
    const config = {
      codec: c,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      bitrate: 3_000_000,
      framerate: VIDEO_FPS,
    };
    if ((await VideoEncoder.isConfigSupported(config)).supported) {
      [codec, trackCodec] = [c, t];
      break;
    }
  }
  if (!codec) throw new Error('VP9 and VP8 video encoding are not supported.');
  const videoFrames: WebmFrame[] = [];
  const video = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      videoFrames.push({
        track: 1,
        timestampUs: chunk.timestamp,
        key: chunk.type === 'key',
        data,
      });
    },
    error: onError,
  });
  video.configure({
    codec,
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    bitrate: 3_000_000,
    framerate: VIDEO_FPS,
  });

  const canvas = new OffscreenCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const g = canvas.getContext('2d')!;
  const timeline = new Timeline(song, OPUS_RATE, VIDEO_FPS, opts.loops);
  let i = 0;
  for (let f = timeline.next(); f; f = timeline.next(), i++) {
    if (failure) throw failure;
    drawFrame(g, song, f, opts.colors);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1e6) / VIDEO_FPS),
      duration: Math.round(1e6 / VIDEO_FPS),
    });
    video.encode(frame, { keyFrame: i % (VIDEO_FPS * 2) === 0 });
    frame.close();
    opus.encode(f.left, f.right);
    await settle(video, opus.encoder);
    if (i % VIDEO_FPS === 0) opts.onProgress?.(f.time);
  }
  await Promise.all([video.flush(), opus.encoder.flush()]);
  video.close();
  opus.encoder.close();
  if (failure) throw failure;

  const data = muxWebm({
    tracks: [
      { codec: trackCodec, width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
      {
        codec: 'A_OPUS',
        sampleRate: OPUS_RATE,
        channels: 2,
        codecPrivate: opusHead(2, opus.preSkip, OPUS_RATE),
        codecDelayNs: Math.round((opus.preSkip / OPUS_RATE) * 1e9),
        seekPreRollNs: 80_000_000,
      },
    ],
    frames: [
      ...videoFrames,
      ...opus.packets.map((p) => ({
        track: 2,
        timestampUs: p.timestampUs,
        key: true,
        data: p.data,
      })),
    ],
    durationMs: (i * 1000) / VIDEO_FPS,
    title: song.title,
  });
  return { data, seconds: timeline.seconds };
}
