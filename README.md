# GB Tracker

A tracker for Game Boy music that runs in the browser — on desktop with a keyboard and on phones with touch.
Sound comes from a cycle-accurate emulation of the Game Boy APU (DMG and Game Boy Color), not from imitation
oscillators. What the tracker plays are the same register writes a sound driver makes on real hardware.

**Live:** https://wirehack7.github.io/Gameboy-Tracker/

What comes next is in the [roadmap](ROADMAP.md).

## Features

- 4 channels as on the hardware: 2 × pulse (channel 1 with sweep), wave, noise
- Pattern editor with order list, 15 instruments per channel type and 16 drawable waveforms
- Effects: arpeggio, slides, portamento, vibrato, volume slide, delay, cut, panning, master volume, speed, jump/break
- DMG or GBC mode per song
- Oscilloscope per channel, click to mute
- Save as JSON, automatic backup in the browser, WAV export
- Game Boy look with light and dark mode

## Development

```sh
npm install
npm run dev     # development server
npm test        # hardware and player tests
npm run build   # production build into dist/
```

Every push to `main` is tested, built and published to GitHub Pages by GitHub Actions.

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
