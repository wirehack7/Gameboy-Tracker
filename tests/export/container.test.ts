/**
 * WebM and Ogg Opus muxers. The browser's WebCodecs encoders are not
 * available in Node, so ffmpeg encodes real VP8 and Opus streams, the tests
 * take their frames out of the IVF and Ogg files with small readers of their
 * own, mux them again and check that ffmpeg decodes the result to exactly the
 * same pictures and samples. Runs when ffmpeg is installed (CI sets FFMPEG=1).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { muxOggOpus, oggCrc, opusHead } from '../../src/export/ogg';
import { muxWebm, vint } from '../../src/export/webm';

function hasFfmpeg() {
  if (process.env.FFMPEG) return true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'mux-'));
const ffmpeg = (...args: string[]) =>
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-y', ...args], {
    maxBuffer: 1 << 28,
  });

/** Frames of an IVF file (VP8 key frames have bit 0 of the first byte clear). */
function readIvf(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset);
  const [rateNum, rateDen] = [v.getUint32(16, true), v.getUint32(20, true)];
  const frames: { pts: number; key: boolean; data: Uint8Array }[] = [];
  for (let o = v.getUint16(6, true); o < b.length; ) {
    const size = v.getUint32(o, true);
    const pts = v.getUint32(o + 4, true);
    const data = b.subarray(o + 12, o + 12 + size);
    frames.push({ pts, key: (data[0] & 1) === 0, data });
    o += 12 + size;
  }
  return {
    width: v.getUint16(12, true),
    height: v.getUint16(14, true),
    frameUs: (1e6 * rateDen) / rateNum,
    frames,
  };
}

/** Packets and last granule position of an Ogg stream. */
function readOgg(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset);
  const packets: Uint8Array[] = [];
  let current: number[] = [];
  let granule = 0;
  for (let o = 0; o < b.length; ) {
    expect(String.fromCharCode(...b.subarray(o, o + 4))).toBe('OggS');
    const n = b[o + 26];
    const lacing = b.subarray(o + 27, o + 27 + n);
    granule = v.getUint32(o + 6, true) + v.getUint32(o + 10, true) * 2 ** 32;
    let d = o + 27 + n;
    for (const l of lacing) {
      current.push(...b.subarray(d, d + l));
      d += l;
      if (l < 255) {
        packets.push(Uint8Array.from(current));
        current = [];
      }
    }
    o = d;
  }
  return { packets, granule };
}

/** Samples (48 kHz) in an Opus packet, from its TOC byte (RFC 6716, 3.1). */
function opusSamples(p: Uint8Array): number {
  const config = p[0] >> 3;
  const ms =
    config < 12 ? [10, 20, 40, 60][config % 4] : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4];
  const code = p[0] & 3;
  const count = code === 0 ? 1 : code < 3 ? 2 : p[1] & 0x3f;
  return (count * ms * 48000) / 1000;
}

function sources() {
  const ivf = join(dir, 'src.ivf');
  const ogg = join(dir, 'src.ogg');
  ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2.4:size=160x120:rate=25',
    '-c:v',
    'libvpx',
    '-g',
    '12',
    '-b:v',
    '300k',
    ivf,
  );
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.4', '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', ogg);
  const video = readIvf(readFileSync(ivf));
  const { packets, granule } = readOgg(readFileSync(ogg));
  const preSkip = new DataView(packets[0].buffer).getUint16(10, true);
  return { ivf, ogg, video, audio: packets.slice(2), preSkip, granule };
}

describe('container basics', () => {
  it('writes EBML sizes as variable-length integers', () => {
    expect(vint(0)).toEqual([0x80]);
    expect(vint(1)).toEqual([0x81]);
    expect(vint(126)).toEqual([0xfe]);
    expect(vint(127)).toEqual([0x40, 0x7f]); // 0xff is reserved for "unknown size"
    expect(vint(0x3ffe)).toEqual([0x7f, 0xfe]);
    expect(vint(0x3fff)).toEqual([0x20, 0x3f, 0xff]);
  });

  it('uses the Ogg CRC-32 and the RFC 7845 OpusHead', () => {
    // CRC-32/MPEG-2 without the final inversion and init: check value of "123456789".
    expect(oggCrc(new TextEncoder().encode('123456789'))).toBe(0x89a1897f);
    const head = opusHead(2, 312, 44100);
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe('OpusHead');
    expect([...head.subarray(8, 19)]).toEqual([1, 2, 0x38, 0x01, 0x44, 0xac, 0, 0, 0, 0, 0]);
  });
});

describe.runIf(hasFfmpeg())('muxers against ffmpeg', () => {
  const src = hasFfmpeg() ? sources() : null!;

  it('Ogg Opus decodes to exactly the samples of the original stream', () => {
    const totalSamples = src.granule - src.preSkip;
    const ogg = muxOggOpus({
      packets: src.audio.map((data) => ({ data, samples: opusSamples(data) })),
      channels: 2,
      preSkip: src.preSkip,
      inputSampleRate: 44100,
      totalSamples,
      tags: { TITLE: 'Test', ARTIST: 'GB Tracker' },
    });
    const file = join(dir, 'mine.opus');
    writeFileSync(file, ogg);
    const pcm = (f: string) => ffmpeg('-i', f, '-f', 's16le', '-');
    const mine = pcm(file);
    const ref = pcm(src.ogg);
    expect(mine.length).toBe(ref.length);
    expect(mine.equals(ref)).toBe(true);
    expect(Math.abs(mine.length / 4 - totalSamples)).toBeLessThanOrEqual(src.preSkip);
    const tags = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream_tags',
      '-of',
      'json',
      file,
    ]).toString();
    expect(tags).toMatch(/"TITLE": "Test"/i);
  });

  it('WebM with VP8 and Opus decodes to the same pictures and sound', () => {
    const { video, audio, preSkip } = src;
    let t = 0;
    const audioFrames = audio.map((data) => {
      const frame = {
        track: 2,
        timestampUs: (t * 1e6) / 48000,
        key: true,
        data,
      };
      t += opusSamples(data);
      return frame;
    });
    const webm = muxWebm({
      tracks: [
        { codec: 'V_VP8', width: video.width, height: video.height },
        {
          codec: 'A_OPUS',
          sampleRate: 48000,
          channels: 2,
          codecPrivate: opusHead(2, preSkip, 48000),
          codecDelayNs: Math.round((preSkip / 48000) * 1e9),
          seekPreRollNs: 80000000,
        },
      ],
      frames: [
        ...video.frames.map((f) => ({
          track: 1,
          timestampUs: f.pts * video.frameUs,
          key: f.key,
          data: f.data,
        })),
        ...audioFrames,
      ],
      durationMs: 2400,
      title: 'Test',
    });
    const file = join(dir, 'mine.webm');
    writeFileSync(file, webm);
    expect([...webm.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

    const md5s = (f: string) =>
      ffmpeg('-i', f, '-map', '0:v', '-f', 'framemd5', '-')
        .toString()
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(',').at(-1)!.trim());
    const ours = md5s(file);
    expect(ours).toHaveLength(video.frames.length);
    expect(ours).toEqual(md5s(src.ivf));

    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]).toString(),
    );
    expect(probe.format.format_name).toContain('webm');
    expect(Number(probe.format.duration)).toBeCloseTo(2.4, 1);
    expect(probe.streams.map((s: { codec_name: string }) => s.codec_name)).toEqual(['vp8', 'opus']);

    // Same Opus packets, same decoder: the sound matches the Ogg original.
    const pcm = (f: string) => ffmpeg('-i', f, '-map', '0:a', '-f', 's16le', '-');
    const ref = pcm(src.ogg);
    const mine = pcm(file);
    expect(Math.abs(mine.length - ref.length)).toBeLessThanOrEqual(48000 * 4 * 0.03);
    const n = Math.min(mine.length, ref.length);
    expect(mine.subarray(0, n).equals(ref.subarray(0, n))).toBe(true);
  });
});
