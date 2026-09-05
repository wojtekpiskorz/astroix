import { PRODUCT_MINIMUM_MACOS } from '../../apps/desktop/src/forge/product.ts';
import {
  PACKAGED_CERTIFIED_PAIR,
  PACKAGED_ELECTRON_PIN,
  PACKAGED_FORGE_PIN,
  PACKAGED_NODE_PIN,
} from '../../packages/runtime/src/internal/packaged-assets.ts';
import type { RepoPins } from './pins.ts';

/**
 * The repo's live pin tables, read through the SAME modules the
 * packaging pipeline and the app's own verifier rule with (#259, L2 —
 * one law, no script-side pin copy: H2's packaged-asset adapter is the
 * one source of truth for the Node/Electron/Forge/pair pins, H3's
 * product module for the minimum-OS metadata). This module imports
 * TypeScript sources and only loads under the raw-Node loader idiom
 * (`npm run candidate`); every pure consumer imports `pins.ts`
 * instead.
 */
export async function readRepoPins(): Promise<RepoPins> {
  return {
    node: PACKAGED_NODE_PIN,
    electron: PACKAGED_ELECTRON_PIN,
    forge: PACKAGED_FORGE_PIN,
    pair: { astro: PACKAGED_CERTIFIED_PAIR.astro, vite: PACKAGED_CERTIFIED_PAIR.vite },
    minimumMacOS: PRODUCT_MINIMUM_MACOS,
  };
}
