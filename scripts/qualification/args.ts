/**
 * The argument law of the packaged-qualification harness (#258, L1;
 * ADR-0008 minimal qualification): the ZIP artifact, the expected
 * checksum, and the evidence output directory are accepted EXCLUSIVELY
 * as explicit command-line flags — never from the environment, never
 * from a discovered default, never from the packaging pipeline's own
 * output tree. The harness qualifies SUPPLIED candidate bytes; whoever
 * supplies them states them, on the command line, in full.
 *
 * This module is pure by construction: it reads the argv slice the
 * caller passes and nothing else — the environment never selects or
 * overrides a candidate (the argument tests prove planted decoy
 * environment variables cannot). The environments the harness COMPOSES
 * elsewhere (the launch env, the bundled-Node identity exec) are
 * minimal explicit allowlists, never inherited from this process
 * (see `process-stage.ts` and `battery.ts`).
 */

/** The three exclusively-explicit required parameters (#258 AC-1). */
export interface QualificationArguments {
  /** The candidate ZIP — an explicit path, supplied bytes. */
  readonly artifact: string;
  /** The expected artifact SHA-256 (lower-case hex, 64 digits). */
  readonly expectedSha256: string;
  /** The evidence output directory — empty or absent, created by the harness. */
  readonly evidenceDir: string;
  /** How long the launched app must stay alive to count as launched (ms). */
  readonly settleMs: number;
  /** How long the app has to honor its own quit surface (ms). */
  readonly quitTimeoutMs: number;
}

/** Why the arguments were rejected — printed with the usage, exit code 2. */
export type ArgumentRejection =
  | { readonly code: 'missing-required'; readonly flag: string }
  | { readonly code: 'value-absent'; readonly flag: string }
  | { readonly code: 'duplicate'; readonly flag: string }
  | { readonly code: 'unknown-flag'; readonly flag: string }
  | { readonly code: 'positional-argument'; readonly value: string }
  | { readonly code: 'malformed-sha256'; readonly value: string }
  | { readonly code: 'malformed-duration'; readonly flag: string; readonly value: string };

/** The flags the harness understands — required first, optional knobs after. */
const REQUIRED_FLAGS = ['--artifact', '--expected-sha256', '--evidence'] as const;
const OPTIONAL_NUMBER_FLAGS = ['--settle-ms', '--quit-timeout-ms'] as const;

const DEFAULT_SETTLE_MS = 30_000;
const DEFAULT_QUIT_TIMEOUT_MS = 90_000;

/** Lower-case hex SHA-256, exactly 64 digits — the one accepted form. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The usage text printed on every argument rejection. */
export const USAGE = `usage: qualify --artifact <zip> --expected-sha256 <64-hex-sha256> --evidence <empty-or-absent-dir>
                 [--settle-ms <ms>] [--quit-timeout-ms <ms>]

The artifact ZIP, its expected checksum, and the evidence directory are
accepted exclusively through these explicit flags — no environment
variable can supply, override, or suggest a candidate (implicit and
env-derived candidate selection is rejected by construction).`;

/**
 * Parses one argv slice into {@link QualificationArguments}, or names
 * the rejection. Strict: unknown flags, duplicated flags, positional
 * leftovers, and malformed values reject — nothing is guessed.
 */
export function parseQualificationArguments(
  argv: readonly string[],
): QualificationArguments | ArgumentRejection {
  const flags = new Map<string, string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) break;
    if (!token.startsWith('--')) {
      return { code: 'positional-argument', value: token };
    }
    const known =
      (REQUIRED_FLAGS as readonly string[]).includes(token) ||
      (OPTIONAL_NUMBER_FLAGS as readonly string[]).includes(token);
    if (!known) {
      return { code: 'unknown-flag', flag: token };
    }
    if (flags.has(token)) {
      return { code: 'duplicate', flag: token };
    }
    const value = argv[index];
    index += 1;
    if (value === undefined || value.startsWith('--')) {
      return { code: 'value-absent', flag: token };
    }
    flags.set(token, value);
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!flags.has(flag)) {
      return { code: 'missing-required', flag };
    }
  }
  const expectedSha256 = flags.get('--expected-sha256');
  // REQUIRED_FLAGS was just proven present for all three
  if (expectedSha256 === undefined) {
    return { code: 'missing-required', flag: '--expected-sha256' };
  }
  if (!SHA256_PATTERN.test(expectedSha256)) {
    return { code: 'malformed-sha256', value: expectedSha256 };
  }
  const settleMs = parseDuration(flags.get('--settle-ms'), DEFAULT_SETTLE_MS);
  if (typeof settleMs === 'number' && !Number.isFinite(settleMs)) {
    return {
      code: 'malformed-duration',
      flag: '--settle-ms',
      value: String(flags.get('--settle-ms')),
    };
  }
  const quitTimeoutMs = parseDuration(flags.get('--quit-timeout-ms'), DEFAULT_QUIT_TIMEOUT_MS);
  if (typeof quitTimeoutMs === 'number' && !Number.isFinite(quitTimeoutMs)) {
    return {
      code: 'malformed-duration',
      flag: '--quit-timeout-ms',
      value: String(flags.get('--quit-timeout-ms')),
    };
  }
  return {
    artifact: flags.get('--artifact') as string,
    expectedSha256,
    evidenceDir: flags.get('--evidence') as string,
    settleMs: settleMs as number,
    quitTimeoutMs: quitTimeoutMs as number,
  };
}

/** One rejection as the CLI prints it. */
export function describeArgumentRejection(rejection: ArgumentRejection): string {
  switch (rejection.code) {
    case 'missing-required':
      return `missing required flag ${rejection.flag} (candidates are never implicit — pass it explicitly)`;
    case 'value-absent':
      return `flag ${rejection.flag} has no value`;
    case 'duplicate':
      return `flag ${rejection.flag} appears twice (an ambiguous candidate is rejected, never guessed)`;
    case 'unknown-flag':
      return `unknown flag ${rejection.flag}`;
    case 'positional-argument':
      return `unexpected positional argument ${rejection.value}`;
    case 'malformed-sha256':
      return `--expected-sha256 must be 64 lower-case hex digits (got ${rejection.value})`;
    case 'malformed-duration':
      return `${rejection.flag} must be a positive integer of milliseconds (got ${rejection.value})`;
  }
}

/** Parses one optional duration knob — absent yields the default, malformed yields NaN. */
function parseDuration(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    return Number.NaN;
  }
  return parsed;
}
