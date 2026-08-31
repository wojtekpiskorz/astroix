import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './react-guard';
import { chromeSheet } from './styles';

const queryClient = new QueryClient();

/** How the chrome reached the document (ADR-0001) — pinned for the e2e lanes. */
export type ChromeMode = 'source' | 'prebuilt';

export function mountChrome(mode: ChromeMode): void {
  const host = document.getElementById('astroix-root');
  if (host === null) {
    throw new Error('astroix: #astroix-root is missing from the chrome document');
  }
  // the mode discriminator: each lane asserts the delivery mode it boots, so
  // a staging regression (source mode silently gone, #150) fails a spec
  // instead of living on undetected
  host.dataset.astroixChromeMode = mode;
  // the chrome's seat at the hot channel: announces itself so the node-side
  // shield can route Astro's sync `full-reload`s around it — the chrome is a
  // stateful SPA, the canvas reloads in its place (spec #13/#74). The
  // announce dispatches a window CustomEvent (#166): `import.meta.hot` here
  // is dead-code-eliminated from the lib bundle; the hot→window bridge in
  // the virtual chrome module (registered before this call in both delivery
  // arms) carries it to `hot.send`
  window.dispatchEvent(new CustomEvent('astroix:chrome'));
  // createRoot(shadowRoot) is the documented React pattern for shadow DOM;
  // events delegated at the root work inside the boundary (stack #4). The
  // chrome stylesheet is adopted on both documents (see styles.ts).
  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, chromeSheet];
  createRoot(shadowRoot).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
