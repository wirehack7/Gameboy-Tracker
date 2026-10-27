/**
 * Ogg Opus muxer (RFC 7845) for the compressed audio export: OpusHead and
 * OpusTags pages, then the encoder's packets with granule positions in
 * 48 kHz samples. The last page's granule trims the encoder's padding.
 */

export interface OggOpusOptions {
  /** Opus packets in order, each with its duration in 48 kHz samples. */
  packets: { data: Uint8Array; samples: number }[];
  channels: number;
  /** Samples the decoder drops at the start (encoder delay). */
  preSkip: number;
  /** Original sample rate (informational). */
  inputSampleRate: number;
  /** Length of the audio in 48 kHz samples. */
  totalSamples: number;
  tags?: Record<string, string>;
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 24;
  for (let b = 0; b < 8; b++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  CRC_TABLE[i] = c >>> 0;
}

/** Ogg page checksum (CRC-32, polynomial 0x04c11db7, not reflected). */
export function oggCrc(data: Uint8Array): number {
  let c = 0;
  for (const b of data) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b) & 0xff]) >>> 0;
  return c;
}

/** OpusHead identification header. */
export function opusHead(channels: number, preSkip: number, inputSampleRate: number): Uint8Array {
  const b = new Uint8Array(19);
  const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('OpusHead'));
  b[8] = 1; // version
  b[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputSampleRate, true);
  v.setInt16(16, 0, true); // output gain
  b[18] = 0; // mapping family: mono/stereo
  return b;
}

function opusTags(tags: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const vendor = enc.encode('GB Tracker');
  const comments = Object.entries(tags).map(([k, val]) => enc.encode(`${k}=${val}`));
  const b = new Uint8Array(8 + 4 + vendor.length + 4 + comments.reduce((n, c) => n + 4 + c.length, 0));
  const v = new DataView(b.buffer);
  b.set(enc.encode('OpusTags'));
  v.setUint32(8, vendor.length, true);
  b.set(vendor, 12);
  let o = 12 + vendor.length;
  v.setUint32(o, comments.length, true);
  o += 4;
  for (const c of comments) {
    v.setUint32(o, c.length, true);
    b.set(c, o + 4);
    o += 4 + c.length;
  }
  return b;
}

const SERIAL = 0x47425452; // "GBTR"

function page(packets: Uint8Array[], flags: number, granule: number, seq: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    for (let n = p.length; ; n -= 255) {
      lacing.push(Math.min(255, n));
      if (n < 255) break;
    }
  }
  const size = packets.reduce((n, p) => n + p.length, 0);
  const b = new Uint8Array(27 + lacing.length + size);
  const v = new DataView(b.buffer);
  b.set([0x4f, 0x67, 0x67, 0x53]); // OggS
  b[5] = flags;
  v.setUint32(6, granule % 2 ** 32, true);
  v.setUint32(10, Math.floor(granule / 2 ** 32), true);
  v.setUint32(14, SERIAL, true);
  v.setUint32(18, seq, true);
  b[26] = lacing.length;
  b.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) {
    b.set(p, o);
    o += p.length;
  }
  v.setUint32(22, oggCrc(b), true);
  return b;
}

export function muxOggOpus(opts: OggOpusOptions): Uint8Array {
  const pages = [
    page([opusHead(opts.channels, opts.preSkip, opts.inputSampleRate)], 0x02, 0, 0),
    page([opusTags(opts.tags ?? {})], 0, 0, 1),
  ];
  const end = opts.preSkip + opts.totalSamples;
  // Granule positions count every decoded sample, the pre-skip included.
  let granule = 0;
  let batch: Uint8Array[] = [];
  let segments = 0;
  opts.packets.forEach((p, i) => {
    const last = i === opts.packets.length - 1;
    batch.push(p.data);
    segments += Math.floor(p.data.length / 255) + 1;
    granule += p.samples;
    // About one second per page, and never more than 255 lacing values.
    const nextSegments = last ? 0 : Math.floor(opts.packets[i + 1].data.length / 255) + 1;
    if (last || batch.length >= 50 || segments + nextSegments > 255) {
      pages.push(page(batch, last ? 0x04 : 0, last ? end : Math.min(granule, end), pages.length));
      batch = [];
      segments = 0;
    }
  });
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pages) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
