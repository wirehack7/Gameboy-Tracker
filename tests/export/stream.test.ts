import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Apu } from '../../src/apu/apu';
import { Engine } from '../../src/audio/engine';
import { PLAYER_C, PLAYER_H, exampleMain, gbdkProject, makefile, songSources, symbolName } from '../../src/export/gbdk';
import { StreamPlayer, Write, captureStream, encodeStream, optimizeStream } from '../../src/export/stream';
import { NINTENDO_LOGO } from '../../src/export/rom';
import { encodeVgm, frameToSample } from '../../src/export/vgm';
import { crc32 } from '../../src/export/zip';
import { demoSong } from '../../src/tracker/demo';
import { FX } from '../../src/tracker/player';
import { CYCLES_PER_TICK, Song, createSong } from '../../src/tracker/song';

function shortSong(): Song {
  const s = createSong();
  s.speed = 2;
  s.patterns[0] = { rows: s.patterns[0].rows.slice(0, 8) };
  s.patterns.push(structuredClone(s.patterns[0]));
  s.order = [0, 1];
  Object.assign(s.patterns[0].rows[0][0], { note: 24, instrument: 0 });
  Object.assign(s.patterns[0].rows[2][2], { note: 30, instrument: 0 });
  Object.assign(s.patterns[1].rows[0][1], { note: 36, instrument: 1, effect: FX.ARPEGGIO, param: 0x37 });
  Object.assign(s.patterns[1].rows[4][3], { note: 50, instrument: 0 });
  Object.assign(s.patterns[1].rows[7][0], { effect: FX.POSITION_JUMP, param: 1 });
  return s;
}

/** Writes per frame as produced by the reference driver. */
function replay(data: Uint8Array, loop: number, frames: number) {
  const player = new StreamPlayer(data, loop);
  const out: Write[][] = [];
  for (let f = 0; f < frames; f++) {
    const w: Write[] = [];
    player.update({ write: (a, v) => w.push([a, v]) });
    out.push(w);
  }
  return out;
}

describe('register stream capture', () => {
  it('stops at the loop and records the loop frame', () => {
    const s = shortSong();
    const stream = captureStream(s);
    // 2 patterns x 8 rows x 2 ticks, looping back to order 1 (frame 16).
    expect(stream.frames.length).toBe(32);
    expect(stream.loopFrame).toBe(16);
  });

  it('starts with the APU power-up writes', () => {
    const stream = captureStream(shortSong());
    expect(stream.frames[0].slice(0, 3)).toEqual([
      [0x26, 0x80],
      [0x24, 0x77],
      [0x25, 0xff],
    ]);
  });

  it('a song without jumps loops to frame 0', () => {
    const s = createSong();
    s.patterns[0] = { rows: s.patterns[0].rows.slice(0, 4) };
    expect(captureStream(s)).toMatchObject({ loopFrame: 0, frames: { length: 4 * s.speed } });
  });
});

describe('stream encoding', () => {
  it('decodes back to the same writes, including the loop', () => {
    const stream = optimizeStream(captureStream(shortSong()));
    const { data, loopOffset } = encodeStream(stream);
    const n = stream.frames.length;
    const played = replay(data, loopOffset, n * 3);
    const expected = [...stream.frames, ...stream.frames.slice(stream.loopFrame), ...stream.frames.slice(stream.loopFrame)];
    expect(played.slice(0, expected.length)).toEqual(expected.slice(0, n * 3));
  });

  it('splits long waits into several commands', () => {
    const frames: Write[][] = Array.from({ length: 300 }, () => []);
    frames[0] = [[0x24, 0x77]];
    const { data } = encodeStream({ model: 'dmg', frames, loopFrame: 0 });
    expect(Array.from(data)).toEqual([0x14, 0x77, 0xfe, 0xfe, 0x80 | (300 - 2 * 0x7e), 0xff]);
  });

  it('drops redundant latch writes but never trigger or envelope writes', () => {
    const frames: Write[][] = [
      [
        [0x13, 0x10],
        [0x12, 0xf0],
        [0x14, 0x80],
      ],
      [
        [0x13, 0x10],
        [0x12, 0xf0],
        [0x14, 0x80],
      ],
    ];
    const opt = optimizeStream({ model: 'dmg', frames, loopFrame: 0 });
    expect(opt.frames[1]).toEqual([
      [0x12, 0xf0],
      [0x14, 0x80],
    ]);
  });

  it('forgets register values at the loop frame', () => {
    const frames: Write[][] = [[[0x24, 0x77]], [[0x24, 0x00]], [[0x24, 0x77]]];
    const opt = optimizeStream({ model: 'dmg', frames, loopFrame: 2 });
    expect(opt.frames[2]).toEqual([[0x24, 0x77]]);
  });

  it('the driver output sounds exactly like the tracker', () => {
    const song = demoSong();
    const stream = captureStream(song);
    const { data, loopOffset } = encodeStream(optimizeStream(stream));
    const rate = 22050;
    const frames = 240;
    const samples = Math.floor((frames * CYCLES_PER_TICK * rate) / 4194304) - 1;

    const engine = new Engine(song, rate);
    engine.play();
    const l1 = new Float32Array(samples);
    const r1 = new Float32Array(samples);
    engine.render(l1, r1, samples);

    const apu = new Apu({ model: song.model, sampleRate: rate });
    apu.write(0x26, 0x80);
    apu.write(0x24, 0x77);
    apu.write(0x25, 0xff);
    const driver = new StreamPlayer(data, loopOffset);
    for (let f = 0; f < frames; f++) {
      driver.update(apu);
      apu.run(CYCLES_PER_TICK);
    }
    expect(Array.from(apu.out.subarray(0, samples * 2).filter((_, i) => i % 2 === 0))).toEqual(Array.from(l1));
  });
});

describe('VGM export', () => {
  function parse(vgm: Uint8Array) {
    const v = new DataView(vgm.buffer);
    const dataStart = 0x34 + v.getUint32(0x34, true);
    const frames: { sample: number; writes: Write[] }[] = [];
    let sample = 0;
    let p = dataStart;
    let loopSample = -1;
    const loopAt = 0x1c + v.getUint32(0x1c, true);
    for (;;) {
      if (p === loopAt) loopSample = sample;
      const c = vgm[p];
      if (c === 0x66) break;
      if (c === 0xb3) {
        if (!frames.length || frames[frames.length - 1].sample !== sample) frames.push({ sample, writes: [] });
        frames[frames.length - 1].writes.push([vgm[p + 1] + 0x10, vgm[p + 2]]);
        p += 3;
      } else if (c === 0x61) {
        sample += vgm[p + 1] | (vgm[p + 2] << 8);
        p += 3;
      } else if (c === 0x62) {
        sample += 735;
        p++;
      } else if (c === 0x63) {
        sample += 882;
        p++;
      } else if (c >= 0x70 && c <= 0x7f) {
        sample += c - 0x6f;
        p++;
      } else throw new Error(`unexpected command ${c.toString(16)}`);
    }
    return { frames, sample, loopSample, view: v };
  }

  it('writes a valid header with the GB clock and loop', () => {
    const stream = captureStream(shortSong());
    const vgm = encodeVgm(stream, { title: 'Test', author: 'Me' });
    const v = new DataView(vgm.buffer);
    expect(new TextDecoder().decode(vgm.subarray(0, 4))).toBe('Vgm ');
    expect(v.getUint32(0x04, true)).toBe(vgm.length - 4);
    expect(v.getUint32(0x08, true)).toBe(0x171);
    expect(v.getUint32(0x80, true)).toBe(4194304);
    const { sample, loopSample } = parse(vgm);
    expect(v.getUint32(0x18, true)).toBe(sample);
    expect(sample).toBe(frameToSample(stream.frames.length));
    expect(loopSample).toBe(frameToSample(stream.loopFrame));
    expect(v.getUint32(0x20, true)).toBe(sample - loopSample);
    const gd3 = 0x14 + v.getUint32(0x14, true);
    expect(new TextDecoder().decode(vgm.subarray(gd3, gd3 + 4))).toBe('Gd3 ');
  });

  it('contains every register write at the right time', () => {
    const stream = captureStream(shortSong());
    const { frames } = parse(encodeVgm(stream));
    const expected = stream.frames
      .map((writes, f) => ({ sample: frameToSample(f), writes }))
      .filter((f) => f.writes.length);
    expect(frames).toEqual(expected);
  });

  it('a frame is about 738 samples at 44.1 kHz', () => {
    expect(frameToSample(60)).toBe(Math.round((60 * 70224 * 44100) / 4194304));
  });
});

describe('GBDK export', () => {
  it('derives C symbol names', () => {
    expect(symbolName('My Song!')).toBe('my_song');
    expect(symbolName('8-bit')).toBe('song_8_bit');
    expect(symbolName('')).toBe('song');
    expect(symbolName('main')).toBe('song_main');
  });

  it('emits the encoded stream as a C array', () => {
    const song = shortSong();
    song.title = 'Short';
    const stream = captureStream(song);
    const src = songSources(song, stream);
    const { data, loopOffset } = encodeStream(optimizeStream(stream));
    expect(src.header).toContain('extern const uint8_t short_data[];');
    expect(src.source).toContain(`const uint16_t short_loop = ${loopOffset}u;`);
    const bytes = [...src.source.matchAll(/0x([0-9A-F]{2})/g)].map((m) => parseInt(m[1], 16));
    expect(bytes).toEqual(Array.from(data));
  });

  it('flags CGB songs in the Makefile', () => {
    const song = createSong();
    expect(makefile(song, 'x')).not.toContain('-Wm-yc');
    song.model = 'cgb';
    expect(makefile(song, 'x')).toContain('-Wm-yc');
  });

  it('bundles a project zip with all sources', () => {
    const song = demoSong();
    const { zip, name } = gbdkProject(song);
    const listing = new TextDecoder('latin1').decode(zip);
    for (const f of ['gbtr_player.h', 'gbtr_player.c', `${name}.h`, `${name}.c`, 'main.c', 'Makefile', 'README.md']) {
      expect(listing).toContain(`${name}/${f}`);
    }
  });

  it('computes standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('produces a zip that unzip accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbtr-'));
    const file = join(dir, 'song.zip');
    writeFileSync(file, gbdkProject(demoSong()).zip);
    const out = execFileSync('unzip', ['-t', file]).toString();
    expect(out).toContain('No errors detected');
  });

  // Compiles the exported project with the real GBDK toolchain (CI sets GBDK_HOME).
  it.runIf(!!process.env.GBDK_HOME)('compiles with GBDK-2020 into a valid ROM', () => {
    const song = demoSong();
    for (const model of ['dmg', 'cgb'] as const) {
      song.model = model;
      const dir = mkdtempSync(join(tmpdir(), 'gbtr-gbdk-'));
      const name = symbolName(song.title);
      const src = songSources(song, captureStream(song), name);
      writeFileSync(join(dir, 'gbtr_player.h'), PLAYER_H);
      writeFileSync(join(dir, 'gbtr_player.c'), PLAYER_C);
      writeFileSync(join(dir, `${name}.h`), src.header);
      writeFileSync(join(dir, `${name}.c`), src.source);
      writeFileSync(join(dir, 'main.c'), exampleMain(song, name));
      writeFileSync(join(dir, 'Makefile'), makefile(song, name));
      const home = process.env.GBDK_HOME!.replace(/\/?$/, '/');
      execFileSync('make', [`GBDK_HOME=${home}`], { cwd: dir, stdio: 'pipe' });
      const rom = readFileSync(join(dir, `${name}.gb`));
      expect(existsSync(join(dir, `${name}.gb`))).toBe(true);
      // Header checksum over 0x134..0x14C as computed by the boot ROM.
      let sum = 0;
      for (let i = 0x134; i <= 0x14c; i++) sum = (sum - rom[i] - 1) & 0xff;
      expect(rom[0x14d]).toBe(sum);
      expect(rom[0x143] & 0x80).toBe(model === 'cgb' ? 0x80 : 0);
      // Cross-check the logo our own ROM export writes.
      expect([...rom.subarray(0x104, 0x134)]).toEqual([...NINTENDO_LOGO]);
      // The song data is in the ROM verbatim.
      const { data } = encodeStream(optimizeStream(captureStream(song)));
      expect(rom.indexOf(Buffer.from(data))).toBeGreaterThan(0x150);
    }
  });
});
