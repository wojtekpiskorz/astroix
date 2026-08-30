/// <reference types="vite/client" />

declare module '*.css?inline' {
  const css: string;
  export default css;
}

declare module 'vite/types/customEvent' {
  interface CustomEventMap {
    'astroix:file-changed': { file: string };
    'astroix:routes-changed': Record<string, never>;
    'astroix:content-synced': Record<string, never>;
  }
}
