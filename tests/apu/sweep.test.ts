// Mirrors Blargg dmg_sound 04-sweep, 05-sweep details and 06-overflow on trigger.
import { describe, expect, it } from 'vitest';
import { Apu, NR10, NR12, NR13, NR14 } from '../../src/apu/apu';
import { channelOn, poweredApu, runStep, syncTo } from './helpers';

function start(apu: Apu, sweep: number, freq: number) {
  apu.write(NR10, sweep);
  apu.write(NR12, 0xf0);
  apu.write(NR13, freq & 0xff);
  apu.write(NR14, 0x80 | (freq >> 8));
}

/** Run until `n` sweep clocks (frame sequencer steps 2 and 6) have happened. */
function sweepClocks(apu: Apu, n: number) {
  for (let i = 0; i < n; i++) {
    let step: number;
    do {
      step = apu.frameStep;
      runStep(apu);
    } while (step !== 2 && step !== 6);
  }
}

describe('frequency sweep (04-sweep)', () => {
  it('adds shadow >> shift on each sweep clock', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x12, 0x100); // period 1, shift 2
    sweepClocks(apu, 1);
    expect(apu.ch1.frequency).toBe(0x100 + 0x40);
    sweepClocks(apu, 1);
    expect(apu.ch1.frequency).toBe(0x140 + 0x50);
  });

  it('subtracts in negate mode', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x19, 0x400); // period 1, negate, shift 1
    sweepClocks(apu, 1);
    expect(apu.ch1.frequency).toBe(0x200);
  });

  it('disables the channel when the result overflows 2047', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x11, 0x500); // 0x500 + 0x280 = 0x780 ok; next 0x780 + 0x3c0 overflows
    expect(channelOn(apu, 0)).toBe(true);
    sweepClocks(apu, 1);
    expect(apu.ch1.frequency).toBe(0x780);
    // The second calculation right after the write already detects overflow.
    expect(channelOn(apu, 0)).toBe(false);
  });

  it('shift 0 performs the overflow check but does not update the frequency', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x10, 0x500); // period 1, shift 0: 0x500 * 2 overflows
    expect(channelOn(apu, 0)).toBe(true);
    sweepClocks(apu, 1);
    expect(apu.ch1.frequency).toBe(0x500);
    expect(channelOn(apu, 0)).toBe(false);
  });

  it('shift 0 without overflow leaves the channel running', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x10, 0x100);
    sweepClocks(apu, 4);
    expect(apu.ch1.frequency).toBe(0x100);
    expect(channelOn(apu, 0)).toBe(true);
  });

  it('period 0 never calculates', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x07, 0x100); // period 0, shift 7 -> enabled but period 0
    sweepClocks(apu, 16);
    expect(apu.ch1.frequency).toBe(0x100);
  });

  it('timer treats period 0 as 8', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x01, 0x100); // period 0 at trigger -> timer 8
    apu.write(NR10, 0x11); // now period 1 (timer keeps running from 8)
    sweepClocks(apu, 7);
    expect(apu.ch1.frequency).toBe(0x100);
    sweepClocks(apu, 1);
    expect(apu.ch1.frequency).toBe(0x180);
  });

  it('timer reloads with the period, e.g. every 3 sweep clocks', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x31, 0x100);
    sweepClocks(apu, 2);
    expect(apu.ch1.frequency).toBe(0x100);
    sweepClocks(apu, 1);
    expect(apu.ch1.frequency).toBe(0x180);
    sweepClocks(apu, 3);
    expect(apu.ch1.frequency).toBe(0x240);
  });

  it('sweep uses the shadow register, not later NR13/NR14 writes', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x11, 0x100);
    apu.write(NR13, 0x00);
    apu.write(NR14, 0x07); // frequency 0x700 without trigger
    sweepClocks(apu, 1);
    expect(apu.ch1.frequency).toBe(0x180);
    expect(channelOn(apu, 0)).toBe(true);
  });

  it('sweep disabled (period 0, shift 0) does nothing even on overflow-prone frequency', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x00, 0x7ff);
    apu.write(NR10, 0x10); // enabling period later does not enable the internal flag
    sweepClocks(apu, 8);
    expect(channelOn(apu, 0)).toBe(true);
    expect(apu.ch1.frequency).toBe(0x7ff);
  });
});

describe('sweep details (05-sweep details)', () => {
  it('leaving negate mode after a negate calculation disables the channel', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x19, 0x400);
    sweepClocks(apu, 1);
    expect(channelOn(apu, 0)).toBe(true);
    apu.write(NR10, 0x11);
    expect(channelOn(apu, 0)).toBe(false);
  });

  it('leaving negate mode before any calculation keeps the channel on', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x28, 0x400); // period 2, negate, shift 0 -> no calc at trigger
    apu.write(NR10, 0x20);
    expect(channelOn(apu, 0)).toBe(true);
  });

  it('the negate calculation at trigger (shift != 0) counts for the quirk', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x79, 0x400);
    apu.write(NR10, 0x71);
    expect(channelOn(apu, 0)).toBe(false);
  });

  it('retriggering clears the negate-used state', () => {
    const apu = poweredApu();
    syncTo(apu, 0);
    start(apu, 0x19, 0x400);
    sweepClocks(apu, 1);
    apu.write(NR10, 0x10); // shift 0, not negate -> disables
    start(apu, 0x18, 0x400); // retrigger, negate, shift 0 -> no calc
    apu.write(NR10, 0x10);
    expect(channelOn(apu, 0)).toBe(true);
  });
});

describe('overflow on trigger (06-overflow on trigger)', () => {
  it('shift != 0 checks for overflow immediately on trigger', () => {
    const apu = poweredApu();
    start(apu, 0x01, 0x7ff);
    expect(channelOn(apu, 0)).toBe(false);
  });

  it('shift 0 does not check on trigger', () => {
    const apu = poweredApu();
    start(apu, 0x00, 0x7ff);
    expect(channelOn(apu, 0)).toBe(true);
  });

  it('negate never overflows on trigger', () => {
    const apu = poweredApu();
    start(apu, 0x09, 0x7ff);
    expect(channelOn(apu, 0)).toBe(true);
  });

  it('the trigger calculation does not write the frequency', () => {
    const apu = poweredApu();
    start(apu, 0x71, 0x100);
    expect(apu.ch1.frequency).toBe(0x100);
  });

  it('borderline: 0x555 + 0x2AA = 0x7FF does not overflow', () => {
    const apu = poweredApu();
    start(apu, 0x01, 0x555);
    expect(channelOn(apu, 0)).toBe(true);
  });
});
