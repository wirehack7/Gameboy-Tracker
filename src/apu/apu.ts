/**
 * Cycle-accurate emulation of the Game Boy APU (DMG and CGB).
 *
 * The behaviour follows the documented hardware: Pan Docs, the gbdev wiki
 * "Gameboy sound hardware" page and the results of Blargg's dmg_sound /
 * cgb_sound test ROMs. Time is measured in CPU clocks (4 194 304 Hz).
 *
 * The emulator is event driven: `run(cycles)` jumps from one event (a channel
 * timer expiring, a frame sequencer step, an output sample) to the next while
 * integrating the analog output, so it is exact to the clock without
 * iterating over every single cycle.
 */

export type Model = 'dmg' | 'cgb';

export const CPU_HZ = 4194304;
/** Frame sequencer runs at 512 Hz, driven by DIV. */
export const FRAME_SEQUENCER_PERIOD = 8192;

/** Register addresses (low byte of 0xFFxx). */
export const NR10 = 0x10, NR11 = 0x11, NR12 = 0x12, NR13 = 0x13, NR14 = 0x14;
export const NR21 = 0x16, NR22 = 0x17, NR23 = 0x18, NR24 = 0x19;
export const NR30 = 0x1a, NR31 = 0x1b, NR32 = 0x1c, NR33 = 0x1d, NR34 = 0x1e;
export const NR41 = 0x20, NR42 = 0x21, NR43 = 0x22, NR44 = 0x23;
export const NR50 = 0x24, NR51 = 0x25, NR52 = 0x26;
export const WAVE_RAM = 0x30;
export const PCM12 = 0x76, PCM34 = 0x77;

/** Bits that always read back as 1 (unused or write-only), FF10..FF2F. */
export const READ_MASKS: readonly number[] = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, // NR10-NR14
  0xff, 0x3f, 0x00, 0xff, 0xbf, // FF15, NR21-NR24
  0x7f, 0xff, 0x9f, 0xff, 0xbf, // NR30-NR34
  0xff, 0xff, 0x00, 0x00, 0xbf, // FF1F, NR41-NR44
  0x00, 0x00, 0x70, // NR50-NR52
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // FF27-FF2F
];

export const DUTY_TABLE: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 1], // 12.5 %
  [1, 0, 0, 0, 0, 0, 0, 1], // 25 %
  [1, 0, 0, 0, 0, 1, 1, 1], // 50 %
  [0, 1, 1, 1, 1, 1, 1, 0], // 75 %
];

export const NOISE_DIVISORS: readonly number[] = [8, 16, 32, 48, 64, 80, 96, 112];

/** Wave RAM contents after power-up differ between models. */
export const INITIAL_WAVE_RAM: Record<Model, readonly number[]> = {
  dmg: [0x84, 0x40, 0x43, 0xaa, 0x2d, 0x78, 0x92, 0x3c, 0x60, 0x59, 0x59, 0xb0, 0x34, 0xb8, 0x2e, 0xda],
  cgb: [0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff],
};

/** Per-clock charge factor of the output high-pass capacitor. */
const HPF_CHARGE: Record<Model, number> = { dmg: 0.999958, cgb: 0.998943 };

/** Effectively "never" for a stopped timer. */
const IDLE = 0x7fffffff;

class Envelope {
  initialVolume = 0;
  increase = false;
  period = 0;
  volume = 0;
  timer = 0;
  running = false;

  write(value: number) {
    this.initialVolume = value >> 4;
    this.increase = (value & 0x08) !== 0;
    this.period = value & 0x07;
  }

  trigger() {
    this.timer = this.period || 8;
    this.volume = this.initialVolume;
    this.running = true;
  }

  clock() {
    if (--this.timer > 0) return;
    this.timer = this.period || 8;
    if (this.period === 0 || !this.running) return;
    const next = this.volume + (this.increase ? 1 : -1);
    if (next >= 0 && next <= 15) this.volume = next;
    else this.running = false;
  }

  /** "Zombie mode": writing NRx2 while the channel is on alters the volume. */
  zombie(oldPeriod: number, oldIncrease: boolean) {
    let v = this.volume;
    if (oldPeriod === 0 && this.running) v += 1;
    else if (!oldIncrease) v += 2;
    if (oldIncrease !== this.increase) v = 16 - v;
    this.volume = v & 0x0f;
  }
}

abstract class Channel {
  enabled = false;
  dacOn = false;
  lengthCounter = 0;
  lengthEnabled = false;
  /** Clocks until the frequency timer next expires. */
  timer = IDLE;

  constructor(readonly maxLength: number) {}

  clockLength() {
    if (this.lengthEnabled && this.lengthCounter > 0) {
      if (--this.lengthCounter === 0) this.enabled = false;
    }
  }

  writeLength(value: number) {
    this.lengthCounter = this.maxLength - value;
  }

  /**
   * Shared NRx4 handling: length enable (with the extra length clock quirk)
   * and the length part of a trigger. Returns true if the channel triggers.
   */
  writeControl(value: number, nextStepClocksLength: boolean): boolean {
    const trigger = (value & 0x80) !== 0;
    const wasEnabled = this.lengthEnabled;
    this.lengthEnabled = (value & 0x40) !== 0;
    if (!nextStepClocksLength && !wasEnabled && this.lengthEnabled && this.lengthCounter > 0) {
      if (--this.lengthCounter === 0 && !trigger) this.enabled = false;
    }
    if (trigger && this.lengthCounter === 0) {
      this.lengthCounter = this.lengthEnabled && !nextStepClocksLength ? this.maxLength - 1 : this.maxLength;
    }
    return trigger;
  }

  abstract output(): number;
}

class PulseChannel extends Channel {
  duty = 0;
  dutyPos = 0;
  frequency = 0;
  readonly env = new Envelope();

  // Sweep (channel 1 only)
  sweepPeriod = 0;
  sweepNegate = false;
  sweepShift = 0;
  sweepTimer = 0;
  sweepEnabled = false;
  shadow = 0;
  negateUsed = false;

  constructor(readonly hasSweep: boolean) {
    super(64);
  }

  period() {
    return (2048 - this.frequency) * 4;
  }

  tick() {
    this.dutyPos = (this.dutyPos + 1) & 7;
    this.timer = this.period();
  }

  trigger() {
    this.enabled = true;
    this.timer = this.period();
    this.env.trigger();
    if (this.hasSweep) {
      this.shadow = this.frequency;
      this.sweepTimer = this.sweepPeriod || 8;
      this.sweepEnabled = this.sweepPeriod !== 0 || this.sweepShift !== 0;
      this.negateUsed = false;
      if (this.sweepShift !== 0) this.sweepCalc();
    }
    if (!this.dacOn) this.enabled = false;
  }

  writeSweep(value: number) {
    const oldNegate = this.sweepNegate;
    this.sweepPeriod = (value >> 4) & 7;
    this.sweepNegate = (value & 0x08) !== 0;
    this.sweepShift = value & 7;
    // Leaving negate mode after a negate calculation disables the channel.
    if (oldNegate && !this.sweepNegate && this.negateUsed) this.enabled = false;
  }

  sweepCalc(): number {
    let delta = this.shadow >> this.sweepShift;
    if (this.sweepNegate) {
      delta = -delta;
      this.negateUsed = true;
    }
    const next = this.shadow + delta;
    if (next > 2047) this.enabled = false;
    return next;
  }

  clockSweep() {
    if (--this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepPeriod || 8;
    if (!this.sweepEnabled || this.sweepPeriod === 0) return;
    const next = this.sweepCalc();
    if (next <= 2047 && this.sweepShift !== 0) {
      this.shadow = next;
      this.frequency = next;
      this.sweepCalc();
    }
  }

  output() {
    return this.enabled && DUTY_TABLE[this.duty][this.dutyPos] ? this.env.volume : 0;
  }
}

class WaveChannel extends Channel {
  frequency = 0;
  volumeCode = 0;
  position = 0;
  sampleBuffer = 0;
  /** Absolute clock of the last wave RAM fetch (for DMG access timing). */
  lastRead = -100;

  constructor() {
    super(256);
  }

  period() {
    return (2048 - this.frequency) * 2;
  }

  tick(ram: Uint8Array, now: number) {
    this.position = (this.position + 1) & 31;
    this.sampleBuffer = ram[this.position >> 1];
    this.lastRead = now;
    this.timer = this.period();
  }

  trigger(ram: Uint8Array, model: Model) {
    // DMG: retriggering while the channel is about to fetch a byte corrupts
    // the first bytes of wave RAM.
    if (model === 'dmg' && this.enabled && this.timer <= 2) {
      const offset = ((this.position + 1) & 31) >> 1;
      if (offset < 4) ram[0] = ram[offset];
      else ram.copyWithin(0, offset & ~3, (offset & ~3) + 4);
    }
    this.enabled = true;
    this.position = 0;
    // The first fetch is delayed by 6 clocks after a trigger.
    this.timer = this.period() + 6;
    if (!this.dacOn) this.enabled = false;
  }

  output() {
    if (!this.enabled) return 0;
    const nibble = this.position & 1 ? this.sampleBuffer & 0x0f : this.sampleBuffer >> 4;
    return this.volumeCode === 0 ? 0 : nibble >> (this.volumeCode - 1);
  }
}

class NoiseChannel extends Channel {
  shift = 0;
  narrow = false;
  divisorCode = 0;
  lfsr = 0x7fff;
  readonly env = new Envelope();

  constructor() {
    super(64);
  }

  period() {
    return NOISE_DIVISORS[this.divisorCode] << this.shift;
  }

  tick() {
    this.timer = this.period();
    // Shift clocks 14 and 15 never clock the LFSR.
    if (this.shift >= 14) return;
    const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
    this.lfsr = (this.lfsr >> 1) | (bit << 14);
    if (this.narrow) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
  }

  trigger() {
    this.enabled = true;
    this.timer = this.period();
    this.lfsr = 0x7fff;
    this.env.trigger();
    if (!this.dacOn) this.enabled = false;
  }

  output() {
    return this.enabled && (this.lfsr & 1) === 0 ? this.env.volume : 0;
  }
}

export interface ApuOptions {
  model?: Model;
  sampleRate?: number;
  /** Also record each channel's analog output per sample (for scopes). */
  captureChannels?: boolean;
}

export class Apu {
  readonly model: Model;
  readonly sampleRate: number;
  readonly captureChannels: boolean;

  readonly ch1 = new PulseChannel(true);
  readonly ch2 = new PulseChannel(false);
  readonly ch3 = new WaveChannel();
  readonly ch4 = new NoiseChannel();
  readonly channels: readonly Channel[] = [this.ch1, this.ch2, this.ch3, this.ch4];
  readonly waveRam: Uint8Array;

  private readonly regs = new Uint8Array(0x30);
  powered = false;
  /** The step the frame sequencer executes next (0-7). */
  frameStep = 0;
  /** Clocks until the next frame sequencer step. */
  frameCounter = FRAME_SEQUENCER_PERIOD;
  /** Absolute clock counter. */
  cycles = 0;
  /** Debug/test switch: per-channel mute (does not affect hardware state). */
  readonly muted = [false, false, false, false];

  // Output state
  private sampleCountdown: number;
  private accL = 0;
  private accR = 0;
  private accCycles = 0;
  private readonly accCh = new Float64Array(4);
  private capL = 0;
  private capR = 0;
  private readonly charge: number;
  /** Interleaved stereo output samples not yet consumed. */
  out: Float32Array = new Float32Array(8192);
  /** Per channel analog output, 4 values per sample (if captureChannels). */
  outChannels: Float32Array = new Float32Array(16384);
  outCount = 0;

  constructor(options: ApuOptions = {}) {
    this.model = options.model ?? 'dmg';
    this.sampleRate = options.sampleRate ?? 48000;
    this.captureChannels = options.captureChannels ?? false;
    this.waveRam = Uint8Array.from(INITIAL_WAVE_RAM[this.model]);
    this.sampleCountdown = CPU_HZ;
    this.charge = Math.pow(HPF_CHARGE[this.model], CPU_HZ / this.sampleRate);
  }

  // ---------------------------------------------------------------- registers

  read(addr: number): number {
    addr &= 0xff;
    if (addr === NR52) {
      let v = 0x70 | (this.powered ? 0x80 : 0);
      this.channels.forEach((c, i) => {
        if (c.enabled) v |= 1 << i;
      });
      return v;
    }
    if (addr >= WAVE_RAM && addr < WAVE_RAM + 16) return this.readWave(addr - WAVE_RAM);
    if (addr === PCM12 || addr === PCM34) {
      if (this.model !== 'cgb') return 0xff;
      return addr === PCM12
        ? this.ch1.output() | (this.ch2.output() << 4)
        : this.ch3.output() | (this.ch4.output() << 4);
    }
    if (addr < 0x10 || addr >= 0x30) return 0xff;
    return this.regs[addr] | READ_MASKS[addr - 0x10];
  }

  write(addr: number, value: number) {
    addr &= 0xff;
    value &= 0xff;
    if (addr >= WAVE_RAM && addr < WAVE_RAM + 16) {
      this.writeWave(addr - WAVE_RAM, value);
      return;
    }
    if (addr === NR52) {
      this.writePower((value & 0x80) !== 0);
      return;
    }
    if (addr < 0x10 || addr > NR51) return;
    if (!this.powered) {
      // DMG: length counters stay writable while the APU is off.
      if (this.model === 'dmg') {
        if (addr === NR11) this.ch1.writeLength(value & 0x3f);
        else if (addr === NR21) this.ch2.writeLength(value & 0x3f);
        else if (addr === NR31) this.ch3.writeLength(value);
        else if (addr === NR41) this.ch4.writeLength(value & 0x3f);
      }
      return;
    }
    this.regs[addr] = value;
    const nextClocksLength = (this.frameStep & 1) === 0;

    switch (addr) {
      case NR10:
        this.ch1.writeSweep(value);
        break;
      case NR11:
      case NR21: {
        const c = addr === NR11 ? this.ch1 : this.ch2;
        c.duty = value >> 6;
        c.writeLength(value & 0x3f);
        break;
      }
      case NR12:
      case NR22:
      case NR42: {
        const c = addr === NR12 ? this.ch1 : addr === NR22 ? this.ch2 : this.ch4;
        const oldPeriod = c.env.period;
        const oldIncrease = c.env.increase;
        c.env.write(value);
        if (c.enabled) c.env.zombie(oldPeriod, oldIncrease);
        c.dacOn = (value & 0xf8) !== 0;
        if (!c.dacOn) c.enabled = false;
        break;
      }
      case NR13:
      case NR23:
      case NR33: {
        const c = addr === NR13 ? this.ch1 : addr === NR23 ? this.ch2 : this.ch3;
        c.frequency = (c.frequency & 0x700) | value;
        break;
      }
      case NR14:
      case NR24: {
        const c = addr === NR14 ? this.ch1 : this.ch2;
        c.frequency = (c.frequency & 0xff) | ((value & 7) << 8);
        if (c.writeControl(value, nextClocksLength)) c.trigger();
        break;
      }
      case NR30:
        this.ch3.dacOn = (value & 0x80) !== 0;
        if (!this.ch3.dacOn) this.ch3.enabled = false;
        break;
      case NR31:
        this.ch3.writeLength(value);
        break;
      case NR32:
        this.ch3.volumeCode = (value >> 5) & 3;
        break;
      case NR34:
        this.ch3.frequency = (this.ch3.frequency & 0xff) | ((value & 7) << 8);
        if (this.ch3.writeControl(value, nextClocksLength)) this.ch3.trigger(this.waveRam, this.model);
        break;
      case NR41:
        this.ch4.writeLength(value & 0x3f);
        break;
      case NR43:
        this.ch4.shift = value >> 4;
        this.ch4.narrow = (value & 0x08) !== 0;
        this.ch4.divisorCode = value & 7;
        break;
      case NR44:
        if (this.ch4.writeControl(value, nextClocksLength)) this.ch4.trigger();
        break;
    }
  }

  /** Wave RAM while channel 3 plays: only the byte being played is reachable. */
  private waveAccessIndex(index: number): number {
    if (!this.ch3.enabled) return index;
    if (this.model === 'cgb' || this.cycles - this.ch3.lastRead < 2) return this.ch3.position >> 1;
    return -1;
  }

  private readWave(index: number): number {
    const i = this.waveAccessIndex(index);
    return i < 0 ? 0xff : this.waveRam[i];
  }

  private writeWave(index: number, value: number) {
    const i = this.waveAccessIndex(index);
    if (i >= 0) this.waveRam[i] = value;
  }

  private writePower(on: boolean) {
    if (on === this.powered) return;
    if (!on) {
      // Powering off writes zero to every register. DMG keeps the length
      // counters through this, CGB clears them as well.
      const lengths = this.channels.map((c) => c.lengthCounter);
      for (let a = 0x10; a <= NR51; a++) this.write(a, 0);
      this.channels.forEach((c, i) => {
        c.enabled = false;
        c.lengthEnabled = false;
        c.lengthCounter = this.model === 'dmg' ? lengths[i] : 0;
      });
      this.powered = false;
    } else {
      this.powered = true;
      this.frameStep = 0;
      this.ch1.dutyPos = 0;
      this.ch2.dutyPos = 0;
      this.ch3.sampleBuffer = 0;
    }
  }

  // ------------------------------------------------------------------ timing

  private stepFrameSequencer() {
    const step = this.frameStep;
    this.frameStep = (step + 1) & 7;
    if (!this.powered) return;
    if ((step & 1) === 0) for (const c of this.channels) c.clockLength();
    if (step === 2 || step === 6) this.ch1.clockSweep();
    if (step === 7) {
      this.ch1.env.clock();
      this.ch2.env.clock();
      this.ch4.env.clock();
    }
  }

  /** Analog output of a channel: DAC maps 0..15 to +1..-1, off DAC = 0. */
  private analog(i: number): number {
    const c = this.channels[i];
    if (!c.dacOn || this.muted[i]) return 0;
    return 1 - c.output() / 7.5;
  }

  /** Advance the APU by the given number of CPU clocks. */
  run(cycles: number) {
    let remaining = cycles;
    const sr = this.sampleRate;
    while (remaining > 0) {
      // Find the next event.
      let n = remaining;
      if (this.frameCounter < n) n = this.frameCounter;
      const toSample = Math.ceil(this.sampleCountdown / sr);
      if (toSample < n) n = toSample;
      if (this.powered) {
        for (const c of this.channels) if (c.enabled && c.timer < n) n = c.timer;
      }
      if (n < 1) n = 1;

      // Integrate output over the interval.
      const a1 = this.analog(0), a2 = this.analog(1), a3 = this.analog(2), a4 = this.analog(3);
      const panning = this.regs[NR51];
      const vol = this.regs[NR50];
      let l = 0, r = 0;
      if (panning & 0x10) l += a1;
      if (panning & 0x20) l += a2;
      if (panning & 0x40) l += a3;
      if (panning & 0x80) l += a4;
      if (panning & 0x01) r += a1;
      if (panning & 0x02) r += a2;
      if (panning & 0x04) r += a3;
      if (panning & 0x08) r += a4;
      l *= (((vol >> 4) & 7) + 1) / 8;
      r *= ((vol & 7) + 1) / 8;
      this.accL += l * n;
      this.accR += r * n;
      if (this.captureChannels) {
        this.accCh[0] += a1 * n;
        this.accCh[1] += a2 * n;
        this.accCh[2] += a3 * n;
        this.accCh[3] += a4 * n;
      }
      this.accCycles += n;

      // Advance time.
      remaining -= n;
      this.cycles += n;
      this.frameCounter -= n;
      this.sampleCountdown -= n * sr;
      if (this.powered) {
        for (const c of this.channels) if (c.enabled) c.timer -= n;
        if (this.ch1.enabled && this.ch1.timer <= 0) this.ch1.tick();
        if (this.ch2.enabled && this.ch2.timer <= 0) this.ch2.tick();
        if (this.ch3.enabled && this.ch3.timer <= 0) this.ch3.tick(this.waveRam, this.cycles);
        if (this.ch4.enabled && this.ch4.timer <= 0) this.ch4.tick();
      }
      if (this.frameCounter <= 0) {
        this.frameCounter += FRAME_SEQUENCER_PERIOD;
        this.stepFrameSequencer();
      }
      if (this.sampleCountdown <= 0) {
        this.sampleCountdown += CPU_HZ;
        this.emitSample();
      }
    }
  }

  private emitSample() {
    const k = 1 / (this.accCycles * 4);
    const inL = this.accL * k;
    const inR = this.accR * k;
    const outL = inL - this.capL;
    const outR = inR - this.capR;
    this.capL = inL - outL * this.charge;
    this.capR = inR - outR * this.charge;

    if (this.outCount * 2 + 2 > this.out.length) {
      const grown = new Float32Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
      const grownCh = new Float32Array(this.outChannels.length * 2);
      grownCh.set(this.outChannels);
      this.outChannels = grownCh;
    }
    this.out[this.outCount * 2] = outL;
    this.out[this.outCount * 2 + 1] = outR;
    if (this.captureChannels) {
      const base = this.outCount * 4;
      for (let i = 0; i < 4; i++) {
        this.outChannels[base + i] = this.accCh[i] / this.accCycles;
        this.accCh[i] = 0;
      }
    }
    this.outCount++;
    this.accL = this.accR = 0;
    this.accCycles = 0;
  }

  /** Remove the first `count` samples from the output buffer. */
  consume(count: number) {
    count = Math.min(count, this.outCount);
    this.out.copyWithin(0, count * 2, this.outCount * 2);
    if (this.captureChannels) this.outChannels.copyWithin(0, count * 4, this.outCount * 4);
    this.outCount -= count;
  }

  /** Clocks needed until `count` more samples are available. */
  cyclesForSamples(count: number): number {
    return Math.max(1, Math.ceil((this.sampleCountdown + (count - 1) * CPU_HZ) / this.sampleRate));
  }
}
