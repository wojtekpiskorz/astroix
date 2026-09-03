import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type PackagedAssetFailure,
  verifyPackagedAssets,
} from '@wojciechpiskorz/astroix-runtime/internal/packaged-assets';

/**
 * The desktop host's runtime-asset resolution (#244, H2): the one seam
 * that decides WHERE the control-plane child's spawn ingredients come
 * from — the packaged immutable resources (verified through the internal
 * packaged-asset adapter) or the controlled dev-checkout artifacts (H1's
 * explicit-executable law) — and nothing else.
 *
 * The no-fallback law (ADR-0008) is structural here, not advisory:
 * packaged mode reads ONLY the resources root (a missing, altered,
 * symlinked, wrong-Node, wrong-architecture, or wrong-Electron layout
 * rejects — no PATH search, no developer Node, no Electron RunAsNode,
 * and never the dev environment variable), and dev mode reads ONLY the
 * explicit `ASTROIX_DESKTOP_NODE` executable (never the resources root).
 * Neither mode may consult the other's source: a packaged boot with a
 * developer Node installed is still exactly the bundled Node, and a dev
 * boot with packaged-looking resources beside it still uses the declared
 * checkout executable.
 *
 * The resolution is Electron-deaf on purpose: the host facts arrive as
 * data, so the focused units fake them and the main wiring supplies
 * Electron's own (`app.isPackaged`, `process.resourcesPath`,
 * `process.versions.electron`, `process.arch`).
 *
 * Rejections are sanitized end to end — the packaged-asset adapter's
 * failure vocabulary (codes and relative resource ids) plus this layer's
 * one dev code — so the fail-closed boot diagnostic can never leak an
 * absolute packaged path or a hash into a public error surface.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The dev-checkout child entry and its raw-Node register (the #230/#240
 * idiom; the packaged rebased entry needs neither). The dev artifacts
 * live at the DESKTOP PACKAGE ROOT, located by the raw-Node register
 * marker — the one checkout artifact the dev spawn needs by name. Two
 * controlled layouts exist, both named here: the bundled main the smoke
 * and dev Electron boots run (`dist-main/main.js`, where this module's
 * code lands one level below the root) and the unbundled module import
 * (`src/runtime-assets/`, two levels below). `import.meta.url` follows
 * the bundled chunk, so the anchoring must hold for both — anything
 * else is drift, never a search.
 */
export function devCheckoutRoot(fromDirectory: string): string | null {
  for (const candidate of [join(fromDirectory, '..'), join(fromDirectory, '..', '..')]) {
    if (existsSync(join(candidate, 'raw-node-register.mjs'))) return candidate;
  }
  return null;
}

const DEV_CHILD_ENTRY_SUFFIX = join('src', 'main', 'control-plane-child.ts');
const DEV_RAW_NODE_REGISTER = 'raw-node-register.mjs';

/** The dev environment variable naming the explicit control-plane-child executable (H1's law: an EXPLICIT node, never a discovery). */
export const DEV_NODE_EXECUTABLE_ENV = 'ASTROIX_DESKTOP_NODE';

/** The host facts the resolution runs on — everything Electron-specific arrives as data. */
export interface RuntimeAssetHostFacts {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly electronVersion: string;
  readonly architecture: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The resolved spawn ingredients for the control-plane child — internal to the host, never a public surface. */
export interface RuntimeAssets {
  readonly mode: 'packaged' | 'dev';
  /** The absolute Node executable — the one every runtime spawn uses, `shell: false` always. */
  readonly nodeExecutable: string;
  /** The control-plane child entry (the rebased plain-ECMAScript bundle when packaged, the checkout source in dev). */
  readonly controlPlaneEntry: string;
  /** Node CLI flags before the entry — the dev loaders in dev, none when packaged. */
  readonly execArgv: readonly string[];
  /** The child's working directory. */
  readonly childCwd: string;
}

/** Why resolution refused — sanitized: codes and the adapter's sanitized failure, never paths or hashes. */
export type RuntimeAssetsRejection =
  | { readonly code: 'packaged-resources-rejected'; readonly failure: PackagedAssetFailure }
  | { readonly code: 'dev-node-executable-required' }
  | { readonly code: 'dev-checkout-unavailable' };

/**
 * Resolves the control-plane child's runtime assets for this host boot.
 * Fail-closed in both modes with no cross-mode fallback: packaged
 * verification must pass before any spawn exists, and dev requires the
 * explicit executable declaration.
 */
export async function resolveRuntimeAssets(
  facts: RuntimeAssetHostFacts,
): Promise<RuntimeAssets | RuntimeAssetsRejection> {
  if (facts.isPackaged) {
    return resolvePackaged(facts);
  }
  return resolveDev(facts.env);
}

async function resolvePackaged(
  facts: RuntimeAssetHostFacts,
): Promise<RuntimeAssets | RuntimeAssetsRejection> {
  const verified = await verifyPackagedAssets({
    resourcesRoot: facts.resourcesPath,
    architecture: facts.architecture,
    electronVersion: facts.electronVersion,
  });
  if ('code' in verified) {
    return { code: 'packaged-resources-rejected', failure: verified };
  }
  return {
    mode: 'packaged',
    nodeExecutable: verified.nodeExecutable,
    controlPlaneEntry: verified.controlPlaneEntry,
    execArgv: verified.execArgv,
    childCwd: dirname(verified.controlPlaneEntry),
  };
}

function resolveDev(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeAssets | RuntimeAssetsRejection {
  const declared = env[DEV_NODE_EXECUTABLE_ENV];
  if (declared === undefined || declared.length === 0) {
    return { code: 'dev-node-executable-required' };
  }
  const checkoutRoot = devCheckoutRoot(HERE);
  if (checkoutRoot === null) {
    return { code: 'dev-checkout-unavailable' };
  }
  return {
    mode: 'dev',
    nodeExecutable: resolve(declared),
    controlPlaneEntry: join(checkoutRoot, DEV_CHILD_ENTRY_SUFFIX),
    execArgv: [
      '--experimental-transform-types',
      '--import',
      join(checkoutRoot, DEV_RAW_NODE_REGISTER),
    ],
    childCwd: checkoutRoot,
  };
}

/**
 * A detail value may print only when it is version-shaped: lowercase
 * version-string charset (digits, lowercase letters, `.`, `+`, `_`,
 * `-`), at most 32 bytes. The manifest schema accepts arbitrary
 * non-empty strings for its pin fields, so a tampered manifest can put
 * ANY bytes — a path shape, a hostile line — into a pin-mismatch detail;
 * those elide rather than print. The printed vocabulary stays exactly
 * what this module claims: codes, relative resource ids, and
 * version-level detail, never attacker-chosen bytes.
 */
const PRINTABLE_DETAIL_VALUE = /^[0-9a-z.+_-]{1,32}$/;

/** One detail entry as it may print — version-shaped values verbatim, anything else elided. */
function printableDetailEntry(key: string, value: string): string {
  return `${key}=${PRINTABLE_DETAIL_VALUE.test(value) ? value : '<elided>'}`;
}

/**
 * The sanitized fail-closed boot diagnostic — the one line main may
 * print (its console is a public surface): codes, relative resource ids,
 * and pin-level detail only, never an absolute packaged path or a hash.
 */
export function runtimeAssetsBootDiagnostic(rejection: RuntimeAssetsRejection): string {
  if (rejection.code === 'dev-node-executable-required') {
    return `dev boot requires the explicit control-plane-child executable (${DEV_NODE_EXECUTABLE_ENV}); there is no PATH search, no system Node, and no Electron-as-Node`;
  }
  if (rejection.code === 'dev-checkout-unavailable') {
    return 'dev boot cannot locate the controlled checkout artifacts (the desktop package root carrying the raw-Node register and the control-plane child entry); packaged execution has no fallback';
  }
  const failure = rejection.failure;
  const resource = failure.resource === undefined ? '' : ` resource=${failure.resource}`;
  const detail =
    failure.detail === undefined
      ? ''
      : ` ${Object.entries(failure.detail)
          .map(([key, value]) => printableDetailEntry(key, value))
          .join(' ')}`;
  return `packaged runtime resources rejected (code=${failure.code}${resource}${detail}); there is no fallback — reinstall the app`;
}
