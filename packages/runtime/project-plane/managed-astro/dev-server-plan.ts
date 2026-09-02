import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { canonicalProjectRoot } from '../../astro-project-adapter/installed-pair.ts';
import { type ExactChildPlan, minimalChildEnv } from '../supervision/exact-child.ts';

/**
 * The managed dev server's exact-child plan (#231, ADR-0005 "Real
 * configuration and duplicate hooks"): the PROJECT'S OWN `astro dev`,
 * resolved from the managed project's installation and spawned with an
 * explicit Node executable plus argv out of the canonical project root —
 * so the dev server loads the project's real configuration and executes
 * its real integrations exactly as in any other dev run (the accepted
 * duplicate-hook cost). No synthetic config is ever constructed here, no
 * shell, no PATH lookup, no inherited environment: the plan is the whole
 * spawn truth (ADR-0008 — project-plane processes execute with the exact
 * stock Node the control plane runs, never a shell-discovered one).
 */

/** Failed to resolve a runnable `astro` CLI from the managed project's own installation. */
export class ManagedDevServerPlanError extends Error {
  constructor(
    readonly code: 'astro-cli-unresolved',
    message: string,
  ) {
    super(message);
    this.name = 'ManagedDevServerPlanError';
  }
}

export interface ManagedDevServerPlanInput {
  /** The managed project root; canonicalized (realpath) before anything resolves from it. */
  readonly projectRoot: string;
  /** The loopback port the dev server is told to serve on (`--host 127.0.0.1`, ADR-0007). */
  readonly port: number;
  /**
   * The Node executable for the child; defaults to the control plane's own
   * `process.execPath` — the bundled stock Node in the packaged runtime.
   */
  readonly nodeExecutable?: string;
}

/**
 * Resolves the managed dev server's exact-child plan: canonical root, the
 * project's own astro CLI entry, `dev --port <port> --host 127.0.0.1`,
 * and the whitelisted child environment. Fails closed (sanitized — the
 * message never names the root or the path) when the project's
 * installation exposes no runnable astro CLI.
 */
export async function managedDevServerPlan(
  input: ManagedDevServerPlanInput,
): Promise<ExactChildPlan> {
  const root = await canonicalProjectRoot(input.projectRoot);
  const cliPath = await resolveAstroCli(root);
  return {
    executable: input.nodeExecutable ?? process.execPath,
    argv: [cliPath, 'dev', '--port', String(input.port), '--host', '127.0.0.1'],
    cwd: root,
    env: minimalChildEnv(process.env),
    ipc: false,
  };
}

/** Resolves the project's own astro CLI entry from its installation — the manifest's `bin`, confined to the astro package directory and verified to exist. */
async function resolveAstroCli(root: string): Promise<string> {
  const projectRequire = createRequire(join(root, 'package.json'));
  let manifestPath: string;
  try {
    manifestPath = projectRequire.resolve('astro/package.json');
  } catch {
    throw unresolved();
  }
  let bin: unknown;
  try {
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    bin = (manifest as { bin?: unknown } | null)?.bin;
  } catch {
    throw unresolved();
  }
  const entry =
    typeof bin === 'object' && bin !== null
      ? (bin as { astro?: unknown }).astro
      : typeof bin === 'string'
        ? bin
        : undefined;
  if (typeof entry !== 'string' || entry.length === 0) throw unresolved();
  // Containment: the manifest's bin entry may name anything lexically —
  // resolve it and require it to stay inside the astro package directory,
  // so "the project's own astro CLI" is literal, never a discovered
  // executable elsewhere on disk. An escaping entry fails closed.
  const packageDirectory = dirname(manifestPath);
  const cliPath = resolve(packageDirectory, entry);
  if (!cliPath.startsWith(`${packageDirectory}${sep}`)) throw unresolved();
  try {
    const stats = await stat(cliPath);
    if (!stats.isFile()) throw unresolved();
  } catch {
    throw unresolved();
  }
  return cliPath;
}

function unresolved(): ManagedDevServerPlanError {
  return new ManagedDevServerPlanError(
    'astro-cli-unresolved',
    "the managed project installation exposes no runnable astro CLI; failed contract: the managed dev server must be the project's own astro, resolved from its own installation",
  );
}
