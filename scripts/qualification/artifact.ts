import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sha256File } from '../../apps/desktop/src/forge/inventory.ts';

/**
 * The artifact-intake checks of the qualification harness (#258, L1):
 * everything the harness decides about the SUPPLIED ZIP before any of
 * its contents are trusted. Translated from the H6/H3 verification
 * command idioms (`verify-package.mjs`'s post-extraction pass, the
 * early-package kit's `ditto -x -k` extraction law) as parameterized
 * black-box checks:
 *
 * 1. **checksum** — the streamed SHA-256 of the supplied bytes against
 *    the explicitly expected value (the H3 candidate-manifest checksum
 *    data idiom; `sha256File` is reused from `inventory.ts` so the hash
 *    law stays one).
 * 2. **structural integrity** — `zip -T` (the CRC test) rejects a
 *    truncated or corrupted archive even before extraction.
 * 3. **extraction + shape** — `ditto -x -k` (the packaging pipeline's
 *    own extraction stage) into an isolated staging root, then the
 *    extracted root must be exactly one application bundle with its
 *    executable present — an unexpected file at the ZIP root fails
 *    closed here.
 *
 * The checks never write to the artifact and never read anything but
 * the path they were given.
 */

const execFileAsync = promisify(execFile);

/** The one product shape the artifact must present (ADR-0008 identity; H6's extraction law). */
export const EXPECTED_APP_BUNDLE_NAME = 'Astroix.app';
export const EXPECTED_APP_EXECUTABLE = 'Astroix';

/** Why a check rejected the artifact — sanitized to codes and facts, never guessed past. */
export type IntakeRejection =
  | { readonly code: 'artifact-missing'; readonly path: string }
  | { readonly code: 'artifact-not-file'; readonly path: string }
  | {
      readonly code: 'sha256-mismatch';
      readonly expected: string;
      readonly actual: string;
      readonly bytes: number;
    }
  | { readonly code: 'zip-structurally-invalid'; readonly output: string }
  | { readonly code: 'extraction-failed'; readonly output: string }
  | { readonly code: 'unexpected-zip-root'; readonly roots: readonly string[] }
  | { readonly code: 'executable-missing' };

/** What extraction proved about the artifact. */
export interface ExtractionFacts {
  readonly extractedAppPath: string;
  readonly executablePath: string;
}

export interface ChecksumOutcome {
  readonly ok: boolean;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly rejection?: IntakeRejection;
}

export interface ZipIntegrityOutcome {
  readonly ok: boolean;
  readonly rejection?: IntakeRejection;
}

export interface ExtractionOutcome {
  readonly ok: boolean;
  readonly facts?: ExtractionFacts;
  readonly rejection?: IntakeRejection;
}

/** Check 1 — the supplied bytes are exactly the expected checksum. */
export async function checksumArtifact(
  artifactPath: string,
  expectedSha256: string,
): Promise<ChecksumOutcome> {
  if (!existsSync(artifactPath)) {
    return {
      ok: false,
      bytes: null,
      sha256: null,
      rejection: { code: 'artifact-missing', path: artifactPath },
    };
  }
  const info = await stat(artifactPath).catch(() => null);
  if (info === null || !info.isFile()) {
    return {
      ok: false,
      bytes: null,
      sha256: null,
      rejection: { code: 'artifact-not-file', path: artifactPath },
    };
  }
  const sha256 = await sha256File(artifactPath);
  if (sha256 !== expectedSha256) {
    return {
      ok: false,
      bytes: info.size,
      sha256,
      rejection: {
        code: 'sha256-mismatch',
        expected: expectedSha256,
        actual: sha256,
        bytes: info.size,
      },
    };
  }
  return { ok: true, bytes: info.size, sha256 };
}

/** Check 2 — the archive's own CRCs hold (truncated and corrupted archives fail here). */
export async function testZipIntegrity(artifactPath: string): Promise<ZipIntegrityOutcome> {
  const result = await run('zip', ['-T', artifactPath], 10 * 60_000);
  if (result === null || result.code !== 0) {
    return {
      ok: false,
      rejection: {
        code: 'zip-structurally-invalid',
        output: (result?.output ?? 'the zip tool is unavailable').slice(-2000),
      },
    };
  }
  return { ok: true };
}

/** Check 3 — extract with the pipeline's own extractor and pin the extracted shape. */
export async function extractAndShape(
  artifactPath: string,
  stagingRoot: string,
): Promise<ExtractionOutcome> {
  const extractDir = join(stagingRoot, 'extracted');
  await mkdir(extractDir, { recursive: true });
  const extraction = await run('ditto', ['-x', '-k', artifactPath, extractDir], 5 * 60_000);
  if (extraction === null || extraction.code !== 0) {
    return {
      ok: false,
      rejection: {
        code: 'extraction-failed',
        output: (extraction?.output ?? 'ditto is unavailable').slice(-2000),
      },
    };
  }
  const roots = (await readdir(extractDir)).sort();
  if (roots.length !== 1 || roots[0] !== EXPECTED_APP_BUNDLE_NAME) {
    return { ok: false, rejection: { code: 'unexpected-zip-root', roots } };
  }
  const appPath = join(extractDir, EXPECTED_APP_BUNDLE_NAME);
  const executablePath = join(appPath, 'Contents', 'MacOS', EXPECTED_APP_EXECUTABLE);
  if (!existsSync(executablePath)) {
    return { ok: false, rejection: { code: 'executable-missing' } };
  }
  return { ok: true, facts: { extractedAppPath: appPath, executablePath } };
}

/** The composed intake law (checksum → structural integrity → extraction + shape). */
export async function intakeArtifact(input: {
  readonly artifactPath: string;
  readonly expectedSha256: string;
  readonly stagingRoot: string;
}): Promise<ChecksumOutcome | ZipIntegrityOutcome | ExtractionOutcome> {
  const checksum = await checksumArtifact(input.artifactPath, input.expectedSha256);
  if (!checksum.ok) return checksum;
  const integrity = await testZipIntegrity(input.artifactPath);
  if (!integrity.ok) return integrity;
  return await extractAndShape(input.artifactPath, input.stagingRoot);
}

/** One bounded command run — `null` when the tool could not even spawn (fail closed). */
async function run(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ code: number; output: string } | null> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: timeoutMs,
      encoding: 'buffer',
    });
    return { code: 0, output: Buffer.concat([result.stdout, result.stderr]).toString('utf8') };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: Buffer;
      stderr?: Buffer;
      message?: string;
    };
    if (typeof failure.code === 'number') {
      return {
        code: failure.code,
        output: Buffer.concat([
          failure.stdout ?? Buffer.alloc(0),
          failure.stderr ?? Buffer.alloc(0),
        ])
          .toString('utf8')
          .concat(failure.message ?? ''),
      };
    }
    return null;
  }
}
