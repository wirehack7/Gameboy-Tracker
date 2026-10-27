/**
 * Minimal WebM (Matroska) muxer for the video and audio export: an EBML
 * header, one segment with Info and Tracks, and clusters of SimpleBlocks.
 * Frames come from WebCodecs encoders (VP8/VP9 video, Opus audio).
 */

export interface WebmTrack {
  codec: 'V_VP8' | 'V_VP9' | 'A_OPUS';
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  codecPrivate?: Uint8Array;
  /** Opus pre-skip in nanoseconds. */
  codecDelayNs?: number;
  seekPreRollNs?: number;
}

export interface WebmFrame {
  /** 1-based index into the tracks. */
  track: number;
  timestampUs: number;
  key: boolean;
  data: Uint8Array;
}

export interface WebmOptions {
  tracks: WebmTrack[];
  frames: WebmFrame[];
  durationMs: number;
  title?: string;
}

/** Longest a cluster may last: block times are signed 16-bit milliseconds. */
const MAX_CLUSTER_MS = 30000;
/** Audio-only files start a new cluster this often. */
const AUDIO_CLUSTER_MS = 5000;

/** EBML variable-length integer (element sizes, track numbers). */
export function vint(value: number): number[] {
  let len = 1;
  while (value >= 2 ** (7 * len) - 1) len++;
  const out: number[] = [];
  for (let i = len - 1; i >= 0; i--) out.push(Math.floor(value / 2 ** (8 * i)) & 0xff);
  out[0] |= 0x80 >> (len - 1);
  return out;
}

type Part = Uint8Array | number[];

function concat(parts: Part[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
}

function el(id: number, ...children: Part[]): Uint8Array {
  const body = concat(children);
  return concat([idBytes(id), vint(body.length), body]);
}

function uint(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  for (let v = value; bytes.length === 0 || v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return el(id, bytes);
}

function float(id: number, value: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value);
  return el(id, b);
}

function str(id: number, value: string): Uint8Array {
  return el(id, new TextEncoder().encode(value));
}

export function muxWebm({ tracks, frames, durationMs, title }: WebmOptions): Uint8Array {
  const header = el(
    0x1a45dfa3,
    uint(0x4286, 1), // EBMLVersion
    uint(0x42f7, 1), // EBMLReadVersion
    uint(0x42f2, 4), // EBMLMaxIDLength
    uint(0x42f3, 8), // EBMLMaxSizeLength
    str(0x4282, 'webm'), // DocType
    uint(0x4287, 4), // DocTypeVersion
    uint(0x4285, 2), // DocTypeReadVersion
  );
  const info = el(
    0x1549a966,
    uint(0x2ad7b1, 1000000), // TimestampScale: milliseconds
    str(0x4d80, 'GB Tracker'), // MuxingApp
    str(0x5741, 'GB Tracker'), // WritingApp
    float(0x4489, durationMs),
    ...(title ? [str(0x7ba9, title)] : []),
  );
  const entries = tracks.map((t, i) => {
    const video = t.codec.startsWith('V_');
    return el(
      0xae,
      uint(0xd7, i + 1), // TrackNumber
      uint(0x73c5, i + 1), // TrackUID
      uint(0x83, video ? 1 : 2), // TrackType
      str(0x86, t.codec),
      ...(t.codecPrivate ? [el(0x63a2, t.codecPrivate)] : []),
      ...(t.codecDelayNs ? [uint(0x56aa, t.codecDelayNs)] : []),
      ...(t.seekPreRollNs ? [uint(0x56bb, t.seekPreRollNs)] : []),
      video
        ? el(0xe0, uint(0xb0, t.width ?? 0), uint(0xba, t.height ?? 0))
        : el(0xe1, float(0xb5, t.sampleRate ?? 48000), uint(0x9f, t.channels ?? 2)),
    );
  });

  // Clusters start at video key frames (or every few seconds without video).
  const hasVideo = tracks.some((t) => t.codec.startsWith('V_'));
  const sorted = [...frames].sort((a, b) => a.timestampUs - b.timestampUs || a.track - b.track);
  const clusters: Uint8Array[] = [];
  let start = -1;
  let blocks: Uint8Array[] = [];
  const flush = () => {
    if (blocks.length) clusters.push(el(0x1f43b675, uint(0xe7, start), ...blocks));
    blocks = [];
  };
  for (const f of sorted) {
    const ms = Math.round(f.timestampUs / 1000);
    const video = tracks[f.track - 1].codec.startsWith('V_');
    const newCluster =
      start < 0 ||
      ms - start >= MAX_CLUSTER_MS ||
      (hasVideo ? video && f.key && ms > start : ms - start >= AUDIO_CLUSTER_MS);
    if (newCluster) {
      flush();
      start = ms;
    }
    const rel = ms - start;
    blocks.push(el(0xa3, vint(f.track), [(rel >> 8) & 0xff, rel & 0xff, f.key || !video ? 0x80 : 0], f.data));
  }
  flush();

  const segment = el(0x18538067, info, el(0x1654ae6b, ...entries), ...clusters);
  return concat([header, segment]);
}
