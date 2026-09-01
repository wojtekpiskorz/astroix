import { defineConfig } from 'astro/config';
import { observableIntegration } from './proof-integration.mjs';

const strategy = process.env.ASTROIX_PROOF_STRATEGY ?? 'attribute';
if (strategy !== 'attribute' && strategy !== 'where') {
  throw new Error(`unsupported proof scoped-style strategy: ${strategy}`);
}

export default defineConfig({
  ...(strategy === 'where' ? { scopedStyleStrategy: 'where' } : {}),
  vite: { server: { strictPort: true } },
  integrations: [
    observableIntegration({
      exclusivePath: process.env.ASTROIX_PROOF_EXCLUSIVE_PATH,
      hookLog: process.env.ASTROIX_PROOF_HOOK_LOG,
      mode: process.env.ASTROIX_PROOF_INTEGRATION_MODE ?? 'append',
      role: process.env.ASTROIX_PROOF_ROLE ?? 'unmarked',
    }),
  ],
});
