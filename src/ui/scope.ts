/** Oscilloscope traces for the channel header. */

/**
 * The last `max` samples of one channel from the interleaved 4-channel scope
 * buffer, centred on zero and clamped to -1..1. The DAC output is unipolar (a
 * silent channel with its DAC on sits at +1), so the trace is centred like the
 * Game Boy's output capacitor does; otherwise it hugs the top of the scope.
 */
export function scopeTrace(data: Float32Array, frames: number, ch: number, max = 512): Float32Array {
  const n = Math.min(frames, max);
  const start = frames - n;
  const out = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i] = data[(start + i) * 4 + ch];
  mean /= n || 1;
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, out[i] - mean));
  return out;
}
