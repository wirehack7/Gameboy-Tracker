import { describe, expect, it } from 'vitest';
import { Apu, NR52 } from '../../src/apu/apu';
import { Engine } from '../../src/audio/engine';
import { encodeWav, renderSong } from '../../src/export/wav';
import { NOISE_NR43, NOTE_COUNT, PULSE_PERIODS, WAVE_PERIODS, noiseClock, noteFrequency, noteName, pulseFrequency, waveFrequency } from '../../src/tracker/notes';
import { FX, Player, RegisterWriter, waveVolumeCode } from '../../src/tracker/player';
import { CYCLES_PER_TICK, EMPTY, NOTE_OFF, Song, createSong, packWave, parseSong } from '../../src/tracker/song';

class Log implements RegisterWriter {
  writes: [number, number][] = [];
  write(addr: number, value: number) {
    this.writes.push([addr, value]);
  }
  take() {
    const w = this.writes;
    this.writes = [];
    return w;
  }
}

const NOTE = (name: string) => {
  for (let n = 0; n < NOTE_COUNT; n++) if (noteName(n) === name) return n;
  throw new Error(name);
};

function song(setup: (s: Song) => void): Song {
  const s = createSong();
  s.speed = 1;
  setup(s);
  return s;
}

function set(s: Song, row: number, ch: number, cell: Partial<Song['patterns'][0]['rows'][0][0]>, pattern = 0) {
  Object.assign(s.patterns[pattern].rows[row][ch], cell);
}

describe('note tables', () => {
  it('A-4 is 440 Hz and C-2 the lowest pulse C (period 44)', () => {
    expect(noteFrequency(NOTE('A-4'))).toBeCloseTo(440, 6);
    expect(PULSE_PERIODS[NOTE('C-2')]).toBe(44);
  });

  it('pulse periods match the commonly used GB note table', () => {
    // Same values as the note tables of common GB music drivers.
    expect(PULSE_PERIODS[NOTE('C-3')]).toBe(1046);
    expect(PULSE_PERIODS[NOTE('C-4')]).toBe(1547);
    expect(PULSE_PERIODS[NOTE('A-4')]).toBe(1750);
    expect(PULSE_PERIODS[NOTE('C-5')]).toBe(1798);
  });

  it('periods are within 1 % of the target pitch (pulse up to C-7, wave up to C-6)', () => {
    for (let n = 0; n <= NOTE('C-7'); n++) {
      expect(Math.abs(pulseFrequency(PULSE_PERIODS[n]) / noteFrequency(n) - 1)).toBeLessThan(0.01);
    }
    for (let n = 0; n <= NOTE('C-6'); n++) {
      expect(Math.abs(waveFrequency(WAVE_PERIODS[n]) / noteFrequency(n) - 1)).toBeLessThan(0.01);
    }
  });

  it('noise notes never decrease in pitch', () => {
    for (let n = 1; n < NOTE_COUNT; n++) {
      expect(noiseClock(NOISE_NR43[n])).toBeGreaterThanOrEqual(noiseClock(NOISE_NR43[n - 1]));
    }
    expect(NOISE_NR43[NOTE_COUNT - 1]).toBe(0x00);
  });

  it('names notes', () => {
    expect(noteName(0)).toBe('C-2');
    expect(noteName(NOTE_COUNT - 1)).toBe('B-8');
    expect(noteName(NOTE('C#5'))).toBe('C#5');
  });
});

describe('player register writes', () => {
  it('triggers a pulse note with the instrument settings', () => {
    const s = song((s) => {
      s.pulseInstruments[1] = { ...s.pulseInstruments[1], duty: 1, volume: 12, envUp: false, envPeriod: 3, length: 0 };
      set(s, 0, 1, { note: NOTE('A-4'), instrument: 1 });
    });
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    log.take();
    p.tick(log);
    const period = PULSE_PERIODS[NOTE('A-4')];
    expect(log.take()).toEqual([
      [0x16, 0x40],
      [0x17, 0xc3],
      [0x18, period & 0xff],
      [0x19, 0x80 | (period >> 8)],
    ]);
  });

  it('writes the sweep register for channel 1', () => {
    const s = song((s) => {
      s.pulseInstruments[0] = { ...s.pulseInstruments[0], sweepPeriod: 2, sweepNegate: true, sweepShift: 3 };
      set(s, 0, 0, { note: NOTE('C-4'), instrument: 0 });
    });
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    log.take();
    p.tick(log);
    expect(log.take()[0]).toEqual([0x10, 0x2b]);
  });

  it('enables the length counter when the instrument has a length', () => {
    const s = song((s) => {
      s.noiseInstruments[0] = { ...s.noiseInstruments[0], length: 10 };
      set(s, 0, 3, { note: NOTE('C-5'), instrument: 0 });
    });
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    log.take();
    p.tick(log);
    const w = log.take();
    expect(w).toContainEqual([0x20, 54]);
    expect(w[w.length - 1]).toEqual([0x23, 0xc0]);
  });

  it('loads wave RAM with the DAC off before triggering the wave channel', () => {
    const s = song((s) => set(s, 0, 2, { note: NOTE('C-4'), instrument: 3 }));
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    log.take();
    p.tick(log);
    const w = log.take();
    expect(w[0]).toEqual([0x1a, 0x00]);
    const ram = w.filter(([a]) => a >= 0x30 && a < 0x40).map(([, v]) => v);
    expect(ram).toEqual(packWave(s.waves[s.waveInstruments[3].wave]));
    const dacOn = w.findIndex(([a, v]) => a === 0x1a && v === 0x80);
    expect(dacOn).toBeGreaterThan(w.findIndex(([a]) => a === 0x3f));
    expect(w[w.length - 1][0]).toBe(0x1e);
    expect(w[w.length - 1][1] & 0x80).toBe(0x80);
  });

  it('does not reload wave RAM for the same wave', () => {
    const s = song((s) => {
      set(s, 0, 2, { note: NOTE('C-4'), instrument: 0 });
      set(s, 1, 2, { note: NOTE('D-4'), instrument: 0 });
    });
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    p.tick(log);
    log.take();
    p.tick(log);
    expect(log.take().some(([a]) => a >= 0x30 && a < 0x40)).toBe(false);
  });

  it('note off turns the DAC off', () => {
    const s = song((s) => {
      set(s, 0, 0, { note: NOTE('C-4'), instrument: 0 });
      set(s, 1, 0, { note: NOTE_OFF });
    });
    const apu = new Apu();
    const p = new Player(s);
    p.start(apu);
    p.tick(apu);
    expect(apu.read(NR52) & 1).toBe(1);
    p.tick(apu);
    expect(apu.read(NR52) & 1).toBe(0);
  });

  it('volume column overrides the instrument volume', () => {
    const s = song((s) => set(s, 0, 1, { note: NOTE('C-4'), instrument: 0, volume: 5 }));
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    log.take();
    p.tick(log);
    expect(log.take()).toContainEqual([0x17, 0x50]);
  });

  it('maps wave volumes to NR32 codes', () => {
    expect([0, 2, 5, 15].map(waveVolumeCode)).toEqual([0, 3, 2, 1]);
  });
});

describe('effects', () => {
  function periods(s: Song, ticks: number, ch = 1) {
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    log.take();
    const base = [0x11, 0x16, 0x1b][ch];
    const out: number[] = [];
    let lo = 0;
    let hi = 0;
    for (let t = 0; t < ticks; t++) {
      p.tick(log);
      for (const [a, v] of log.take()) {
        if (a === base + 2) lo = v;
        if (a === base + 3) hi = v & 7;
      }
      out.push((hi << 8) | lo);
    }
    return out;
  }

  it('0xy arpeggio cycles note, +x, +y each tick', () => {
    const s = song((s) => {
      s.speed = 6;
      set(s, 0, 1, { note: NOTE('C-4'), instrument: 0, effect: FX.ARPEGGIO, param: 0x47 });
    });
    const c = PULSE_PERIODS[NOTE('C-4')], e = PULSE_PERIODS[NOTE('E-4')], g = PULSE_PERIODS[NOTE('G-4')];
    expect(periods(s, 6)).toEqual([c, e, g, c, e, g]);
  });

  it('1xx / 2xx slide the period every tick after the first', () => {
    const s = song((s) => {
      s.speed = 4;
      set(s, 0, 1, { note: NOTE('C-4'), instrument: 0, effect: FX.SLIDE_UP, param: 5 });
    });
    const c = PULSE_PERIODS[NOTE('C-4')];
    expect(periods(s, 4)).toEqual([c, c + 5, c + 10, c + 15]);
  });

  it('3xx glides to the new note without retriggering', () => {
    const s = song((s) => {
      s.speed = 8;
      set(s, 0, 1, { note: NOTE('C-4'), instrument: 0 });
      set(s, 1, 1, { note: NOTE('C#4'), effect: FX.PORTAMENTO, param: 20 });
    });
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    for (let i = 0; i < 8; i++) p.tick(log);
    log.take();
    for (let i = 0; i < 8; i++) p.tick(log);
    const w = log.take();
    expect(w.some(([a, v]) => a === 0x19 && v & 0x80)).toBe(false);
    const lastLo = w.filter(([a]) => a === 0x18).pop()![1];
    expect(lastLo).toBe(PULSE_PERIODS[NOTE('C#4')] & 0xff);
  });

  it('Bxx jumps to an order and Dxx breaks to a row', () => {
    const s = song((s) => {
      s.patterns.push(structuredClone(s.patterns[0]));
      s.order = [0, 1];
      set(s, 1, 0, { effect: FX.POSITION_JUMP, param: 1 });
      set(s, 1, 0, { effect: FX.PATTERN_BREAK, param: 5 }, 1);
    });
    const p = new Player(s);
    const log = new Log();
    const seen: [number, number][] = [];
    p.onRow = (o, r) => seen.push([o, r]);
    p.start(log);
    for (let i = 0; i < 5; i++) p.tick(log);
    expect(seen).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [0, 5],
    ]);
  });

  it('Fxx changes the speed', () => {
    const s = song((s) => set(s, 0, 0, { effect: FX.SET_SPEED, param: 3 }));
    const p = new Player(s);
    const log = new Log();
    const rows: number[] = [];
    p.onRow = (_, r) => rows.push(r);
    p.start(log);
    for (let i = 0; i < 7; i++) p.tick(log);
    expect(rows).toEqual([0, 1, 2]);
  });

  it('Exx cuts the note after xx ticks', () => {
    const s = song((s) => {
      s.speed = 6;
      set(s, 0, 1, { note: NOTE('C-4'), instrument: 0, effect: FX.NOTE_CUT, param: 3 });
    });
    const apu = new Apu();
    const p = new Player(s);
    p.start(apu);
    for (let i = 0; i < 3; i++) p.tick(apu);
    expect(apu.read(NR52) & 2).toBe(2);
    p.tick(apu);
    expect(apu.read(NR52) & 2).toBe(0);
  });

  it('7xx delays the note by xx ticks', () => {
    const s = song((s) => {
      s.speed = 6;
      set(s, 0, 1, { note: NOTE('C-4'), instrument: 0, effect: FX.NOTE_DELAY, param: 2 });
    });
    const apu = new Apu();
    const p = new Player(s);
    p.start(apu);
    p.tick(apu);
    p.tick(apu);
    expect(apu.read(NR52) & 2).toBe(0);
    p.tick(apu);
    expect(apu.read(NR52) & 2).toBe(2);
  });

  it('Cxy sets volume and envelope with a retrigger', () => {
    const s = song((s) => {
      set(s, 0, 1, { note: NOTE('C-4'), instrument: 0 });
      set(s, 1, 1, { effect: FX.SET_VOLUME, param: 0x9a });
    });
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    p.tick(log);
    log.take();
    p.tick(log);
    const w = log.take();
    expect(w).toContainEqual([0x17, 0x9a]);
    expect(w[w.length - 1][1] & 0x80).toBe(0x80);
  });

  it('5xx and 8xx write NR50 and NR51', () => {
    const s = song((s) => {
      set(s, 0, 0, { effect: FX.MASTER_VOLUME, param: 0x35 });
      set(s, 0, 1, { effect: FX.PANNING, param: 0x5a });
    });
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    log.take();
    p.tick(log);
    expect(log.take()).toEqual([
      [0x24, 0x35],
      [0x25, 0x5a],
    ]);
  });

  it('9xx changes the duty of a playing pulse note', () => {
    const s = song((s) => {
      set(s, 0, 0, { note: NOTE('C-4'), instrument: 0 });
      set(s, 1, 0, { effect: FX.DUTY_WAVE, param: 3 });
    });
    const apu = new Apu();
    const p = new Player(s);
    p.start(apu);
    p.tick(apu);
    p.tick(apu);
    expect(apu.ch1.duty).toBe(3);
  });

  it('counts loops when the song wraps around', () => {
    const s = song((s) => (s.patterns[0] = { rows: s.patterns[0].rows.slice(0, 4) }));
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    for (let i = 0; i < 4; i++) p.tick(log);
    expect(p.loops).toBe(0);
    p.tick(log);
    expect(p.loops).toBe(1);
  });
});

describe('end to end through the emulated APU', () => {
  /** Count rising zero crossings of the left output. */
  function measureFrequency(s: Song, seconds = 1) {
    const sampleRate = 48000;
    const engine = new Engine(s, sampleRate);
    engine.play();
    const n = sampleRate * seconds;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    engine.render(l, r, n);
    let crossings = 0;
    for (let i = sampleRate / 10 + 1; i < n; i++) if (l[i - 1] < 0 && l[i] >= 0) crossings++;
    return crossings / (seconds - 0.1);
  }

  it('A-4 on a pulse channel sounds at 440 Hz', () => {
    const s = song((s) => set(s, 0, 0, { note: NOTE('A-4'), instrument: 0 }));
    expect(measureFrequency(s)).toBeGreaterThan(437);
    expect(measureFrequency(s)).toBeLessThan(443);
  });

  it('A-4 on the wave channel (sine) sounds at 440 Hz', () => {
    const s = song((s) => {
      s.waveInstruments[0].wave = 3; // sine preset
      set(s, 0, 2, { note: NOTE('A-4'), instrument: 0 });
    });
    const f = measureFrequency(s);
    expect(f).toBeGreaterThan(437);
    expect(f).toBeLessThan(443);
  });

  it('the player ticks once per frame (70224 clocks, ~59.73 Hz)', () => {
    const s = song(() => {});
    const engine = new Engine(s, 48000);
    const rows: number[] = [];
    engine.player.onRow = (_, r) => rows.push(r);
    engine.play();
    const n = 48000;
    engine.render(new Float32Array(n), new Float32Array(n), n);
    expect(CYCLES_PER_TICK).toBe(154 * 456);
    expect(rows.length).toBe(60); // 59.73 ticks per second, speed 1
  });

  it('renders a WAV file of the song length', async () => {
    const s = song((s) => {
      s.speed = 6;
      s.patterns[0] = { rows: s.patterns[0].rows.slice(0, 16) };
      set(s, 0, 0, { note: NOTE('C-4'), instrument: 0 });
    });
    const { left, right, sampleRate } = await renderSong(s, { sampleRate: 22050, tail: 0 });
    const seconds = left.length / sampleRate;
    expect(seconds).toBeCloseTo((16 * 6) / 59.7275, 1);
    const wav = encodeWav(left, right, sampleRate);
    const text = new TextDecoder().decode(wav.subarray(0, 16));
    expect(text.startsWith('RIFF')).toBe(true);
    expect(text.slice(8, 16)).toBe('WAVEfmt ');
    expect(wav.length).toBe(44 + left.length * 4);
  });
});

describe('song files', () => {
  it('round-trips through JSON', () => {
    const s = song((s) => set(s, 3, 2, { note: 40, instrument: 2, volume: 9, effect: 0xc, param: 0x81 }));
    const back = parseSong(JSON.parse(JSON.stringify(s)));
    expect(back).toEqual(s);
  });

  it('rejects files without patterns', () => {
    expect(() => parseSong({ title: 'x' })).toThrow();
  });

  it('clamps out of range values', () => {
    const s = createSong();
    const raw = JSON.parse(JSON.stringify(s));
    raw.patterns[0].rows[0][0] = { note: 500, instrument: 99, volume: -5, effect: 3, param: 999 };
    raw.order = [7];
    const back = parseSong(raw);
    expect(back.patterns[0].rows[0][0]).toEqual({ note: 83, instrument: 14, volume: EMPTY, effect: 3, param: 255 });
    expect(back.order).toEqual([0]);
  });
});
