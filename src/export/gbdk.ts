/**
 * GBDK-2020 export: the register stream as a C array plus a tiny C driver and
 * an example project. The driver only copies bytes to the APU registers once
 * per frame, so playback on hardware matches the tracker exactly.
 */
import { SAMPLE_PERIOD, SAMPLE_TAC, SAMPLE_TMA } from '../tracker/sample';
import { Song } from '../tracker/song';
import { RegisterStream, captureStream, encodeStream, optimizeStream } from './stream';
import { ZipEntry, zip } from './zip';

export function symbolName(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s || s === 'main' || s.startsWith('gbtr_')) return `song_${s}`.replace(/_$/, '');
  return /^[0-9]/.test(s) ? `song_${s}` : s;
}

/** Escape a string for a C comment / string literal. */
function cText(s: string) {
  return s.replace(/[^\x20-\x7e]/g, '?').replace(/\*\//g, '* /').replace(/["\\]/g, '\\$&');
}

export const PLAYER_H = `#ifndef GBTR_PLAYER_H
#define GBTR_PLAYER_H

#include <stdint.h>

/*
 * GB Tracker register stream player.
 *
 * Stream format:
 *   0x00-0x2F vv  write vv to register 0xFF10 + command
 *   0x30 nn       start sample nn
 *   0x31          stop the sample
 *   0x81-0xFE     wait (command & 0x7F) frames
 *   0xFF          continue at the loop offset
 *
 * Samples are streamed into wave RAM from the timer interrupt, 256 times a
 * second (16 bytes each time). Songs with samples need gbtr_set_samples().
 */

/* Start playing a song. Turns the APU on. */
void gbtr_play(const uint8_t *data, uint16_t loop_offset);

/*
 * Register the song's samples (wave RAM chunks and chunk counts) and start
 * the timer interrupt that streams them. Uses TMA/TAC and add_TIM().
 */
void gbtr_set_samples(const uint8_t * const *samples, const uint16_t *chunks);

/* Call exactly once per frame (VBlank), e.g. after vsync() or from add_VBL(). */
void gbtr_update(void);

/* Stop playback and silence all channels. */
void gbtr_stop(void);

#endif
`;

export const PLAYER_C = `#include <gb/gb.h>
#include <gb/hardware.h>
#include "gbtr_player.h"

static const uint8_t *gbtr_pos;
static const uint8_t *gbtr_loop;
static uint8_t gbtr_wait;

static const uint8_t * const *gbtr_samples;
static const uint16_t *gbtr_sample_chunks;
static const uint8_t *gbtr_smp_pos;
static uint16_t gbtr_smp_left;
static volatile uint8_t gbtr_smp_on;

/* Timer interrupt: load the next 32 nibbles and restart the wave channel. */
static void gbtr_sample_tick(void) {
    const uint8_t *s;
    volatile uint8_t *w;
    uint8_t i;
    if (!gbtr_smp_on) return;
    if (!gbtr_smp_left) {
        gbtr_smp_on = 0;
        NR30_REG = 0x00;
        return;
    }
    gbtr_smp_left--;
    s = gbtr_smp_pos;
    w = (volatile uint8_t *)0xFF30u;
    NR30_REG = 0x00; /* channel off: wave RAM is writable, no DMG corruption */
    for (i = 16; i; i--) *w++ = *s++;
    NR30_REG = 0x80;
    NR33_REG = 0x${(SAMPLE_PERIOD & 0xff).toString(16).toUpperCase().padStart(2, '0')};
    NR34_REG = 0x${(0x80 | (SAMPLE_PERIOD >> 8)).toString(16).toUpperCase()};
    gbtr_smp_pos = s;
}

void gbtr_set_samples(const uint8_t * const *samples, const uint16_t *chunks) {
    CRITICAL {
        gbtr_samples = samples;
        gbtr_sample_chunks = chunks;
        gbtr_smp_on = 0;
        remove_TIM(gbtr_sample_tick);
        add_TIM(gbtr_sample_tick);
    }
    TMA_REG = 0x${SAMPLE_TMA.toString(16).toUpperCase()};
    TAC_REG = 0x${SAMPLE_TAC.toString(16).toUpperCase().padStart(2, '0')}; /* 16384 Hz / 64 = 256 Hz */
    set_interrupts(IE_REG | TIM_IFLAG);
}

static void gbtr_sample_start(uint8_t n) {
    if (!gbtr_samples) return;
    CRITICAL {
        gbtr_smp_pos = gbtr_samples[n];
        gbtr_smp_left = gbtr_sample_chunks[n];
        gbtr_smp_on = 1;
        TIMA_REG = TMA_REG; /* next reload one full period from now */
        IF_REG &= ~TIM_IFLAG;
        gbtr_sample_tick();
    }
}

void gbtr_play(const uint8_t *data, uint16_t loop_offset) {
    gbtr_pos = 0;
    NR52_REG = 0x80;
    NR50_REG = 0x77;
    NR51_REG = 0xFF;
    gbtr_wait = 0;
    gbtr_loop = data + loop_offset;
    gbtr_pos = data;
}

void gbtr_update(void) {
    uint8_t cmd;
    if (!gbtr_pos) return;
    if (gbtr_wait) {
        gbtr_wait--;
        return;
    }
    for (;;) {
        cmd = *gbtr_pos++;
        if (cmd < 0x30) {
            *(volatile uint8_t *)(0xFF10u + cmd) = *gbtr_pos++;
        } else if (cmd == 0x30) {
            gbtr_sample_start(*gbtr_pos++);
        } else if (cmd == 0x31) {
            gbtr_smp_on = 0;
        } else if (cmd == 0xFF) {
            gbtr_pos = gbtr_loop;
        } else {
            gbtr_wait = (cmd & 0x7F) - 1;
            return;
        }
    }
}

void gbtr_stop(void) {
    gbtr_pos = 0;
    gbtr_smp_on = 0;
    NR52_REG = 0x00;
    NR52_REG = 0x80;
}
`;

/** C initialiser lines for a byte array, 16 bytes per line. */
function byteLines(data: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += 16) {
    lines.push(
      '    ' +
        Array.from(data.subarray(i, i + 16))
          .map((b) => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`)
          .join(', ') +
        ',',
    );
  }
  return lines.join('\n') || '    0x00,';
}


export function songSources(song: Song, stream: RegisterStream, name = symbolName(song.title)) {
  const { data, loopOffset } = encodeStream(optimizeStream(stream));
  const samples = stream.samples ?? [];
  const guard = `${name.toUpperCase()}_H`;
  const sampleDecl = samples.length
    ? `
/* Samples: wave RAM chunks (16 bytes each) and chunk counts. Pass both to gbtr_set_samples(). */
#define ${name.toUpperCase()}_SAMPLE_COUNT ${samples.length}u
extern const uint8_t * const ${name}_samples[];
extern const uint16_t ${name}_sample_chunks[];
`
    : '';
  const header = `#ifndef ${guard}
#define ${guard}

#include <stdint.h>

/* "${cText(song.title)}"${song.author ? ` by ${cText(song.author)}` : ''}, exported from GB Tracker (${song.model.toUpperCase()}). */

#define ${name.toUpperCase()}_SIZE ${data.length}u

extern const uint8_t ${name}_data[];
extern const uint16_t ${name}_loop;
${sampleDecl}
#endif
`;
  const sampleDefs = samples.length
    ? '\n' +
      samples
        .map(
          (chunks, i) => `/* ${cText(song.samples[i]?.name ?? '')}: ${chunks.length / 16} chunks */
const uint8_t ${name}_sample${i}[] = {
${byteLines(chunks)}
};
`,
        )
        .join('\n') +
      `
const uint8_t * const ${name}_samples[] = { ${samples.map((_, i) => `${name}_sample${i}`).join(', ')} };
const uint16_t ${name}_sample_chunks[] = { ${samples.map((c) => `${c.length / 16}u`).join(', ')} };
`
    : '';
  const source = `#include "${name}.h"

const uint16_t ${name}_loop = ${loopOffset}u;

const uint8_t ${name}_data[] = {
${byteLines(data)}
};
${sampleDefs}`;
  return { header, source, size: data.length, frames: stream.frames.length, loopFrame: stream.loopFrame };
}

export function exampleMain(song: Song, name: string, samples = song.samples.length > 0) {
  return `#include <gb/gb.h>
#include <stdio.h>
#include "gbtr_player.h"
#include "${name}.h"

void main(void) {
    printf("\\n GB TRACKER\\n\\n %s\\n", "${cText(song.title).slice(0, 18)}");
${samples ? `    gbtr_set_samples(${name}_samples, ${name}_sample_chunks);\n` : ''}    gbtr_play(${name}_data, ${name}_loop);
    while (1) {
        vsync();
        gbtr_update();
    }
}
`;
}

export function makefile(song: Song, name: string) {
  const title = cText(song.title || 'GB TRACKER')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .slice(0, 11) || 'GB TRACKER';
  const cgb = song.model === 'cgb' ? ' -Wm-yc' : '';
  return `# Builds ${name}.gb with GBDK-2020 (https://github.com/gbdk-2020/gbdk-2020).
GBDK_HOME ?= ../gbdk/
LCC = $(GBDK_HOME)bin/lcc

${name}.gb: main.c gbtr_player.c ${name}.c gbtr_player.h ${name}.h
\t$(LCC) -Wm-yn"${title}"${cgb} -o $@ main.c gbtr_player.c ${name}.c

clean:
\trm -f *.gb *.o *.lst *.map *.sym *.ihx *.noi *.asm *.rel *.cdb *.adb

.PHONY: clean
`;
}

export function readme(song: Song, name: string, size: number) {
  return `# ${song.title || 'Song'} – GBDK export

Exported from GB Tracker. The song is stored as a stream of APU register writes
(${size} bytes) and played by a small driver that runs once per frame.

## Build

\`\`\`sh
make GBDK_HOME=/path/to/gbdk/
\`\`\`

This produces \`${name}.gb\`${song.model === 'cgb' ? ' (flagged as Game Boy Color compatible)' : ''}.

## Use in your own project

1. Copy \`gbtr_player.c\`, \`gbtr_player.h\`, \`${name}.c\` and \`${name}.h\` into your project.
2. Start the song with \`gbtr_play(${name}_data, ${name}_loop);\`${
    song.samples.length
      ? `
   The song uses samples: call \`gbtr_set_samples(${name}_samples, ${name}_sample_chunks);\` once
   before. It streams them from the timer interrupt (TMA/TAC, \`add_TIM\`), 256 times a second.`
      : ''
  }
3. Call \`gbtr_update();\` once per frame, e.g. right after \`vsync()\`, or register it
   with \`add_VBL(gbtr_update);\`.
4. \`gbtr_stop();\` silences the APU.

The data lives in ROM bank 0/1. Very long songs can exceed the space of a 32 KB ROM;
in that case put \`${name}.c\` in its own bank (\`#pragma bank\`) and switch to it with
\`SWITCH_ROM()\` before calling \`gbtr_update()\`.
`;
}

export function gbdkProject(song: Song): { zip: Uint8Array; name: string; size: number } {
  const name = symbolName(song.title);
  const stream = captureStream(song);
  const src = songSources(song, stream, name);
  const entries: ZipEntry[] = [
    { name: `${name}/gbtr_player.h`, data: PLAYER_H },
    { name: `${name}/gbtr_player.c`, data: PLAYER_C },
    { name: `${name}/${name}.h`, data: src.header },
    { name: `${name}/${name}.c`, data: src.source },
    { name: `${name}/main.c`, data: exampleMain(song, name) },
    { name: `${name}/Makefile`, data: makefile(song, name) },
    { name: `${name}/README.md`, data: readme(song, name, src.size) },
  ];
  return { zip: zip(entries), name, size: src.size };
}
