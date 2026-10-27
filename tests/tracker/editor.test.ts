import { describe, expect, it } from 'vitest';
import { clearField, deleteRow, enterDigit, formatCell, insertRow, moveCursor, noteFromKey } from '../../src/ui/editor';
import { EMPTY, NOTE_OFF, emptyCell, emptyPattern } from '../../src/tracker/song';

describe('pattern editor', () => {
  it('maps physical keys to notes relative to the octave', () => {
    expect(noteFromKey('KeyZ', 4)).toBe(24); // C-4
    expect(noteFromKey('KeyQ', 4)).toBe(36); // C-5
    expect(noteFromKey('KeyA', 4)).toBeNull();
    expect(noteFromKey('KeyP', 8)).toBeNull(); // beyond B-8
  });

  it('wraps the cursor across fields, channels and rows', () => {
    expect(moveCursor({ row: 0, ch: 0, field: 5 }, 64, 0, 1)).toEqual({ row: 0, ch: 1, field: 0 });
    expect(moveCursor({ row: 0, ch: 0, field: 0 }, 64, -1, -1)).toEqual({ row: 63, ch: 3, field: 5 });
  });

  it('enters hex digits into the right fields', () => {
    const c = emptyCell();
    enterDigit(c, 1, 3);
    enterDigit(c, 2, 0xa);
    enterDigit(c, 4, 0x4);
    enterDigit(c, 5, 0x7);
    expect(c).toEqual({ note: EMPTY, instrument: 2, volume: 0xa, effect: 0, param: 0x47 });
    expect(formatCell(c)).toEqual(['---', '3', 'A', '0', '4', '7']);
    clearField(c, 4);
    expect(c.effect).toBe(EMPTY);
  });

  it('formats note off', () => {
    expect(formatCell({ ...emptyCell(), note: NOTE_OFF })[0]).toBe('===');
  });

  it('inserts and deletes rows in one channel only', () => {
    const p = emptyPattern(4);
    p.rows[1][2].note = 10;
    p.rows[1][0].note = 5;
    insertRow(p, 2, 0);
    expect(p.rows[2][2].note).toBe(10);
    expect(p.rows[1][0].note).toBe(5);
    deleteRow(p, 2, 0);
    expect(p.rows[1][2].note).toBe(10);
  });
});
