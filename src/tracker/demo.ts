import { NOTE_COUNT, noteName } from './notes';
import { FX } from './player';
import { EMPTY, Song, createSong } from './song';

/** A short demo so the first visit makes a sound. */
export function demoSong(): Song {
  const s = createSong();
  s.title = 'Demo';
  const p = s.patterns[0];
  const n = (name: string) => {
    for (let i = 0; i < NOTE_COUNT; i++) if (noteName(i) === name) return i;
    return EMPTY;
  };
  const bass = ['C-3', 'C-3', 'G-2', 'A#2'];
  const lead = ['E-5', 'G-5', 'C-6', 'G-5', 'D-5', 'F-5', 'B-5', 'F-5'];
  s.pulseInstruments[0] = { ...s.pulseInstruments[0], name: 'Lead', duty: 2, volume: 12, envPeriod: 2 };
  s.pulseInstruments[1] = { ...s.pulseInstruments[1], name: 'Arp', duty: 1, volume: 9, envPeriod: 0 };
  s.waveInstruments[0] = { ...s.waveInstruments[0], name: 'Bass', wave: 0 };
  s.noiseInstruments[0] = { ...s.noiseInstruments[0], name: 'Kick', volume: 15, envPeriod: 1, narrow: false };
  s.noiseInstruments[1] = { ...s.noiseInstruments[1], name: 'Hat', volume: 8, envPeriod: 1, narrow: true };
  for (let r = 0; r < 64; r++) {
    if (r % 4 === 0) Object.assign(p.rows[r][0], { note: n(lead[(r / 4) % 8]), instrument: 0 });
    if (r % 16 === 0)
      Object.assign(p.rows[r][1], { note: n('C-4'), instrument: 1, effect: FX.ARPEGGIO, param: r % 32 ? 0x58 : 0x47 });
    if (r % 8 === 0) Object.assign(p.rows[r][2], { note: n(bass[(r / 16) | 0]), instrument: 0 });
    if (r % 8 === 4) Object.assign(p.rows[r][2], { note: n(bass[(r / 16) | 0]) + 12, instrument: 0 });
    if (r % 8 === 0) Object.assign(p.rows[r][3], { note: n('C-3'), instrument: 0 });
    else if (r % 4 === 2) Object.assign(p.rows[r][3], { note: n('C-8'), instrument: 1 });
  }
  return s;
}
