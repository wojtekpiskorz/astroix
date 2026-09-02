/**
 * The exact-child spawn discipline (#231, ADR-0005 process topology +
 * ADR-0006 §8): every child the control plane creates is described by an
 * {@link ExactChildPlan} — an absolute executable plus an explicit argv,
 * the canonical (realpath'd) project root as cwd, `shell: false`, and an
 * explicit whitelisted environment. Nothing is ever discovered through a
 * shell, a PATH lookup, or environment inheritance, and no plan carries a
 * PID: cleanup authority is the live child handle the spawner retains
 * (ADR-0006 §8 — persisted PIDs are never kill authority).
 */

/** One exact child the control plane spawns and retains. */
export interface ExactChildPlan {
  /** The absolute executable path — never a bare name, never a shell string. */
  readonly executable: string;
  /** The explicit argv — one entry per argument, never a shell-parsed string. */
  readonly argv: readonly string[];
  /** The canonical (realpath'd) project root the child runs in. */
  readonly cwd: string;
  /** The explicit child environment — the {@link minimalChildEnv} species, never inherited. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Whether the child is spawned with a Node IPC channel (`stdio` … `'ipc'`)
   * so the spawner can hold the worker's private wire. Structurally part of
   * the plan so no spawn call ever decides transport on its own.
   */
  readonly ipc: boolean;
  /** Node CLI flags placed before the module (worker children only). */
  readonly execArgv?: readonly string[];
}

/** Keys a supervised child environment may carry — everything else is dropped. */
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const;

/** Set for every supervised child: telemetry stays off, always. */
const CHILD_ENV_FIXED = { ASTRO_TELEMETRY_DISABLED: '1' } as const;

/**
 * The deliberately minimal, whitelisted child environment (#231, the D3
 * `minimalChildEnv` species minus `CI` — that flag belongs to the
 * certification host, and a supervised user project is not CI): the
 * spawner's own environment is NOT inherited, so vitest/Vite state
 * (`NODE_ENV`, `VITE_*`, poisoned `NODE_OPTIONS`, secrets) can never leak
 * into a managed project's processes. Children get only what a project
 * process needs; unknown keys — however innocuous — are dropped rather
 * than passed through.
 */
export function minimalChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = { ...CHILD_ENV_FIXED };
  for (const key of CHILD_ENV_KEYS) {
    const value = parent[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}
