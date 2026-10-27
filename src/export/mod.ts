/**
 * ProTracker MOD export (M.K., 4 channels, 31 samples, PAL timing).
 *
 * MOD only has three octaves, so each instrument gets a sample whose period
 * length (8..128 samples) puts the notes it plays into that range. Hardware
 * envelopes and length counters cannot be expressed in MOD, so they are
 * rendered into the sample (exact at the instrument's most common note).
 */
import { noteFrequency } from '../tracker/notes';
import { Song } from '../tracker/song';
import {
  InstrumentRef,
  MODULE_BPM,
  ModuleCell,
  TICK_HZ,
  Warnings,
  amigaUnits,
  basePeriodLength,
  SAMPLE_NOTE,
  convertPattern,
  instrumentSample,
  instrumentVolume,
  instrumentWaveform,
  notesByInstrument,
  refKey,
  sampleData,
  usedInstruments,
  volumeEnvelope,
} from './module';

/** ProTracker periods, finetune 0, C-1 .. B-3. */
export const AMIGA_PERIODS = [
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453, 428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
];
/** Paula clock (PAL) / 2: sample rate = AMIGA_CLOCK / period. */
export const AMIGA_CLOCK = 3546895;
const MAX_SAMPLE_BYTES = 0x1fffe;

export interface ModSampleLayout {
  ref: InstrumentRef;
  /** Samples per pitch period (base period length * 2^k). */
  periodLength: number;
  /** MOD note index (0 = C-1) = tracker note + offset. */
  offset: number;
  finetune: number;
  /** Most common note, at which baked envelopes are exact. */
  refNote: number;
}

/** Choose the period length so the lowest note used lands in MOD's range. */
export function modLayout(ref: InstrumentRef, notes: number[]): ModSampleLayout {
  const base = basePeriodLength(ref.kind);
  const lo = notes.length ? Math.min(...notes) : 24;
  const offsetFor = (len: number) =>
    -Math.round(12 * Math.log2(AMIGA_CLOCK / AMIGA_PERIODS[0] / len / noteFrequency(0)));
  // Shortest period length that keeps the lowest note at or above C-1, so
  // as many notes as possible fit into the three octaves above it.
  // Noise is random anyway, so it may skip LFSR steps (down to 4 samples per pitch period).
  let k = ref.kind === 'noise' ? -4 : -2;
  while (k < 2 && lo + offsetFor(base * 2 ** k) < 0) k++;
  const periodLength = base * 2 ** k;
  const offset = offsetFor(periodLength);
  // ProTracker periods are rounded, so measure the residual over the middle octave.
  let cents = 0;
  for (let p = 12; p < 24; p++) {
    const played = AMIGA_CLOCK / AMIGA_PERIODS[p] / periodLength;
    cents += 1200 * Math.log2(noteFrequency(p - offset) / played);
  }
  const finetune = Math.max(-8, Math.min(7, Math.round(cents / 12 / 12.5)));
  const counts = new Map<number, number>();
  for (const n of notes) counts.set(n, (counts.get(n) ?? 0) + 1);
  const refNote = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 24;
  return { ref, periodLength, offset, finetune, refNote };
}

/**
 * Tracker samples play at 7936 Hz: SAMPLE_NOTE is written as C-2 (period
 * 428, 8287 Hz) with finetune -6 (-3/4 semitone), which gives 7936 Hz.
 */
export const MOD_SAMPLE_LAYOUT = { periodLength: 0, offset: 12 - SAMPLE_NOTE, finetune: -6, refNote: SAMPLE_NOTE };

/** Rendered sample data with its loop (in bytes; loopLength 0 = one-shot). */
export function modSample(song: Song, layout: ModSampleLayout): { data: Int8Array; loopStart: number; loopLength: number } {
  const hex = instrumentSample(song, layout.ref);
  if (hex !== null) {
    const raw = sampleData(hex).subarray(0, MAX_SAMPLE_BYTES);
    const data = raw.length % 2 ? Int8Array.from([...raw, raw[raw.length - 1] ?? 0]) : raw;
    return { data, loopStart: 0, loopLength: 0 };
  }
  const wave = instrumentWaveform(song, layout.ref, layout.periodLength / basePeriodLength(layout.ref.kind));
  const env = volumeEnvelope(song, layout.ref);
  if (!env.length) {
    // Loops must be whole words: repeat odd waveforms (noise periods) twice.
    const data = wave.length % 2 ? Int8Array.from([...wave, ...wave]) : wave;
    return { data, loopStart: 0, loopLength: data.length };
  }
  const rate = noteFrequency(layout.refNote) * layout.periodLength; // samples per second at the reference note
  const perTick = rate / TICK_HZ;
  const last = env.at(-1)!;
  const levelAt = (tick: number) => {
    for (let i = 1; i < env.length; i++)
      if (tick <= env[i].tick) {
        const a = env[i - 1];
        const b = env[i];
        return a.value + ((b.value - a.value) * (tick - a.tick)) / Math.max(1e-9, b.tick - a.tick);
      }
    return last.value;
  };
  let length = Math.ceil(last.tick * perTick);
  const sustain = last.value > 0;
  if (sustain) length = Math.ceil(length / wave.length) * wave.length + wave.length;
  length = Math.min(length + (length % 2), MAX_SAMPLE_BYTES);
  const data = new Int8Array(length);
  for (let i = 0; i < length; i++) data[i] = Math.round((wave[i % wave.length] * levelAt(i / perTick)) / 64);
  if (!sustain) return { data, loopStart: 0, loopLength: 0 };
  const loopLength = Math.min(length, wave.length + (wave.length % 2));
  return { data, loopStart: length - loopLength, loopLength };
}

export function encodeMod(song: Song): { data: Uint8Array; warnings: string[] } {
  const warn = new Warnings();
  const refs = usedInstruments(song);
  if (refs.length > 31) throw new Error(`MOD allows 31 samples, this song uses ${refs.length} instruments.`);
  const notes = notesByInstrument(song);
  const layouts = refs.map((r) =>
    instrumentSample(song, r) !== null ? { ref: r, ...MOD_SAMPLE_LAYOUT } : modLayout(r, notes.get(refKey(r)) ?? []),
  );
  const byKey = new Map(layouts.map((l, i) => [refKey(l.ref), { layout: l, number: i + 1 }]));

  // Patterns are split into 64-row chunks; the first order gets its own copy
  // so the speed and tempo commands only run once.
  const chunksOf = (p: number) => Math.max(1, Math.ceil(song.patterns[p].rows.length / 64));
  const firstChunk: number[] = [];
  let next = 0;
  song.patterns.forEach((_, p) => {
    firstChunk[p] = next;
    next += chunksOf(p);
  });
  const introChunk = next;
  const orderStart: number[] = [];
  const orders: number[] = [];
  song.order.forEach((p, i) => {
    orderStart[i] = orders.length;
    for (let c = 0; c < chunksOf(p); c++) orders.push(i === 0 && c === 0 ? introChunk : firstChunk[p] + c);
  });
  if (orders.length > 128) throw new Error('MOD allows 128 order positions.');
  const units = amigaUnits(
    (n, r) => AMIGA_CLOCK / (noteFrequency(n) * (byKey.get(refKey(r))?.layout.periodLength ?? 32)),
  );

  const chunkCells: ModuleCell[][][] = [];
  song.patterns.forEach((pat, p) => {
    const cells = convertPattern(
      pat,
      {
        units,
        instrumentNumber: (r) => byKey.get(refKey(r))?.number ?? 0,
        globalVolume: false,
        orderPosition: (pos) => orderStart[pos] ?? 0,
        isSample: (r) => instrumentSample(song, r) !== null,
      },
      warn,
      () => 36,
    );
    for (let c = 0; c < chunksOf(p); c++) {
      const rows = cells.slice(c * 64, c * 64 + 64);
      if (rows.length < 64) {
        // End a short pattern early with a break on a free effect column.
        const last = rows.at(-1)!;
        const free = last.find((cell) => cell.effect === null);
        if (free) {
          free.effect = 0xd;
          free.param = 0;
        } else warn.add('short patterns without a free effect column');
      }
      chunkCells.push(rows);
    }
  });
  // Intro copy of the first order's first chunk with speed and tempo.
  const intro = structuredClone(chunkCells[firstChunk[song.order[0]]]);
  const freeCells = intro[0].filter((c) => c.effect === null);
  if (freeCells.length >= 1) [freeCells[0].effect, freeCells[0].param] = [0xf, Math.min(31, song.speed)];
  else warn.add('start speed (no free effect column on the first row)');
  if (freeCells.length >= 2) [freeCells[1].effect, freeCells[1].param] = [0xf, MODULE_BPM];
  else warn.add('tempo (no free effect column on the first row)');
  chunkCells.push(intro);
  if (chunkCells.length > 64) throw new Error('MOD allows 64 patterns.');

  const out: number[] = [];
  const text = (s: string, n: number) => {
    for (let i = 0; i < n; i++) out.push(i < s.length ? s.charCodeAt(i) & 0x7f : 0);
  };
  const u16be = (v: number) => out.push((v >> 8) & 0xff, v & 0xff);

  text(song.title, 20);
  const samples = layouts.map((l) => modSample(song, l));
  for (let i = 0; i < 31; i++) {
    const l = layouts[i];
    const s = samples[i];
    if (!l) {
      text('', 22);
      out.push(0, 0, 0, 0, 0, 0, 0, 1);
      continue;
    }
    const ins = l.ref.kind === 'pulse' ? song.pulseInstruments[l.ref.index] : l.ref.kind === 'wave' ? song.waveInstruments[l.ref.index] : song.noiseInstruments[l.ref.index];
    text(`${l.ref.kind[0].toUpperCase()}${(l.ref.index + 1).toString(16).toUpperCase()} ${ins.name}`, 22);
    u16be(s.data.length / 2);
    out.push(l.finetune & 15, instrumentVolume(song, l.ref));
    u16be(s.loopLength ? s.loopStart / 2 : 0);
    u16be(s.loopLength ? s.loopLength / 2 : 1);
  }
  out.push(orders.length, 127);
  for (let i = 0; i < 128; i++) out.push(orders[i] ?? 0);
  text('M.K.', 4);

  for (const rows of chunkCells) {
    for (let r = 0; r < 64; r++)
      for (let ch = 0; ch < 4; ch++) {
        const c = rows[r]?.[ch];
        let period = 0;
        let sample = 0;
        let effect = 0;
        let param = 0;
        if (c) {
          if (typeof c.note === 'number') {
            const info = [...byKey.values()].find((v) => v.number === c.instrument) ?? currentLayout(rows, r, ch, byKey);
            let p = c.note + (info?.layout.offset ?? -12);
            if (p < 0 || p > 35) warn.add('notes outside the three MOD octaves (moved by octaves)');
            while (p < 0) p += 12;
            while (p > 35) p -= 12;
            period = AMIGA_PERIODS[p];
          }
          sample = c.instrument ?? 0;
          if (c.effect !== null) {
            effect = c.effect;
            param = c.param;
            if (c.volume !== null) warn.add('volume next to an effect');
          } else if (c.volume !== null) {
            effect = 0xc;
            param = c.volume;
          } else if (c.pan !== null) {
            effect = 0x8;
            param = c.pan;
          }
        }
        out.push((sample & 0xf0) | (period >> 8), period & 0xff, ((sample & 15) << 4) | (effect & 15), param & 0xff);
      }
  }
  for (const s of samples) for (const v of s.data) out.push(v & 0xff);
  return { data: Uint8Array.from(out), warnings: warn.list() };
}

/** Layout of the instrument playing on a channel (porta notes carry no instrument). */
function currentLayout(
  rows: ModuleCell[][],
  r: number,
  ch: number,
  byKey: Map<string, { layout: ModSampleLayout; number: number }>,
) {
  for (let i = r; i >= 0; i--) {
    const n = rows[i][ch].instrument;
    if (n) return [...byKey.values()].find((v) => v.number === n);
  }
  return undefined;
}
