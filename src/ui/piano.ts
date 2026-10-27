/** Layout of the on-screen piano. */
import { NOTE_COUNT, noteName } from '../tracker/notes';

export interface PianoKey {
  note: number;
  black: boolean;
  /** Index of the white key this key sits on (black keys sit on its right edge). */
  white: number;
  label: string;
}

const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

/** Keys from the C of `octave` over `octaves` octaves plus the closing C, clipped to the note range. */
export function pianoKeys(octave: number, octaves: number): PianoKey[] {
  const first = (octave - 2) * 12;
  const keys: PianoKey[] = [];
  let white = -1;
  for (let note = first; note <= first + octaves * 12 && note < NOTE_COUNT; note++) {
    if (note < 0) continue;
    const black = BLACK[note % 12];
    if (!black) white++;
    keys.push({ note, black, white, label: note % 12 === 0 ? noteName(note).replace('-', '') : '' });
  }
  return keys;
}

/** How many octaves fit a given width with white keys at least `minKey` px wide (wider for touch). */
export function pianoOctaves(width: number, minKey = 26): number {
  return Math.max(1, Math.min(4, Math.floor(width / (7 * minKey))));
}
