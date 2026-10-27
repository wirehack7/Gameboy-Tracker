import { Apu, Model, NR32 } from '../apu/apu';
import { Player } from '../tracker/player';
import { SAMPLE_START, SampleBus, sampleChunks } from '../tracker/sample';
import { CYCLES_PER_TICK, Song } from '../tracker/song';

/**
 * APU + player, clocked together: the player ticks every CYCLES_PER_TICK
 * emulated clocks, exactly like a driver running from the VBlank interrupt,
 * and samples are streamed into wave RAM like a driver's timer interrupt does.
 */
export class Engine {
  apu: Apu;
  readonly player: Player;
  /** Where the player writes: the APU plus the sample streaming. */
  bus: SampleBus;
  private untilTick = 0;

  constructor(
    song: Song,
    readonly sampleRate: number,
    readonly captureChannels = false,
  ) {
    this.apu = this.createApu(song.model);
    this.bus = new SampleBus(this.apu, song.samples.map((s) => sampleChunks(s.data)));
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
      this.bus = new SampleBus(this.apu, []);
    }
    this.bus.samples = song.samples.map((s) => sampleChunks(s.data));
    this.player.setSong(song);
  }

  play(order = 0, row = 0, loopPattern = false) {
    this.player.loopPattern = loopPattern;
    this.player.start(this.bus, order, row);
    this.untilTick = 0;
  }

  stop() {
    this.player.stop(this.bus);
  }

  /** Play a sample on its own at full volume (sample list preview). */
  previewSample(index: number) {
    if (this.player.playing) return;
    this.bus.write(NR32, 0x20);
    this.bus.write(SAMPLE_START, index);
    this.player.forgetWave();
  }

  /**
   * Render `frames` stereo samples. Per-channel output (if captured) is
   * written to `channels` as 4 interleaved values per frame.
   */
  render(left: Float32Array, right: Float32Array, frames: number, channels?: Float32Array) {
    const apu = this.apu;
    const voice = this.bus.voice;
    while (apu.outCount < frames) {
      if (this.untilTick <= 0) {
        this.player.tick(this.bus);
        this.untilTick += CYCLES_PER_TICK;
      }
      const cycles = Math.min(this.untilTick, voice.untilReload, apu.cyclesForSamples(frames - apu.outCount));
      apu.run(cycles);
      this.untilTick -= cycles;
      voice.advance(cycles, apu);
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
