import { describe, expect, it } from 'vitest';
import { scopeTrace } from '../../src/ui/scope';

/** Interleaved 4-channel buffer with `fn(i)` on channel `ch` and +1 (DAC on, silent) elsewhere. */
function buffer(frames: number, ch: number, fn: (i: number) => number): Float32Array {
  const data = new Float32Array(frames * 4).fill(1);
  for (let i = 0; i < frames; i++) data[i * 4 + ch] = fn(i);
  return data;
}

describe('channel scopes', () => {
  it('centre a silent channel whose DAC is on instead of drawing it at the top', () => {
    const trace = scopeTrace(buffer(600, 0, () => 0.3), 600, 3);
    expect(trace).toHaveLength(512);
    expect(Math.max(...trace.map(Math.abs))).toBe(0);
  });

  it('centre a unipolar pulse wave around zero', () => {
    // 50% duty between the DAC levels 0 and 1, as a pulse channel outputs it.
    const trace = scopeTrace(buffer(512, 1, (i) => (i % 32 < 16 ? 1 : 0)), 512, 1);
    expect(Math.max(...trace)).toBeCloseTo(0.5);
    expect(Math.min(...trace)).toBeCloseTo(-0.5);
  });

  it('show the newest samples and clamp to the scope height', () => {
    const trace = scopeTrace(buffer(1000, 2, (i) => (i < 488 ? 0 : i % 2 ? 4 : -4)), 1000, 2);
    expect(trace).toHaveLength(512);
    expect(Math.max(...trace)).toBe(1);
    expect(Math.min(...trace)).toBe(-1);
  });

  it('copes with an empty buffer', () => {
    expect(scopeTrace(new Float32Array(0), 0, 0)).toHaveLength(0);
  });
});
