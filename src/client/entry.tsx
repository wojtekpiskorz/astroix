import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Placeholder } from './placeholder';
import './react-guard';

export function mountChrome(): void {
  const host = document.getElementById('astroix-root');
  if (host === null) {
    throw new Error('astroix: #astroix-root is missing from the chrome document');
  }
  createRoot(host).render(
    <StrictMode>
      <Placeholder />
    </StrictMode>,
  );
}
