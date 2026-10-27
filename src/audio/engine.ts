import { Apu, Model } from '../apu/apu';
import { Player } from '../tracker/player';
import { CYCLES_PER_TICK, Song } from '../tracker/song';

/**
 * APU + player, clocked together: the player ticks every CYCLES_PER_TICK
 * emulated clocks, exactly like a driver running from the VBlank interrupt.
 */
export class Engine {
  apu: Apu;
  readonly player: Player;
  private untilTick = 0;

  constructor(
    song: Song,
    readonly sampleRate: number,
    readonly captureChannels = false,
  ) {
    this.apu = this.createApu(song.model);
    this.player = new Player(song);
  }

  private createApu(model: Model) {
    const apu = new Apu({ model, sampleRate: this.sampleRate, captureChannels: this.captureChannels });
    Player.init(apu);
    return apu;
  }

  setSong(song: Song) {
    if (song.model !== this.apu.model) {
      const muted = [...this.apu.muted];
      this.apu = this.createApu(song.model);
      muted.forEach((m, i) => (this.apu.muted[i] = m));
    }
    this.player.setSong(song);
  }

  play(order = 0, row = 0, loopPattern = false) {
    this.player.loopPattern = loopPattern;
    this.player.start(this.apu, order, row);
    this.untilTick = 0;
  }

  stop() {
    this.player.stop(this.apu);
  }

  /**
   * Render `frames` stereo samples. Per-channel output (if captured) is
   * written to `channels` as 4 interleaved values per frame.
   */
  render(left: Float32Array, right: Float32Array, frames: number, channels?: Float32Array) {
    const apu = this.apu;
    while (apu.outCount < frames) {
      if (this.untilTick <= 0) {
        this.player.tick(apu);
        this.untilTick += CYCLES_PER_TICK;
      }
      const cycles = Math.min(this.untilTick, apu.cyclesForSamples(frames - apu.outCount));
      apu.run(cycles);
      this.untilTick -= cycles;
    }
    const out = apu.out;
    for (let i = 0; i < frames; i++) {
      left[i] = out[i * 2];
      right[i] = out[i * 2 + 1];
    }
    if (channels && this.captureChannels) channels.set(apu.outChannels.subarray(0, frames * 4));
    apu.consume(frames);
  }
}
