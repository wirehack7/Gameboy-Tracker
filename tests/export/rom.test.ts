import { describe, expect, it } from 'vitest';
import { FONT_FIRST, FONT_GLYPHS, fontText, fontTiles, glyphRows } from '../../src/export/font';
import {
  DATA_START,
  EncodedSong,
  LOAD_ADDRESS,
  NINTENDO_LOGO,
  buildGbs,
  buildRom,
  encodeSong,
  globalChecksum,
  headerChecksum,
} from '../../src/export/rom';
import { RegisterStream, StreamPlayer, Write, encodeStream, optimizeStream } from '../../src/export/stream';
import { demoSong } from '../../src/tracker/demo';
import { CYCLES_PER_TICK, Song } from '../../src/tracker/song';
import { Sm83, TestBus } from './sm83';

/** Expected writes per frame, from the reference driver. */
function reference(enc: EncodedSong, frames: number): Write[][] {
  const player = new StreamPlayer(enc.data, enc.loopOffset);
  const out: Write[][] = [];
  for (let f = 0; f < frames; f++) {
    const w: Write[] = [];
    player.update({ write: (a, v) => w.push([a, v]) });
    out.push(w);
  }
  return out;
}

/** Load a GBS file like a GBS player does and call play once per frame. */
function runGbs(file: Uint8Array, frames: number) {
  const v = new DataView(file.buffer, file.byteOffset);
  const load = v.getUint16(0x06, true);
  const init = v.getUint16(0x08, true);
  const play = v.getUint16(0x0a, true);
  const rom = new Uint8Array(load + file.length - 0x70);
  rom.set(file.subarray(0x70), load);
  const bus = new TestBus(rom);
  const cpu = new Sm83(bus);
  bus.cpu = cpu;
  cpu.sp = v.getUint16(0x0c, true);
  cpu.a = 0;
  cpu.call(init);
  const out: Write[][] = [];
  for (let f = 0; f < frames; f++) {
    const start = bus.apuWrites.length;
    cpu.call(play);
    out.push(bus.apuWrites.slice(start).map(({ addr, value }) => [addr, value] as Write));
  }
  return { out, bus, cpu };
}

/** Run a ROM from the entry point, logging the APU writes of each play call. */
function runRom(rom: Uint8Array, play: number, frames: number) {
  const bus = new TestBus(rom);
  const cpu = new Sm83(bus);
  bus.cpu = cpu;
  cpu.pc = 0x100;
  bus.io[0x40] = 0x91; // LCD on, as the boot ROM leaves it
  const calls: number[] = []; // cycle of each play call
  const out: Write[][] = [];
  let start = 0;
  for (let steps = 0; calls.length <= frames; steps++) {
    if (steps > 50_000_000) throw new Error('ROM did not reach enough frames');
    if (cpu.pc === play) {
      if (calls.length) out.push(bus.apuWrites.slice(start).map(({ addr, value }) => [addr, value] as Write));
      start = bus.apuWrites.length;
      calls.push(cpu.cycles);
    }
    cpu.step();
  }
  return { out, calls, bus, cpu };
}

/** A synthetic stream big enough to span several banks, loop inside bank 2. */
function longStream(lead: number): EncodedSong {
  const frames: Write[][] = [];
  for (let i = 0; i < lead; i++) frames.push([]);
  for (let f = 0; f < 4000; f++) {
    const w: Write[] = [];
    for (let k = 0; k < 4 + (f % 5); k++) w.push([0x10 + ((f + k) % 0x30), (f * 7 + k) & 0xff]);
    frames.push(w);
    if (f % 13 === 0) frames.push([], []);
  }
  const stream: RegisterStream = { model: 'dmg', frames, loopFrame: 2600 };
  return encodeStream(optimizeStream(stream));
}

function tileText(bus: TestBus, x: number, y: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bus.vram[0x1800 + y * 32 + x + i] + FONT_FIRST);
  return s;
}

describe('font', () => {
  it('covers ASCII 0x20-0x5F with 5x7 glyphs', () => {
    expect(FONT_GLYPHS).toBe(64);
    for (let c = 0x20; c < 0x60; c++) {
      const rows = glyphRows(c);
      expect(rows).toHaveLength(7);
      for (const r of rows) expect(r).toBeLessThan(32);
      if (c !== 0x20) expect(rows.some((r) => r)).toBe(true);
    }
    expect(glyphRows(0x20).every((r) => r === 0)).toBe(true);
  });

  it('encodes tiles in colour 3 at x=1..5', () => {
    const t = fontTiles();
    expect(t.length).toBe(64 * 16);
    // 'T': top row ##### -> pixels 1-5, then the stem in pixel 3.
    const tile = ('T'.charCodeAt(0) - FONT_FIRST) * 16;
    expect(t[tile]).toBe(0b01111100);
    expect(t[tile + 1]).toBe(0b01111100);
    expect(t[tile + 2]).toBe(0b00010000);
    expect(t[tile + 14]).toBe(0); // row 7 is spacing
    for (let i = 0; i < t.length; i += 2) expect(t[i] & 0b10000011).toBe(0);
  });

  it('maps text to upper case and unknown characters to ?', () => {
    expect(fontText('ab{')).toEqual([0x41, 0x42, 0x3f]);
  });
});

describe('GBS export', () => {
  it('has a valid GBS v1 header', () => {
    const song = demoSong();
    const { data, info } = buildGbs(song);
    const v = new DataView(data.buffer);
    expect(String.fromCharCode(...data.subarray(0, 3))).toBe('GBS');
    expect(data[3]).toBe(1);
    expect(data[4]).toBe(1);
    expect(data[5]).toBe(1);
    expect(v.getUint16(6, true)).toBe(LOAD_ADDRESS);
    expect(v.getUint16(8, true)).toBe(info.init);
    expect(v.getUint16(10, true)).toBe(info.play);
    expect(v.getUint16(12, true)).toBe(0xfffe);
    expect(data[0x0f]).toBe(0); // VBlank rate
    const title = String.fromCharCode(...data.subarray(0x10, 0x30)).replace(/\0+$/, '');
    expect(title).toBe(song.title.slice(0, 32));
    // Song data sits at 0x4000 (bank 1).
    const enc = encodeSong(song);
    expect([...data.subarray(0x70 + DATA_START - LOAD_ADDRESS).slice(0, 64)]).toEqual([...enc.data.slice(0, 64)]);
  });

  it('plays the demo song exactly like the reference driver, across the loop', () => {
    const song = demoSong();
    const enc = encodeSong(song);
    const frames = 2 * (song.order.length * 64 * song.speed) + 50;
    const { out } = runGbs(buildGbs(song).data, frames);
    expect(out).toEqual(reference(enc, frames));
  });

  it.each([0, 1])('follows the stream across banks (lead %i)', (lead) => {
    const enc = longStream(lead);
    expect(enc.data.length).toBeGreaterThan(2 * 0x4000);
    expect(enc.loopOffset).toBeGreaterThan(0x4000);
    const frames = 4000 + 4000 / 13 * 2 + 1500;
    const { out, bus } = runGbs(buildGbs(demoSong(), enc).data, frames);
    expect(out).toEqual(reference(enc, frames));
    const banks = Math.ceil(enc.data.length / 0x4000);
    expect(new Set(bus.bankWrites)).toEqual(new Set(Array.from({ length: banks }, (_, i) => i + 1)));
  });

  it('test streams include a register write split across a bank boundary', () => {
    const split = [0, 1].some((lead) => {
      const { data } = longStream(lead);
      for (let i = 0; i < data.length; i += data[i] < 0x30 ? 2 : 1) if (data[i] < 0x30 && i % 0x4000 === 0x3fff) return true;
      return false;
    });
    expect(split).toBe(true);
  });
});

describe('ROM export', () => {
  const song: Song = demoSong();

  it('has a header the boot ROM accepts', () => {
    for (const model of ['dmg', 'cgb'] as const) {
      const { data, banks } = buildRom({ ...song, model });
      expect(data.length).toBe(banks * 0x4000);
      expect([...data.subarray(0x104, 0x134)]).toEqual([...NINTENDO_LOGO]);
      expect(data[0x14d]).toBe(headerChecksum(data));
      expect((data[0x14e] << 8) | data[0x14f]).toBe(globalChecksum(data));
      expect(data[0x143]).toBe(model === 'cgb' ? 0x80 : 0);
      expect(data[0x148]).toBe(Math.log2(banks) - 1);
      expect(data[0x147]).toBe(0); // fits into 32 KiB
      expect(data[0x100]).toBe(0x00); // nop; jp main
      expect(data[0x101]).toBe(0xc3);
    }
  });

  it('uses MBC5 and a matching ROM size for long songs', () => {
    const enc = longStream(0);
    const { data, banks } = buildRom(song, enc);
    const needed = 1 + Math.ceil(enc.data.length / 0x4000);
    expect(banks).toBeGreaterThanOrEqual(needed);
    expect(banks / 2).toBeLessThan(needed);
    expect(data.length).toBe(banks * 0x4000);
    expect(data[0x147]).toBe(0x19);
    expect(data[0x148]).toBe(Math.log2(banks) - 1);
  });

  it('runs from the entry point: display, one play call per VBlank, exact writes', () => {
    const enc = encodeSong(song);
    const { data, play } = buildRom(song);
    const frames = 200;
    const { out, calls, bus } = runRom(data, play, frames);
    expect(out).toEqual(reference(enc, frames));
    // play runs at the start of VBlank, once per frame.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i] - calls[i - 1]).toBeGreaterThan(CYCLES_PER_TICK - 500);
      expect(calls[i] - calls[i - 1]).toBeLessThan(CYCLES_PER_TICK + 500);
    }
    // LCD on with BG tiles at 0x8000, font loaded, text on screen.
    expect(bus.io[0x40]).toBe(0x91);
    expect(bus.io[0x47]).toBe(0xe4);
    expect([...bus.vram.subarray(0, 64 * 16)]).toEqual([...fontTiles()]);
    expect(tileText(bus, 1, 1, 10)).toBe('GB TRACKER');
    expect(tileText(bus, 1, 4, Math.min(18, song.title.length))).toBe(song.title.toUpperCase().slice(0, 18));
    // 200 frames = 3 s.
    expect(tileText(bus, 1, 11, 10)).toBe('TIME 00:03');
  });

  it('keeps counting the time in BCD past a minute', () => {
    const { data, play } = buildRom(song);
    const { bus } = runRom(data, play, 60 * 61 + 1);
    expect(tileText(bus, 1, 11, 10)).toBe('TIME 01:01');
  });

  it('sets the CGB background palette on CGB', () => {
    const { data, play } = buildRom({ ...song, model: 'cgb' });
    const { bus } = runRom(data, play, 1);
    // BCPS write with auto increment, then 8 BCPD writes; the last one is
    // the high byte of colour 3 (A/B red 0xA3224F -> RGB555 0x2494).
    expect(bus.io[0x68]).toBe(0x80);
    expect(bus.io[0x69]).toBe(0x24);
  });
});
