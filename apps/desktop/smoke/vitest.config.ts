import { defineConfig } from 'vitest/config';

/**
 * The desktop smoke lane's own vitest config (#243): NOT part of `npm
 * test` — it launches the real Electron binary (like `certify:adapter`,
 * a locally-run lane gate, `npm run test:desktop`), so the deterministic
 * CI gates stay biome/tsc/vitest. Node environment: the tests spawn and
 * observe processes; no DOM. The document-authority spec (#246, H4)
 * and the service-worker bypass spec (#247, H5) join the same lane:
 * they too drive the real Electron binary (their own harness mains,
 * built per run) — additive includes, same gate. The early packaged
 * smoke family (#248, H6) joins the same way: it launches the REAL
 * extracted package (`npm run package`'s ZIP) and self-skips without a
 * local build — like H2's packaged-spawn lane, the run stays out of
 * `npm test` (real GUI binary, real codesign, ADR-0008 local-only).
 * The CSS inspection lane (#249, I1) joins the same way: the real
 * Electron window over the shared control-plane composition in a real
 * stock-Node child, driving the real product flow (launcher button →
 * project document → canvas selection → the read-only CSS panel). The
 * CSS auto-write lane (#250, I2) joins the same way: the real edit
 * gesture through the real rule editor, the real grant-bound
 * write-executor child, and the canvas document's own stylesheet tags
 * as the HMR reflection (the computed cascade is the web battery's
 * face of that law — occluded harness windows skip style recalc).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/desktop/smoke/desktop-smoke.test.ts',
      'e2e/desktop/css-inspection*.spec.ts',
      'e2e/desktop/css-write*.spec.ts',
      'e2e/desktop/document-authority*.spec.ts',
      'e2e/desktop/service-worker-bypass*.spec.ts',
      'e2e/desktop/early-package*.spec.ts',
    ],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    teardownTimeout: 15_000,
    fileParallelism: false,
    reporters: 'default',
  },
});
