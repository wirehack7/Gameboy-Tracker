/**
 * Shared conversion for the XM and MOD exports: Game Boy instruments become
 * samples (one waveform period, or a run of LFSR noise), and the pattern
 * cells are translated into the classic tracker effect set.
 *
 * Pitch is exact: a pulse or wave sample holds one period of N samples, so a
 * note of frequency f plays at f * N Hz; noise is sampled one LFSR step per
 * sample and plays at the LFSR clock the player uses for that note (~64 * f).
 */
import { DUTY_TABLE } from '../apu/apu';
import { FX, waveVolumeCode } from '../tracker/player';
import { NOTE_COUNT, PULSE_PERIODS, WAVE_PERIODS } from '../tracker/notes';
import { CHANNEL_COUNT, CHANNEL_KINDS, Cell, ChannelKind, EMPTY, NOTE_OFF, Pattern, Song } from '../tracker/song';

/** Frames (player ticks) per second. */
export const TICK_HZ = 4194304 / 70224;
/** XM/MOD tempo closest to one tick per frame: BPM * 2 / 5 Hz = 59.6 Hz. */
export const MODULE_BPM = 149;

export type InstrumentRef = { kind: ChannelKind; index: number };

export interface ModuleCell {
  /** Tracker note 0..83, 'off', or null. */
  note: number | 'off' | null;
  /** Output instrument number (1-based), or null. */
  instrument: number | null;
  /** 0..64, or null. */
  volume: number | null;
  /** Classic effect number (0x0-0xF, 0xE sub-commands in param), or null. */
  effect: number | null;
  param: number;
  /** Panning 0..255 that could not go into the effect column. */
  pan: number | null;
}

/** Things the format cannot represent, counted for the export report. */
export class Warnings {
  readonly counts = new Map<string, number>();
  add(what: string, n = 1) {
    this.counts.set(what, (this.counts.get(what) ?? 0) + n);
  }
  list(): string[] {
    return [...this.counts].map(([w, n]) => `${w} (${n}×)`);
  }
}

// ------------------------------------------------------------------ samples

/** One period of a pulse wave, DC removed (as after the Game Boy's high-pass filter). */
export function pulseCycle(duty: number, length: number): Int8Array {
  const bits = DUTY_TABLE[duty & 3];
  const high = bits.reduce((a, b) => a + b, 0) / 8;
  const out = new Int8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.round((bits[Math.floor((i * 8) / length)] - high) * 120);
  return out;
}

/** One period of a wave pattern (32 4-bit samples), resampled to `length`. */
export function waveCycle(wave: readonly number[], length: number): Int8Array {
  const mean = wave.reduce((a, b) => a + b, 0) / wave.length;
  const out = new Int8Array(length);
  for (let i = 0; i < length; i++) {
    // Average when shrinking, repeat when growing.
    const from = Math.floor((i * 32) / length);
    const to = Math.max(from + 1, Math.floor(((i + 1) * 32) / length));
    let sum = 0;
    for (let j = from; j < to; j++) sum += wave[j];
    out[i] = Math.round((sum / (to - from) - mean) * 8);
  }
  return out;
}

/** The noise channel's LFSR output, one value per clock, for one full period. */
export function lfsrSequence(narrow: boolean): Int8Array {
  const length = narrow ? 127 : 32767;
  const out = new Int8Array(length);
  let lfsr = 0x7fff;
  for (let i = 0; i < length; i++) {
    out[i] = lfsr & 1 ? -60 : 60; // output is the inverted bit 0
    const x = (lfsr ^ (lfsr >> 1)) & 1;
    lfsr = (lfsr >> 1) | (x << 14);
    if (narrow) lfsr = (lfsr & ~0x40) | (x << 6);
  }
  return out;
}

/**
 * Samples per pitch period at the reference rate: a note of frequency f plays
 * the sample at f * periodLength Hz.
 */
export function basePeriodLength(kind: ChannelKind): number {
  return kind === 'noise' ? 64 : 32;
}

/** Waveform of an instrument with `scale` = 2^k times the base period length. */
export function instrumentWaveform(song: Song, ref: InstrumentRef, scale: number): Int8Array {
  if (ref.kind === 'pulse') return pulseCycle(song.pulseInstruments[ref.index].duty, 32 * scale);
  if (ref.kind === 'wave') return waveCycle(song.waves[song.waveInstruments[ref.index].wave], 32 * scale);
  const seq = lfsrSequence(song.noiseInstruments[ref.index].narrow);
  if (scale === 1) return seq;
  if (scale > 1) {
    const out = new Int8Array(seq.length * scale);
    for (let i = 0; i < out.length; i++) out[i] = seq[Math.floor(i / scale)];
    return out;
  }
  const step = Math.round(1 / scale);
  const out = new Int8Array(seq.length);
  for (let i = 0; i < out.length; i++) out[i] = seq[(i * step) % seq.length];
  return out;
}

/** Default volume 0..64 of an instrument, as the player loads it. */
export function instrumentVolume(song: Song, ref: InstrumentRef): number {
  if (ref.kind === 'wave') return waveVolume64(song.waveInstruments[ref.index].volume);
  const ins = ref.kind === 'pulse' ? song.pulseInstruments[ref.index] : song.noiseInstruments[ref.index];
  return ins.envUp && ins.envPeriod ? 64 : Math.round((ins.volume * 64) / 15);
}

const WAVE_CODE_FRACTION = [0, 1, 0.5, 0.25];

function waveVolume64(code: number): number {
  return Math.round(64 * WAVE_CODE_FRACTION[code & 3]);
}

/** Volume column value 0..15 on a channel, as 0..64. */
export function cellVolume64(kind: ChannelKind, volume: number): number {
  return kind === 'wave' ? waveVolume64(waveVolumeCode(volume)) : Math.round((volume * 64) / 15);
}

export interface EnvelopePoint {
  tick: number;
  value: number;
}

/**
 * Volume envelope (0..64, relative to the instrument volume) of the hardware
 * envelope and length counter, in ticks. Empty when the volume is constant.
 */
export function volumeEnvelope(song: Song, ref: InstrumentRef): EnvelopePoint[] {
  if (ref.kind === 'wave') {
    const len = song.waveInstruments[ref.index].length;
    return len ? cutAt([{ tick: 0, value: 64 }], (len / 256) * TICK_HZ) : [];
  }
  const ins = ref.kind === 'pulse' ? song.pulseInstruments[ref.index] : song.noiseInstruments[ref.index];
  const points: EnvelopePoint[] = [];
  const step = (ins.envPeriod / 64) * TICK_HZ;
  if (ins.envPeriod && !ins.envUp && ins.volume > 0) {
    // Volume drops by one every `step` ticks; linear between the steps.
    const stride = Math.ceil((ins.volume + 1) / 11);
    for (let i = 0; i <= ins.volume; i += stride) points.push({ tick: i * step, value: (64 * (ins.volume - i)) / ins.volume });
    if (points.at(-1)!.value !== 0) points.push({ tick: ins.volume * step, value: 0 });
  } else if (ins.envPeriod && ins.envUp && ins.volume < 15) {
    points.push({ tick: 0, value: (64 * ins.volume) / 15 }, { tick: (15 - ins.volume) * step, value: 64 });
  } else if (ins.length) {
    points.push({ tick: 0, value: 64 });
  }
  const length = ins.length ? (ins.length / 256) * TICK_HZ : Infinity;
  return cutAt(points, length).map((p) => ({ tick: Math.round(p.tick), value: Math.round(p.value) }));
}

function valueAt(points: EnvelopePoint[], tick: number): number {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (tick <= b.tick) return a.value + ((b.value - a.value) * (tick - a.tick)) / Math.max(1e-9, b.tick - a.tick);
  }
  return points.at(-1)!.value;
}

/** Silence the envelope at `tick` (length counter expiry). */
function cutAt(points: EnvelopePoint[], tick: number): EnvelopePoint[] {
  if (!Number.isFinite(tick) || !points.length) return points;
  const kept = points.filter((p) => p.tick < tick);
  const v = valueAt(points, tick);
  if (v > 0) kept.push({ tick, value: v }, { tick: tick + 1, value: 0 });
  else kept.push({ tick, value: 0 });
  return kept.slice(0, 12);
}

// ----------------------------------------------------------------- patterns

/** Instruments used per channel kind, in output order (pulse, wave, noise). */
export function usedInstruments(song: Song): InstrumentRef[] {
  const used = new Set<string>();
  for (const pat of song.patterns)
    for (const row of pat.rows)
      row.forEach((cell, ch) => {
        if (cell.note >= 0 || cell.instrument !== EMPTY) {
          const index = cell.instrument !== EMPTY ? cell.instrument : 0;
          used.add(`${CHANNEL_KINDS[ch]}:${index}`);
        }
      });
  const order: ChannelKind[] = ['pulse', 'wave', 'noise'];
  return [...used]
    .map((k) => {
      const [kind, index] = k.split(':');
      return { kind: kind as ChannelKind, index: Number(index) };
    })
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.index - b.index);
}

/** Notes each instrument plays (for choosing a MOD octave and baking envelopes). */
export function notesByInstrument(song: Song): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const pat of song.patterns)
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      let ins = 0;
      for (const row of pat.rows) {
        const c = row[ch];
        if (c.instrument !== EMPTY) ins = c.instrument;
        if (c.note >= 0) {
          const key = `${CHANNEL_KINDS[ch]}:${ins}`;
          if (!out.has(key)) out.set(key, []);
          out.get(key)!.push(c.note);
        }
      }
    }
  return out;
}

export const refKey = (r: InstrumentRef) => `${r.kind}:${r.index}`;

/** Semitones per tick that a Game Boy period slide of `amount` makes at `note`. */
export function slideSemitones(kind: ChannelKind, note: number, amount: number, up: boolean): number {
  const x = (kind === 'wave' ? WAVE_PERIODS : PULSE_PERIODS)[Math.max(0, Math.min(NOTE_COUNT - 1, note))];
  const from = 2048 - x;
  const to = up ? Math.max(1, from - amount) : Math.min(2048, from + amount);
  return Math.abs(12 * Math.log2(from / to));
}

export interface PitchUnits {
  /** Slide parameter for a pitch change of `semitones` per tick at `note` with instrument `ref`. */
  slide(note: number, semitones: number, ref: InstrumentRef): number;
  /** Vibrato depth for an amplitude of `semitones` at `note`. */
  vibrato(note: number, semitones: number, ref: InstrumentRef): number;
}

/** XM with linear frequencies: 1xx = xx/16 semitone per tick, vibrato depth ≈ 1/8 semitone. */
export const XM_UNITS: PitchUnits = {
  slide: (_n, s) => Math.max(1, Math.min(255, Math.round(s * 16))),
  vibrato: (_n, s) => Math.max(1, Math.min(15, Math.round(s * 8))),
};

const D = (semitones: number) => 1 - 2 ** (-semitones / 12);
/** ProTracker: slides in Amiga period units, vibrato depth ≈ 2 period units per step. */
export function amigaUnits(periodOf: (note: number, ref: InstrumentRef) => number): PitchUnits {
  return {
    slide: (n, s, r) => Math.max(1, Math.min(255, Math.round(periodOf(n, r) * D(s)))),
    vibrato: (n, s, r) => Math.max(1, Math.min(15, Math.round((periodOf(n, r) * D(s)) / 2))),
  };
}

/** Panning 0..255 of a channel for an NR51 value (bits 4-7 left, 0-3 right). */
export function nr51Pan(nr51: number, ch: number): number {
  const left = (nr51 >> (4 + ch)) & 1;
  const right = (nr51 >> ch) & 1;
  return left && !right ? 0 : right && !left ? 255 : 128;
}

export interface ConvertOptions {
  units: PitchUnits;
  instrumentNumber: (ref: InstrumentRef) => number;
  /** Format has a global volume command (XM Gxx). */
  globalVolume: boolean;
  /** Map a Bxx order position (MOD may split patterns). */
  orderPosition?: (pos: number) => number;
}

/** Translate one pattern. `defaultNote` gives a pitch for slides before any note. */
export function convertPattern(
  pat: Pattern,
  opts: ConvertOptions,
  warn: Warnings,
  defaultNote: (ch: number) => number,
): ModuleCell[][] {
  const rows: ModuleCell[][] = pat.rows.map((row) =>
    row.map(() => ({ note: null, instrument: null, volume: null, effect: null, param: 0, pan: null })),
  );
  const instrument = [0, 0, 0, 0];
  const lastNote = [0, 1, 2, 3].map(defaultNote);
  const pan = [128, 128, 128, 128];

  pat.rows.forEach((row, r) => {
    const panWrites: number[] = [];
    row.forEach((cell: Cell, ch) => {
      const out = rows[r][ch];
      const kind = CHANNEL_KINDS[ch];
      if (cell.instrument !== EMPTY) instrument[ch] = cell.instrument;
      const porta = cell.effect === FX.PORTAMENTO && cell.note >= 0;
      if (cell.note === NOTE_OFF) {
        out.note = 'off';
        out.volume = 0;
      } else if (cell.note >= 0) {
        out.note = cell.note;
        lastNote[ch] = cell.note;
        // The player reloads the instrument on every note, which resets the volume.
        if (!porta) out.instrument = opts.instrumentNumber({ kind, index: instrument[ch] });
      }
      if (cell.volume !== EMPTY) out.volume = cellVolume64(kind, cell.volume);
      if (cell.effect === EMPTY) return;
      const p = cell.param;
      const n = lastNote[ch];
      const ref = { kind, index: instrument[ch] };
      const set = (effect: number, param: number) => {
        out.effect = effect;
        out.param = param & 0xff;
      };
      switch (cell.effect) {
        case FX.ARPEGGIO:
          if (p) set(0x0, p);
          break;
        case FX.SLIDE_UP:
        case FX.SLIDE_DOWN:
          if (kind === 'noise') warn.add('pitch slides on the noise channel');
          else if (p) {
            const up = cell.effect === FX.SLIDE_UP;
            set(up ? 0x1 : 0x2, opts.units.slide(n, slideSemitones(kind, n, p, up), ref));
          }
          break;
        case FX.PORTAMENTO:
          if (kind === 'noise') warn.add('pitch slides on the noise channel');
          else set(0x3, p ? opts.units.slide(n, slideSemitones(kind, n, p, true), ref) : 0);
          break;
        case FX.VIBRATO:
          if (kind === 'noise') warn.add('vibrato on the noise channel');
          else {
            const depth = p & 15 ? opts.units.vibrato(n, slideSemitones(kind, n, p & 15, true), ref) : 0;
            set(0x4, (p & 0xf0) | depth);
          }
          break;
        case FX.MASTER_VOLUME:
          if (opts.globalVolume) set(0x10, Math.round((64 * (Math.max((p >> 4) & 7, p & 7) + 1)) / 8));
          else warn.add('master volume (5xx)');
          break;
        case FX.NOTE_DELAY:
          set(0xe, 0xd0 | Math.min(15, p));
          if (p > 15) warn.add('note delays longer than 15 ticks');
          break;
        case FX.PANNING:
          panWrites.push(p);
          break;
        case FX.DUTY_WAVE:
          warn.add('duty/waveform changes (9xx)');
          break;
        case FX.VOLUME_SLIDE: {
          const net = Math.round((((p >> 4) - (p & 15)) * 64) / 15);
          if (net > 0) set(0xa, Math.min(15, net) << 4);
          else if (net < 0) set(0xa, Math.min(15, -net));
          break;
        }
        case FX.POSITION_JUMP:
          set(0xb, opts.orderPosition ? opts.orderPosition(p) : p);
          break;
        case FX.SET_VOLUME:
          if (out.volume === null) out.volume = cellVolume64(kind, p >> 4);
          else set(0xc, cellVolume64(kind, p >> 4));
          if (p & 7) warn.add('envelope changes (Cxy with y > 0)');
          break;
        case FX.PATTERN_BREAK:
          set(0xd, (Math.floor(p / 10) << 4) | p % 10);
          break;
        case FX.NOTE_CUT:
          if (p === 0) out.volume = 0;
          else if (p <= 15) set(0xe, 0xc0 | p);
          else warn.add('note cuts later than 15 ticks');
          break;
        case FX.SET_SPEED:
          if (p > 31) warn.add('speeds above 31');
          if (p) set(0xf, Math.min(31, p));
          break;
      }
    });
    // NR51 pans all channels at once: write the new position wherever it changed.
    for (const nr51 of panWrites) {
      for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
        const value = nr51Pan(nr51, ch);
        if (value === pan[ch]) continue;
        pan[ch] = value;
        const out = rows[r][ch];
        const own = pat.rows[r][ch].effect === FX.PANNING;
        if (out.effect === null || own) {
          out.effect = 0x8;
          out.param = value;
        } else out.pan = value;
      }
    }
  });
  return rows;
}
