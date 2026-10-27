import { NR10, NR30, NR50, NR51, NR52, WAVE_RAM } from '../apu/apu';
import { Macros, macroValue } from './macro';
import { NOISE_NR43, NOTE_COUNT, PULSE_PERIODS, WAVE_PERIODS } from './notes';
import { SAMPLE_START, SAMPLE_STOP } from './sample';
import { CHANNEL_KINDS, CHANNEL_COUNT, Cell, EMPTY, NOTE_OFF, Song, packWave } from './song';

/** Anything that accepts APU register writes (the emulator, a logger, ...). */
export interface RegisterWriter {
  write(addr: number, value: number): void;
}

/** Effect numbers (first hex digit of the effect column). */
export const FX = {
  ARPEGGIO: 0x0,
  SLIDE_UP: 0x1,
  SLIDE_DOWN: 0x2,
  PORTAMENTO: 0x3,
  VIBRATO: 0x4,
  MASTER_VOLUME: 0x5,
  NOTE_DELAY: 0x7,
  PANNING: 0x8,
  DUTY_WAVE: 0x9,
  VOLUME_SLIDE: 0xa,
  POSITION_JUMP: 0xb,
  SET_VOLUME: 0xc,
  PATTERN_BREAK: 0xd,
  NOTE_CUT: 0xe,
  SET_SPEED: 0xf,
} as const;

const NRX1 = [0x11, 0x16, 0x1b, 0x20];

interface ChannelState {
  note: number;
  /** Current period register value (NR43 value for noise). */
  period: number;
  instrument: number;
  volume: number;
  envUp: boolean;
  envPeriod: number;
  duty: number;
  wave: number;
  active: boolean;
  trigger: boolean;
  /** The pending trigger starts a new note (not just a volume change). */
  newNote: boolean;
  lastPeriod: number;
  effect: number;
  param: number;
  arpeggio: number;
  portaTarget: number;
  portaSpeed: number;
  vibSpeed: number;
  vibDepth: number;
  vibPhase: number;
  cutTick: number;
  delayed: Cell | null;
  delayTick: number;
  /** Noise: 7-bit LFSR. */
  narrow: boolean;
  /** Ticks since the note started: the position in the instrument's macros. */
  macroTick: number;
  /** Volume the volume macro asks for this tick (-1: no volume macro). */
  macroVolume: number;
}

function initialChannel(): ChannelState {
  return {
    note: EMPTY,
    period: 0,
    instrument: 0,
    volume: 15,
    envUp: false,
    envPeriod: 0,
    duty: 2,
    wave: 0,
    active: false,
    trigger: false,
    newNote: false,
    lastPeriod: -1,
    effect: EMPTY,
    param: 0,
    arpeggio: 0,
    portaTarget: -1,
    portaSpeed: 0,
    vibSpeed: 0,
    vibDepth: 0,
    vibPhase: 0,
    cutTick: -1,
    delayed: null,
    delayTick: -1,
    narrow: false,
    macroTick: 0,
    macroVolume: -1,
  };
}

/** Wave channel volume (0..15) to NR32 volume code. */
export function waveVolumeCode(volume: number): number {
  if (volume <= 0) return 0;
  if (volume <= 3) return 3;
  if (volume <= 7) return 2;
  return 1;
}

const WAVE_CODE_VOLUME = [0, 15, 7, 3];

export function periodForNote(channel: number, note: number): number {
  const n = Math.max(0, Math.min(NOTE_COUNT - 1, note));
  const kind = CHANNEL_KINDS[channel];
  return kind === 'pulse' ? PULSE_PERIODS[n] : kind === 'wave' ? WAVE_PERIODS[n] : NOISE_NR43[n];
}

/**
 * Tick based song player. Every call to `tick()` corresponds to one VBlank
 * and produces the register writes a Game Boy sound driver would make.
 */
export class Player {
  order = 0;
  row = 0;
  tickInRow = 0;
  speed: number;
  playing = false;
  /** How often the song has looped (a row was reached a second time). */
  loops = 0;
  onRow?: (order: number, row: number) => void;

  private channels: ChannelState[] = [];
  private loadedWave = -1;
  /** A sample is playing on the wave channel (the driver streams it). */
  private sampleOn = false;
  private visited = new Set<number>();
  private jumpOrder = -1;
  private breakRow = -1;
  /** Rows of a single pattern to loop (pattern play mode). */
  loopPattern = false;
  /**
   * Skip reloading wave RAM when the same wave plays again. Exports turn
   * this off so every note is self-contained and the stream can loop anywhere.
   */
  cacheWave = true;

  constructor(public song: Song) {
    this.speed = song.speed;
    this.reset();
  }

  private reset() {
    this.channels = Array.from({ length: CHANNEL_COUNT }, initialChannel);
    this.loadedWave = -1;
    this.sampleOn = false;
    this.visited.clear();
    this.loops = 0;
    this.jumpOrder = -1;
    this.breakRow = -1;
    this.speed = this.song.speed;
  }

  /** Power up the APU with sane mixer defaults. */
  static init(out: RegisterWriter) {
    out.write(NR52, 0x80);
    out.write(NR50, 0x77);
    out.write(NR51, 0xff);
  }

  start(out: RegisterWriter, order = 0, row = 0) {
    this.reset();
    this.order = Math.max(0, Math.min(this.song.order.length - 1, order));
    this.row = row;
    this.tickInRow = 0;
    this.playing = true;
    Player.init(out);
  }

  stop(out: RegisterWriter) {
    this.playing = false;
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) this.silence(out, ch);
  }

  get pattern() {
    return this.song.patterns[this.song.order[this.order]] ?? this.song.patterns[0];
  }

  tick(out: RegisterWriter) {
    if (!this.playing) {
      // Keep previewed notes' per-tick effects (e.g. note cut) alive.
      for (let ch = 0; ch < CHANNEL_COUNT; ch++) this.update(out, ch, 1);
      return;
    }
    if (this.tickInRow === 0) this.startRow(out);
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const st = this.channels[ch];
      if (st.delayed && this.tickInRow === st.delayTick) {
        this.applyCell(out, ch, st.delayed);
        st.delayed = null;
      }
      this.update(out, ch, this.tickInRow);
    }
    if (++this.tickInRow >= this.speed) {
      this.tickInRow = 0;
      this.advance();
    }
  }

  private startRow(out: RegisterWriter) {
    const key = (this.order << 8) | this.row;
    if (this.visited.has(key)) {
      this.loops++;
      this.visited.clear();
    }
    this.visited.add(key);
    this.onRow?.(this.order, this.row);
    const cells = this.pattern.rows[this.row];
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const cell = cells[ch];
      const st = this.channels[ch];
      st.delayed = null;
      if (cell.effect === FX.NOTE_DELAY && cell.param > 0) {
        st.delayed = cell;
        st.delayTick = cell.param;
        continue;
      }
      this.applyCell(out, ch, cell);
    }
  }

  private advance() {
    const rows = this.pattern.rows.length;
    if (this.jumpOrder >= 0 || this.breakRow >= 0) {
      if (!this.loopPattern) {
        this.order = this.jumpOrder >= 0 ? this.jumpOrder : this.order + 1;
        if (this.order >= this.song.order.length) this.order = 0;
      }
      this.row = Math.max(0, this.breakRow);
      if (this.row >= this.pattern.rows.length) this.row = 0;
      this.jumpOrder = this.breakRow = -1;
      return;
    }
    if (++this.row >= rows) {
      this.row = 0;
      if (!this.loopPattern && ++this.order >= this.song.order.length) this.order = 0;
    }
  }

  /** Apply a row's cell to a channel (note, instrument, volume, effect). */
  private applyCell(out: RegisterWriter, ch: number, cell: Cell) {
    const st = this.channels[ch];
    const kind = CHANNEL_KINDS[ch];
    st.effect = cell.effect;
    st.param = cell.param;
    st.cutTick = -1;

    if (cell.instrument !== EMPTY) this.loadInstrument(ch, cell.instrument);

    if (cell.note === NOTE_OFF) {
      this.silence(out, ch);
    } else if (cell.note !== EMPTY) {
      const period = periodForNote(ch, cell.note);
      if (cell.effect === FX.PORTAMENTO && st.active && kind !== 'noise') {
        st.portaTarget = period;
      } else {
        if (cell.instrument === EMPTY) this.loadInstrument(ch, st.instrument);
        st.note = cell.note;
        st.period = period;
        st.trigger = true;
        st.newNote = true;
        st.vibPhase = 0;
        st.portaTarget = -1;
        st.macroTick = 0;
      }
    }

    if (cell.volume !== EMPTY) {
      st.volume = cell.volume;
      if (cell.note === EMPTY && st.active) st.trigger = true;
    }

    const p = cell.param;
    switch (cell.effect) {
      case FX.ARPEGGIO:
        st.arpeggio = p;
        break;
      case FX.PORTAMENTO:
        if (p) st.portaSpeed = p;
        break;
      case FX.VIBRATO:
        if (p >> 4) st.vibSpeed = p >> 4;
        if (p & 15) st.vibDepth = p & 15;
        break;
      case FX.MASTER_VOLUME:
        out.write(NR50, p);
        break;
      case FX.PANNING:
        out.write(NR51, p);
        break;
      case FX.DUTY_WAVE:
        if (kind === 'pulse') {
          st.duty = p & 3;
          if (st.active) out.write(NRX1[ch], (st.duty << 6) | this.lengthBits(ch));
        } else if (kind === 'wave' && this.sampleIndex(st.instrument) < 0) {
          st.wave = p & 15;
          if (st.active) {
            st.trigger = true;
            st.newNote = true;
          }
        }
        break;
      case FX.POSITION_JUMP:
        if (this.playing) this.jumpOrder = p;
        break;
      case FX.SET_VOLUME:
        st.volume = p >> 4;
        st.envUp = (p & 8) !== 0;
        st.envPeriod = p & 7;
        if (st.active || st.trigger) st.trigger = true;
        break;
      case FX.PATTERN_BREAK:
        if (this.playing) this.breakRow = p;
        break;
      case FX.NOTE_CUT:
        st.cutTick = p;
        break;
      case FX.SET_SPEED:
        if (p > 0) this.speed = p;
        break;
    }
    if (cell.effect !== FX.ARPEGGIO) st.arpeggio = 0;
  }

  private loadInstrument(ch: number, index: number) {
    const st = this.channels[ch];
    st.instrument = index;
    const kind = CHANNEL_KINDS[ch];
    if (kind === 'pulse') {
      const ins = this.song.pulseInstruments[index];
      st.volume = ins.volume;
      st.envUp = ins.envUp;
      st.envPeriod = ins.envPeriod;
      st.duty = ins.duty;
    } else if (kind === 'wave') {
      const ins = this.song.waveInstruments[index];
      st.volume = WAVE_CODE_VOLUME[ins.volume & 3];
      st.wave = ins.wave;
    } else {
      const ins = this.song.noiseInstruments[index];
      st.volume = ins.volume;
      st.envUp = ins.envUp;
      st.envPeriod = ins.envPeriod;
      st.narrow = ins.narrow;
    }
  }

  private instrumentMacros(ch: number): Macros {
    const index = this.channels[ch].instrument;
    const kind = CHANNEL_KINDS[ch];
    const ins =
      kind === 'pulse'
        ? this.song.pulseInstruments[index]
        : kind === 'wave'
          ? this.song.waveInstruments[index]
          : this.song.noiseInstruments[index];
    return ins.macros;
  }

  /**
   * Steps the instrument's macros for this tick: returns the period with the
   * arpeggio and pitch macros applied, and changes duty, waveform, LFSR width
   * and volume the way a driver does: duty by rewriting NRx1, the LFSR width
   * with the next NR43 write, the wave channel's volume through NR32 (both
   * take effect without a trigger), and the waveform and the pulse and noise
   * volume by retriggering, as wave RAM may not be written while the channel
   * plays and NRx2 only takes effect on a trigger.
   */
  private applyMacros(out: RegisterWriter, ch: number, period: number, noteOffset: number): number {
    const st = this.channels[ch];
    const kind = CHANNEL_KINDS[ch];
    const m = this.instrumentMacros(ch);
    const tick = st.macroTick;
    const live = st.active && !st.trigger;

    const arp = macroValue(m.arp, tick);
    if (arp && st.note >= 0) {
      const note = st.note + noteOffset;
      period =
        kind === 'noise'
          ? periodForNote(ch, note + arp)
          : period + periodForNote(ch, note + arp) - periodForNote(ch, note);
    }
    const pitch = kind === 'noise' ? null : macroValue(m.pitch, tick);
    if (pitch) period += pitch;
    if (kind !== 'noise') period = Math.max(0, Math.min(2047, period));

    const duty = macroValue(m.duty, tick);
    if (duty !== null) {
      if (kind === 'pulse' && duty !== st.duty) {
        st.duty = duty;
        if (live) out.write(NRX1[ch], (st.duty << 6) | this.lengthBits(ch));
      } else if (kind === 'wave' && duty !== st.wave && this.sampleIndex(st.instrument) < 0) {
        st.wave = duty;
        if (live) st.trigger = true;
      } else if (kind === 'noise' && (duty === 1) !== st.narrow) {
        st.narrow = duty === 1;
        st.lastPeriod = -1;
      }
    }

    const volume = macroValue(m.volume, tick);
    const before = st.macroVolume;
    st.macroVolume = volume === null ? -1 : Math.round((volume * st.volume) / 15);
    if (volume !== null && st.macroVolume !== before && live && !st.trigger) {
      if (kind === 'wave') out.write(0x1c, waveVolumeCode(st.macroVolume) << 5);
      else st.trigger = true;
    }
    return period;
  }

  private instrumentLength(ch: number): number {
    const st = this.channels[ch];
    const kind = CHANNEL_KINDS[ch];
    if (kind === 'pulse') return this.song.pulseInstruments[st.instrument].length;
    if (kind === 'wave') return this.song.waveInstruments[st.instrument].length;
    return this.song.noiseInstruments[st.instrument].length;
  }

  private lengthBits(ch: number): number {
    const len = this.instrumentLength(ch);
    return len ? (ch === 2 ? 256 : 64) - len : 0;
  }

  /** The sample a wave instrument plays, or -1 for its waveform. */
  private sampleIndex(instrument: number): number {
    const i = this.song.waveInstruments[instrument]?.sample ?? -1;
    return i >= 0 && i < this.song.samples.length ? i : -1;
  }

  private stopSample(out: RegisterWriter) {
    if (!this.sampleOn) return;
    out.write(SAMPLE_STOP, 0);
    this.sampleOn = false;
  }

  private silence(out: RegisterWriter, ch: number) {
    const st = this.channels[ch];
    if (ch === 2) {
      this.stopSample(out);
      out.write(NR30, 0);
    }
    else out.write(NRX1[ch] + 1, 0); // NRx2 = 0 turns the DAC off
    st.active = false;
    st.trigger = false;
    st.note = EMPTY;
    st.lastPeriod = -1;
  }

  /** Per-tick processing: effects, then register writes. */
  private update(out: RegisterWriter, ch: number, tick: number) {
    const st = this.channels[ch];
    const kind = CHANNEL_KINDS[ch];

    if (st.cutTick >= 0 && tick === st.cutTick) {
      this.silence(out, ch);
      st.cutTick = -1;
      return;
    }
    if (!st.active && !st.trigger) return;

    const max = kind === 'noise' ? 0xff : 2047;
    if (tick > 0 && kind !== 'noise') {
      if (st.effect === FX.SLIDE_UP) st.period = Math.min(max, st.period + st.param);
      else if (st.effect === FX.SLIDE_DOWN) st.period = Math.max(0, st.period - st.param);
      else if (st.effect === FX.PORTAMENTO && st.portaTarget >= 0) {
        const d = st.portaTarget - st.period;
        st.period += Math.sign(d) * Math.min(Math.abs(d), st.portaSpeed);
        if (st.period === st.portaTarget) st.portaTarget = -1;
      }
    }
    if (tick > 0 && st.effect === FX.VOLUME_SLIDE && st.active) {
      const v = Math.max(0, Math.min(15, st.volume + (st.param >> 4) - (st.param & 15)));
      if (v !== st.volume) {
        st.volume = v;
        st.trigger = true;
      }
    }

    let period = st.period;
    let offset = 0;
    if (st.arpeggio && st.note >= 0) {
      offset = [0, st.arpeggio >> 4, st.arpeggio & 15][tick % 3];
      if (offset) period = periodForNote(ch, st.note + offset);
    }
    if (st.effect === FX.VIBRATO && st.vibDepth && kind !== 'noise') {
      if (tick > 0) st.vibPhase = (st.vibPhase + st.vibSpeed) & 63;
      period += Math.round(Math.sin((st.vibPhase / 64) * Math.PI * 2) * st.vibDepth);
      period = Math.max(0, Math.min(max, period));
    }
    period = this.applyMacros(out, ch, period, offset);

    if (st.trigger) {
      this.triggerChannel(out, ch, period, st.newNote);
      st.trigger = false;
      st.newNote = false;
      st.active = true;
    } else if (period !== st.lastPeriod && !(kind === 'wave' && this.sampleOn)) {
      this.writePeriod(out, ch, period, false);
    }
    st.macroTick++;
  }

  private writePeriod(out: RegisterWriter, ch: number, period: number, trigger: boolean) {
    const st = this.channels[ch];
    st.lastPeriod = period;
    const lenEnable = this.instrumentLength(ch) ? 0x40 : 0;
    const t = trigger ? 0x80 : 0;
    if (ch === 3) {
      const narrow = st.narrow ? 0x08 : 0;
      out.write(0x22, (period & 0xf7) | narrow);
      if (trigger) out.write(0x23, t | lenEnable);
      return;
    }
    const base = NRX1[ch];
    out.write(base + 2, period & 0xff);
    out.write(base + 3, t | lenEnable | ((period >> 8) & 7));
  }

  private triggerChannel(out: RegisterWriter, ch: number, period: number, newNote = true) {
    const st = this.channels[ch];
    const kind = CHANNEL_KINDS[ch];
    const sample = kind === 'wave' ? this.sampleIndex(st.instrument) : -1;
    // A volume macro replaces the hardware envelope.
    const volume = st.macroVolume >= 0 ? st.macroVolume : st.volume;
    const envelope = st.macroVolume >= 0 ? 0 : (st.envUp ? 8 : 0) | st.envPeriod;
    if (sample >= 0) {
      // Samples play at a fixed rate; the driver's timer streams them, so
      // pitch effects do not apply and a volume change only rewrites NR32.
      if (!newNote && !this.sampleOn) return;
      out.write(0x1c, waveVolumeCode(volume) << 5);
      if (newNote) {
        out.write(SAMPLE_START, sample);
        this.sampleOn = true;
        this.loadedWave = -1; // the sample overwrites wave RAM
      }
      st.lastPeriod = period;
      return;
    }
    if (kind === 'wave') {
      this.stopSample(out);
      // Turning the DAC off first disables the channel, so loading wave RAM
      // and retriggering never hit the DMG wave RAM corruption bug.
      out.write(NR30, 0);
      if (this.loadedWave !== st.wave || !this.cacheWave) {
        const bytes = packWave(this.song.waves[st.wave]);
        bytes.forEach((b, i) => out.write(WAVE_RAM + i, b));
        this.loadedWave = st.wave;
      }
      out.write(NR30, 0x80);
      out.write(0x1b, this.lengthBits(ch));
      out.write(0x1c, waveVolumeCode(volume) << 5);
    } else {
      if (ch === 0) {
        const ins = this.song.pulseInstruments[st.instrument];
        out.write(NR10, (ins.sweepPeriod << 4) | (ins.sweepNegate ? 8 : 0) | ins.sweepShift);
      }
      const duty = kind === 'pulse' ? st.duty << 6 : 0;
      out.write(NRX1[ch], duty | this.lengthBits(ch));
      out.write(NRX1[ch] + 1, (volume << 4) | envelope);
    }
    this.writePeriod(out, ch, period, true);
  }

  /** Play a single note immediately (note entry / jamming). */
  preview(out: RegisterWriter, ch: number, note: number, instrument: number) {
    const st = this.channels[ch];
    if (!this.playing) {
      st.effect = EMPTY;
      st.arpeggio = 0;
      st.cutTick = -1;
    }
    this.loadInstrument(ch, instrument);
    st.note = note;
    st.period = periodForNote(ch, note);
    st.macroTick = 0;
    st.trigger = true;
    const period = this.applyMacros(out, ch, st.period, 0);
    st.trigger = false;
    this.triggerChannel(out, ch, period, true);
    st.macroTick = 1;
    st.active = true;
  }

  /** Stop a previewed note. */
  release(out: RegisterWriter, ch: number) {
    this.silence(out, ch);
  }

  /** Wave RAM was changed behind the player's back: reload it on the next wave note. */
  forgetWave() {
    this.loadedWave = -1;
  }

  /** The song was edited: keep the position but drop cached state. */
  setSong(song: Song) {
    this.song = song;
    this.loadedWave = -1;
    if (this.order >= song.order.length) this.order = 0;
    if (this.row >= this.pattern.rows.length) this.row = 0;
  }
}
