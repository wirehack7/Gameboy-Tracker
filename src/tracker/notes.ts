/**
 * Note numbers and their Game Boy register values.
 *
 * Note 0 is C-2 (65.41 Hz), the lowest C the pulse channels can play
 * (period register 44). The range covers 7 octaves up to B-8.
 */

export const NOTE_COUNT = 84;
export const LOWEST_OCTAVE = 2;
const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

export function noteName(note: number): string {
  return NAMES[note % 12] + (Math.floor(note / 12) + LOWEST_OCTAVE);
}

/** Equal temperament, A-4 = 440 Hz. */
export function noteFrequency(note: number): number {
  const midi = note + (LOWEST_OCTAVE + 1) * 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clampPeriod(x: number) {
  return Math.max(0, Math.min(2047, Math.round(x)));
}

/** Pulse channels: f = 131072 / (2048 - x). */
export const PULSE_PERIODS: readonly number[] = Array.from({ length: NOTE_COUNT }, (_, n) =>
  clampPeriod(2048 - 131072 / noteFrequency(n)),
);

/** Wave channel: f = 65536 / (2048 - x) (32 samples per cycle at 2 MHz). */
export const WAVE_PERIODS: readonly number[] = Array.from({ length: NOTE_COUNT }, (_, n) =>
  clampPeriod(2048 - 65536 / noteFrequency(n)),
);

export function pulseFrequency(period: number) {
  return 131072 / (2048 - period);
}

export function waveFrequency(period: number) {
  return 65536 / (2048 - period);
}

/** LFSR clock rate of an NR43 value (without width bit), in Hz. */
export function noiseClock(nr43: number): number {
  const divisor = [8, 16, 32, 48, 64, 80, 96, 112][nr43 & 7];
  return 4194304 / (divisor << (nr43 >> 4));
}

/**
 * Noise "notes": each note maps to the NR43 shift/divisor combination whose
 * LFSR clock is closest to 64 times the note frequency, which spreads the
 * 84 notes over the usable range of the noise channel.
 */
export const NOISE_NR43: readonly number[] = (() => {
  const options: number[] = [];
  for (let s = 0; s < 14; s++) for (let r = 0; r < 8; r++) options.push((s << 4) | r);
  return Array.from({ length: NOTE_COUNT }, (_, n) => {
    const target = Math.log(noteFrequency(n) * 64);
    let best = options[0];
    let bestDist = Infinity;
    for (const o of options) {
      const d = Math.abs(Math.log(noiseClock(o)) - target);
      if (d < bestDist - 1e-9) {
        best = o;
        bestDist = d;
      }
    }
    return best;
  });
})();
