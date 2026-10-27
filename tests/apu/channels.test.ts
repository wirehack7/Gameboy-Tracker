// Channel level behaviour: duty, envelope, DAC, wave and noise channels,
// including Blargg dmg_sound 09/10/12 (wave RAM access while playing).
import { describe, expect, it } from 'vitest';
import {
  Apu,
  DUTY_TABLE,
  NR12,
  NR21,
  NR22,
  NR23,
  NR24,
  NR30,
  NR32,
  NR33,
  NR34,
  NR42,
  NR43,
  NR44,
  NR50,
  NR51,
  NR52,
} from '../../src/apu/apu';
import { channelOn, poweredApu, runStep, syncTo } from './helpers';

describe('pulse channel', () => {
  it.each([0, 1, 2, 3])('duty %i produces the documented waveform', (duty) => {
    const apu = poweredApu();
    apu.write(NR21, duty << 6);
    apu.write(NR22, 0xf0);
    apu.write(NR23, 0x00);
    apu.write(NR24, 0x87);
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      apu.run(apu.ch2.timer);
      seen.push(apu.ch2.output() ? 1 : 0);
    }
    // Duty position starts at 0 after power on and advances before output.
    const expected = [...DUTY_TABLE[duty].slice(1), DUTY_TABLE[duty][0]];
    expect(seen).toEqual(expected);
  });

  it('frequency timer period is (2048 - x) * 4 clocks', () => {
    const apu = poweredApu();
    apu.write(NR22, 0xf0);
    apu.write(NR23, 0x34);
    apu.write(NR24, 0x82);
    expect(apu.ch2.timer).toBe((2048 - 0x234) * 4);
    const pos = apu.ch2.dutyPos;
    apu.run((2048 - 0x234) * 4 * 8);
    expect(apu.ch2.dutyPos).toBe(pos);
  });

  it('trigger does not reset the duty position', () => {
    const apu = poweredApu();
    apu.write(NR22, 0xf0);
    apu.write(NR24, 0x87);
    apu.run(apu.ch2.timer * 3);
    const pos = apu.ch2.dutyPos;
    apu.write(NR24, 0x87);
    expect(apu.ch2.dutyPos).toBe(pos);
  });

  it('frequency changes apply at the next timer reload', () => {
    const apu = poweredApu();
    apu.write(NR22, 0xf0);
    apu.write(NR23, 0x00);
    apu.write(NR24, 0x80); // period 8192
    apu.run(100);
    apu.write(NR23, 0xff);
    apu.write(NR24, 0x07); // period 4, no trigger
    expect(apu.ch2.timer).toBe(8192 - 100);
    apu.run(8192 - 100);
    expect(apu.ch2.timer).toBe(4);
  });
});

describe('volume envelope', () => {
  it('steps once per period at 64 Hz and stops at 0', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    apu.write(NR22, 0x22); // volume 2, decrease, period 2
    apu.write(NR24, 0x80);
    expect(apu.ch2.env.volume).toBe(2);
    runStep(apu, 8);
    expect(apu.ch2.env.volume).toBe(2);
    runStep(apu, 8);
    expect(apu.ch2.env.volume).toBe(1);
    runStep(apu, 16);
    expect(apu.ch2.env.volume).toBe(0);
    runStep(apu, 64);
    expect(apu.ch2.env.volume).toBe(0);
    // Volume 0 does not disable the channel, the DAC is still on.
    expect(channelOn(apu, 1)).toBe(true);
  });

  it('increases up to 15 and stays there', () => {
    const apu = poweredApu();
    apu.write(NR22, 0xd9); // volume 13, increase, period 1
    apu.write(NR24, 0x80);
    runStep(apu, 8 * 10);
    expect(apu.ch2.env.volume).toBe(15);
  });

  it('period 0 never changes the volume', () => {
    const apu = poweredApu();
    apu.write(NR22, 0x88);
    apu.write(NR24, 0x80);
    runStep(apu, 8 * 20);
    expect(apu.ch2.env.volume).toBe(8);
  });

  describe('zombie mode (NRx2 write while playing)', () => {
    it('old period 0 with running envelope adds 1', () => {
      const apu = poweredApu();
      apu.write(NR22, 0x58); // vol 5, increase, period 0
      apu.write(NR24, 0x80);
      apu.write(NR22, 0x58);
      expect(apu.ch2.env.volume).toBe(6);
    });

    it('old subtract mode adds 2', () => {
      const apu = poweredApu();
      apu.write(NR22, 0x51); // vol 5, decrease, period 1
      apu.write(NR24, 0x80);
      apu.write(NR22, 0x51);
      expect(apu.ch2.env.volume).toBe(7);
    });

    it('switching direction sets volume to 16 - volume', () => {
      const apu = poweredApu();
      apu.write(NR22, 0x59); // vol 5, increase, period 1
      apu.write(NR24, 0x80);
      apu.write(NR22, 0x51);
      expect(apu.ch2.env.volume).toBe(11);
    });

    it('wraps to 4 bits', () => {
      const apu = poweredApu();
      apu.write(NR22, 0xf1);
      apu.write(NR24, 0x80);
      apu.write(NR22, 0xf1);
      expect(apu.ch2.env.volume).toBe(1);
    });
  });
});

describe('DACs', () => {
  it.each([
    [NR12, 0x14, 0],
    [NR22, NR24, 1],
    [NR42, NR44, 3],
  ])('NRx2 upper 5 bits zero turns the DAC off and disables the channel', (nrx2, nrx4, ch) => {
    const apu = poweredApu();
    apu.write(nrx2, 0xf0);
    apu.write(nrx4, 0x80);
    expect(channelOn(apu, ch)).toBe(true);
    apu.write(nrx2, 0x07);
    expect(channelOn(apu, ch)).toBe(false);
    apu.write(nrx4, 0x80);
    expect(channelOn(apu, ch)).toBe(false);
  });

  it('volume 0 with increase keeps the DAC on', () => {
    const apu = poweredApu();
    apu.write(NR22, 0x08);
    apu.write(NR24, 0x80);
    expect(channelOn(apu, 1)).toBe(true);
  });

  it('turning the DAC back on does not re-enable the channel', () => {
    const apu = poweredApu();
    apu.write(NR22, 0xf0);
    apu.write(NR24, 0x80);
    apu.write(NR22, 0x00);
    apu.write(NR22, 0xf0);
    expect(channelOn(apu, 1)).toBe(false);
  });

  it('NR30 bit 7 controls the wave DAC', () => {
    const apu = poweredApu();
    apu.write(NR30, 0x80);
    apu.write(NR34, 0x80);
    expect(channelOn(apu, 2)).toBe(true);
    apu.write(NR30, 0x00);
    expect(channelOn(apu, 2)).toBe(false);
  });

  it('a disabled channel with DAC on outputs digital 0 (analog +1), DAC off outputs 0', () => {
    const apu = new Apu({ sampleRate: 48000 });
    apu.write(NR52, 0x80);
    apu.write(NR50, 0x77);
    apu.write(NR51, 0x22);
    apu.write(NR22, 0xf0); // DAC on, channel not triggered
    apu.run(48);
    apu.run(apu.cyclesForSamples(1));
    expect(apu.out[0]).toBeGreaterThan(0.2);
  });
});

function startWave(apu: Apu, freq: number, volumeCode = 1) {
  apu.write(NR30, 0x80);
  apu.write(NR32, volumeCode << 5);
  apu.write(NR33, freq & 0xff);
  apu.write(NR34, 0x80 | (freq >> 8));
}

function fillWave(apu: Apu, bytes: number[]) {
  bytes.forEach((b, i) => apu.write(0x30 + i, b));
}

describe('wave channel', () => {
  const ramp = Array.from({ length: 16 }, (_, i) => (i << 4) | (15 - i));

  it('plays nibbles high first and starts at sample 1 after trigger', () => {
    const apu = poweredApu();
    fillWave(apu, ramp);
    startWave(apu, 0x700);
    const period = (2048 - 0x700) * 2;
    expect(apu.ch3.timer).toBe(period + 6);
    // Until the first fetch, the (cleared) sample buffer is played.
    expect(apu.ch3.output()).toBe(0);
    apu.run(period + 6);
    const seen = [apu.ch3.output()];
    for (let i = 0; i < 31; i++) {
      apu.run(period);
      seen.push(apu.ch3.output());
    }
    const expected = Array.from({ length: 32 }, (_, i) => {
      const pos = (i + 1) & 31;
      const byte = ramp[pos >> 1];
      return pos & 1 ? byte & 15 : byte >> 4;
    });
    expect(seen).toEqual(expected);
  });

  it.each([
    [0, 0],
    [1, 0xc],
    [2, 0x6],
    [3, 0x3],
  ])('volume code %i shifts the sample', (code, expected) => {
    const apu = poweredApu();
    fillWave(apu, Array(16).fill(0xcc));
    startWave(apu, 0x700, code);
    apu.run(apu.ch3.timer);
    expect(apu.ch3.output()).toBe(expected);
  });

  it('frequency timer period is (2048 - x) * 2 clocks', () => {
    const apu = poweredApu();
    startWave(apu, 0x123);
    apu.run(apu.ch3.timer);
    expect(apu.ch3.timer).toBe((2048 - 0x123) * 2);
  });

  describe('wave RAM read while on (09-wave read while on)', () => {
    it('DMG: reads return the byte being fetched only right at the fetch', () => {
      const apu = poweredApu('dmg');
      fillWave(apu, ramp);
      startWave(apu, 0x700);
      apu.run(apu.ch3.timer);
      apu.run(apu.ch3.timer); // position 2 -> byte 1
      expect(apu.read(0x3f)).toBe(ramp[1]);
      apu.run(1);
      expect(apu.read(0x30)).toBe(ramp[1]);
      apu.run(1);
      expect(apu.read(0x30)).toBe(0xff);
    });

    it('CGB: reads always return the byte at the current position', () => {
      const apu = poweredApu('cgb');
      fillWave(apu, ramp);
      startWave(apu, 0x700);
      apu.run(apu.ch3.timer);
      apu.run(apu.ch3.timer);
      apu.run(37);
      expect(apu.read(0x3f)).toBe(ramp[1]);
    });

    it('reads are normal once the channel is off', () => {
      const apu = poweredApu('dmg');
      fillWave(apu, ramp);
      startWave(apu, 0x700);
      apu.write(NR30, 0);
      expect(apu.read(0x35)).toBe(ramp[5]);
    });
  });

  describe('wave RAM write while on (12-wave write while on)', () => {
    it('DMG: writes away from a fetch are ignored', () => {
      const apu = poweredApu('dmg');
      fillWave(apu, ramp);
      startWave(apu, 0x700);
      apu.run(10);
      apu.write(0x30, 0x00);
      expect(apu.waveRam[0]).toBe(ramp[0]);
    });

    it('DMG: writes at a fetch go to the byte being played', () => {
      const apu = poweredApu('dmg');
      fillWave(apu, ramp);
      startWave(apu, 0x700);
      apu.run(apu.ch3.timer);
      apu.run(apu.ch3.timer);
      apu.write(0x3a, 0x99);
      expect(apu.waveRam[1]).toBe(0x99);
      expect(apu.waveRam[10]).toBe(ramp[10]);
    });

    it('CGB: writes go to the byte being played', () => {
      const apu = poweredApu('cgb');
      fillWave(apu, ramp);
      startWave(apu, 0x700);
      apu.run(10);
      apu.write(0x37, 0x99);
      expect(apu.waveRam[0]).toBe(0x99);
    });
  });

  describe('retrigger while playing (10-wave trigger while on)', () => {
    function retriggerAt(model: 'dmg' | 'cgb', position: number, timerLeft: number) {
      const apu = poweredApu(model);
      fillWave(apu, ramp);
      startWave(apu, 0x700);
      for (let i = 0; i < position; i++) apu.run(apu.ch3.timer);
      apu.run(apu.ch3.timer - timerLeft);
      apu.write(NR34, 0x87);
      return apu;
    }

    it('DMG: byte to fetch in the first 4 bytes is copied to byte 0', () => {
      const apu = retriggerAt('dmg', 4, 2); // next fetch is position 5 -> byte 2
      expect(Array.from(apu.waveRam)).toEqual([ramp[2], ...ramp.slice(1)]);
    });

    it('DMG: otherwise the aligned 4-byte block is copied to bytes 0-3', () => {
      const apu = retriggerAt('dmg', 12, 2); // next fetch position 13 -> byte 6
      expect(Array.from(apu.waveRam)).toEqual([...ramp.slice(4, 8), ...ramp.slice(4)]);
    });

    it('DMG: no corruption when not about to fetch', () => {
      const apu = retriggerAt('dmg', 12, 50);
      expect(Array.from(apu.waveRam)).toEqual(ramp);
    });

    it('CGB: retriggering never corrupts wave RAM', () => {
      const apu = retriggerAt('cgb', 12, 2);
      expect(Array.from(apu.waveRam)).toEqual(ramp);
    });

    it('retrigger resets the position to 0', () => {
      const apu = retriggerAt('cgb', 12, 50);
      expect(apu.ch3.position).toBe(0);
    });
  });
});

describe('noise channel', () => {
  function startNoise(apu: Apu, nr43: number) {
    apu.write(NR42, 0xf0);
    apu.write(NR43, nr43);
    apu.write(NR44, 0x80);
  }

  function outputBits(apu: Apu, count: number) {
    const bits: number[] = [];
    for (let i = 0; i < count; i++) {
      apu.run(apu.ch4.timer);
      bits.push(apu.ch4.lfsr & 1);
    }
    return bits;
  }

  it('trigger sets all 15 LFSR bits', () => {
    const apu = poweredApu();
    startNoise(apu, 0x00);
    expect(apu.ch4.lfsr).toBe(0x7fff);
  });

  it('15-bit mode is a maximal length sequence (period 32767)', () => {
    const apu = poweredApu();
    startNoise(apu, 0x00);
    const bits = outputBits(apu, 32767);
    expect(apu.ch4.lfsr).toBe(0x7fff);
    expect(bits.filter((b) => b === 1).length).toBe(16384);
  });

  it('7-bit mode repeats every 127 clocks', () => {
    const apu = poweredApu();
    startNoise(apu, 0x08);
    const bits = outputBits(apu, 127 * 3);
    expect(bits.slice(127, 254)).toEqual(bits.slice(0, 127));
    expect(bits.slice(0, 127).filter((b) => b === 1).length).toBe(64);
  });

  it('first LFSR steps from 0x7FFF', () => {
    const apu = poweredApu();
    startNoise(apu, 0x00);
    apu.run(apu.ch4.timer);
    expect(apu.ch4.lfsr).toBe(0x3fff);
    // Output is the inverted bit 0: high when bit 0 is 0.
    expect(apu.ch4.output()).toBe(0);
  });

  it.each([
    [0x00, 8],
    [0x01, 16],
    [0x07, 112],
    [0x10, 16],
    [0x37, 112 << 3],
    [0xd5, 80 << 13],
  ])('NR43=%s gives a period of %i clocks', (nr43, period) => {
    const apu = poweredApu();
    startNoise(apu, nr43);
    expect(apu.ch4.timer).toBe(period);
  });

  it('clock shift 14 and 15 do not clock the LFSR', () => {
    const apu = poweredApu();
    startNoise(apu, 0xe0);
    apu.run(apu.ch4.timer * 3);
    expect(apu.ch4.lfsr).toBe(0x7fff);
  });
});

describe('mixer', () => {
  function squareApu(nr51: number, nr50 = 0x77) {
    const apu = new Apu({ sampleRate: 48000 });
    apu.write(NR52, 0x80);
    apu.write(NR50, nr50);
    apu.write(NR51, nr51);
    apu.write(NR22, 0xf0);
    apu.write(NR23, 0x00);
    apu.write(NR24, 0x87); // ~1 kHz... (131072 / 256 = 512 Hz)
    apu.run(4194304 / 10);
    return apu;
  }

  function peak(apu: Apu, channel: 0 | 1) {
    let m = 0;
    for (let i = 0; i < apu.outCount; i++) m = Math.max(m, Math.abs(apu.out[i * 2 + channel]));
    return m;
  }

  it('NR51 routes channel 2 to the left only', () => {
    const apu = squareApu(0x20);
    expect(peak(apu, 0)).toBeGreaterThan(0.1);
    expect(peak(apu, 1)).toBe(0);
  });

  it('NR51 routes channel 2 to the right only', () => {
    const apu = squareApu(0x02);
    expect(peak(apu, 0)).toBe(0);
    expect(peak(apu, 1)).toBeGreaterThan(0.1);
  });

  it('NR50 scales each side by (volume + 1) / 8', () => {
    const loud = squareApu(0x22, 0x70);
    const ratio = peak(loud, 1) / peak(loud, 0);
    expect(ratio).toBeCloseTo(1 / 8, 2);
  });

  it('the high-pass filter removes DC', () => {
    const apu = new Apu({ sampleRate: 48000 });
    apu.write(NR52, 0x80);
    apu.write(NR50, 0x77);
    apu.write(NR51, 0xff);
    apu.write(NR22, 0xf0); // DAC on, constant level
    apu.run(4194304);
    expect(Math.abs(apu.out[(apu.outCount - 1) * 2])).toBeLessThan(0.001);
  });

  it('produces the requested number of samples per second', () => {
    const apu = new Apu({ sampleRate: 44100 });
    apu.run(4194304);
    expect(Math.abs(apu.outCount - 44100)).toBeLessThanOrEqual(1);
  });

  it('cyclesForSamples yields exactly the requested samples', () => {
    const apu = new Apu({ sampleRate: 44100 });
    apu.run(1234);
    const before = apu.outCount;
    apu.run(apu.cyclesForSamples(128));
    expect(apu.outCount - before).toBe(128);
  });
});
