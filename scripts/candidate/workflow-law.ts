import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The workflow law of the restricted-candidate workflow (#259, L2):
 * the checked-in `.github/workflows/pre-alpha-candidate.yml` is the
 * ONLY delivery workflow, and its shape is load-bearing —
 * `workflow_dispatch` alone (candidate checkpoints only, NEVER per-PR
 * or per-push), a restricted DRAFT release (`gh release create
 * --draft`, never a publish, never npm), checksum steps around the
 * download, and evidence artifacts on every path. `validateWorkflow`
 * is the pure law over the parsed YAML; the focused self-tests run it
 * against the live file (the K4 CI-law idiom) and against synthetic
 * violations of every rule.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKFLOW_PATH = join(
  HERE,
  '..',
  '..',
  '.github',
  'workflows',
  'pre-alpha-candidate.yml',
);

export interface WorkflowVerdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** The workflow file's own name — anything else is not this lane's workflow. */
export const WORKFLOW_NAME = 'Pre-alpha candidate';

/**
 * Validates one parsed workflow document (or a text that `parse`
 * consumed) against the law. Pure: the self-tests feed synthetic
 * documents; the live gate reads the real file.
 */
export function validateWorkflow(doc: unknown): WorkflowVerdict {
  const problems: string[] = [];
  const workflow = doc as {
    name?: unknown;
    on?: unknown;
    jobs?: unknown;
    true?: unknown;
  };
  if (workflow === null || typeof workflow !== 'object') {
    return { ok: false, problems: ['the workflow document is not an object'] };
  }
  if (workflow.name !== WORKFLOW_NAME) {
    problems.push(`the workflow name is "${String(workflow.name)}", not "${WORKFLOW_NAME}"`);
  }
  // YAML 1.1 parses bare `on:` as boolean true — accept exactly that spelling
  const triggers = (workflow.on ?? workflow.true) as unknown;
  if (triggers === undefined || triggers === null || typeof triggers !== 'object') {
    problems.push('the workflow declares no trigger object');
  } else if (Array.isArray(triggers)) {
    problems.push('the workflow trigger list must be exactly [workflow_dispatch]');
  } else {
    const keys = Object.keys(triggers);
    if (keys.length !== 1 || keys[0] !== 'workflow_dispatch') {
      problems.push(
        `the workflow must trigger on workflow_dispatch ONLY (candidate checkpoints, never per-PR) — found [${keys.join(', ')}]`,
      );
    }
    const dispatch = (triggers as Record<string, unknown>).workflow_dispatch;
    if (dispatch === null || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
      problems.push('workflow_dispatch must carry its inputs as a mapping');
    }
  }
  const jobs = workflow.jobs as
    | Record<
        string,
        { 'runs-on'?: unknown; steps?: unknown; 'timeout-minutes'?: unknown; permissions?: unknown }
      >
    | undefined;
  if (jobs === undefined || typeof jobs !== 'object' || Object.keys(jobs).length === 0) {
    problems.push('the workflow declares no jobs');
    return { ok: problems.length === 0, problems };
  }
  for (const [jobId, job] of Object.entries(jobs)) {
    const runsOn = job?.['runs-on'];
    if (typeof runsOn !== 'string' || !runsOn.includes('macos')) {
      problems.push(
        `job ${jobId} must run on a macOS arm64 runner (the product shape, ADR-0008) — found ${String(runsOn)}`,
      );
    }
    if (job?.['timeout-minutes'] === undefined) {
      problems.push(
        `job ${jobId} carries no timeout-minutes (a hung candidate must fail the job, never hang it)`,
      );
    }
    const steps = Array.isArray(job?.steps) ? (job?.steps as Array<Record<string, unknown>>) : [];
    const stepText = JSON.stringify(steps);
    if (/npm\s+publish|gh release edit|changeset publish|npm run release/.test(stepText)) {
      problems.push(
        `job ${jobId} publishes or un-drafts — npm and public releases are forbidden (ADR-0008 restricted pre-alpha)`,
      );
    }
    if (stepText.includes('--draft=false') || stepText.includes('draft: false')) {
      problems.push(`job ${jobId} un-drafts a release — the candidate stays a restricted draft`);
    }
    if (stepText.includes('gh release create') && !stepText.includes('--draft')) {
      problems.push(
        `job ${jobId} creates a release without --draft — the candidate must land as a restricted draft`,
      );
    }
    const hasEvidenceUpload = stepText.includes('upload-artifact');
    if (!hasEvidenceUpload) {
      problems.push(
        `job ${jobId} uploads no artifacts — evidence survives every path (#129 doctrine)`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Reads and validates the live workflow file. */
export async function validateWorkflowFile(path: string): Promise<WorkflowVerdict> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { ok: false, problems: [`the workflow file is missing at ${path}`] };
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    return {
      ok: false,
      problems: [
        `the workflow file does not parse: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  return validateWorkflow(doc);
}
