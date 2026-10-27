import { describe, expect, it } from 'vitest';
import { Apu, NR42, NR43, NR44, NR52 } from '../../src/apu/apu';
import { AMIGA_CLOCK, AMIGA_PERIODS, encodeMod, modLayout } from '../../src/export/mod';
import {
  TICK_HZ,
  XM_UNITS,
  basePeriodLength,
  convertPattern,
  lfsrSequence,
  nr51Pan,
  pulseCycle,
  slideSemitones,
  volumeEnvelope,
  waveCycle,
} from '../../src/export/module';
import { XM_KEY_OFF, XM_NOTE_OFFSET, encodeXm, xmTuning } from '../../src/export/xm';
import { demoSong } from '../../src/tracker/demo';
import { NOTE_COUNT, noteFrequency, pulseFrequency, PULSE_PERIODS } from '../../src/tracker/notes';
import { FX } from '../../src/tracker/player';
import { EMPTY, NOTE_OFF, Song, createSong } from '../../src/tracker/song';

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

// ------------------------------------------------------------ test parsers

interface XmFile {
  name: string;
  orders: number[];
  restart: number;
  channels: number;
  flags: number;
  speed: number;
  bpm: number;
  patterns: { rows: number; cells: number[][][] }[];
  instruments: {
    name: string;
    envelope: [number, number][];
    envOn: boolean;
    sample: { volume: number; finetune: number; type: number; relativeNote: number; loopStart: number; loopLength: number; data: Int8Array };
  }[];
}

/** Independent XM reader (FT2 file format v1.04). */
function parseXm(b: Uint8Array): XmFile {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const str = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n)).replace(/\0+$/, '');
  expect(str(0, 17)).toBe('Extended Module: ');
  expect(b[37]).toBe(0x1a);
  expect(v.getUint16(58, true)).toBe(0x0104);
  const headerSize = v.getUint32(60, true);
  const length = v.getUint16(64, true);
  const xm: XmFile = {
    name: str(17, 20),
    restart: v.getUint16(66, true),
    channels: v.getUint16(68, true),
    flags: v.getUint16(74, true),
    speed: v.getUint16(76, true),
    bpm: v.getUint16(78, true),
    orders: [...b.subarray(80, 80 + length)],
    patterns: [],
    instruments: [],
  };
  const numPatterns = v.getUint16(70, true);
  const numInstruments = v.getUint16(72, true);
  let o = 60 + headerSize;
  for (let p = 0; p < numPatterns; p++) {
    const hl = v.getUint32(o, true);
    const rows = v.getUint16(o + 5, true);
    const size = v.getUint16(o + 7, true);
    let d = o + hl;
    const end = d + size;
    const cells: number[][][] = [];
    for (let r = 0; r < rows; r++) {
      const row: number[][] = [];
      for (let c = 0; c < xm.channels; c++) {
        const f = [0, 0, 0, 0, 0];
        const first = b[d++];
        if (first & 0x80) {
          for (let i = 0; i < 5; i++) if (first & (1 << i)) f[i] = b[d++];
        } else {
          f[0] = first;
          for (let i = 1; i < 5; i++) f[i] = b[d++];
        }
        row.push(f);
      }
      cells.push(row);
    }
    expect(d).toBe(end);
    xm.patterns.push({ rows, cells });
    o = end;
  }
  for (let i = 0; i < numInstruments; i++) {
    const size = v.getUint32(o, true);
    const name = str(o + 4, 22);
    const samples = v.getUint16(o + 27, true);
    expect(samples).toBe(1);
    const points = b[o + 225];
    const envelope: [number, number][] = [];
    for (let k = 0; k < points; k++) envelope.push([v.getUint16(o + 129 + k * 4, true), v.getUint16(o + 131 + k * 4, true)]);
    const envOn = (b[o + 233] & 1) === 1;
    o += size;
    const len = v.getUint32(o, true);
    const sample = {
      loopStart: v.getUint32(o + 4, true),
      loopLength: v.getUint32(o + 8, true),
      volume: b[o + 12],
      finetune: v.getInt8(o + 13),
      type: b[o + 14],
      relativeNote: v.getInt8(o + 16),
      data: new Int8Array(len),
    };
    o += 40;
    let acc = 0;
    for (let k = 0; k < len; k++) {
      acc = (acc + b[o + k]) & 0xff;
      sample.data[k] = (acc << 24) >> 24;
    }
    o += len;
    xm.instruments.push({ name, envelope, envOn, sample });
  }
  expect(o).toBe(b.length);
  return xm;
}

interface ModFile {
  title: string;
  samples: { name: string; length: number; finetune: number; volume: number; loopStart: number; loopLength: number; data: Int8Array }[];
  orders: number[];
  patterns: { sample: number; period: number; effect: number; param: number }[][][];
}

/** Independent ProTracker M.K. reader. */
function parseMod(b: Uint8Array): ModFile {
  const str = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n)).replace(/\0+$/, '');
  const be = (o: number) => (b[o] << 8) | b[o + 1];
  expect(str(1080, 4)).toBe('M.K.');
  const samples = [];
  for (let i = 0; i < 31; i++) {
    const o = 20 + i * 30;
    samples.push({
      name: str(o, 22),
      length: be(o + 22) * 2,
      finetune: ((b[o + 24] & 15) << 28) >> 28,
      volume: b[o + 25],
      loopStart: be(o + 26) * 2,
      loopLength: be(o + 28) * 2,
      data: new Int8Array(0),
    });
  }
  const length = b[950];
  const orders = [...b.subarray(952, 952 + length)];
  const numPatterns = Math.max(...b.subarray(952, 952 + 128)) + 1;
  const patterns = [];
  let o = 1084;
  for (let p = 0; p < numPatterns; p++) {
    const rows = [];
    for (let r = 0; r < 64; r++) {
      const row = [];
      for (let c = 0; c < 4; c++, o += 4)
        row.push({ sample: (b[o] & 0xf0) | (b[o + 2] >> 4), period: ((b[o] & 15) << 8) | b[o + 1], effect: b[o + 2] & 15, param: b[o + 3] });
      rows.push(row);
    }
    patterns.push(rows);
  }
  for (const s of samples) {
    s.data = Int8Array.from(b.subarray(o, o + s.length), (x) => (x << 24) >> 24);
    o += s.length;
  }
  expect(o).toBe(b.length);
  return { title: str(0, 20), samples, orders, patterns };
}

/** A song with one sustained note per channel, for pitch tests. */
function toneSong(notes: number[], setup?: (s: Song) => void): Song {
  const s = createSong();
  s.patterns = [{ rows: s.patterns[0].rows.slice(0, 16) }];
  s.order = [0];
  notes.forEach((n, ch) => {
    if (n >= 0) s.patterns[0].rows[0][ch] = { note: n, instrument: 0, volume: EMPTY, effect: EMPTY, param: 0 };
  });
  for (const ins of [...s.pulseInstruments, ...s.noiseInstruments]) {
    ins.envPeriod = 0;
    ins.volume = 15;
    ins.length = 0;
  }
  setup?.(s);
  return s;
}

// --------------------------------------------------------------- samples

describe('instrument samples', () => {
  it('pulse periods follow the hardware duty table with no DC', () => {
    for (let duty = 0; duty < 4; duty++) {
      const c = pulseCycle(duty, 32);
      const high = c.filter((x) => x > 0).length;
      expect(high).toBe([4, 8, 16, 24][duty]);
      expect(Math.abs(c.reduce((a, b) => a + b, 0))).toBeLessThanOrEqual(32);
    }
  });

  it('wave periods keep the 4-bit shape', () => {
    const ramp = Array.from({ length: 32 }, (_, i) => i >> 1);
    const c = waveCycle(ramp, 32);
    for (let i = 1; i < 32; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    expect(c[31] - c[0]).toBe(15 * 8);
    expect([...waveCycle(ramp, 16)]).toEqual([...c].filter((_, i) => i % 2 === 0));
  });

  it('noise is the APU LFSR output, bit for bit, for 15 and 7 bits', () => {
    for (const narrow of [false, true]) {
      const apu = new Apu();
      apu.write(NR52, 0x80);
      apu.write(NR42, 0xf0);
      apu.write(NR43, narrow ? 0x08 : 0x00); // divisor 8 clocks, shift 0
      apu.write(NR44, 0x80);
      const hw: number[] = [];
      for (let i = 0; i < 400; i++) {
        hw.push(apu.ch4.output() > 0 ? 1 : 0);
        apu.run(8);
      }
      const seq = [...lfsrSequence(narrow)].map((x) => (x > 0 ? 1 : 0));
      const cycle = (i: number) => seq[i % seq.length];
      const offset = [0, 1, 2].find((d) => hw.slice(d, d + 300).every((b, i) => b === cycle(i)));
      expect(offset).toBeDefined();
    }
    // Maximal-length sequences: the state returns after 2^15-1 / 2^7-1 steps.
    expect(lfsrSequence(false).length).toBe(32767);
    expect(lfsrSequence(true).length).toBe(127);
  });

  it('envelopes follow the hardware step timing', () => {
    const s = createSong();
    Object.assign(s.pulseInstruments[0], { volume: 15, envUp: false, envPeriod: 4, length: 0 });
    const env = volumeEnvelope(s, { kind: 'pulse', index: 0 });
    expect(env[0]).toEqual({ tick: 0, value: 64 });
    // 15 steps of 4/64 s each.
    expect(env.at(-1)).toEqual({ tick: Math.round(15 * (4 / 64) * TICK_HZ), value: 0 });
    expect(env.length).toBeLessThanOrEqual(12);
    // Length counter: silence after (64 - t1) / 256 s.
    Object.assign(s.pulseInstruments[1], { volume: 10, envUp: false, envPeriod: 0, length: 32 });
    const cut = volumeEnvelope(s, { kind: 'pulse', index: 1 });
    expect(cut.at(-1)!.value).toBe(0);
    expect(cut.at(-1)!.tick).toBeCloseTo((32 / 256) * TICK_HZ, -0.5);
    // Constant volume needs no envelope.
    Object.assign(s.pulseInstruments[2], { volume: 10, envPeriod: 0, length: 0 });
    expect(volumeEnvelope(s, { kind: 'pulse', index: 2 })).toEqual([]);
  });
});

// -------------------------------------------------------------------- XM

describe('XM export', () => {
  it('writes a valid FT2 module of the demo song', () => {
    const song = demoSong();
    const xm = parseXm(encodeXm(song).data);
    expect(xm.name).toBe(song.title.slice(0, 20));
    expect(xm.channels).toBe(4);
    expect(xm.flags & 1).toBe(1);
    expect(xm.speed).toBe(song.speed);
    expect(xm.bpm).toBe(149);
    expect(xm.orders).toEqual(song.order);
    expect(xm.patterns.map((p) => p.rows)).toEqual(song.patterns.map((p) => p.rows.length));
    // Every tracker note is in the pattern at XM note + 13, with an instrument.
    song.patterns.forEach((pat, p) =>
      pat.rows.forEach((row, r) =>
        row.forEach((cell, ch) => {
          const x = xm.patterns[p].cells[r][ch];
          if (cell.note >= 0) {
            expect(x[0]).toBe(cell.note + XM_NOTE_OFFSET);
            expect(x[1]).toBeGreaterThan(0);
          } else if (cell.note === NOTE_OFF) expect(x[0]).toBe(XM_KEY_OFF);
          else expect(x[0]).toBe(0);
        }),
      ),
    );
    for (const ins of xm.instruments) {
      expect(ins.sample.type & 3).toBe(1);
      expect(ins.sample.loopLength).toBe(ins.sample.data.length);
    }
  });

  it('plays every note at the Game Boy pitch (linear frequency table)', () => {
    for (const len of [32, 64]) {
      const { relativeNote, finetune } = xmTuning(len);
      for (let n = 0; n < NOTE_COUNT; n++) {
        const x = n + XM_NOTE_OFFSET;
        expect(x).toBeGreaterThanOrEqual(1);
        expect(x).toBeLessThanOrEqual(96);
        const rate = 8363 * 2 ** ((x - 49 + relativeNote + finetune / 128) / 12);
        expect(Math.abs(cents(rate / len, noteFrequency(n)))).toBeLessThan(1);
      }
    }
  });

  it('stores the waveforms and envelopes of the instruments', () => {
    const song = toneSong([24, EMPTY, 24, 24], (s) => {
      s.pulseInstruments[0].duty = 1;
      Object.assign(s.noiseInstruments[0], { envPeriod: 2, volume: 12, narrow: true });
    });
    const xm = parseXm(encodeXm(song).data);
    expect(xm.instruments.map((i) => i.name.slice(0, 2))).toEqual(['P1', 'W1', 'N1']);
    expect([...xm.instruments[0].sample.data]).toEqual([...pulseCycle(1, 32)]);
    expect(xm.instruments[0].envOn).toBe(false);
    expect([...xm.instruments[2].sample.data]).toEqual([...lfsrSequence(true)]);
    expect(xm.instruments[2].envOn).toBe(true);
    expect(xm.instruments[2].sample.volume).toBe(Math.round((12 * 64) / 15));
  });
});

// ----------------------------------------------------------------- effects

describe('effect translation', () => {
  const cellsFor = (cells: Partial<import('../../src/tracker/song').Cell>[], ch = 0) => {
    const s = createSong();
    const pat = { rows: s.patterns[0].rows.slice(0, cells.length) };
    cells.forEach((c, r) => Object.assign(pat.rows[r][ch], c));
    return convertPattern(pat, { units: XM_UNITS, instrumentNumber: () => 1, globalVolume: true }, new (class {
      counts = new Map();
      add() {}
      list() {
        return [];
      }
    })() as never, () => 36);
  };

  it('converts period slides to semitones at the current pitch', () => {
    // 2 period units per tick at C-5 on a pulse channel.
    const rows = cellsFor([{ note: 36, instrument: 0 }, { effect: FX.SLIDE_UP, param: 2 }]);
    const semis = 12 * Math.log2(pulseFrequency(PULSE_PERIODS[36] + 2) / pulseFrequency(PULSE_PERIODS[36]));
    expect(semis).toBeCloseTo(slideSemitones('pulse', 36, 2, true), 9);
    expect(rows[1][0]).toMatchObject({ effect: 1, param: Math.round(semis * 16) });
  });

  it('maps volume, cut, delay, break, speed and note off', () => {
    const rows = cellsFor([
      { note: 24, volume: 15 },
      { volume: 0 },
      { effect: FX.NOTE_CUT, param: 3 },
      { effect: FX.NOTE_DELAY, param: 2 },
      { effect: FX.PATTERN_BREAK, param: 0x12 },
      { effect: FX.SET_SPEED, param: 3 },
      { effect: FX.VOLUME_SLIDE, param: 0x02 },
      { note: NOTE_OFF },
      { effect: FX.SET_VOLUME, param: 0x80 },
      { effect: FX.MASTER_VOLUME, param: 0x33 },
    ]);
    expect(rows[0][0]).toMatchObject({ note: 24, instrument: 1, volume: 64 });
    expect(rows[1][0].volume).toBe(0);
    expect(rows[2][0]).toMatchObject({ effect: 0xe, param: 0xc3 });
    expect(rows[3][0]).toMatchObject({ effect: 0xe, param: 0xd2 });
    expect(rows[4][0]).toMatchObject({ effect: 0xd, param: 0x18 }); // row 18 decimal
    expect(rows[5][0]).toMatchObject({ effect: 0xf, param: 3 });
    expect(rows[6][0]).toMatchObject({ effect: 0xa, param: 0x09 }); // 2/15 -> 9/64 per tick
    expect(rows[7][0]).toMatchObject({ note: 'off', volume: 0 });
    expect(rows[8][0].volume).toBe(Math.round((8 * 64) / 15));
    expect(rows[9][0]).toMatchObject({ effect: 0x10, param: 32 }); // NR50 3/7 -> G20
  });

  it('pans every channel from NR51', () => {
    expect(nr51Pan(0xff, 2)).toBe(128);
    expect(nr51Pan(0x10, 0)).toBe(0);
    expect(nr51Pan(0x01, 0)).toBe(255);
    const rows = cellsFor([{ effect: FX.PANNING, param: 0x5a }]); // left: ch0, ch2; right: ch1, ch3
    expect(rows[0].map((c) => c.param)).toEqual([0, 255, 0, 255]);
    expect(rows[0].every((c) => c.effect === 8)).toBe(true);
  });
});

// ------------------------------------------------------------------- MOD

describe('MOD export', () => {
  it('writes a valid M.K. module of the demo song', () => {
    const song = demoSong();
    const mod = parseMod(encodeMod(song).data);
    expect(mod.title).toBe(song.title.slice(0, 20));
    expect(mod.orders.length).toBeGreaterThanOrEqual(song.order.length);
    // Speed and tempo are set on the first row.
    const first = mod.patterns[mod.orders[0]][0];
    expect(first.some((c) => c.effect === 0xf && c.param === song.speed)).toBe(true);
    expect(first.some((c) => c.effect === 0xf && c.param === 149)).toBe(true);
    for (const s of mod.samples.filter((x) => x.length)) {
      expect(s.length % 2).toBe(0);
      if (s.loopLength > 2) expect(s.loopStart + s.loopLength).toBeLessThanOrEqual(s.length);
    }
    // Every note is a ProTracker period.
    for (const p of mod.patterns) for (const row of p) for (const c of row) if (c.period) expect(AMIGA_PERIODS).toContain(c.period);
  });

  it('plays notes at the Game Boy pitch within the finetune resolution', () => {
    for (const kind of ['pulse', 'wave', 'noise'] as const)
      for (const lo of [0, 12, 24, 36, 48, 72]) {
        const l = modLayout({ kind, index: 0 }, [lo]);
        // The lowest note lands in the bottom octave.
        expect(lo + l.offset).toBeGreaterThanOrEqual(0);
        if (l.periodLength > basePeriodLength(kind) / (kind === 'noise' ? 16 : 4)) expect(lo + l.offset).toBeLessThan(12);
        for (let n = lo; n < lo + 36 && n < NOTE_COUNT; n++) {
          const p = n + l.offset;
          expect(p).toBeGreaterThanOrEqual(0);
          if (p > 35) break;
          const rate = (AMIGA_CLOCK / AMIGA_PERIODS[p]) * 2 ** (l.finetune / 96);
          expect(Math.abs(cents(rate / l.periodLength, noteFrequency(n)))).toBeLessThan(12);
        }
      }
  });

  it('renders decaying envelopes into one-shot samples', () => {
    const song = toneSong([36, EMPTY, EMPTY, 36], (s) => {
      Object.assign(s.pulseInstruments[0], { envPeriod: 1, volume: 15 });
      Object.assign(s.noiseInstruments[0], { envPeriod: 2, volume: 8 });
    });
    const mod = parseMod(encodeMod(song).data);
    for (const s of mod.samples.slice(0, 2)) {
      expect(s.loopLength).toBe(2); // no loop
      const head = Math.max(...[...s.data.subarray(0, 64)].map(Math.abs));
      const tail = Math.max(...[...s.data.subarray(s.length - 64)].map(Math.abs));
      expect(head).toBeGreaterThan(40);
      expect(tail).toBeLessThan(8);
    }
    // 15 steps of 1/64 s at C-5 with the chosen period length.
    const l = modLayout({ kind: 'pulse', index: 0 }, [36]);
    expect(mod.samples[0].length).toBeCloseTo((15 / 64) * noteFrequency(36) * l.periodLength, -2);
  });

  it('splits long patterns and remaps jumps', () => {
    const s = createSong();
    s.patterns = [{ rows: Array.from({ length: 100 }, () => s.patterns[0].rows[0].map((c) => ({ ...c }))) }];
    s.order = [0, 0];
    s.patterns[0].rows[99][1] = { note: EMPTY, instrument: EMPTY, volume: EMPTY, effect: FX.POSITION_JUMP, param: 1 };
    const mod = parseMod(encodeMod(s).data);
    expect(mod.orders.length).toBe(4);
    // Row 99 is row 35 of the second chunk; B01 jumps to MOD position 2.
    const chunk = mod.patterns[mod.orders[3]];
    expect(chunk[35][1]).toMatchObject({ effect: 0xb, param: 2 });
    expect(chunk[35].some((c) => c.effect === 0xd)).toBe(true);
  });
});
