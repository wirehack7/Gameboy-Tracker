/**
 * Turning imported audio (WAV, MP3, ...) into wave channel data. Decoding is
 * left to the browser; everything here works on plain Float32 PCM so it can
 * be tested without Web Audio.
 */

/** Mix any number of channels down to mono. */
export function toMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0]?.length ?? 0);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
}

/**
 * Resample by averaging the input over each output sample's span (a box
 * filter, so downsampling does not alias badly), with linear interpolation
 * when upsampling.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  const length = Math.max(1, Math.round((input.length * to) / from));
  return resampleTo(input, length);
}

/** Resample to an exact number of output samples. */
export function resampleTo(input: Float32Array, length: number): Float32Array {
  const out = new Float32Array(length);
  if (!input.length) return out;
  const ratio = input.length / length;
  for (let i = 0; i < length; i++) {
    const start = i * ratio;
    const end = start + ratio;
    if (ratio <= 1) {
      // Upsampling: interpolate at the centre of the output sample.
      const x = Math.min(input.length - 1, Math.max(0, start + ratio / 2 - 0.5));
      const k = Math.floor(x);
      const f = x - k;
      out[i] = input[k] * (1 - f) + input[Math.min(input.length - 1, k + 1)] * f;
      continue;
    }
    let sum = 0;
    for (let k = Math.floor(start); k < Math.ceil(end) && k < input.length; k++) {
      const w = Math.min(end, k + 1) - Math.max(start, k);
      sum += input[k] * w;
    }
    out[i] = sum / ratio;
  }
  return out;
}

/**
 * Quantise to 4-bit levels 0..15. The signal's mean is removed and its peak
 * scaled to the full range, so quiet recordings still use all 16 levels.
 */
export function quantize4(input: Float32Array, normalize = true): number[] {
  let mean = 0;
  for (const v of input) mean += v;
  mean = input.length ? mean / input.length : 0;
  let peak = 0;
  for (const v of input) peak = Math.max(peak, Math.abs(v - mean));
  const gain = normalize ? (peak > 1e-6 ? 1 / peak : 0) : 1;
  return Array.from(input, (v) => Math.max(0, Math.min(15, Math.round(7.5 + (v - mean) * gain * 7.5))));
}

/** Files up to this many samples are treated as one single-cycle waveform. */
export const SINGLE_CYCLE_MAX = 2048;
const WINDOW = 4096;
const MIN_HZ = 30;
const MAX_HZ = 2000;

/**
 * Length in samples of one period of the signal (normalised autocorrelation),
 * or 0 if no clear pitch is found.
 */
export function detectPeriod(x: Float32Array, rate: number): number {
  const minLag = Math.max(2, Math.floor(rate / MAX_HZ));
  const maxLag = Math.min(Math.floor(x.length / 2), Math.ceil(rate / MIN_HZ));
  const corr = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let sum = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < x.length; i++) {
      sum += x[i] * x[i + lag];
      e1 += x[i] * x[i];
      e2 += x[i + lag] * x[i + lag];
    }
    corr[lag] = e1 && e2 ? sum / Math.sqrt(e1 * e2) : 0;
  }
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) if (corr[lag] > corr[best]) best = lag;
  if (!best || corr[best] < 0.5) return 0;
  // The first peak close to the best one is the fundamental (avoids octave errors).
  for (let lag = minLag + 1; lag < best; lag++) {
    if (corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1] && corr[lag] > corr[best] * 0.9) {
      best = lag;
      break;
    }
  }
  // Parabolic interpolation for a sub-sample period.
  const a = corr[best - 1], b = corr[best], c = corr[best + 1];
  const d = a - 2 * b + c;
  return best + (d < 0 ? (0.5 * (a - c)) / d : 0);
}

/** Start of the loudest WINDOW-sample section. */
function loudestWindow(x: Float32Array): number {
  if (x.length <= WINDOW) return 0;
  const hop = WINDOW / 4;
  let best = 0, bestEnergy = -1;
  for (let s = 0; s + WINDOW <= x.length; s += hop) {
    let e = 0;
    for (let i = s; i < s + WINDOW; i++) e += x[i] * x[i];
    if (e > bestEnergy) [best, bestEnergy] = [s, e];
  }
  return best;
}

/**
 * Make a 32 × 4-bit waveform from audio. Short files (single-cycle waveform
 * libraries) are squeezed into 32 samples as a whole; longer ones have one
 * period cut out of their loudest part, starting at a rising zero crossing.
 */
export function waveFromAudio(x: Float32Array, rate: number): number[] {
  if (x.length <= SINGLE_CYCLE_MAX) return quantize4(resampleTo(x, 32));
  const start = loudestWindow(x);
  const win = x.subarray(start, start + WINDOW);
  let mean = 0;
  for (const v of win) mean += v;
  mean /= win.length;
  const centred = win.map((v) => v - mean);
  const period = detectPeriod(centred, rate);
  if (!period) throw new Error('No repeating waveform found');
  let zero = 0;
  for (let i = 1; i < centred.length - period; i++) {
    if (centred[i - 1] < 0 && centred[i] >= 0) {
      zero = i;
      break;
    }
  }
  // One period, read with sub-sample accuracy.
  const n = Math.max(32, Math.round(period * 4));
  const cycle = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = zero + (i / n) * period;
    const k = Math.floor(p);
    const f = p - k;
    cycle[i] = centred[k] * (1 - f) + centred[Math.min(centred.length - 1, k + 1)] * f;
  }
  return quantize4(resampleTo(cycle, 32));
}
