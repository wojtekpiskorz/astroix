import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The source-state law of the restricted-candidate workflow (#259,
 * L2): a candidate is assembled ONCE from CLEAN, identified source —
 * `git status --porcelain` must be empty (a dirty tree is a refused
 * candidate, never a best-effort build) and `git rev-parse HEAD` names
 * the commit every piece of evidence is tied to. The ignored build
 * trees (`apps/desktop/out/`, `dist-main/`, `resources/`,
 * `test-results/`, `qualification/manifests/`' unclaimed run
 * directories) never dirty the porcelain view, so the law observes
 * exactly what git tracks.
 */

const execFileAsync = promisify(execFile);

export interface SourceFacts {
  readonly commit: string;
  readonly clean: boolean;
  /** The raw porcelain lines — the evidence behind a dirty-source refusal. */
  readonly porcelain: readonly string[];
}

/** Reads the source facts; an unreadable git state fails closed (commit ''). */
export async function readSourceFacts(cwd: string): Promise<SourceFacts> {
  let commit = '';
  let porcelain: string[] = [];
  try {
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    commit = head.stdout.trim();
  } catch {
    commit = '';
  }
  try {
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    porcelain = status.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    porcelain = ['(git status failed)'];
  }
  return { commit, clean: commit !== '' && porcelain.length === 0, porcelain };
}
