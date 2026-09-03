import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGED_ELECTRON_PIN,
  PACKAGED_NODE_PIN,
  verifyPackagedAssets,
} from '../../../packages/runtime/src/internal/packaged-assets.ts';

/**
 * The packaged-runtime verification step (#244, H2; ADR-0008's
 * "verification runs again after ZIP extraction"): verifies one
 * assembled or extracted resources root through the SAME internal
 * packaged-asset adapter the app boots with — pins, layout, containment,
 * symlink policy, executable identity, and every SHA-256 — and reports
 * the sanitized verdict. The pin table's Electron pin is the expectation
 * here (a raw-Node script has no running Electron); the app itself
 * additionally checks the manifest against its own live Electron.
 *
 * Locally-run tooling, never a CI gate (like the assembly it checks):
 * `npm run verify:runtime -- <resourcesRoot>` (default:
 * `apps/desktop/resources`, the assembly output). Exit code 1 on any
 * rejection — there is no fallback layout to try.
 */

const DEFAULT_ROOT = fileURLToPath(new URL('../resources/', import.meta.url));
const root = resolve(process.argv[2] ?? DEFAULT_ROOT);

const verified = await verifyPackagedAssets({
  resourcesRoot: root,
  architecture: process.arch,
  electronVersion: PACKAGED_ELECTRON_PIN,
});

if ('code' in verified) {
  console.error(`verify-runtime: REJECTED ${JSON.stringify(verified)}`);
  process.exit(1);
}

console.log(
  `verify-runtime: passed — node executable and control-plane entry resolved under ${root} (pins verified against the adapter's table: node ${PACKAGED_NODE_PIN}, electron ${PACKAGED_ELECTRON_PIN})`,
);
console.log(`verify-runtime: node executable: ${verified.nodeExecutable}`);
console.log(`verify-runtime: control-plane entry: ${verified.controlPlaneEntry}`);
console.log(`verify-runtime: execArgv: ${JSON.stringify(verified.execArgv)}`);
