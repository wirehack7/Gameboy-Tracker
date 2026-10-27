import type { HtmlTagDescriptor, Plugin } from 'vite';

/**
 * The analytics snippet of the live site: raw HTML (usually one or more
 * <script> tags) from the TRACKING_CODE environment variable, which the Pages
 * workflow sets from a repository variable. Without it (local, dev and CI
 * builds, forks) the site is built without any tracking.
 */
export function trackingCode(env: Record<string, string | undefined> = process.env): string | null {
  return env.TRACKING_CODE?.trim() || null;
}

/**
 * An inline loader that adds the snippet's elements to <head> unless the
 * browser sends Do Not Track or Global Privacy Control. Scripts are rebuilt
 * from their attributes and text, because parsed <script> elements don't run.
 */
export function trackingLoader(code: string): string {
  // Escape "<" so the snippet cannot end the inline script early.
  const html = JSON.stringify(code).replace(/</g, '\\u003c');
  return (
    `(function(){var n=navigator,d=n.doNotTrack||window.doNotTrack||n.msDoNotTrack;` +
    `if(d==='1'||d==='yes'||n.globalPrivacyControl===true)return;` +
    `var t=document.createElement('template');t.innerHTML=${html};` +
    `Array.prototype.forEach.call(t.content.childNodes,function(el){if(el.nodeType!==1)return;` +
    `if(el.tagName==='SCRIPT'){var s=document.createElement('script');` +
    `Array.prototype.forEach.call(el.attributes,function(a){s.setAttribute(a.name,a.value);});` +
    `s.text=el.text;el=s;}else el=document.importNode(el,true);document.head.appendChild(el);});})();`
  );
}

/** Injects the tracking loader into every page of a production build when TRACKING_CODE is set. */
export function analytics(code = trackingCode()): Plugin {
  return {
    name: 'gb-tracker-analytics',
    apply: 'build',
    transformIndexHtml(): HtmlTagDescriptor[] {
      if (!code) return [];
      return [{ tag: 'script', children: trackingLoader(code), injectTo: 'head' }];
    },
  };
}
