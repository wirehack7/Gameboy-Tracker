import { describe, expect, it } from 'vitest';
import { detectPeriod, quantize4, resample, resampleTo, toMono, waveFromAudio } from '../../src/audio/import';
import { WAVE_PRESETS } from '../../src/tracker/song';

const tone = (hz: number, rate: number, seconds: number, shape = (p: number) => Math.sin(p * 2 * Math.PI), phase = 0) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => shape((((i * hz) / rate + phase) % 1 + 1) % 1));

/** Smallest circular distance between two waves, over all rotations. */
function rotationDistance(a: number[], b: number[]) {
  let best = Infinity;
  for (let r = 0; r < 32; r++) {
    let d = 0;
    for (let i = 0; i < 32; i++) d = Math.max(d, Math.abs(a[(i + r) % 32] - b[i]));
    best = Math.min(best, d);
  }
  return best;
}

describe('audio import', () => {
  it('mixes channels down to mono', () => {
    const m = toMono([Float32Array.from([1, 0, -1]), Float32Array.from([0, 0, 1])]);
    expect([...m]).toEqual([0.5, 0, 0]);
  });

  it('resamples to the requested length and keeps a constant signal', () => {
    expect(resample(new Float32Array(44100), 44100, 7936).length).toBe(7936);
    for (const n of [7, 32, 100]) {
      const out = resampleTo(new Float32Array(50).fill(0.25), n);
      expect(out.length).toBe(n);
      for (const v of out) expect(v).toBeCloseTo(0.25, 6);
    }
  });

  it('quantises to 16 levels, using the full range', () => {
    const q = quantize4(Float32Array.from([-0.1, 0, 0.1]));
    expect(q).toEqual([0, 8, 15]);
    expect(quantize4(new Float32Array(4))).toEqual([8, 8, 8, 8]);
    expect(quantize4(Float32Array.from([2, -2]), false)).toEqual([15, 0]);
  });

  it('finds the period of a tone, also with harmonics', () => {
    const rate = 44100;
    for (const hz of [55, 110, 261.63, 440, 1000]) {
      expect(Math.abs(detectPeriod(tone(hz, rate, 0.1), rate) - rate / hz)).toBeLessThan(0.5);
      const rich = tone(hz, rate, 0.1, (p) => Math.sin(p * 2 * Math.PI) + 0.8 * Math.sin(p * 4 * Math.PI));
      expect(Math.abs(detectPeriod(rich, rate) - rate / hz)).toBeLessThan(0.5);
    }
    expect(detectPeriod(Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * i * 0.37)), rate)).toBe(0);
  });

  it('uses a short single-cycle file as a whole', () => {
    const saw = Float32Array.from({ length: 600 }, (_, i) => i / 300 - 1);
    expect(waveFromAudio(saw, 44100)).toEqual(WAVE_PRESETS.saw);
  });

  it('cuts one period out of a long recording', () => {
    const rate = 44100;
    const tri = (p: number) => (p < 0.5 ? 4 * p - 1 : 3 - 4 * p);
    for (const hz of [110, 440]) {
      const w = waveFromAudio(tone(hz, rate, 1, tri, 0.3), rate);
      expect(w).toHaveLength(32);
      expect(Math.min(...w)).toBe(0);
      expect(Math.max(...w)).toBe(15);
      expect(rotationDistance(w, WAVE_PRESETS.triangle)).toBeLessThanOrEqual(1);
    }
  });

  it('takes the loudest part of the file', () => {
    const rate = 44100;
    const quiet = tone(220, rate, 0.5).map((v) => v * 0.01);
    const loud = tone(220, rate, 0.2, (p) => (p < 0.5 ? 1 : -1));
    const x = new Float32Array(quiet.length + loud.length);
    x.set(quiet);
    x.set(loud, quiet.length);
    const w = waveFromAudio(x, rate);
    // A square: half the samples high, half low.
    expect(w.filter((v) => v >= 14).length).toBeGreaterThanOrEqual(14);
    expect(w.filter((v) => v <= 1).length).toBeGreaterThanOrEqual(14);
  });

  it('rejects noise', () => {
    let seed = 1;
    const noise = Float32Array.from({ length: 20000 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1);
    expect(() => waveFromAudio(noise, 44100)).toThrow();
  });
});
