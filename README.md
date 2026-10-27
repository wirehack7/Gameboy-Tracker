# GB Tracker

Ein Tracker für Game-Boy-Musik, der im Browser läuft – am Desktop mit Tastatur und am Handy per Touch.
Der Klang kommt aus einer zyklusgenauen Emulation der Game-Boy-APU (DMG und Game Boy Color), nicht aus
nachgebauten Oszillatoren. Was der Tracker spielt, sind dieselben Registerzugriffe, die ein Sound-Treiber
auf echter Hardware machen würde.

**Live:** https://wirehack7.github.io/Gameboy-Tracker/

Was als Nächstes kommt, steht in der [Roadmap](ROADMAP.md).

## Funktionen

- 4 Kanäle wie auf der Hardware: 2 × Pulse (Kanal 1 mit Sweep), Wave, Noise
- Pattern-Editor mit Order-Liste, 15 Instrumenten je Kanaltyp und 16 zeichenbaren Wellenformen
- Effekte: Arpeggio, Slides, Portamento, Vibrato, Volume-Slide, Delay, Cut, Panning, Master-Volume, Speed, Sprung/Break
- DMG- oder GBC-Modus pro Song
- Oszilloskope je Kanal, Mute per Klick
- Speichern als JSON, automatische Sicherung im Browser, WAV-Export
- Game-Boy-Optik mit hellem und dunklem Modus

## Entwicklung

```sh
npm install
npm run dev     # Entwicklungsserver
npm test        # Hardware- und Player-Tests
npm run build   # Produktions-Build nach dist/
```

Jeder Push auf `main` wird getestet, gebaut und über GitHub Actions auf GitHub Pages veröffentlicht.

## Hardware-Abdeckung

Die APU-Tests in `tests/apu/` prüfen das dokumentierte Verhalten der Original-Hardware
(Pan Docs, gbdev-Wiki „Gameboy sound hardware“) und sind nach Blargg's `dmg_sound`-Test-ROMs gegliedert:

| Blargg-Test | Abgedeckt in |
| --- | --- |
| 01-registers | `registers.test.ts` (Lesemasken, Schreiben bei ausgeschalteter APU, Wave-RAM) |
| 02-len ctr | `length.test.ts` |
| 03-trigger | `length.test.ts` (Extra-Length-Clock, Trigger lädt 63/255) |
| 04-sweep | `sweep.test.ts` |
| 05-sweep details | `sweep.test.ts` (Negate-Quirk) |
| 06-overflow on trigger | `sweep.test.ts` |
| 07-len sweep period sync | `length.test.ts` (Frame Sequencer: Length 0/2/4/6, Sweep 2/6, Envelope 7) |
| 08-len ctr during power | `length.test.ts` (DMG behält Länge, CGB löscht sie) |
| 09-wave read while on | `channels.test.ts` |
| 10-wave trigger while on | `channels.test.ts` (DMG-Wave-RAM-Korruption) |
| 11-regs after power | `registers.test.ts` |
| 12-wave write while on | `channels.test.ts` |

Dazu kommen Duty-Muster, Envelope inklusive „Zombie Mode“, DACs, Noise-LFSR (15/7 Bit, Periodenlänge),
Mixer (NR50/NR51), High-Pass-Filter, PCM12/PCM34 (nur CGB) und End-to-End-Tests, die die Tonhöhe des
emulierten Ausgangs messen.

Grenzen der Emulation: Sie arbeitet auf Taktebene der CPU (4,19 MHz). Effekte unterhalb eines Takts, etwa
die exakte Position im 2-MHz-Raster des Wave-Kanals oder die revisionsabhängigen Unterschiede des Zombie
Mode zwischen einzelnen DMG-Chips, sind angenähert.
