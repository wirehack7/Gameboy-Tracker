/**
 * Register streams: the song rendered to the exact APU register writes the
 * player makes, frame by frame. This is the common base of the GBDK/C,
 * VGM and (later) ROM exports, and can be replayed on real hardware by a
 * tiny driver.
 */
import type { Model } from '../apu/apu';
import { Player, RegisterWriter } from '../tracker/player';
import { Song } from '../tracker/song';

export type Write = [addr: number, value: number];

export interface RegisterStream {
  model: Model;
  /** Writes per frame (register addresses as the low byte of 0xFFxx). */
  frames: Write[][];
  /** Frame the song loops back to after the last frame. */
  loopFrame: number;
}

/** Hard limit: 30 minutes of frames. */
const MAX_FRAMES = 60 * 60 * 30;

export function captureStream(song: Song, maxFrames = MAX_FRAMES): RegisterStream {
  const frames: Write[][] = [];
  let current: Write[] = [];
  const out: RegisterWriter = { write: (addr, value) => current.push([addr & 0xff, value & 0xff]) };
  const player = new Player(song);
  player.cacheWave = false;
  const firstFrame = new Map<number, number>();
  let rowKey = 0;
  player.onRow = (order, row) => {
    rowKey = (order << 8) | row;
    if (!firstFrame.has(rowKey)) firstFrame.set(rowKey, frames.length);
  };
  player.start(out);
  let loopFrame = 0;
  while (frames.length < maxFrames) {
    const loops = player.loops;
    player.tick(out);
    if (player.loops > loops) {
      // This frame starts the second pass: loop back to where the row first played.
      loopFrame = firstFrame.get(rowKey) ?? 0;
      break;
    }
    frames.push(current);
    current = [];
  }
  return { model: song.model, frames, loopFrame };
}

/**
 * Registers whose writes have no side effect besides storing the value, so a
 * write of the value already there can be dropped. NRx1, NRx2 and NRx4 are
 * never dropped (length reload, DAC/zombie effects, triggers).
 */
const LATCH_REGISTERS = new Set([0x13, 0x18, 0x1c, 0x1d, 0x22, 0x24, 0x25]);

/** Drop redundant writes. The loop frame starts with no assumptions. */
export function optimizeStream(stream: RegisterStream): RegisterStream {
  const last = new Map<number, number>();
  const frames = stream.frames.map((writes, f) => {
    if (f === stream.loopFrame) last.clear();
    return writes.filter(([a, v]) => {
      if (!LATCH_REGISTERS.has(a)) return true;
      if (last.get(a) === v) return false;
      last.set(a, v);
      return true;
    });
  });
  return { ...stream, frames };
}

/** Stream byte codes, shared with the C driver. */
export const CMD_WAIT = 0x80; // 0x81..0xFF minus END: wait n frames
export const CMD_END = 0xff; // jump to the loop point
export const MAX_WAIT = 0x7e;

/**
 * Encode a stream into the compact driver format:
 *   0x00-0x2F vv  write vv to register 0xFF10 + cmd
 *   0x81-0xFE     wait (cmd & 0x7F) frames
 *   0xFF          continue at the loop offset
 */
export function encodeStream(stream: RegisterStream): { data: Uint8Array; loopOffset: number } {
  const bytes: number[] = [];
  let wait = 0;
  let loopOffset = 0;
  const flush = () => {
    while (wait > 0) {
      const n = Math.min(wait, MAX_WAIT);
      bytes.push(CMD_WAIT | n);
      wait -= n;
    }
  };
  stream.frames.forEach((writes, f) => {
    if (f === stream.loopFrame) {
      flush();
      loopOffset = bytes.length;
    }
    if (writes.length) flush();
    for (const [a, v] of writes) bytes.push(a - 0x10, v);
    wait++;
  });
  flush();
  bytes.push(CMD_END);
  return { data: Uint8Array.from(bytes), loopOffset };
}

/**
 * Reference implementation of the C driver (`gbtr_update`), used to verify
 * the encoding. Call `update` once per frame.
 */
export class StreamPlayer {
  private pos = 0;
  private wait = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly loopOffset: number,
  ) {}

  update(out: RegisterWriter) {
    if (this.wait) {
      this.wait--;
      return;
    }
    for (;;) {
      const cmd = this.data[this.pos++];
      if (cmd < 0x30) {
        out.write(0x10 + cmd, this.data[this.pos++]);
      } else if (cmd === CMD_END) {
        this.pos = this.loopOffset;
      } else {
        this.wait = (cmd & 0x7f) - 1;
        return;
      }
    }
  }
}
