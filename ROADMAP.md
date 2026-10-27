# Roadmap

Web-basierter Game-Boy-Tracker für Desktop- und Mobil-Browser. Jede Phase landet als eigener Pull Request
und wird nach dem Merge automatisch auf GitHub Pages veröffentlicht. Erledigte Punkte werden hier abgehakt.

## Phase 1 – Fundament
- [ ] Projektgerüst (Vite + TypeScript, Vitest), CI für Tests und Build
- [ ] DMG-APU-Emulation, zyklusgenau und registerbasiert
  - [ ] Pulse 1 mit Sweep (inkl. Negate-Quirk, Overflow beim Trigger)
  - [ ] Pulse 2
  - [ ] Wave-Kanal (Wave-RAM, Lautstärke-Shift, Zugriff während der Wiedergabe)
  - [ ] Noise-Kanal (15/7-Bit-LFSR, Teiler/Shift)
  - [ ] Frame Sequencer, Length Counter, Envelope, DACs, NR50/NR51/NR52, Power-Verhalten
  - [ ] Register-Lesemasken, High-Pass-Filter wie auf der Hardware
- [ ] Hardware-Tests nach dem Vorbild von Blargg `dmg_sound` (01–12) und Pan Docs
- [ ] Song-Modell (Patterns, Order-Liste, Instrumente, Wellenformen) und Player mit Effekten
- [ ] Pattern-Editor im Game-Boy-Look (Off-White, rote Knöpfe) mit Dark Mode
- [ ] Bedienung per Tastatur und Touch (Bildschirm-Keypad fürs Handy)
- [ ] Wiedergabe per AudioWorklet, Oszilloskope je Kanal
- [ ] Speichern/Laden (Browser-Speicher und JSON-Datei)
- [ ] WAV-Export
- [ ] Deployment auf GitHub Pages

## Phase 2 – Game Boy Color
- [ ] CGB-Modus der APU (Unterschiede bei Length Counter/Power, Wave-RAM, PCM12/PCM34, Filter)
- [ ] Tests für die CGB-Unterschiede (Vorbild Blargg `cgb_sound`)
- [ ] Umschaltung DMG/CGB pro Song

## Phase 3 – Export für Entwickler
- [ ] C-Arrays für GBDK (Register-Stream + kleiner Player in C)
- [ ] Beispielprojekt für GBDK-2020, das den Export abspielt
- [ ] VGM-Export (Game-Boy-Chip), nützlich für andere Tools

## Phase 4 – Game-Boy-Formate
- [ ] GBS-Export (Game Boy Sound System)
- [ ] Spielbares ROM (.gb/.gbc) mit eingebautem Player und Anzeige

## Phase 5 – Tracker-Formate
- [ ] XM-Export (Samples aus den Kanälen, Patterns und Effekte übersetzt)
- [ ] MOD-Export (ProTracker, 4 Kanäle)
- [ ] Import von XM/MOD, soweit sinnvoll abbildbar

## Phase 6 – Audio und Video
- [ ] Weitere Audio-Formate (z. B. OGG/MP3 über den Browser, Einzelspuren pro Kanal)
- [ ] Video-Export mit Oszilloskopen und laufenden Patterns (WebM über MediaRecorder/WebCodecs)

## Phase 7 – Komfort
- [ ] Undo/Redo, Copy/Paste von Blöcken, Transponieren
- [ ] Instrument-Makros (Tabellen für Duty/Volume/Pitch pro Tick)
- [ ] PWA: offline nutzbar, auf dem Handy installierbar
- [ ] MIDI-Eingabe
