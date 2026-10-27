import { NOTE_COUNT, noteName } from '../tracker/notes';
import { CHANNEL_COUNT, Cell, EMPTY, NOTE_OFF, Pattern, emptyCell } from '../tracker/song';

/** Editable fields of a cell: note, instrument, volume, effect, param high, param low. */
export const FIELDS = ['note', 'instrument', 'volume', 'effect', 'paramHi', 'paramLo'] as const;
export const FIELD_COUNT = FIELDS.length;

export interface Cursor {
  row: number;
  ch: number;
  field: number;
}

/** Physical key codes to semitone offsets (layout independent, works on QWERTZ too). */
export const NOTE_KEYS: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21,
  Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

export function noteFromKey(code: string, octave: number): number | null {
  const offset = NOTE_KEYS[code];
  if (offset === undefined) return null;
  const note = (octave - 2) * 12 + offset;
  return note >= 0 && note < NOTE_COUNT ? note : null;
}

const hex = (v: number) => v.toString(16).toUpperCase();

/** Text of each field of a cell, as shown in the pattern view. */
export function formatCell(c: Cell): string[] {
  const note = c.note === NOTE_OFF ? '===' : c.note === EMPTY ? '---' : noteName(c.note);
  const fx = c.effect === EMPTY;
  return [
    note,
    c.instrument === EMPTY ? '-' : hex(c.instrument + 1),
    c.volume === EMPTY ? '-' : hex(c.volume),
    fx ? '-' : hex(c.effect),
    fx ? '-' : hex(c.param >> 4),
    fx ? '-' : hex(c.param & 15),
  ];
}

export function moveCursor(cur: Cursor, rows: number, dRow: number, dField = 0): Cursor {
  let field = cur.field + dField;
  let ch = cur.ch;
  while (field < 0) {
    field += FIELD_COUNT;
    ch = (ch + CHANNEL_COUNT - 1) % CHANNEL_COUNT;
  }
  while (field >= FIELD_COUNT) {
    field -= FIELD_COUNT;
    ch = (ch + 1) % CHANNEL_COUNT;
  }
  const row = (((cur.row + dRow) % rows) + rows) % rows;
  return { row, ch, field };
}

export function jumpChannel(cur: Cursor, dCh: number): Cursor {
  return { ...cur, ch: (cur.ch + dCh + CHANNEL_COUNT) % CHANNEL_COUNT, field: 0 };
}

/** Enter a hex digit (0-15) into a non-note field. Returns false if nothing changed. */
export function enterDigit(c: Cell, field: number, digit: number): boolean {
  switch (FIELDS[field]) {
    case 'instrument':
      c.instrument = digit === 0 ? EMPTY : digit - 1;
      return true;
    case 'volume':
      c.volume = digit;
      return true;
    case 'effect':
      c.effect = digit;
      return true;
    case 'paramHi':
      if (c.effect === EMPTY) c.effect = 0;
      c.param = (digit << 4) | (c.param & 15);
      return true;
    case 'paramLo':
      if (c.effect === EMPTY) c.effect = 0;
      c.param = (c.param & 0xf0) | digit;
      return true;
  }
  return false;
}

export function enterNote(c: Cell, note: number, instrument: number) {
  c.note = note;
  if (note !== NOTE_OFF) c.instrument = instrument;
}

/** Clear the field under the cursor; on the note column the whole note/instrument/volume. */
export function clearField(c: Cell, field: number) {
  switch (FIELDS[field]) {
    case 'note':
      c.note = EMPTY;
      c.instrument = EMPTY;
      c.volume = EMPTY;
      break;
    case 'instrument':
      c.instrument = EMPTY;
      break;
    case 'volume':
      c.volume = EMPTY;
      break;
    default:
      c.effect = EMPTY;
      c.param = 0;
  }
}

/** Insert an empty row at `row` in one channel, pushing the rest down. */
export function insertRow(p: Pattern, ch: number, row: number) {
  for (let r = p.rows.length - 1; r > row; r--) p.rows[r][ch] = p.rows[r - 1][ch];
  p.rows[row][ch] = emptyCell();
}

/** Delete `row` in one channel, pulling the rest up. */
export function deleteRow(p: Pattern, ch: number, row: number) {
  for (let r = row; r < p.rows.length - 1; r++) p.rows[r][ch] = p.rows[r + 1][ch];
  p.rows[p.rows.length - 1][ch] = emptyCell();
}

/** Transpose the notes of one channel by `semitones`. */
export function transpose(p: Pattern, ch: number, semitones: number) {
  for (const r of p.rows) {
    const c = r[ch];
    if (c.note >= 0) c.note = Math.max(0, Math.min(NOTE_COUNT - 1, c.note + semitones));
  }
}
