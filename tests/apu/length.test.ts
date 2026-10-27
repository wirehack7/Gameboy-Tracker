// Mirrors Blargg dmg_sound 02-len ctr, 03-trigger, 07-len sweep period sync
// and 08-len ctr during power.
import { describe, expect, it } from 'vitest';
import { Apu, NR52 } from '../../src/apu/apu';
import { BASE, channelOn, dacOn, maxLength, poweredApu, runStep, syncTo, writeLength } from './helpers';

const CHANNELS = [0, 1, 2, 3];
const trigger = (apu: Apu, ch: number, lengthEnable: boolean) =>
  apu.write(BASE[ch] + 4, 0x80 | (lengthEnable ? 0x40 : 0));
const control = (apu: Apu, ch: number, lengthEnable: boolean) => apu.write(BASE[ch] + 4, lengthEnable ? 0x40 : 0);
const counter = (apu: Apu, ch: number) => apu.channels[ch].lengthCounter;

describe.each(CHANNELS)('length counter, channel %i (02-len ctr)', (ch) => {
  it('disables the channel after `length` length clocks', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 0);
    writeLength(apu, ch, 4);
    trigger(apu, ch, true);
    expect(channelOn(apu, ch)).toBe(true);
    runStep(apu, 2 * 3); // three length clocks
    expect(channelOn(apu, ch)).toBe(true);
    runStep(apu, 2);
    expect(channelOn(apu, ch)).toBe(false);
  });

  it('does not count while length is disabled', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 0);
    writeLength(apu, ch, 1);
    trigger(apu, ch, false);
    runStep(apu, 16);
    expect(channelOn(apu, ch)).toBe(true);
    expect(counter(apu, ch)).toBe(1);
  });

  it('trigger reloads a zero length counter with the maximum', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 0);
    writeLength(apu, ch, 1);
    trigger(apu, ch, true);
    runStep(apu, 2);
    expect(channelOn(apu, ch)).toBe(false);
    expect(counter(apu, ch)).toBe(0);
    trigger(apu, ch, false);
    expect(counter(apu, ch)).toBe(maxLength(ch));
  });

  it('trigger does not reload a non-zero length counter', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 0);
    writeLength(apu, ch, 10);
    trigger(apu, ch, false);
    expect(counter(apu, ch)).toBe(10);
  });

  it('writing the length while running takes effect immediately', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 0);
    writeLength(apu, ch, 50);
    trigger(apu, ch, true);
    writeLength(apu, ch, 1);
    runStep(apu, 1);
    expect(channelOn(apu, ch)).toBe(false);
  });

  it('a stopped length counter keeps the channel off but disabled length lets it run', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 0);
    writeLength(apu, ch, 2);
    trigger(apu, ch, true);
    runStep(apu, 1);
    control(apu, ch, false);
    runStep(apu, 8);
    expect(channelOn(apu, ch)).toBe(true);
    expect(counter(apu, ch)).toBe(1);
  });
});

describe.each(CHANNELS)('length quirks on NRx4 writes, channel %i (03-trigger)', (ch) => {
  it('enabling length when the next step does not clock length clocks it once', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 1);
    writeLength(apu, ch, 5);
    control(apu, ch, true);
    expect(counter(apu, ch)).toBe(4);
  });

  it('enabling length when the next step clocks length does not clock it', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 0);
    writeLength(apu, ch, 5);
    control(apu, ch, true);
    expect(counter(apu, ch)).toBe(5);
  });

  it('enabling length again while already enabled does not clock it', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 1);
    writeLength(apu, ch, 5);
    control(apu, ch, true);
    control(apu, ch, true);
    expect(counter(apu, ch)).toBe(4);
  });

  it('the extra clock reaching zero disables the channel without a trigger', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 0);
    writeLength(apu, ch, 2);
    trigger(apu, ch, false);
    syncTo(apu, 1);
    writeLength(apu, ch, 1);
    control(apu, ch, true);
    expect(counter(apu, ch)).toBe(0);
    expect(channelOn(apu, ch)).toBe(false);
  });

  it('the extra clock reaching zero with a trigger reloads max - 1', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 1);
    writeLength(apu, ch, 1);
    trigger(apu, ch, true);
    expect(channelOn(apu, ch)).toBe(true);
    expect(counter(apu, ch)).toBe(maxLength(ch) - 1);
  });

  it('trigger with zero length and length enabled in the first half loads max - 1', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 0);
    writeLength(apu, ch, 1);
    trigger(apu, ch, true);
    runStep(apu, 1);
    expect(counter(apu, ch)).toBe(0);
    syncTo(apu, 1);
    trigger(apu, ch, true);
    expect(counter(apu, ch)).toBe(maxLength(ch) - 1);
  });

  it('trigger with zero length and length enabled in the second half loads max', () => {
    const apu = poweredApu();
    dacOn(apu, ch);
    syncTo(apu, 0);
    writeLength(apu, ch, 1);
    trigger(apu, ch, true);
    runStep(apu, 2);
    syncTo(apu, 0);
    trigger(apu, ch, true);
    expect(counter(apu, ch)).toBe(maxLength(ch));
  });

  it('trigger with the DAC off loads length but leaves the channel off', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    trigger(apu, ch, false);
    expect(channelOn(apu, ch)).toBe(false);
    expect(counter(apu, ch)).toBe(maxLength(ch));
  });
});

describe('frame sequencer timing (07-len sweep period sync)', () => {
  it('runs at 512 Hz', () => {
    const apu = poweredApu();
    const start = apu.frameStep;
    apu.run(4194304);
    expect(apu.frameStep).toBe(start); // 512 steps = 64 full cycles of 8
    expect(apu.cycles).toBe(4194304);
  });

  it('clocks length on steps 0, 2, 4, 6 after power on', () => {
    const apu = poweredApu();
    dacOn(apu, 1);
    writeLength(apu, 1, 40);
    apu.write(0x19, 0xc0);
    // Next step is 0 after power on.
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = apu.ch2.lengthCounter;
      const step = apu.frameStep;
      runStep(apu);
      if (apu.ch2.lengthCounter !== before) seen.push(step);
    }
    expect(seen).toEqual([0, 2, 4, 6]);
  });

  it('clocks sweep on steps 2 and 6', () => {
    const apu = poweredApu();
    apu.write(0x10, 0x11); // period 1, shift 1
    apu.write(0x12, 0xf0);
    apu.write(0x13, 0x10);
    apu.write(0x14, 0x80);
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = apu.ch1.frequency;
      const step = apu.frameStep;
      runStep(apu);
      if (apu.ch1.frequency !== before) seen.push(step);
    }
    expect(seen).toEqual([2, 6]);
  });

  it('clocks envelopes on step 7', () => {
    const apu = poweredApu();
    apu.write(0x12, 0xf1);
    apu.write(0x14, 0x80);
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = apu.ch1.env.volume;
      const step = apu.frameStep;
      runStep(apu);
      if (apu.ch1.env.volume !== before) seen.push(step);
    }
    expect(seen).toEqual([7]);
  });
});

describe('length counters across power (08-len ctr during power)', () => {
  it.each(CHANNELS)('DMG: channel %i keeps its length counter through power off', (ch) => {
    const apu = poweredApu('dmg');
    writeLength(apu, ch, 7);
    apu.write(NR52, 0);
    apu.write(NR52, 0x80);
    expect(counter(apu, ch)).toBe(7);
  });

  it.each(CHANNELS)('DMG: channel %i length is writable while powered off', (ch) => {
    const apu = new Apu({ model: 'dmg' });
    writeLength(apu, ch, 3);
    apu.write(NR52, 0x80);
    expect(counter(apu, ch)).toBe(3);
    dacOn(apu, ch);
    syncTo(apu, 0);
    trigger(apu, ch, true);
    runStep(apu, 6);
    expect(channelOn(apu, ch)).toBe(false);
  });

  it.each(CHANNELS)('CGB: channel %i length is cleared by power off and not writable', (ch) => {
    const apu = poweredApu('cgb');
    writeLength(apu, ch, 7);
    apu.write(NR52, 0);
    expect(counter(apu, ch)).toBe(0);
    writeLength(apu, ch, 3);
    apu.write(NR52, 0x80);
    expect(counter(apu, ch)).toBe(0);
  });

  it('length counters are not clocked while powered off', () => {
    const apu = new Apu({ model: 'dmg' });
    writeLength(apu, 0, 10);
    apu.run(8192 * 16);
    expect(counter(apu, 0)).toBe(10);
  });
});
