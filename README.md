# GB Tracker

A tracker for Game Boy music that runs in the browser — on desktop with a keyboard and on phones with touch.
Sound comes from a cycle-accurate emulation of the Game Boy APU (DMG and Game Boy Color), not from imitation
oscillators. What the tracker plays are the same register writes a sound driver makes on real hardware.

**Live:** https://wirehack7.github.io/Gameboy-Tracker/

**Manual:** [docs/MANUAL.md](docs/MANUAL.md), also on the site: https://wirehack7.github.io/Gameboy-Tracker/manual.html

What comes next is in the [roadmap](ROADMAP.md).

## Features

- 4 channels as on the hardware: 2 × pulse (channel 1 with sweep), wave, noise
- Pattern editor with order list, 15 instruments per channel type and 16 drawable waveforms
- Effects: arpeggio, slides, portamento, vibrato, volume slide, delay, cut, panning, master volume, speed, jump/break
- DMG or GBC mode per song
- Oscilloscope per channel, click to mute
- Save as JSON, automatic backup in the browser
- Exports: playable Game Boy ROM (.gb/.gbc), GBS, VGM, WAV, and a GBDK-2020 project (C array + tiny driver + Makefile)
- Full-window tracker layout in Game Boy colours (off-white, A/B-button red) with colour-coded pattern columns, light and dark mode
- Responsive: desktop with side lists, tablet two-column, phone with views and an on-screen keypad
- On-screen piano (mouse, touch, glissando) and Web MIDI input from any connected keyboard
- Master volume for playback
- Interface in English, German, Spanish and French (picked from the browser language, switchable in the toolbar)

## Exports

All hardware exports share one base: the song captured as the exact APU register writes the player makes per
frame (`src/export/stream.ts`). Playing that stream back reproduces the tracker output sample for sample, which
the tests check.

- **GBDK project (.zip):** `gbtr_player.c/.h` (a ~40 line driver), the song as `const uint8_t` array, an example
  `main.c` and a `Makefile`. Call `gbtr_play(song_data, song_loop)` once and `gbtr_update()` every frame. The
  C code is plain C99 with direct register writes, so it also works with other SDCC-based setups.
- **Game Boy ROM (.gb / .gbc):** a cartridge image that plays the song in a loop and shows title, author, model
  and a play timer. It boots on real hardware, flash carts and emulators. Songs longer than one 16 KiB bank use
  MBC5 banking. CGB songs get the CGB flag and a white/red palette.
- **GBS:** Game Boy Sound System v1 for music players (VBlank rate). Same driver as the ROM.
- **VGM:** VGM 1.71 with the Game Boy DMG chip, including loop point and GD3 tags.
- **WAV:** 16-bit stereo, rendered by the emulator.

Stream format used by the C driver:

| Byte | Meaning |
| --- | --- |
| `0x00`–`0x2F`, `vv` | write `vv` to register `0xFF10 + byte` |
| `0x81`–`0xFE` | wait `byte & 0x7F` frames |
| `0xFF` | continue at the loop offset |

The ROM and GBS contain a hand-assembled SM83 version of the same driver at `0x0400`; the stream starts at
`0x4000` (bank 1) and the driver switches banks by writing to `0x2000`. The tests run both images on a small
SM83 interpreter (`tests/export/sm83.ts`) and compare every register write with the reference driver, across bank
boundaries and the loop point.

## Development

```sh
npm install
npm run dev     # development server
npm test        # hardware and player tests
npm run build   # production build into dist/
```

Every push to `main` is tested, built and published to GitHub Pages by GitHub Actions.

### Translations

UI strings live in `src/i18n/locales/`. English (`en.ts`) is the base locale and defines every key;
other locales may lag behind and fall back to English. To add a string, add a key to `en.ts` and use
`t('key')` in code (or `data-i18n`, `data-i18n-title`, `data-i18n-aria-label` in static markup).
To add a language, create `locales/<code>.ts` and register it in `LOCALES` in `src/i18n/index.ts`.

### Manual

The manual is written in `docs/MANUAL.md`; the build renders it into `manual.html` on the site
(`src/manual/`). `tests/docs/manual.test.ts` fails when an effect, export button or tab is missing from the
manual, so update it in the same PR as the feature.

## Hardware coverage

The APU tests in `tests/apu/` check the documented behaviour of the original hardware (Pan Docs, gbdev wiki
"Gameboy sound hardware") and are organised after Blargg's `dmg_sound` test ROMs:

| Blargg test | Covered in |
| --- | --- |
| 01-registers | `registers.test.ts` (read masks, writes while powered off, wave RAM) |
| 02-len ctr | `length.test.ts` |
| 03-trigger | `length.test.ts` (extra length clock, trigger loads 63/255) |
| 04-sweep | `sweep.test.ts` |
| 05-sweep details | `sweep.test.ts` (negate quirk) |
| 06-overflow on trigger | `sweep.test.ts` |
| 07-len sweep period sync | `length.test.ts` (frame sequencer: length 0/2/4/6, sweep 2/6, envelope 7) |
| 08-len ctr during power | `length.test.ts` (DMG keeps lengths, CGB clears them) |
| 09-wave read while on | `channels.test.ts` |
| 10-wave trigger while on | `channels.test.ts` (DMG wave RAM corruption) |
| 11-regs after power | `registers.test.ts` |
| 12-wave write while on | `channels.test.ts` |

On top of that: duty patterns, envelope including "zombie mode", DACs, noise LFSR (15/7 bit, period length),
mixer (NR50/NR51), high-pass filter, PCM12/PCM34 (CGB only) and end-to-end tests that measure the pitch of the
emulated output.

Limits of the emulation: it works at CPU clock resolution (4.19 MHz). Effects below one clock, such as the exact
position in the wave channel's 2 MHz grid, or the revision-specific differences of zombie mode between individual
DMG chips, are approximated.
