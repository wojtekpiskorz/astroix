import { mountChrome } from './entry';

// Prebuilt-bundle entry (ADR-0001): the shipped chrome is one self-contained
// ESM — react/react-dom, the Tailwind-compiled CSS and CodeMirror bundled in,
// zero bare imports for the consumer's Vite to resolve. Source mode uses
// entry.tsx directly instead.
mountChrome('prebuilt');
