import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Mounts the builder chrome into a shadow DOM attached to `host` (scaffold
 * stage — placeholder tree; the Content/CSS tabs land with the chrome tasks).
 */
export function mountChrome(host: HTMLElement): void {
  const shadow = host.attachShadow({ mode: 'open' });
  createRoot(shadow).render(
    <StrictMode>
      <div data-astroix-chrome>Astroix chrome</div>
    </StrictMode>,
  );
}
