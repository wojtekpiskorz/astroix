import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AdapterErrorDetails } from './adapter-error';
import { AdapterError } from './adapter-error';
import type { ExactPair } from './certified-pair';

/**
 * Pair resolution from the managed project's own installation (ADR-0005:
 * "Astro and Vite resolve from the managed project's own installation").
 * This is the resolution layer ONLY — it reads manifests and never
 * imports Astro or Vite behavior; imports happen in `composition.ts`,
 * strictly after the pair gate. Negative pair tests stub this layer
 * (fake manifests in temp installs), never the behavior layer (#225).
 *
 * The root is canonicalized (`fs.realpath`) before resolution: mixing
 * `/var` and `/private/var` forms breaks Astro's compile-metadata key and
 * can duplicate the project root (#206 implementation constraint 1).
 */

/** The managed dependencies the adapter certifies — exactly these two, no others. */
type ManagedDependency = 'astro' | 'vite';

/**
 * The canonical (realpath'd) managed project root — every adapter entry
 * resolves from this form so no seam ever observes two spellings of one
 * project.
 */
export async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  return realpath(projectRoot);
}

/**
 * Resolves the installed Astro and Vite versions from `projectRoot`'s own
 * installation. Fails closed (`dependency-unresolved`) when either
 * dependency does not resolve from the project or its manifest carries no
 * string version — with sanitized diagnostics that never name the root.
 */
export async function resolveInstalledPair(projectRoot: string): Promise<ExactPair> {
  const root = await canonicalProjectRoot(projectRoot);
  const projectRequire = createRequire(join(root, 'package.json'));
  const astro = await readInstalledVersion(projectRequire, 'astro');
  const vite = await readInstalledVersion(projectRequire, 'vite');
  return { astro, vite };
}

async function readInstalledVersion(
  projectRequire: NodeRequire,
  name: ManagedDependency,
): Promise<string> {
  let manifestPath: string;
  try {
    manifestPath = projectRequire.resolve(`${name}/package.json`);
  } catch (cause) {
    throw unresolvedError(name, 'not-resolvable', cause);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    throw unresolvedError(name, 'versionless-manifest', cause);
  }
  const version = (manifest as { version?: unknown })?.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw unresolvedError(name, 'versionless-manifest');
  }
  return version;
}

function unresolvedError(
  dependency: 'astro' | 'vite',
  reason: 'not-resolvable' | 'versionless-manifest',
  cause?: unknown,
): AdapterError {
  const details: AdapterErrorDetails = { dependency, reason };
  const what =
    reason === 'not-resolvable'
      ? 'does not resolve from the managed project installation'
      : 'has a manifest with no string version';
  return new AdapterError(
    'dependency-unresolved',
    `AstroProjectAdapter compatibility rejection: the managed project dependency ${dependency} ${what}; failed contract: Astro and Vite must resolve from the managed project's own installation`,
    details,
    { cause },
  );
}
