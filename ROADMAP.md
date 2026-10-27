# Roadmap

Web-based Game Boy tracker for desktop and mobile browsers. Each phase lands as its own pull request and is
published to GitHub Pages automatically after merging. Finished items are ticked here.

## Phase 1 – Foundation
- [x] Project setup (Vite + TypeScript, Vitest), CI for tests and build
- [x] DMG APU emulation, cycle-accurate and register based
  - [x] Pulse 1 with sweep (incl. negate quirk, overflow on trigger)
  - [x] Pulse 2
  - [x] Wave channel (wave RAM, volume shift, access while playing)
  - [x] Noise channel (15/7-bit LFSR, divisor/shift)
  - [x] Frame sequencer, length counters, envelopes, DACs, NR50/NR51/NR52, power behaviour
  - [x] Register read masks, high-pass filter as on the hardware
- [x] Hardware tests modelled on Blargg's `dmg_sound` (01–12) and Pan Docs
- [x] Song model (patterns, order list, instruments, waveforms) and player with effects
- [x] Pattern editor in Game Boy style (off-white, red buttons) with dark mode
- [x] Keyboard and touch input (on-screen keypad for phones)
- [x] Playback via AudioWorklet, oscilloscope per channel
- [x] Save/load (browser storage and JSON file)
- [x] WAV export
- [x] Deployment to GitHub Pages

## Phase 2 – Game Boy Color
- [x] CGB mode of the APU (differences in length counters/power, wave RAM, PCM12/PCM34, filter)
- [ ] Tests for the CGB differences modelled on Blargg's `cgb_sound` (basics already in phase 1)
- [x] DMG/CGB switch per song

## Phase 3 – Developer exports
- [x] C arrays for GBDK (register stream + small player in C)
- [x] Example GBDK-2020 project that plays the export (compiled with GBDK in CI)
- [x] VGM export (Game Boy chip), useful for other tools

## Phase 4 – Game Boy formats
- [x] GBS export (Game Boy Sound System)
- [x] Playable ROM (.gb/.gbc) with built-in player and display

## Phase 5 – Tracker formats
- [ ] XM export (samples from the channels, patterns and effects translated)
- [ ] MOD export (ProTracker, 4 channels)
- [ ] XM/MOD import where it maps sensibly

## Phase 6 – Audio and video
- [ ] More audio formats (e.g. OGG/MP3 via the browser, stems per channel)
- [ ] Video export with oscilloscopes and scrolling patterns (WebM via MediaRecorder/WebCodecs)

## Phase 7 – Comfort
- [ ] Undo/redo, copy/paste of blocks, transpose
- [ ] Instrument macros (per-tick tables for duty/volume/pitch)
- [ ] PWA: works offline, installable on phones
- [x] MIDI input
- [x] On-screen piano (mouse and touch)
