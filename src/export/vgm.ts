/**
 * VGM 1.71 export for the Game Boy DMG chip (command 0xB3).
 * https://vgmrips.net/wiki/VGM_Specification
 */
import { CPU_HZ } from '../apu/apu';
import { CYCLES_PER_TICK } from '../tracker/song';
import { RegisterStream } from './stream';

const VGM_RATE = 44100;
const HEADER_SIZE = 0x100;

export interface VgmTags {
  title?: string;
  author?: string;
  game?: string;
  date?: string;
  notes?: string;
}

/** Sample position (44.1 kHz) of the start of a frame. */
export function frameToSample(frame: number): number {
  return Math.round((frame * CYCLES_PER_TICK * VGM_RATE) / CPU_HZ);
}

function gd3(tags: VgmTags): Uint8Array {
  const strings = [
    tags.title ?? '',
    '',
    tags.game ?? '',
    '',
    'Nintendo Game Boy',
    '',
    tags.author ?? '',
    '',
    tags.date ?? '',
    'GB Tracker',
    tags.notes ?? '',
  ];
  const chars: number[] = [];
  for (const s of strings) {
    for (const c of s) chars.push(c.charCodeAt(0) & 0xffff);
    chars.push(0);
  }
  const body = new Uint8Array(chars.length * 2);
  const bv = new DataView(body.buffer);
  chars.forEach((c, i) => bv.setUint16(i * 2, c, true));
  const out = new Uint8Array(12 + body.length);
  const v = new DataView(out.buffer);
  out.set([0x47, 0x64, 0x33, 0x20]); // "Gd3 "
  v.setUint32(4, 0x100, true);
  v.setUint32(8, body.length, true);
  out.set(body, 12);
  return out;
}

export function encodeVgm(stream: RegisterStream, tags: VgmTags = {}): Uint8Array {
  const data: number[] = [];
  let pos = 0; // samples written so far
  let loopDataOffset = 0;
  let loopSample = 0;

  const waitUntil = (target: number) => {
    let n = target - pos;
    while (n > 0) {
      if (n === 735) {
        data.push(0x62);
        n = 0;
      } else if (n === 882) {
        data.push(0x63);
        n = 0;
      } else if (n <= 16) {
        data.push(0x70 + n - 1);
        n = 0;
      } else {
        const k = Math.min(n, 0xffff);
        data.push(0x61, k & 0xff, k >> 8);
        n -= k;
      }
    }
    pos = target;
  };

  stream.frames.forEach((writes, f) => {
    waitUntil(frameToSample(f));
    if (f === stream.loopFrame) {
      loopDataOffset = data.length;
      loopSample = pos;
    }
    for (const [a, v] of writes) data.push(0xb3, a - 0x10, v);
  });
  waitUntil(frameToSample(stream.frames.length));
  data.push(0x66);

  const tag = gd3(tags);
  const total = HEADER_SIZE + data.length + tag.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out.set([0x56, 0x67, 0x6d, 0x20]); // "Vgm "
  v.setUint32(0x04, total - 0x04, true);
  v.setUint32(0x08, 0x171, true);
  v.setUint32(0x14, HEADER_SIZE + data.length - 0x14, true);
  v.setUint32(0x18, pos, true);
  v.setUint32(0x1c, HEADER_SIZE + loopDataOffset - 0x1c, true);
  v.setUint32(0x20, pos - loopSample, true);
  v.setUint32(0x24, 60, true);
  v.setUint32(0x34, HEADER_SIZE - 0x34, true);
  v.setUint32(0x80, CPU_HZ, true);
  out.set(data, HEADER_SIZE);
  out.set(tag, HEADER_SIZE + data.length);
  return out;
}
