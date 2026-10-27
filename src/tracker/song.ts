import type { Model } from '../apu/apu';
import { Macros, emptyMacros, parseMacros } from './macro';
import { SAMPLE_COUNT, SAMPLE_MAX_LENGTH } from './sample';

/** Empty field marker for note, instrument, volume and effect. */
export const EMPTY = -1;
/** Note value that stops the channel (shown as "==="). */
export const NOTE_OFF = -2;

export const CHANNEL_COUNT = 4;
export const DEFAULT_ROWS = 64;
export const INSTRUMENT_COUNT = 15;
export const WAVE_COUNT = 16;
/** CPU clocks per frame: the player ticks once per VBlank (~59.73 Hz). */
export const CYCLES_PER_TICK = 70224;

export type ChannelKind = 'pulse' | 'wave' | 'noise';
export const CHANNEL_KINDS: readonly ChannelKind[] = ['pulse', 'pulse', 'wave', 'noise'];

export interface Cell {
  /** 0..83, EMPTY or NOTE_OFF */
  note: number;
  /** 0..14 (shown as 1..F), or EMPTY */
  instrument: number;
  /** 0..15, or EMPTY */
  volume: number;
  /** 0..15, or EMPTY */
  effect: number;
  /** 0..255 */
  param: number;
}

export interface Pattern {
  /** rows[row][channel] */
  rows: Cell[][];
}

export interface PulseInstrument {
  name: string;
  /** 0: 12.5 %, 1: 25 %, 2: 50 %, 3: 75 % */
  duty: number;
  volume: number;
  envUp: boolean;
  /** 0 = no envelope */
  envPeriod: number;
  /** 0 = off, else 1..64 */
  length: number;
  /** Channel 1 only */
  sweepPeriod: number;
  sweepNegate: boolean;
  sweepShift: number;
  /** Per-tick tables (see macro.ts). */
  macros: Macros;
}

export interface WaveInstrument {
  name: string;
  wave: number;
  /** NR32 volume code: 0 mute, 1 100 %, 2 50 %, 3 25 % */
  volume: number;
  /** 0 = off, else 1..256 */
  length: number;
  /** Sample to play instead of the waveform, -1 = none (see sample.ts). */
  sample: number;
  macros: Macros;
}

/** A 4-bit sample for the wave channel, at SAMPLE_RATE. */
export interface Sample {
  name: string;
  /** One hex digit (level 0..15) per sample. */
  data: string;
}

export interface NoiseInstrument {
  name: string;
  volume: number;
  envUp: boolean;
  envPeriod: number;
  length: number;
  /** 7-bit LFSR (metallic/periodic noise) */
  narrow: boolean;
  macros: Macros;
}

export interface Song {
  version: 1;
  title: string;
  author: string;
  model: Model;
  /** Ticks per row */
  speed: number;
  patterns: Pattern[];
  order: number[];
  pulseInstruments: PulseInstrument[];
  waveInstruments: WaveInstrument[];
  noiseInstruments: NoiseInstrument[];
  /** WAVE_COUNT waves of 32 4-bit samples */
  waves: number[][];
  /** Up to SAMPLE_COUNT samples for wave instruments. */
  samples: Sample[];
}

export function emptyCell(): Cell {
  return { note: EMPTY, instrument: EMPTY, volume: EMPTY, effect: EMPTY, param: 0 };
}

export function isEmptyCell(c: Cell) {
  return c.note === EMPTY && c.instrument === EMPTY && c.volume === EMPTY && c.effect === EMPTY;
}

export function emptyPattern(rows = DEFAULT_ROWS): Pattern {
  return { rows: Array.from({ length: rows }, () => Array.from({ length: CHANNEL_COUNT }, emptyCell)) };
}

export function clonePattern(p: Pattern): Pattern {
  return { rows: p.rows.map((r) => r.map((c) => ({ ...c }))) };
}

export const WAVE_PRESETS: Record<string, number[]> = {
  triangle: Array.from({ length: 32 }, (_, i) => (i < 16 ? i : 31 - i)),
  saw: Array.from({ length: 32 }, (_, i) => i >> 1),
  square: Array.from({ length: 32 }, (_, i) => (i < 16 ? 15 : 0)),
  sine: Array.from({ length: 32 }, (_, i) => Math.round(7.5 + 7.5 * Math.sin((i / 32) * Math.PI * 2))),
  pulse25: Array.from({ length: 32 }, (_, i) => (i < 8 ? 15 : 0)),
};

export function defaultPulse(i: number): PulseInstrument {
  return {
    name: `Pulse ${i + 1}`,
    duty: 2,
    volume: 15,
    envUp: false,
    envPeriod: i === 0 ? 0 : 1 + (i % 7),
    length: 0,
    sweepPeriod: 0,
    sweepNegate: false,
    sweepShift: 0,
    macros: emptyMacros(),
  };
}

export function defaultWaveInstrument(i: number): WaveInstrument {
  return { name: `Wave ${i + 1}`, wave: i, volume: 1, length: 0, sample: -1, macros: emptyMacros() };
}

export function defaultNoise(i: number): NoiseInstrument {
  return {
    name: `Noise ${i + 1}`,
    volume: 15,
    envUp: false,
    envPeriod: 1 + (i % 7),
    length: 0,
    narrow: i % 2 === 1,
    macros: emptyMacros(),
  };
}

export function createSong(): Song {
  const presets = Object.values(WAVE_PRESETS);
  return {
    version: 1,
    title: 'Untitled',
    author: '',
    model: 'dmg',
    speed: 6,
    patterns: [emptyPattern()],
    order: [0],
    pulseInstruments: Array.from({ length: INSTRUMENT_COUNT }, (_, i) => defaultPulse(i)),
    waveInstruments: Array.from({ length: INSTRUMENT_COUNT }, (_, i) => defaultWaveInstrument(i)),
    noiseInstruments: Array.from({ length: INSTRUMENT_COUNT }, (_, i) => defaultNoise(i)),
    waves: Array.from({ length: WAVE_COUNT }, (_, i) => [...presets[i % presets.length]]),
    samples: [],
  };
}

/** Remove a sample; instruments that used it fall back to their waveform. */
export function deleteSample(song: Song, index: number) {
  song.samples.splice(index, 1);
  for (const w of song.waveInstruments) {
    if (w.sample === index) w.sample = -1;
    else if (w.sample > index) w.sample--;
  }
}

/** Pack 32 nibbles into the 16 bytes of wave RAM (high nibble first). */
export function packWave(samples: readonly number[]): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) bytes.push(((samples[i * 2] & 15) << 4) | (samples[i * 2 + 1] & 15));
  return bytes;
}

const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;

/** Validate and normalise a parsed song file. Throws on unusable input. */
export function parseSong(json: unknown): Song {
  if (!json || typeof json !== 'object') throw new Error('Not a valid song file');
  const raw = json as Partial<Song>;
  if (!Array.isArray(raw.patterns) || !Array.isArray(raw.order)) throw new Error('Song file has no patterns');
  const base = createSong();
  const cell = (c: Partial<Cell> | undefined): Cell => ({
    note: c?.note === NOTE_OFF ? NOTE_OFF : clampInt(c?.note, EMPTY, 83, EMPTY),
    instrument: clampInt(c?.instrument, EMPTY, INSTRUMENT_COUNT - 1, EMPTY),
    volume: clampInt(c?.volume, EMPTY, 15, EMPTY),
    effect: clampInt(c?.effect, EMPTY, 15, EMPTY),
    param: clampInt(c?.param, 0, 255, 0),
  });
  const patterns = raw.patterns.map((p) => ({
    rows: (Array.isArray(p?.rows) && p.rows.length ? p.rows : emptyPattern().rows)
      .slice(0, 256)
      .map((r) => Array.from({ length: CHANNEL_COUNT }, (_, ch) => cell(Array.isArray(r) ? r[ch] : undefined))),
  }));
  if (!patterns.length) patterns.push(emptyPattern());
  const order = raw.order.map((o) => clampInt(o, 0, patterns.length - 1, 0));
  const samples: Sample[] = (Array.isArray(raw.samples) ? raw.samples : []).slice(0, SAMPLE_COUNT).map((x, i) => ({
    name: typeof x?.name === 'string' ? x.name : `Sample ${i + 1}`,
    data: typeof x?.data === 'string' ? x.data.replace(/[^0-9a-f]/gi, '').toLowerCase().slice(0, SAMPLE_MAX_LENGTH) : '',
  }));
  return {
    version: 1,
    title: typeof raw.title === 'string' ? raw.title : base.title,
    author: typeof raw.author === 'string' ? raw.author : '',
    model: raw.model === 'cgb' ? 'cgb' : 'dmg',
    speed: clampInt(raw.speed, 1, 31, 6),
    patterns,
    order: order.length ? order : [0],
    pulseInstruments: base.pulseInstruments.map((d, i) => {
      const p = { ...d, ...raw.pulseInstruments?.[i] };
      return { ...p, macros: parseMacros(p.macros, 'pulse') };
    }),
    waveInstruments: base.waveInstruments.map((d, i) => {
      const w = { ...d, ...raw.waveInstruments?.[i] };
      return { ...w, sample: clampInt(w.sample, -1, samples.length - 1, -1), macros: parseMacros(w.macros, 'wave') };
    }),
    noiseInstruments: base.noiseInstruments.map((d, i) => {
      const n = { ...d, ...raw.noiseInstruments?.[i] };
      return { ...n, macros: parseMacros(n.macros, 'noise') };
    }),
    waves: base.waves.map((d, i) => {
      const w = raw.waves?.[i];
      return Array.isArray(w) && w.length === 32 ? w.map((s) => clampInt(s, 0, 15, 0)) : d;
    }),
    samples,
  };
}
