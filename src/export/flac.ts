/**
 * FLAC encoder (lossless, 16-bit stereo): fixed predictors of order 0-4 with
 * partitioned Rice coding, and the best of left/right, left/side, side/right
 * and mid/side stereo per frame. No LPC, so files are a little larger than
 * the reference encoder's, but they decode to exactly the WAV's samples.
 */

const BLOCK_SIZE = 4096;
const MAX_PARTITION_ORDER = 8;

/** Float sample to 16-bit, exactly as the WAV export rounds it. */
export function toInt16(v: number): number {
  return Math.round(Math.max(-1, Math.min(1, v)) * 32767);
}

class BitWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private acc = 0;
  private bits = 0;

  get byteLength() {
    return this.len;
  }

  /** Write the low `n` bits of `value` (n <= 32), most significant first. */
  write(value: number, n: number) {
    while (n > 24) {
      n -= 16;
      this.write(Math.floor(value / 2 ** n) & 0xffff, 16);
    }
    if (n === 0) return;
    this.acc = this.acc * 2 ** n + (value & (2 ** n - 1));
    this.bits += n;
    while (this.bits >= 8) {
      this.bits -= 8;
      this.byte(Math.floor(this.acc / 2 ** this.bits) & 0xff);
    }
    this.acc %= 2 ** this.bits;
  }

  writeSigned(value: number, n: number) {
    this.write(value < 0 ? value + 2 ** n : value, n);
  }

  /** `q` zero bits and a one. */
  unary(q: number) {
    while (q >= 24) {
      this.write(0, 24);
      q -= 24;
    }
    this.write(1, q + 1);
  }

  align() {
    if (this.bits) this.write(0, 8 - this.bits);
  }

  private byte(b: number) {
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = b;
  }

  bytes(from = 0, to = this.len) {
    return this.buf.subarray(from, to);
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i << 8;
  for (let b = 0; b < 8; b++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  CRC8[i] = c8;
  CRC16[i] = c16;
}

/** CRC-8 of a frame header (polynomial x^8 + x^2 + x + 1). */
export function crc8(data: Uint8Array): number {
  let c = 0;
  for (const b of data) c = CRC8[c ^ b];
  return c;
}

/** CRC-16 of a frame (polynomial x^16 + x^15 + x^2 + 1). */
export function crc16(data: Uint8Array): number {
  let c = 0;
  for (const b of data) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b];
  return c;
}

/** Residual of the fixed predictor of the given order. */
function fixedResidual(x: Int32Array, order: number): Int32Array {
  const r = new Int32Array(x.length - order);
  for (let i = order; i < x.length; i++) {
    let p = 0;
    if (order === 1) p = x[i - 1];
    else if (order === 2) p = 2 * x[i - 1] - x[i - 2];
    else if (order === 3) p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3];
    else if (order === 4) p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
    r[i - order] = x[i] - p;
  }
  return r;
}

const zigzag = (v: number) => (v >= 0 ? 2 * v : -2 * v - 1);

interface RiceChoice {
  order: number;
  params: number[];
  bits: number;
}

/** Best partition order and Rice parameters for a residual. */
function riceChoice(residual: Int32Array, blockSize: number, predictorOrder: number): RiceChoice {
  let best: RiceChoice | null = null;
  for (let po = 0; po <= MAX_PARTITION_ORDER; po++) {
    const parts = 1 << po;
    if (blockSize % parts || blockSize / parts <= predictorOrder) break;
    const params: number[] = [];
    let bits = 6; // coding method + partition order
    let pos = 0;
    for (let p = 0; p < parts; p++) {
      const n = blockSize / parts - (p === 0 ? predictorOrder : 0);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += zigzag(residual[pos + i]);
      let bestK = 0;
      let bestBits = Infinity;
      for (let k = 0; k <= 14; k++) {
        const b = n * (k + 1) + Math.floor(sum / 2 ** k);
        if (b < bestBits) [bestK, bestBits] = [k, b];
      }
      params.push(bestK);
      bits += 4 + bestBits;
      pos += n;
    }
    if (!best || bits < best.bits) best = { order: po, params, bits };
  }
  return best!;
}

interface Subframe {
  bits: number;
  write: (w: BitWriter) => void;
}

/** The smallest of CONSTANT, VERBATIM and FIXED (order 0-4) for one channel. */
function subframe(x: Int32Array, bps: number): Subframe {
  if (x.every((v) => v === x[0]))
    return {
      bits: 8 + bps,
      write: (w) => {
        w.write(0, 8);
        w.writeSigned(x[0], bps);
      },
    };
  let best: Subframe = {
    bits: 8 + bps * x.length,
    write: (w) => {
      w.write(0b00000010, 8);
      for (const v of x) w.writeSigned(v, bps);
    },
  };
  for (let order = 0; order <= 4 && order < x.length; order++) {
    const residual = fixedResidual(x, order);
    const rice = riceChoice(residual, x.length, order);
    const bits = 8 + order * bps + rice.bits;
    if (bits >= best.bits) continue;
    best = {
      bits,
      write: (w) => {
        w.write(0b00010000 | (order << 1), 8);
        for (let i = 0; i < order; i++) w.writeSigned(x[i], bps);
        w.write(0, 2); // Rice coding, 4-bit parameters
        w.write(rice.order, 4);
        let pos = 0;
        rice.params.forEach((k, p) => {
          w.write(k, 4);
          const n = x.length / (1 << rice.order) - (p === 0 ? order : 0);
          for (let i = 0; i < n; i++) {
            const u = zigzag(residual[pos + i]);
            w.unary(Math.floor(u / 2 ** k));
            w.write(u % 2 ** k, k);
          }
          pos += n;
        });
      },
    };
  }
  return best;
}

/** UTF-8 style coding of the frame number. */
export function utf8Number(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  let len = 2;
  while (n >= 2 ** (5 * len + 1)) len++;
  for (let i = len - 1; i > 0; i--) {
    out.unshift(0x80 | (n & 0x3f));
    n = Math.floor(n / 64);
  }
  out.unshift(((0xff00 >> len) & 0xff) | n);
  return out;
}

/** Encode stereo float samples as a 16-bit FLAC file. */
export function encodeFlac(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
  const total = left.length;
  const w = new BitWriter();
  w.write(0x664c6143, 32); // "fLaC"
  w.write(0x80, 8); // last metadata block: STREAMINFO
  w.write(34, 24);
  w.write(BLOCK_SIZE, 16);
  w.write(BLOCK_SIZE, 16);
  w.write(0, 24); // frame sizes unknown
  w.write(0, 24);
  w.write(sampleRate, 20);
  w.write(1, 3); // 2 channels
  w.write(15, 5); // 16 bits
  w.write(Math.floor(total / 2 ** 32), 4);
  w.write(total % 2 ** 32, 32);
  for (let i = 0; i < 4; i++) w.write(0, 32); // no MD5

  for (let frame = 0, start = 0; start < total; frame++, start += BLOCK_SIZE) {
    const n = Math.min(BLOCK_SIZE, total - start);
    const l = new Int32Array(n);
    const r = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = toInt16(left[start + i]);
      r[i] = toInt16(right[start + i]);
    }
    const side = l.map((v, i) => v - r[i]);
    const mid = l.map((v, i) => (v + r[i]) >> 1);
    const L = subframe(l, 16);
    const R = subframe(r, 16);
    const S = subframe(side, 17);
    const M = subframe(mid, 16);
    // Channel assignment: independent, left/side, side/right, mid/side.
    const options: [number, Subframe, Subframe][] = [
      [1, L, R],
      [8, L, S],
      [9, S, R],
      [10, M, S],
    ];
    const [assignment, a, b] = options.reduce((x, y) => (y[1].bits + y[2].bits < x[1].bits + x[2].bits ? y : x));

    const frameStart = w.byteLength;
    w.write(0xfff8, 16); // sync code, fixed block size
    w.write(n === BLOCK_SIZE ? 12 : 7, 4); // 4096, or a 16-bit size after the frame number
    w.write(0, 4); // sample rate from STREAMINFO
    w.write(assignment, 4);
    w.write(4, 3); // 16 bits
    w.write(0, 1);
    for (const byte of utf8Number(frame)) w.write(byte, 8);
    if (n !== BLOCK_SIZE) w.write(n - 1, 16);
    w.write(crc8(w.bytes(frameStart)), 8);
    a.write(w);
    b.write(w);
    w.align();
    w.write(crc16(w.bytes(frameStart)), 16);
  }
  return w.bytes().slice();
}
