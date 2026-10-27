import { describe, expect, it } from 'vitest';
import { NR30, NR32, NR33, NR34, WAVE_RAM } from '../../src/apu/apu';
import { sampleFromAudio } from '../../src/audio/import';
import { Engine } from '../../src/audio/engine';
import { captureStream, encodeStream, optimizeStream, StreamPlayer, Write } from '../../src/export/stream';
import { cycleToSample, encodeVgm } from '../../src/export/vgm';
import { FX, Player, RegisterWriter } from '../../src/tracker/player';
import {
  SAMPLE_CHUNK,
  SAMPLE_MAX_LENGTH,
  SAMPLE_PERIOD,
  SAMPLE_RATE,
  SAMPLE_RELOAD_CYCLES,
  SAMPLE_START,
  SAMPLE_STOP,
  SampleBus,
  SampleVoice,
  sampleChunks,
  sampleLevels,
} from '../../src/tracker/sample';
import { CYCLES_PER_TICK, NOTE_OFF, Song, createSong, deleteSample, parseSong } from '../../src/tracker/song';
import { poweredApu } from '../apu/helpers';

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

/** A ramp 0..15 repeated: every level differs from its neighbour. */
const ramp = (n: number) => Array.from({ length: n }, (_, i) => (i % 16).toString(16)).join('');

function sampleSong(data = ramp(100)): Song {
  const s = createSong();
  s.speed = 1;
  s.samples = [{ name: 'Ramp', data }];
  s.waveInstruments[0].sample = 0;
  return s;
}

/** Run the APU and the voice together, reloading at the exact clock (like Engine). */
function run(apu: ReturnType<typeof poweredApu>, bus: SampleBus, cycles: number) {
  while (cycles > 0) {
    const n = Math.min(cycles, bus.voice.untilReload);
    apu.run(n);
    bus.voice.advance(n, apu);
    cycles -= n;
  }
}

const cell = (s: Song, row: number, c: Partial<Song['patterns'][0]['rows'][0][0]>) =>
  Object.assign(s.patterns[0].rows[row][2], c);

describe('sample timing constants', () => {
  it('wave channel period and timer reload agree with the hardware clocks', () => {
    // One nibble every (2048 - period) * 2 clocks; 32 nibbles per reload.
    expect((2048 - SAMPLE_PERIOD) * 2 * 32).toBe(SAMPLE_RELOAD_CYCLES);
    // TIMA counts at 16384 Hz (every 256 clocks) and overflows after 0x100 - 0xC0 = 64 counts.
    expect(256 * (0x100 - 0xc0)).toBe(SAMPLE_RELOAD_CYCLES);
    expect(SAMPLE_RATE).toBe(7936);
  });
});

describe('sample chunks', () => {
  it('puts 31 new levels at wave RAM positions 1..31, position 0 copies position 1', () => {
    const levels = Array.from({ length: 70 }, (_, i) => (i * 7) % 16);
    const hex = levels.map((v) => v.toString(16)).join('');
    expect(sampleLevels(hex)).toEqual(levels);
    const c = sampleChunks(hex);
    expect(c.length).toBe(3 * 16); // ceil(70 / 31)
    const nib = (k: number, p: number) => (p & 1 ? c[k * 16 + (p >> 1)] & 15 : c[k * 16 + (p >> 1)] >> 4);
    for (let k = 0; k < 3; k++) {
      expect(nib(k, 0)).toBe(nib(k, 1));
      for (let p = 1; p < 32; p++) expect(nib(k, p)).toBe(levels[Math.min(69, k * SAMPLE_CHUNK + p - 1)]);
    }
    expect(sampleChunks('').length).toBe(0);
  });
});

describe('sample voice', () => {
  it('reloads with the DAC off, then restarts the channel at the sample period', () => {
    const log = new Log();
    const v = new SampleVoice();
    const chunks = sampleChunks(ramp(40));
    v.start(chunks, log);
    expect(log.take()).toEqual([
      [NR30, 0],
      ...Array.from({ length: 16 }, (_, i) => [WAVE_RAM + i, chunks[i]]),
      [NR30, 0x80],
      [NR33, SAMPLE_PERIOD & 0xff],
      [NR34, 0x80 | (SAMPLE_PERIOD >> 8)],
    ]);
    v.advance(SAMPLE_RELOAD_CYCLES - 1, log);
    expect(log.take()).toEqual([]);
    v.advance(1, log);
    expect(log.take().slice(1, 17)).toEqual(Array.from({ length: 16 }, (_, i) => [WAVE_RAM + i, chunks[16 + i]]));
    // After the last chunk: DAC off and done.
    v.advance(SAMPLE_RELOAD_CYCLES, log);
    expect(log.take()).toEqual([[NR30, 0]]);
    expect(v.active).toBe(false);
  });

  it('plays every level for one 8192 Hz step on the emulated DMG and CGB, 31 per reload', () => {
    for (const model of ['dmg', 'cgb'] as const) {
      const apu = poweredApu(model);
      apu.write(NR32, 0x20); // 100 %
      const levels = sampleLevels(ramp(31 * 4));
      const bus = new SampleBus(apu, [sampleChunks(ramp(31 * 4))]);
      bus.write(SAMPLE_START, 0);
      const heard: number[] = [];
      let t = 0;
      // Sample the output in the middle of every 512-clock step.
      for (let step = 0; step < 32 * 4; step++) {
        const mid = step * 512 + 256 + 6;
        run(apu, bus, mid - t);
        t = mid;
        heard.push(apu.ch3.output());
      }
      for (let k = 0; k < 4; k++) {
        // Step 0 of each reload holds an old nibble, steps 1..31 are the chunk.
        expect(heard.slice(k * 32 + 1, k * 32 + 32), `${model} chunk ${k}`).toEqual(levels.slice(k * 31, k * 31 + 31));
      }
      // The held nibble is the high nibble of the last fetched byte: position 30 of the previous chunk.
      for (let k = 1; k < 4; k++) expect(heard[k * 32]).toBe(levels[k * 31 - 2]);
    }
  });

  it('never corrupts wave RAM on the DMG while retriggering', () => {
    const apu = poweredApu('dmg');
    const chunks = sampleChunks(ramp(31 * 20));
    const bus = new SampleBus(apu, [chunks]);
    bus.write(SAMPLE_START, 0);
    for (let k = 1; k < 20; k++) {
      // Run right up to the reload, the moment a retrigger would hit a fetch.
      run(apu, bus, SAMPLE_RELOAD_CYCLES);
      expect([...apu.waveRam]).toEqual([...chunks.subarray(k * 16, k * 16 + 16)]);
    }
  });
});

describe('player with sample instruments', () => {
  it('starts the sample with the instrument volume and stops it on note off', () => {
    const s = sampleSong();
    s.waveInstruments[0].volume = 2; // 50 %
    cell(s, 0, { note: 36, instrument: 0 });
    cell(s, 2, { note: NOTE_OFF });
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    log.take();
    p.tick(log);
    expect(log.take()).toEqual([
      [NR32, 2 << 5],
      [SAMPLE_START, 0],
    ]);
    p.tick(log);
    expect(log.take()).toEqual([]);
    p.tick(log);
    expect(log.take()).toEqual([
      [SAMPLE_STOP, 0],
      [NR30, 0],
    ]);
  });

  it('a volume change only rewrites NR32, pitch effects write nothing', () => {
    const s = sampleSong();
    cell(s, 0, { note: 36, instrument: 0 });
    cell(s, 1, { volume: 4 });
    cell(s, 2, { effect: FX.SLIDE_UP, param: 0x10 });
    cell(s, 3, { effect: FX.VIBRATO, param: 0x44 });
    s.speed = 3;
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    log.take();
    for (let i = 0; i < 3; i++) p.tick(log);
    log.take();
    p.tick(log);
    expect(log.take()).toEqual([[NR32, 2 << 5]]);
    for (let i = 0; i < 8; i++) p.tick(log);
    expect(log.take()).toEqual([]);
  });

  it('a waveform note after a sample stops it and reloads wave RAM', () => {
    const s = sampleSong();
    cell(s, 0, { note: 36, instrument: 0 });
    cell(s, 1, { note: 36, instrument: 1 });
    cell(s, 2, { note: 36, instrument: 0 });
    cell(s, 3, { note: 36, instrument: 1 });
    const p = new Player(s);
    const log = new Log();
    p.start(log);
    p.tick(log);
    log.take();
    p.tick(log);
    const w = log.take();
    expect(w[0]).toEqual([SAMPLE_STOP, 0]);
    expect(w.filter(([a]) => a >= WAVE_RAM && a < WAVE_RAM + 16)).toHaveLength(16);
    p.tick(log);
    p.tick(log);
    // Even though wave 1 was loaded before, the sample overwrote wave RAM.
    expect(log.take().filter(([a]) => a >= WAVE_RAM && a < WAVE_RAM + 16)).toHaveLength(16);
  });

  it('plays through the engine: wave RAM follows the sample chunk by chunk', () => {
    const s = sampleSong(ramp(31 * 30));
    cell(s, 0, { note: 36, instrument: 0 });
    const e = new Engine(s, 48000);
    e.play();
    const chunks = sampleChunks(s.samples[0].data);
    const l = new Float32Array(1);
    // Render up to just after the 5th reload (1 frame of player tick at 0).
    let rendered = 0;
    const target = 5 * SAMPLE_RELOAD_CYCLES + 100;
    while ((rendered * 4194304) / 48000 < target) {
      e.render(l, l, 1);
      rendered++;
    }
    expect([...e.apu.waveRam]).toEqual([...chunks.subarray(5 * 16, 6 * 16)]);
  });
});

describe('sample streams and exports', () => {
  it('encodes sample commands and the reference driver decodes them', () => {
    const s = sampleSong();
    cell(s, 0, { note: 36, instrument: 0 });
    cell(s, 3, { note: NOTE_OFF });
    const stream = captureStream(s);
    expect(stream.samples).toEqual([sampleChunks(s.samples[0].data)]);
    expect(stream.frames[0]).toContainEqual([SAMPLE_START, 0]);
    const enc = encodeStream(optimizeStream(stream));
    expect([...enc.data]).toContain(0x30);
    const player = new StreamPlayer(enc.data, enc.loopOffset);
    const opt = optimizeStream(stream);
    for (let f = 0; f < stream.frames.length; f++) {
      const w: Write[] = [];
      player.update({ write: (a, v) => w.push([a, v]) });
      expect(w).toEqual(opt.frames[f]);
    }
  });

  it('does not drop a period write that a sample changed behind the stream', () => {
    const s = sampleSong();
    s.speed = 2;
    cell(s, 0, { note: 36, instrument: 1 });
    cell(s, 1, { note: 36, instrument: 0 });
    cell(s, 2, { note: 36, instrument: 1 });
    const opt = optimizeStream(captureStream(s));
    const nr33 = (f: number) => opt.frames[f].filter(([a]) => a === NR33);
    expect(nr33(0)).toHaveLength(1);
    expect(nr33(4)).toEqual(nr33(0));
  });

  it('VGM contains every reload at its exact clock', () => {
    const s = sampleSong(ramp(31 * 10));
    cell(s, 0, { note: 36, instrument: 0 });
    s.patterns[0].rows.length = 64;
    const stream = captureStream(s);
    const vgm = encodeVgm(stream);
    // Walk the VGM commands, logging (sample position, register, value).
    const writes: [number, number, number][] = [];
    let pos = 0;
    for (let i = 0x100; vgm[i] !== 0x66; ) {
      const c = vgm[i];
      if (c === 0xb3) {
        writes.push([pos, vgm[i + 1] + 0x10, vgm[i + 2]]);
        i += 3;
      } else if (c === 0x61) {
        pos += vgm[i + 1] | (vgm[i + 2] << 8);
        i += 3;
      } else if (c === 0x62) (pos += 735), i++;
      else if (c === 0x63) (pos += 882), i++;
      else if (c >= 0x70 && c <= 0x7f) (pos += c - 0x6f), i++;
      else throw new Error(`unexpected ${c.toString(16)}`);
    }
    const triggers = writes.filter(([, a, v]) => a === NR34 && v === 0x87).map(([p]) => p);
    expect(triggers).toEqual(Array.from({ length: 10 }, (_, k) => cycleToSample(k * SAMPLE_RELOAD_CYCLES)));
    // The end of the sample switches the DAC off one reload later.
    expect(writes).toContainEqual([cycleToSample(10 * SAMPLE_RELOAD_CYCLES), NR30, 0]);
    expect(10 * SAMPLE_RELOAD_CYCLES).toBeLessThan(64 * CYCLES_PER_TICK);
  });
});

describe('sample import and song files', () => {
  it('converts audio to 4-bit levels at the sample rate, trimming silence', () => {
    const rate = 44100;
    const x = new Float32Array(rate);
    for (let i = 10000; i < 10000 + rate / 4; i++) x[i] = Math.sin((i * 2 * Math.PI * 200) / rate);
    const hex = sampleFromAudio(x, rate);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(Math.abs(hex.length - SAMPLE_RATE / 4)).toBeLessThan(40);
    const levels = sampleLevels(hex);
    expect(Math.min(...levels)).toBe(0);
    expect(Math.max(...levels)).toBe(15);
    expect(() => sampleFromAudio(new Float32Array(1000), rate)).toThrow();
    expect(sampleFromAudio(Float32Array.from({ length: rate * 10 }, (_, i) => Math.sin(i)), rate).length).toBe(
      SAMPLE_MAX_LENGTH,
    );
  });

  it('round-trips samples through a song file and validates them', () => {
    const s = sampleSong();
    const back = parseSong(JSON.parse(JSON.stringify(s)));
    expect(back.samples).toEqual(s.samples);
    expect(back.waveInstruments[0].sample).toBe(0);
    const bad = parseSong({ ...JSON.parse(JSON.stringify(s)), samples: [{ name: 3, data: 'xyz12G' }] });
    expect(bad.samples).toEqual([{ name: 'Sample 1', data: '12' }]);
    const none = parseSong({ ...JSON.parse(JSON.stringify(s)), samples: undefined });
    expect(none.samples).toEqual([]);
    expect(none.waveInstruments[0].sample).toBe(-1);
  });

  it('deleting a sample renumbers the instruments that use later ones', () => {
    const s = createSong();
    s.samples = [
      { name: 'a', data: '1' },
      { name: 'b', data: '2' },
      { name: 'c', data: '3' },
    ];
    s.waveInstruments[0].sample = 0;
    s.waveInstruments[1].sample = 1;
    s.waveInstruments[2].sample = 2;
    deleteSample(s, 1);
    expect(s.samples.map((x) => x.name)).toEqual(['a', 'c']);
    expect(s.waveInstruments.slice(0, 3).map((w) => w.sample)).toEqual([0, -1, 1]);
  });
});
