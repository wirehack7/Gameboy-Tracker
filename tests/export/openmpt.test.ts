/**
 * Cross-check of the XM and MOD exports with libopenmpt, the playback engine
 * of OpenMPT (WebAssembly build from the chiptune3 package). Runs in CI
 * (OPENMPT=1): loads the files, compares the pattern data libopenmpt reads,
 * the song length, and the pitch of rendered notes.
 */
import { describe, expect, it } from 'vitest';
import { encodeMod } from '../../src/export/mod';
import { captureStream } from '../../src/export/stream';
import { encodeXm } from '../../src/export/xm';
import { demoSong } from '../../src/tracker/demo';
import { noteFrequency } from '../../src/tracker/notes';
import { EMPTY, Song, createSong } from '../../src/tracker/song';

const RATE = 48000;
// Command indices of openmpt_module_get_pattern_row_channel_command.
const CMD_NOTE = 0;
const CMD_INSTRUMENT = 1;

type Lib = Record<string, any>;
let lib: Lib | null = null;
async function openmpt(): Promise<Lib> {
  lib ??= await (await import('chiptune3/libopenmpt.worklet.js')).default();
  return lib;
}

function load(l: Lib, data: Uint8Array): number {
  const ptr = l._malloc(data.length);
  l.HEAPU8.set(data, ptr);
  const mod = l._openmpt_module_create_from_memory(ptr, data.length, 0, 0, 0);
  l._free(ptr);
  expect(mod).not.toBe(0);
  return mod;
}

function render(l: Lib, mod: number, seconds: number): Float32Array {
  l._openmpt_module_set_repeat_count(mod, 0);
  const chunk = 1024;
  const left = l._malloc(4 * chunk);
  const right = l._malloc(4 * chunk);
  const out = new Float32Array(Math.round(seconds * RATE));
  let pos = 0;
  while (pos < out.length) {
    const n = l._openmpt_module_read_float_stereo(mod, RATE, Math.min(chunk, out.length - pos), left, right);
    if (!n) break;
    for (let i = 0; i < n; i++) out[pos + i] = l.HEAPF32[left / 4 + i] + l.HEAPF32[right / 4 + i];
    pos += n;
  }
  l._free(left);
  l._free(right);
  return out.subarray(0, pos);
}

/** Fundamental from rising zero crossings (after the attack). */
function pitch(samples: Float32Array): number {
  const from = Math.round(0.05 * RATE);
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < samples.length; i++)
    if (samples[i - 1] < 0 && samples[i] >= 0) {
      if (first < 0) first = i;
      else count++;
      last = i;
    }
  return (count * RATE) / (last - first);
}

function toneSong(note: number, ch: number): Song {
  const s = createSong();
  s.patterns = [{ rows: s.patterns[0].rows.slice(0, 32) }];
  s.order = [0];
  s.patterns[0].rows[0][ch] = { note, instrument: 0, volume: EMPTY, effect: EMPTY, param: 0 };
  Object.assign(s.pulseInstruments[0], { duty: 2, volume: 15, envPeriod: 0, length: 0 });
  s.waveInstruments[0].volume = 1;
  return s;
}

describe.runIf(!!process.env.OPENMPT)('libopenmpt cross-check', () => {
  const formats = [
    ['XM', encodeXm, 0.004],
    ['MOD', encodeMod, 0.008],
  ] as const;

  for (const [name, encode, tolerance] of formats) {
    it(`${name}: loads the demo song with the same patterns and length`, async () => {
      const l = await openmpt();
      const song = demoSong();
      const mod = load(l, encode(song).data);
      expect(l._openmpt_module_get_num_channels(mod)).toBe(4);
      // Note column as libopenmpt reads it: same notes up to a fixed offset.
      let offset: number | null = null;
      let pattern = l._openmpt_module_get_order_pattern(mod, 0);
      if (name === 'XM') {
        expect(l._openmpt_module_get_num_orders(mod)).toBe(song.order.length);
        pattern = song.order[0];
      }
      const rows = song.patterns[song.order[0]].rows;
      for (let r = 0; r < Math.min(64, rows.length); r++)
        for (let ch = 0; ch < 4; ch++) {
          const cell = rows[r][ch];
          const note = l._openmpt_module_get_pattern_row_channel_command(mod, pattern, r, ch, CMD_NOTE);
          if (cell.note >= 0) {
            offset ??= note - cell.note;
            expect(note - cell.note).toBe(offset);
            expect(l._openmpt_module_get_pattern_row_channel_command(mod, pattern, r, ch, CMD_INSTRUMENT)).toBeGreaterThan(0);
          }
        }
      expect(offset).not.toBeNull();
      // One tick per frame: the song lasts as long as on the Game Boy.
      const seconds = captureStream(song).frames.length / (4194304 / 70224);
      expect(l._openmpt_module_get_duration_seconds(mod)).toBeCloseTo(seconds, 0);
      const audio = render(l, mod, 2);
      expect(Math.max(...audio.subarray(0, RATE).map(Math.abs))).toBeGreaterThan(0.05);
      l._openmpt_module_destroy(mod);
    });

    it(`${name}: pulse and wave notes play at the Game Boy pitch`, async () => {
      const l = await openmpt();
      for (const [ch, notes] of [
        [0, [12, 36, 60]],
        [2, [12, 36, 48]],
      ] as const)
        for (const note of notes) {
          const mod = load(l, encode(toneSong(note, ch)).data);
          const f = pitch(render(l, mod, 0.5));
          l._openmpt_module_destroy(mod);
          expect(Math.abs(f / noteFrequency(note) - 1), `${name} ch${ch + 1} note ${note}: ${f} Hz`).toBeLessThan(tolerance);
        }
    });
  }
});
