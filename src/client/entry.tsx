import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './react-guard';
import { chromeSheet } from './styles';

const queryClient = new QueryClient();

export function mountChrome(): void {
  const host = document.getElementById('astroix-root');
  if (host === null) {
    throw new Error('astroix: #astroix-root is missing from the chrome document');
  }
  // the chrome's seat at the hot channel: announces itself so the node-side
  // shield can route Astro's sync `full-reload`s around it — the chrome is a
  // stateful SPA, the canvas reloads in its place (spec #13/#74)
  import.meta.hot?.send('astroix:chrome', {});
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
