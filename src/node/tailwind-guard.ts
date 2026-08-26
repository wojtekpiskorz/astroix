import type { AstroUserConfig } from 'astro';

/**
 * Guard: skip our Tailwind plugin when the host already registered one.
 * The `@tailwindcss/vite` factory returns an array whose plugin names start
 * with `@tailwindcss/vite:` (verified on 4.x) — that prefix is the check.
 */
export function hostRegistersTailwind(viteConfig: AstroUserConfig['vite']): boolean {
  const seen = new Set<string>();
  const walk = (input: unknown): void => {
    if (Array.isArray(input)) {
      for (const entry of input) walk(entry);
      return;
    }
    if (!input || typeof input !== 'object') return;
    const plugin = input as { name?: unknown };
    if (typeof plugin.name === 'string') seen.add(plugin.name);
  };
  walk(viteConfig?.plugins);
  for (const name of seen) {
    if (name.startsWith('@tailwindcss/vite')) return true;
  }
  return false;
}
