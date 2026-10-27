import type { HtmlTagDescriptor, Plugin } from 'vite';

export interface AnalyticsConfig {
  /** Base URL of the Umami instance, e.g. https://umami.example.com */
  host: string;
  websiteId: string;
}

/**
 * Reads the Umami settings from the environment (UMAMI_HOST, UMAMI_WEBSITE_ID).
 * The Pages workflow sets them from repository variables; without both of them
 * (local and CI builds, forks) the site is built without any tracking.
 */
export function analyticsConfig(env: Record<string, string | undefined> = process.env): AnalyticsConfig | null {
  const host = env.UMAMI_HOST?.trim().replace(/\/+$/, '');
  const websiteId = env.UMAMI_WEBSITE_ID?.trim();
  if (!host || !websiteId) return null;
  if (!/^[\w-]+$/.test(websiteId)) throw new Error('UMAMI_WEBSITE_ID must be a plain id');
  const url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`);
  return { host: url.href.replace(/\/+$/, ''), websiteId };
}

/**
 * The inline loader: adds Umami's tracker (script.js) and session recorder
 * (recorder.js) unless the browser sends Do Not Track.
 */
export function analyticsLoader({ host, websiteId }: AnalyticsConfig): string {
  const scripts = JSON.stringify(['script.js', 'recorder.js'].map((f) => `${host}/${f}`));
  return (
    `(function(){var n=navigator,d=n.doNotTrack||window.doNotTrack||n.msDoNotTrack;` +
    `if(d==='1'||d==='yes'||n.globalPrivacyControl===true)return;` +
    `${scripts}.forEach(function(u){var s=document.createElement('script');s.defer=true;s.src=u;` +
    `s.setAttribute('data-website-id',${JSON.stringify(websiteId)});document.head.appendChild(s);});})();`
  );
}

/** Injects the Umami loader into every page of a production build when configured. */
export function analytics(config = analyticsConfig()): Plugin {
  return {
    name: 'gb-tracker-analytics',
    apply: 'build',
    transformIndexHtml(): HtmlTagDescriptor[] {
      if (!config) return [];
      return [{ tag: 'script', children: analyticsLoader(config), injectTo: 'head' }];
    },
  };
}
