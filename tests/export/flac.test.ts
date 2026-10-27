/**
 * FLAC export: CRCs and frame numbers against the spec's check values, and a
 * bit-exact round trip through ffmpeg's FLAC decoder (with CRC checking) when
 * ffmpeg is installed (it is on the CI runners). Stems must add up to the mix.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc16, crc8, encodeFlac, toInt16, utf8Number } from '../../src/export/flac';
import { renderSong, renderStems } from '../../src/export/wav';
import { demoSong } from '../../src/tracker/demo';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** ffmpeg is installed; CI sets FFMPEG=1 so a missing ffmpeg fails instead of skipping. */
function hasFfmpeg() {
  if (process.env.FFMPEG) return true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Decode with ffmpeg, failing on any CRC or bitstream error. */
function ffmpegDecode(flac: Uint8Array): Int16Array {
  const file = join(mkdtempSync(join(tmpdir(), 'flac-')), 'x.flac');
  writeFileSync(file, flac);
  const pcm = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-xerror', '-err_detect', 'crccheck+bitstream+explode', '-i', file, '-f', 's16le', '-'],
    { maxBuffer: 1 << 28 },
  );
  return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
}

function expectExact(left: Float32Array, right: Float32Array) {
  const pcm = ffmpegDecode(encodeFlac(left, right, 44100));
  expect(pcm.length).toBe(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    if (pcm[2 * i] !== toInt16(left[i]) || pcm[2 * i + 1] !== toInt16(right[i]))
      throw new Error(`sample ${i}: ${pcm[2 * i]}/${pcm[2 * i + 1]}, expected ${toInt16(left[i])}/${toInt16(right[i])}`);
  }
}

describe('FLAC', () => {
  it('uses the CRC-8 and CRC-16 of the FLAC spec', () => {
    // Standard check values for "123456789".
    expect(crc8(ascii('123456789'))).toBe(0xf4);
    expect(crc16(ascii('123456789'))).toBe(0xfee8);
  });

  it('codes frame numbers like UTF-8', () => {
    expect(utf8Number(0x41)).toEqual([0x41]);
    expect(utf8Number(0xe9)).toEqual([0xc3, 0xa9]);
    expect(utf8Number(0x20ac)).toEqual([0xe2, 0x82, 0xac]);
    expect(utf8Number(0x1f600)).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('writes a STREAMINFO header with the length and format', () => {
    const data = encodeFlac(new Float32Array(5000), new Float32Array(5000), 48000);
    expect([...data.subarray(0, 4)]).toEqual([...ascii('fLaC')]);
    const v = new DataView(data.buffer, data.byteOffset);
    expect(data[4]).toBe(0x80); // last block, STREAMINFO
    expect(v.getUint16(8)).toBe(4096);
    // 20-bit rate, 3-bit channels - 1, 5-bit bits - 1, 36-bit total samples.
    const bits = v.getUint32(18);
    expect(bits >>> 12).toBe(48000);
    expect((bits >>> 9) & 7).toBe(1);
    expect((bits >>> 4) & 31).toBe(15);
    expect(v.getUint32(22)).toBe(5000);
  });

  it.runIf(hasFfmpeg())('decodes bit-exactly in ffmpeg: edge cases', () => {
    const n = 4096 * 2 + 77; // two full frames and a short one
    const f = (fn: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => fn(i));
    expectExact(f(() => 0), f(() => 0));
    expectExact(f((i) => (i % 64 < 32 ? 1 : -1)), f((i) => (i % 50 < 25 ? -1 : 1))); // full-scale squares
    let seed = 1;
    const noise = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 30 - 1);
    expectExact(f(noise), f(noise)); // incompressible: verbatim subframes
    expectExact(f((i) => Math.sin(i / 20)), f((i) => Math.sin(i / 20) * 0.5)); // mid/side
    expectExact(f(() => 0.5), f((i) => (i < 4096 ? 0.5 : -0.25))); // constant subframes
    expectExact(new Float32Array(1), new Float32Array(1));
  });

  it.runIf(hasFfmpeg())('decodes bit-exactly in ffmpeg: the demo song, smaller than WAV', async () => {
    const { left, right } = await renderSong(demoSong(), { maxSeconds: 8, tail: 0 });
    expectExact(left, right);
    expect(encodeFlac(left, right, 44100).length).toBeLessThan(left.length * 4 * 0.6);
  });
});

describe('stems', () => {
  it('render each channel alone, and the stems add up to the mix', async () => {
    const song = demoSong();
    const mix = await renderSong(structuredClone(song), { maxSeconds: 4, tail: 0 });
    const stems = await renderStems(song, { maxSeconds: 4, tail: 0 });
    expect(stems).toHaveLength(4);
    let maxDiff = 0;
    let peak = 0;
    for (let i = 0; i < mix.left.length; i++) {
      const l = stems.reduce((s, x) => s + x.left[i], 0);
      const r = stems.reduce((s, x) => s + x.right[i], 0);
      maxDiff = Math.max(maxDiff, Math.abs(l - mix.left[i]), Math.abs(r - mix.right[i]));
      peak = Math.max(peak, Math.abs(mix.left[i]));
    }
    for (const s of stems) expect(s.left.length).toBe(mix.left.length);
    // The mixer and the high-pass filter are linear: only float rounding remains.
    expect(peak).toBeGreaterThan(0.05);
    expect(maxDiff).toBeLessThan(1e-4);
    // Every stem has sound of its own.
    for (const s of stems) expect(s.left.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeGreaterThan(0.01);
  });
});
