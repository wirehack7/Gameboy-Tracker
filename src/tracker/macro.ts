/**
 * Instrument macros: per-tick tables that the player steps through while a
 * note plays, one step per frame (VBlank), like the tables of LSDJ or the
 * sequences of FamiTracker. They only change what the driver writes to the
 * APU registers, so every export that replays the register stream (ROM, GBS,
 * VGM, GBDK, audio and video) plays them exactly as the tracker does.
 */

export type MacroKind = 'volume' | 'arp' | 'pitch' | 'duty';
export const MACRO_KINDS: readonly MacroKind[] = ['volume', 'arp', 'pitch', 'duty'];

/** Longest table. */
export const MACRO_LENGTH = 64;

export interface Macro {
  /** One value per tick; empty = the macro is off. */
  steps: number[];
  /** Step to jump back to after the last one, or -1 to hold the last step. */
  loop: number;
}

export type Macros = Record<MacroKind, Macro>;

export function emptyMacros(): Macros {
  return {
    volume: { steps: [], loop: -1 },
    arp: { steps: [], loop: -1 },
    pitch: { steps: [], loop: -1 },
    duty: { steps: [], loop: -1 },
  };
}

/**
 * The range of each macro on each channel type:
 * - volume: 0..15, scales the note's volume (15 = unchanged);
 * - arp: semitones added to the note;
 * - pitch: added to the period register (positive = higher), not on noise;
 * - duty: the duty cycle (pulse, 0..3), the waveform (wave, 0..15) or the LFSR width (noise, 0 = 15 bit, 1 = 7 bit).
 */
export function macroRange(kind: MacroKind, channel: 'pulse' | 'wave' | 'noise'): [number, number] | null {
  switch (kind) {
    case 'volume':
      return [0, 15];
    case 'arp':
      return [-48, 48];
    case 'pitch':
      return channel === 'noise' ? null : [-128, 127];
    case 'duty':
      return channel === 'pulse' ? [0, 3] : channel === 'wave' ? [0, 15] : [0, 1];
  }
}

/** The value at `tick` ticks into the note, or null when the macro is off. */
export function macroValue(m: Macro, tick: number): number | null {
  const n = m.steps.length;
  if (!n) return null;
  if (tick < n) return m.steps[tick];
  if (m.loop < 0 || m.loop >= n) return m.steps[n - 1];
  return m.steps[m.loop + ((tick - m.loop) % (n - m.loop))];
}

/** A macro as text: values separated by spaces, "|" before the step the loop returns to. */
export function formatMacro(m: Macro): string {
  return m.steps.map((v, i) => (i === m.loop ? `| ${v}` : String(v))).join(' ');
}

/**
 * Reads the text form ("15 12 9 | 6 3"). Numbers outside `range` are clamped,
 * anything that is not a number is skipped, and at most MACRO_LENGTH steps are kept.
 */
export function parseMacro(text: string, range: [number, number]): Macro {
  const steps: number[] = [];
  let loop = -1;
  for (const token of text.replace(/\|/g, ' | ').split(/[\s,;]+/)) {
    if (token === '|') {
      if (loop < 0) loop = steps.length;
      continue;
    }
    const v = Number.parseInt(token, 10);
    if (!Number.isFinite(v) || steps.length >= MACRO_LENGTH) continue;
    steps.push(Math.max(range[0], Math.min(range[1], v)));
  }
  return { steps, loop: loop < steps.length ? loop : -1 };
}

/** Validates macros from a song file; unknown or broken entries become empty macros. */
export function parseMacros(raw: unknown, channel: 'pulse' | 'wave' | 'noise'): Macros {
  const out = emptyMacros();
  if (!raw || typeof raw !== 'object') return out;
  for (const kind of MACRO_KINDS) {
    const range = macroRange(kind, channel);
    const m = (raw as Record<string, Partial<Macro> | undefined>)[kind];
    if (!range || !m || !Array.isArray(m.steps)) continue;
    const steps = m.steps
      .slice(0, MACRO_LENGTH)
      .map((v) =>
        typeof v === 'number' && Number.isFinite(v) ? Math.max(range[0], Math.min(range[1], Math.round(v))) : 0,
      );
    const loop =
      typeof m.loop === 'number' && Number.isInteger(m.loop) && m.loop >= 0 && m.loop < steps.length ? m.loop : -1;
    out[kind] = { steps, loop };
  }
  return out;
}

export function hasMacros(m: Macros | undefined): boolean {
  return !!m && MACRO_KINDS.some((k) => m[k].steps.length > 0);
}
