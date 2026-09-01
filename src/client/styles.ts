import chromeCss from '../../packages/app-shell/src/chrome.css?inline';

/**
 * Tailwind delivery per T1: ONE constructed stylesheet adopted on BOTH the
 * document and the chrome's shadow root. Shadow-only adoption kills
 * `@property` registrations (tailwindcss#15005) — dual adoption is the fix.
 * The theme entry itself lives in packages/app-shell (#218); this bootstrap
 * stays with the integration entry it styles until the retirement gate.
 */
export const chromeSheet: CSSStyleSheet = new CSSStyleSheet();
chromeSheet.replaceSync(chromeCss);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, chromeSheet];

if (import.meta.hot) {
  import.meta.hot.accept('../../packages/app-shell/src/chrome.css?inline', (mod) => {
    const css = typeof mod === 'string' ? mod : (mod?.default ?? '');
    // an empty payload means the recompile failed — keep the previous styles
    // rather than wiping the sheet
    if (css !== '') chromeSheet.replaceSync(css);
  });
}
