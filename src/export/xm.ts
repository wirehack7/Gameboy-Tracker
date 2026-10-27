/**
 * FastTracker 2 XM export (linear frequencies, 4 channels).
 * Each used instrument becomes an XM instrument with one looped sample and a
 * volume envelope for the hardware envelope and length counter.
 */
import { noteFrequency } from '../tracker/notes';
import { Song } from '../tracker/song';
import {
  MODULE_BPM,
  ModuleCell,
  Warnings,
  XM_UNITS,
  basePeriodLength,
  convertPattern,
  instrumentVolume,
  instrumentWaveform,
  refKey,
  usedInstruments,
  volumeEnvelope,
} from './module';

/** XM note number of a tracker note: C-2 (note 0) is XM C-1 (13), B-8 is B-7 (96). */
export const XM_NOTE_OFFSET = 13;
export const XM_KEY_OFF = 97;

/**
 * Relative note and finetune that make the sample (N samples per period) play
 * the tracker's pitch: XM plays note x at 8363 * 2^((x - 49 + rel + fine/128) / 12) Hz.
 */
export function xmTuning(periodLength: number): { relativeNote: number; finetune: number } {
  const n = 24; // C-4
  const semis = 12 * Math.log2((noteFrequency(n) * periodLength) / 8363) - (n + XM_NOTE_OFFSET - 49);
  let relativeNote = Math.floor(semis);
  let finetune = Math.round((semis - relativeNote) * 128);
  if (finetune > 127) {
    relativeNote++;
    finetune -= 128;
  }
  return { relativeNote, finetune };
}

class Writer {
  private bytes: number[] = [];
  get length() {
    return this.bytes.length;
  }
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >> 8);
  }
  u32(v: number) {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }
  text(s: string, length: number) {
    for (let i = 0; i < length; i++) this.u8(i < s.length ? s.charCodeAt(i) & 0x7f : 0);
  }
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.u8(b[i]);
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0);
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

function packCell(c: ModuleCell, w: number[], warn: Warnings) {
  const note = c.note === 'off' ? XM_KEY_OFF : c.note === null ? 0 : c.note + XM_NOTE_OFFSET;
  let vol = c.volume !== null ? 0x10 + c.volume : 0;
  if (c.pan !== null) {
    if (vol) warn.add('panning changes without a free column');
    else vol = 0xc0 | (c.pan >> 4);
  }
  const effect = c.effect ?? 0;
  const param = c.effect === null ? 0 : c.param;
  const fields = [note, c.instrument ?? 0, vol, effect, param];
  let mask = 0;
  fields.forEach((f, i) => f && (mask |= 1 << i));
  if (mask === 0x1f) return w.push(...fields);
  w.push(0x80 | mask);
  for (const f of fields) if (f) w.push(f);
}

export function encodeXm(song: Song): { data: Uint8Array; warnings: string[] } {
  const warn = new Warnings();
  const refs = usedInstruments(song);
  const numbers = new Map(refs.map((r, i) => [refKey(r), i + 1]));
  const w = new Writer();

  w.text('Extended Module: ', 17);
  w.text(song.title, 20);
  w.u8(0x1a);
  w.text('GB Tracker', 20);
  w.u16(0x0104);
  w.u32(276);
  w.u16(song.order.length);
  w.u16(0); // restart position
  w.u16(4);
  w.u16(song.patterns.length);
  w.u16(refs.length);
  w.u16(1); // linear frequency table
  w.u16(Math.min(31, song.speed));
  w.u16(MODULE_BPM);
  for (let i = 0; i < 256; i++) w.u8(song.order[i] ?? 0);

  for (const pat of song.patterns) {
    const cells = convertPattern(
      pat,
      { units: XM_UNITS, instrumentNumber: (r) => numbers.get(refKey(r)) ?? 0, globalVolume: true },
      warn,
      () => 36,
    );
    const data: number[] = [];
    for (const row of cells) for (const c of row) packCell(c, data, warn);
    w.u32(9);
    w.u8(0);
    w.u16(cells.length);
    w.u16(data.length);
    w.raw(data);
  }

  for (const ref of refs) {
    const ins =
      ref.kind === 'pulse' ? song.pulseInstruments[ref.index] : ref.kind === 'wave' ? song.waveInstruments[ref.index] : song.noiseInstruments[ref.index];
    if (ref.kind === 'pulse' && song.pulseInstruments[ref.index].sweepPeriod) warn.add('pitch sweeps');
    const sample = instrumentWaveform(song, ref, 1);
    const env = volumeEnvelope(song, ref);
    const { relativeNote, finetune } = xmTuning(basePeriodLength(ref.kind));

    w.u32(263);
    w.text(`${ref.kind[0].toUpperCase()}${(ref.index + 1).toString(16).toUpperCase()} ${ins.name}`, 22);
    w.u8(0);
    w.u16(1);
    w.u32(40);
    w.zeros(96); // every note plays sample 0
    for (let i = 0; i < 12; i++) {
      w.u16(env[i]?.tick ?? 0);
      w.u16(env[i]?.value ?? 0);
    }
    w.zeros(48); // panning envelope
    w.u8(env.length); // volume points
    w.u8(0); // panning points
    w.zeros(3); // volume sustain, loop start, loop end
    w.zeros(3); // panning sustain, loop start, loop end
    w.u8(env.length ? 1 : 0); // volume envelope on, no sustain or loop
    w.u8(0); // panning envelope off
    w.zeros(4); // auto-vibrato
    w.u16(0); // fadeout
    w.zeros(22);

    w.u32(sample.length);
    w.u32(0);
    w.u32(sample.length);
    w.u8(instrumentVolume(song, ref));
    w.u8(finetune);
    w.u8(1); // forward loop, 8-bit
    w.u8(128);
    w.u8(relativeNote);
    w.u8(0);
    w.text(ins.name, 22);
    let prev = 0;
    for (const s of sample) {
      w.u8(s - prev);
      prev = s;
    }
  }
  return { data: w.done(), warnings: warn.list() };
}
