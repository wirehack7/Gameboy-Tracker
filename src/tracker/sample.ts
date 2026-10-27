/**
 * Sample playback on the wave channel, the way LSDJ kits do it: a timer
 * interrupt reloads wave RAM with the next 32 nibbles of the sample and
 * restarts the channel, 256 times per second.
 *
 * Timing (all exact on the hardware):
 * - The channel runs at period 1792: one nibble every (2048 - 1792) * 2 = 512
 *   clocks, i.e. 8192 Hz, so 32 positions take 16384 clocks.
 * - The timer runs from the 16384 Hz clock with TMA = 0xC0 and overflows
 *   every 64 counts = 16384 clocks (256 Hz).
 * - After a trigger the channel waits 6 clocks plus one period before it
 *   fetches position 1; the sample buffer is not refilled, so until then it
 *   plays the high nibble of the last fetched byte (position 30 of the
 *   previous chunk). Positions 1..31 follow, and the reload 16384 clocks
 *   later comes before position 0 would be fetched. So each reload plays 31
 *   new nibbles (wave RAM positions 1..31) after a short hold of an old one.
 *   Position 0 is never heard; it gets a copy of position 1.
 *
 * The effective sample rate is therefore 31 × 256 = 7936 Hz.
 */
import { NR30, NR33, NR34, WAVE_RAM } from '../apu/apu';
import type { RegisterWriter } from './player';

export const SAMPLE_PERIOD = 1792;
export const SAMPLE_RELOAD_CYCLES = 16384;
export const SAMPLE_CHUNK = 31;
export const SAMPLE_RATE = SAMPLE_CHUNK * 256;
/** Timer settings for the drivers: 16384 Hz clock, overflow every 64 counts. */
export const SAMPLE_TMA = 0xc0;
export const SAMPLE_TAC = 0x07;
/** Longest sample in seconds. */
export const SAMPLE_MAX_SECONDS = 4;
export const SAMPLE_MAX_LENGTH = SAMPLE_MAX_SECONDS * SAMPLE_RATE;
/** Samples per song. */
export const SAMPLE_COUNT = 16;

/**
 * Pseudo registers in the player's write stream (outside the APU's address
 * range). The drivers turn them into "start sample n" / "stop sample".
 */
export const SAMPLE_START = 0x40;
export const SAMPLE_STOP = 0x41;

/** Decode a sample's hex string (one digit per 4-bit level). */
export function sampleLevels(hex: string): number[] {
  return Array.from(hex, (c) => parseInt(c, 16) & 15);
}

/** Wave RAM images for a sample: 16 bytes per reload. */
export function sampleChunks(hex: string): Uint8Array {
  const levels = sampleLevels(hex);
  const count = Math.ceil(levels.length / SAMPLE_CHUNK);
  const out = new Uint8Array(count * 16);
  for (let k = 0; k < count; k++) {
    const nibbles = new Array<number>(32);
    for (let p = 1; p < 32; p++) {
      const i = k * SAMPLE_CHUNK + p - 1;
      nibbles[p] = levels[Math.min(i, levels.length - 1)];
    }
    nibbles[0] = nibbles[1];
    for (let b = 0; b < 16; b++) out[k * 16 + b] = (nibbles[b * 2] << 4) | nibbles[b * 2 + 1];
  }
  return out;
}

/**
 * The timer interrupt part of a sample-playing driver. `reload` is what the
 * interrupt handler does; `untilReload` counts the clocks to the next one.
 */
export class SampleVoice {
  private chunks: Uint8Array | null = null;
  private next = 0;
  untilReload = Infinity;

  get active() {
    return this.chunks !== null;
  }

  /** Start a sample: the first chunk is loaded at once, the timer restarted. */
  start(chunks: Uint8Array, out: RegisterWriter) {
    this.chunks = chunks;
    this.next = 0;
    this.untilReload = SAMPLE_RELOAD_CYCLES;
    this.reload(out);
  }

  stop() {
    this.chunks = null;
    this.untilReload = Infinity;
  }

  reload(out: RegisterWriter) {
    const chunks = this.chunks;
    if (!chunks) return;
    if (this.next * 16 >= chunks.length) {
      // End of the sample: DAC off.
      out.write(NR30, 0);
      this.stop();
      return;
    }
    // The DAC off disables the channel, so wave RAM is freely writable and
    // the restart cannot hit the DMG wave RAM corruption.
    out.write(NR30, 0);
    for (let i = 0; i < 16; i++) out.write(WAVE_RAM + i, chunks[this.next * 16 + i]);
    out.write(NR30, 0x80);
    out.write(NR33, SAMPLE_PERIOD & 0xff);
    out.write(NR34, 0x80 | (SAMPLE_PERIOD >> 8));
    this.next++;
  }

  /** Advance by `cycles` clocks, reloading when the timer fires. */
  advance(cycles: number, out: RegisterWriter) {
    this.untilReload -= cycles;
    while (this.active && this.untilReload <= 0) {
      this.untilReload += SAMPLE_RELOAD_CYCLES;
      this.reload(out);
    }
  }
}

/**
 * A register writer that acts like a sample-playing driver: APU writes go
 * through, SAMPLE_START / SAMPLE_STOP drive a SampleVoice.
 */
export class SampleBus implements RegisterWriter {
  readonly voice = new SampleVoice();

  constructor(
    private readonly target: RegisterWriter,
    public samples: readonly Uint8Array[],
  ) {}

  write(addr: number, value: number) {
    if (addr === SAMPLE_START) this.voice.start(this.samples[value] ?? new Uint8Array(0), this.target);
    else if (addr === SAMPLE_STOP) this.voice.stop();
    else {
      // The player only touches NR30 to use CH3 itself, which ends a sample
      // (a previewed one; during playback it sends SAMPLE_STOP first).
      if (addr === NR30) this.voice.stop();
      this.target.write(addr, value);
    }
  }
}
