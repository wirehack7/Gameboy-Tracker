import { afterEach, describe, expect, it, vi } from 'vitest';
import { analytics, analyticsConfig, analyticsLoader } from '../../src/analytics/plugin';
import { track } from '../../src/analytics/track';

const ID = '00000000-1111-2222-3333-444444444444';

describe('analytics config', () => {
  it('is off unless both variables are set', () => {
    expect(analyticsConfig({})).toBeNull();
    expect(analyticsConfig({ UMAMI_HOST: 'https://umami.example' })).toBeNull();
    expect(analyticsConfig({ UMAMI_WEBSITE_ID: ID })).toBeNull();
    expect(analyticsConfig({ UMAMI_HOST: '', UMAMI_WEBSITE_ID: '' })).toBeNull();
  });

  it('normalises the host', () => {
    expect(analyticsConfig({ UMAMI_HOST: 'https://umami.example/', UMAMI_WEBSITE_ID: ID })).toEqual({
      host: 'https://umami.example',
      websiteId: ID,
    });
    expect(analyticsConfig({ UMAMI_HOST: ' umami.example ', UMAMI_WEBSITE_ID: ` ${ID}\n` })?.host).toBe(
      'https://umami.example',
    );
  });

  it('rejects an id that could break out of the script', () => {
    expect(() => analyticsConfig({ UMAMI_HOST: 'umami.example', UMAMI_WEBSITE_ID: '"></script>' })).toThrow();
  });
});

describe('analytics loader', () => {
  const config = { host: 'https://umami.example', websiteId: ID };

  function run(nav: Record<string, unknown>) {
    const added: { src: string; id: string | null; defer: boolean }[] = [];
    const document = {
      createElement: () => {
        const attrs: Record<string, string> = {};
        return { defer: false, src: '', setAttribute: (k: string, v: string) => (attrs[k] = v), attrs };
      },
      head: {
        appendChild: (s: { src: string; defer: boolean; attrs: Record<string, string> }) =>
          added.push({ src: s.src, id: s.attrs['data-website-id'] ?? null, defer: s.defer }),
      },
    };
    new Function('navigator', 'window', 'document', analyticsLoader(config))(nav, {}, document);
    return added;
  }

  it('adds the tracker and the recorder', () => {
    expect(run({})).toEqual([
      { src: 'https://umami.example/script.js', id: ID, defer: true },
      { src: 'https://umami.example/recorder.js', id: ID, defer: true },
    ]);
  });

  it('respects Do Not Track and Global Privacy Control', () => {
    expect(run({ doNotTrack: '1' })).toEqual([]);
    expect(run({ globalPrivacyControl: true })).toEqual([]);
    expect(run({ doNotTrack: '0' })).toHaveLength(2);
  });

  it('is injected only when configured', () => {
    const html = (p: ReturnType<typeof analytics>) =>
      (p.transformIndexHtml as unknown as () => { children: string }[])();
    expect(html(analytics(null))).toEqual([]);
    const tags = html(analytics(config));
    expect(tags).toHaveLength(1);
    expect(tags[0].children).toContain(ID);
  });
});

describe('track', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a no-op without Umami', () => {
    vi.stubGlobal('window', {});
    expect(() => track('play')).not.toThrow();
  });

  it('forwards events and swallows errors', () => {
    const calls: unknown[] = [];
    vi.stubGlobal('window', { umami: { track: (...a: unknown[]) => calls.push(a) } });
    track('export', { format: 'xm' });
    expect(calls).toEqual([['export', { format: 'xm' }]]);
    vi.stubGlobal('window', {
      umami: {
        track: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(() => track('play')).not.toThrow();
  });
});
