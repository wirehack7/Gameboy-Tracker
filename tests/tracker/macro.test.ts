import { describe, expect, it } from 'vitest';
import { Apu, NR52 } from '../../src/apu/apu';
import { encodeMod } from '../../src/export/mod';
import { captureStream } from '../../src/export/stream';
import { encodeXm } from '../../src/export/xm';
import { copySounds } from '../../src/tracker/library';
import {
  Macro,
  emptyMacros,
  formatMacro,
  macroRange,
  macroValue,
  parseMacro,
  parseMacros,
} from '../../src/tracker/macro';
import { NOISE_NR43, PULSE_PERIODS, WAVE_PERIODS } from '../../src/tracker/notes';
import { Player, RegisterWriter } from '../../src/tracker/player';
import { CYCLES_PER_TICK, NOTE_OFF, Song, createSong, packWave, parseSong } from '../../src/tracker/song';

const m = (steps: number[], loop = -1): Macro => ({ steps, loop });
const C4 = 24;

describe('macro tables', () => {
  it('steps one value per tick, then holds the last step or loops', () => {
    expect(macroValue(m([]), 0)).toBeNull();
    const hold = m([15, 10, 5]);
    expect([0, 1, 2, 3, 50].map((t) => macroValue(hold, t))).toEqual([15, 10, 5, 5, 5]);
    const loop = m([15, 10, 5, 0], 1);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((t) => macroValue(loop, t))).toEqual([15, 10, 5, 0, 10, 5, 0, 10]);
    expect([0, 1, 2, 3].map((t) => macroValue(m([3, 7], 1), t))).toEqual([3, 7, 7, 7]);
  });

  it('reads and writes the text form with a loop marker', () => {
    expect(parseMacro('15 12 9 | 6 3', [0, 15])).toEqual(m([15, 12, 9, 6, 3], 3));
    expect(parseMacro('|0,12;7', [-48, 48])).toEqual(m([0, 12, 7], 0));
    expect(parseMacro('0 4 7|', [-48, 48])).toEqual(m([0, 4, 7]));
    expect(parseMacro('20 -3 x 9', [0, 15])).toEqual(m([15, 0, 9]));
    expect(parseMacro(Array(100).fill('1').join(' '), [0, 15]).steps).toHaveLength(64);
    expect(formatMacro(m([15, 12, 9, 6], 2))).toBe('15 12 | 9 6');
    expect(parseMacro(formatMacro(m([0, -12, 12], 1)), [-48, 48])).toEqual(m([0, -12, 12], 1));
  });

  it('has a range per channel type; noise has no pitch macro', () => {
    expect(macroRange('duty', 'pulse')).toEqual([0, 3]);
    expect(macroRange('duty', 'wave')).toEqual([0, 15]);
    expect(macroRange('duty', 'noise')).toEqual([0, 1]);
    expect(macroRange('pitch', 'noise')).toBeNull();
  });

  it('cleans macros from song files and keeps old files loading', () => {
    expect(parseMacros(undefined, 'pulse')).toEqual(emptyMacros());
    const raw = { volume: { steps: [20, 3.4, 'x'], loop: 7 }, duty: { steps: [5, 1], loop: 1 }, pitch: { steps: [9] } };
    const got = parseMacros(raw, 'noise');
    expect(got.volume).toEqual(m([15, 3, 0]));
    expect(got.duty).toEqual(m([1, 1], 1));
    expect(got.pitch).toEqual(m([]));
    const old = JSON.parse(JSON.stringify(createSong()));
    for (const ins of old.pulseInstruments) delete ins.macros;
    expect(parseSong(old).pulseInstruments[0].macros).toEqual(emptyMacros());
    const s = createSong();
    s.waveInstruments[2].macros.arp = m([0, 12], 0);
    expect(parseSong(JSON.parse(JSON.stringify(s))).waveInstruments[2].macros.arp).toEqual(m([0, 12], 0));
    const target = createSong();
    copySounds(target, s);
    expect(target.waveInstruments[2].macros.arp).toEqual(m([0, 12], 0));
  });
});

/** Runs the player against the emulated APU, one frame per tick, logging the writes of every tick. */
function run(s: Song, ticks: number, inspect: (apu: Apu, tick: number, writes: [number, number][]) => void) {
  const apu = new Apu({ model: s.model });
  let writes: [number, number][] = [];
  const out: RegisterWriter = {
    write: (addr, value) => {
      writes.push([addr, value]);
      apu.write(addr, value);
    },
  };
  const player = new Player(s);
  player.start(out);
  for (let t = 0; t < ticks; t++) {
    writes = [];
    player.tick(out);
    inspect(apu, t, writes);
    apu.run(CYCLES_PER_TICK);
  }
  return apu;
}

function song(setup: (s: Song) => void): Song {
  const s = createSong();
  s.speed = 16;
  setup(s);
  return s;
}

const triggers = (writes: [number, number][], nrx4: number) => writes.filter(([a, v]) => a === nrx4 && v & 0x80).length;

describe('instrument macros on the hardware', () => {
  it('volume macro: the pulse channel plays each step at its volume, with the envelope off', () => {
    const s = song((s) => {
      s.pulseInstruments[0].envPeriod = 3;
      s.pulseInstruments[0].macros.volume = m([15, 12, 8, 4, 0, 6], 5);
      s.patterns[0].rows[0][0] = { ...s.patterns[0].rows[0][0], note: C4, instrument: 0 };
    });
    const levels: number[] = [];
    const nr12: number[] = [];
    run(s, 8, (apu, _t, writes) => {
      levels.push(apu.ch1.enabled && apu.ch1.dacOn ? apu.ch1.env.volume : 0);
      for (const [a, v] of writes) if (a === 0x12) nr12.push(v);
    });
    expect(levels).toEqual([15, 12, 8, 4, 0, 6, 6, 6]);
    // Every change retriggers with the envelope period 0, so the hardware holds the level.
    expect(nr12).toEqual([0xf0, 0xc0, 0x80, 0x40, 0x00, 0x60]);
  });

  it('volume macro scales with the volume column', () => {
    const s = song((s) => {
      s.pulseInstruments[0].macros.volume = m([15, 10]);
      s.patterns[0].rows[0][0] = { ...s.patterns[0].rows[0][0], note: C4, instrument: 0, volume: 6 };
    });
    const levels: number[] = [];
    run(s, 2, (apu) => levels.push(apu.ch1.env.volume));
    expect(levels).toEqual([6, 4]);
  });

  it('volume macro on the wave channel rewrites NR32 without a retrigger', () => {
    const s = song((s) => {
      s.waveInstruments[0].macros.volume = m([15, 7, 3, 0]);
      s.patterns[0].rows[0][2] = { ...s.patterns[0].rows[0][2], note: C4, instrument: 0 };
    });
    const codes: number[] = [];
    let retriggers = 0;
    run(s, 4, (apu, t, writes) => {
      codes.push(apu.ch3.volumeCode);
      if (t > 0) retriggers += triggers(writes, 0x1e);
      expect(apu.ch3.enabled).toBe(true);
    });
    expect(codes).toEqual([1, 2, 3, 0]);
    expect(retriggers).toBe(0);
  });

  it('duty macro rewrites NRx1 without retriggering and keeps the length bits', () => {
    const s = song((s) => {
      s.pulseInstruments[0].macros.duty = m([0, 1, 2, 3], 0);
      s.patterns[0].rows[0][1] = { ...s.patterns[0].rows[0][1], note: C4, instrument: 0 };
    });
    const duties: number[] = [];
    let retriggers = 0;
    run(s, 6, (apu, t, writes) => {
      duties.push(apu.ch2.duty);
      if (t > 0) retriggers += triggers(writes, 0x19);
    });
    expect(duties).toEqual([0, 1, 2, 3, 0, 1]);
    expect(retriggers).toBe(0);
  });

  it('arpeggio macro adds semitones to the note, also on top of a slide', () => {
    const s = song((s) => {
      s.pulseInstruments[0].macros.arp = m([0, 4, 7], 0);
      s.patterns[0].rows[0][0] = { ...s.patterns[0].rows[0][0], note: C4, instrument: 0 };
    });
    const periods: number[] = [];
    run(s, 6, (apu) => periods.push(apu.ch1.frequency));
    const chord = [C4, C4 + 4, C4 + 7].map((n) => PULSE_PERIODS[n]);
    expect(periods).toEqual([...chord, ...chord]);

    const slide = song((s) => {
      s.pulseInstruments[0].macros.arp = m([0, 12], 0);
      s.patterns[0].rows[0][0] = { ...s.patterns[0].rows[0][0], note: C4, instrument: 0, effect: 1, param: 2 };
    });
    const slid: number[] = [];
    run(slide, 3, (apu) => slid.push(apu.ch1.frequency));
    const octave = PULSE_PERIODS[C4 + 12] - PULSE_PERIODS[C4];
    expect(slid).toEqual([PULSE_PERIODS[C4], PULSE_PERIODS[C4] + 2 + octave, PULSE_PERIODS[C4] + 4]);
  });

  it('arpeggio macro on noise picks the NR43 of each note; LFSR width macro sets bit 3', () => {
    const s = song((s) => {
      s.noiseInstruments[0].narrow = false;
      s.noiseInstruments[0].macros.arp = m([12, 0]);
      s.noiseInstruments[0].macros.duty = m([1, 1, 0]);
      s.patterns[0].rows[0][3] = { ...s.patterns[0].rows[0][3], note: C4, instrument: 0 };
    });
    const nr43: number[] = [];
    const narrow: boolean[] = [];
    run(s, 3, (apu, _t, writes) => {
      for (const [a, v] of writes) if (a === 0x22) nr43.push(v);
      narrow.push(apu.ch4.narrow);
    });
    expect(narrow).toEqual([true, true, false]);
    expect(nr43).toEqual([(NOISE_NR43[C4 + 12] & 0xf7) | 8, (NOISE_NR43[C4] & 0xf7) | 8, NOISE_NR43[C4] & 0xf7]);
  });

  it('pitch macro offsets the period register (a kick drum drop on the wave channel)', () => {
    const s = song((s) => {
      s.waveInstruments[0].macros.pitch = m([0, -40, -80, -120]);
      s.patterns[0].rows[0][2] = { ...s.patterns[0].rows[0][2], note: C4, instrument: 0 };
    });
    const periods: number[] = [];
    run(s, 5, (apu) => periods.push(apu.ch3.frequency));
    expect(periods).toEqual([0, -40, -80, -120, -120].map((d) => WAVE_PERIODS[C4] + d));
  });

  it('waveform macro reloads wave RAM with the DAC off and retriggers', () => {
    const s = song((s) => {
      s.waveInstruments[0].macros.duty = m([0, 2]);
      s.patterns[0].rows[0][2] = { ...s.patterns[0].rows[0][2], note: C4, instrument: 0 };
    });
    run(s, 3, (apu, t, writes) => {
      const ram = [...apu.waveRam];
      expect(ram).toEqual(packWave(s.waves[t === 0 ? 0 : 2]));
      expect(apu.ch3.enabled).toBe(true);
      if (t === 1) {
        // NR30 off before the first wave RAM write, the trigger after the last.
        const firstRam = writes.findIndex(([a]) => a >= 0x30);
        const off = writes.findIndex(([a, v]) => a === 0x1a && v === 0);
        expect(off).toBeGreaterThanOrEqual(0);
        expect(off).toBeLessThan(firstRam);
        expect(triggers(writes, 0x1e)).toBe(1);
      }
      if (t === 2) expect(triggers(writes, 0x1e)).toBe(0);
    });
  });

  it('restarts on a new note, not on a volume change, and stops on note off', () => {
    const s = song((s) => {
      s.speed = 2;
      s.pulseInstruments[0].macros.volume = m([15, 9, 3]);
      const rows = s.patterns[0].rows;
      rows[0][0] = { ...rows[0][0], note: C4, instrument: 0 };
      rows[1][0] = { ...rows[1][0], volume: 15 };
      rows[2][0] = { ...rows[2][0], note: C4 + 1 };
      rows[3][0] = { ...rows[3][0], note: NOTE_OFF };
    });
    const levels: number[] = [];
    run(s, 8, (apu) => levels.push(apu.ch1.enabled && apu.ch1.dacOn ? apu.ch1.env.volume : 0));
    expect(levels).toEqual([15, 9, 3, 3, 15, 9, 0, 0]);
  });

  it('previewed notes run their macros too', () => {
    const s = song((s) => (s.pulseInstruments[3].macros.volume = m([4, 8, 12])));
    const apu = new Apu();
    apu.write(NR52, 0x80);
    const player = new Player(s);
    player.preview(apu, 0, C4, 3);
    const levels = [apu.ch1.env.volume];
    for (let i = 0; i < 3; i++) {
      apu.run(CYCLES_PER_TICK);
      player.tick(apu);
      levels.push(apu.ch1.env.volume);
    }
    expect(levels).toEqual([4, 8, 12, 12]);
  });

  it('ends up in the register stream that ROM, GBS, VGM and GBDK replay', () => {
    const plain = song((s) => (s.patterns[0].rows[0][1] = { ...s.patterns[0].rows[0][1], note: C4, instrument: 0 }));
    const withMacro = song((s) => {
      s.patterns[0].rows[0][1] = { ...s.patterns[0].rows[0][1], note: C4, instrument: 0 };
      s.pulseInstruments[0].macros.duty = m([0, 3]);
    });
    const nr21 = (song: Song) =>
      captureStream(song)
        .frames.slice(0, 2)
        .map((f) => f.filter(([a]) => a === 0x16).map(([, v]) => v >> 6));
    expect(nr21(plain)).toEqual([[2], []]);
    expect(nr21(withMacro)).toEqual([[0], [3]]);
  });

  it('XM and MOD exports say that they leave macros out', () => {
    const s = song((s) => {
      s.patterns[0].rows[0][0] = { ...s.patterns[0].rows[0][0], note: C4, instrument: 0 };
      s.pulseInstruments[0].macros.volume = m([15, 0]);
    });
    const macros = (w: string[]) => w.some((x) => x.startsWith('instrument macros'));
    expect(macros(encodeXm(s).warnings)).toBe(true);
    expect(macros(encodeMod(s).warnings)).toBe(true);
    s.pulseInstruments[0].macros.volume = m([]);
    expect(macros(encodeXm(s).warnings)).toBe(false);
  });
});
