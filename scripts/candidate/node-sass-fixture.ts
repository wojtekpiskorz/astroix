import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The negative fixture leg (#259, L2): drives
 * `qualification/fixtures/unsupported-node-sass/reject.mjs` over its
 * own manifest-only package.json and fails unless the screening
 * produced the charter's deterministic prelaunch rejection — the six
 * structured diagnostic fields, `installed: false`, and NO
 * installation artifact ever appearing in the fixture directory (the
 * never-installs law, checked on the real filesystem after the run).
 */

export interface SassFixtureVerdict {
  readonly ok: boolean;
  readonly findings: readonly string[];
  readonly diagnostic: Readonly<Record<string, unknown>> | null;
}

export async function runNodeSassLeg(input: {
  readonly fixtureDir: string;
  readonly runtimeNode: string;
  readonly runtimeAbi: string;
  readonly os: string;
  readonly arch: string;
  readonly onLog?: (line: string) => void;
}): Promise<SassFixtureVerdict> {
  const log = (line: string): void => {
    input.onLog?.(line);
  };
  const manifest = join(input.fixtureDir, 'package.json');
  const run = await spawnCapture(
    process.execPath,
    [
      join(input.fixtureDir, 'reject.mjs'),
      '--manifest',
      manifest,
      '--runtime-node',
      input.runtimeNode,
      '--runtime-abi',
      input.runtimeAbi,
      '--os',
      input.os,
      '--arch',
      input.arch,
    ],
    30_000,
  );
  log(`node-sass: reject.mjs exit ${String(run.exitCode ?? run.signal)}`);
  const findings: string[] = [];
  interface ScreeningVerdict {
    accepted?: unknown;
    installed?: unknown;
    rejection?: unknown;
  }
  let verdict: ScreeningVerdict | null = null;
  try {
    verdict = JSON.parse(run.stdout) as ScreeningVerdict;
  } catch {
    findings.push(
      `the screening printed no parseable verdict (exit ${String(run.exitCode ?? run.signal)})`,
    );
  }
  if (run.exitCode !== 0) {
    findings.push(
      `the screening exited ${String(run.exitCode ?? run.signal)} — misuse is never a screening verdict`,
    );
  }
  if (verdict !== null) {
    if (verdict.accepted !== false)
      findings.push('the screening ACCEPTED node-sass 9 (the deterministic rejection is missing)');
    if (verdict.installed !== false)
      findings.push('the screening claims an installation happened — it must never install');
    const rejection = verdict.rejection as Record<string, unknown> | undefined;
    if (rejection === undefined) {
      findings.push('the screening produced no rejection diagnostic');
    } else {
      for (const field of [
        'package',
        'version',
        'runtime',
        'os',
        'architecture',
        'upstream-support',
      ]) {
        if (rejection[field] === undefined)
          findings.push(`the rejection diagnostic is missing the ${field} field`);
      }
    }
  }
  // the never-installs law, on the real filesystem: no installation artifact
  const leftovers = (await readdir(input.fixtureDir)).filter(
    (entry) => entry !== 'package.json' && entry !== 'reject.mjs',
  );
  if (leftovers.length > 0) {
    findings.push(
      `the fixture directory carries unexpected artifacts after screening: ${leftovers.join(', ')}`,
    );
    await rm(join(input.fixtureDir, 'node_modules'), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
  return {
    ok: findings.length === 0,
    findings,
    diagnostic: (verdict?.rejection as Readonly<Record<string, unknown>> | undefined) ?? null,
  };
}

/** One bounded spawn with full stdout/stderr capture. */
export function spawnCapture(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      stderr.push(Buffer.from(error.message));
      resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal: signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
