/**
 * The restricted-draft reference of the restricted-candidate workflow
 * (#259, L2; ADR-0008's access-limited draft release): the ONE
 * delivery shape a candidate may take — a DRAFT release asset on this
 * repository, visible to collaborators only, never published, never
 * npm. The dry run references the exact asset it WOULD upload (the
 * ticket's focused test); the dispatch workflow's own steps perform
 * the upload/download and hand the same reference back so the evidence
 * manifest can name what a tester would receive.
 *
 * The qualify-mode admission law over the reference lives here too
 * (`modeCombinationProblem`): a dry run's reference is prospective —
 * optional; downloaded mode's is retrospective and cross-checkable, so
 * it may never be absent.
 */

/** The one repository a candidate may ever be drafted on. */
export const CANDIDATE_REPOSITORY = 'wojtekpiskorz/astroix';

/** The shape of a draft asset reference. */
export interface DraftAssetRef {
  readonly repository: string;
  readonly tag: string;
  readonly asset: string;
  /** The download URL a tester would receive the bytes from. */
  readonly url: string;
  readonly visibility: 'restricted-draft';
}

/** The draft asset a label's ZIP would be uploaded as (deterministic in the label + asset name). */
export function draftAssetRef(input: {
  readonly label: string;
  readonly assetName: string;
  readonly repository?: string;
}): DraftAssetRef {
  const repository = input.repository ?? CANDIDATE_REPOSITORY;
  const tag = `pre-alpha-candidate-${input.label}`;
  return {
    repository,
    tag,
    asset: input.assetName,
    url: `https://github.com/${repository}/releases/download/${tag}/${input.assetName}`,
    visibility: 'restricted-draft',
  };
}

/** Why a supplied draft reference is refused. */
export type DraftRefProblem =
  | 'wrong-repository'
  | 'wrong-tag'
  | 'wrong-asset'
  | 'wrong-visibility'
  | 'malformed';

/**
 * Checks a workflow-supplied `--draft-ref repository:tag:asset` against
 * the dry run's own computed reference: the dispatch upload must land
 * on the SAME repository, tag, and asset name the manifest already
 * names, as a restricted draft. Pure — the self-tests pin every
 * refusal direction.
 */
export function checkDraftRef(
  supplied: { repository: string; tag: string; asset: string; visibility?: string },
  expected: DraftAssetRef,
): DraftRefProblem | null {
  if (
    supplied.repository === undefined ||
    supplied.tag === undefined ||
    supplied.asset === undefined ||
    supplied.repository === '' ||
    supplied.tag === '' ||
    supplied.asset === ''
  ) {
    return 'malformed';
  }
  if (supplied.repository !== expected.repository) return 'wrong-repository';
  if (supplied.tag !== expected.tag) return 'wrong-tag';
  if (supplied.asset !== expected.asset) return 'wrong-asset';
  if (supplied.visibility !== undefined && supplied.visibility !== 'restricted-draft') {
    return 'wrong-visibility';
  }
  return null;
}

/**
 * The qualify mode/transfer-flags law over the draft reference: a dry
 * run records no upload and no download (its reference is prospective —
 * optional); downloaded mode records both AND must supply `--draft-ref`
 * — the one mode where the reference is retrospective and
 * cross-checkable against the run's own computed asset, so its absence
 * is a named refusal, never silent (#259 review round 6). Pure —
 * exported for the focused self-tests (the `leaseFindings` idiom: a
 * direct unit call, host-independent; the CLI self-executes at import,
 * so the law lives here, beside the reference it governs).
 */
export function modeCombinationProblem(
  mode: 'dry-run' | 'downloaded',
  uploaded: boolean,
  downloaded: boolean,
  draftRef: string | undefined,
): string | null {
  if (mode === 'dry-run' && (uploaded || downloaded)) {
    return 'a dry run records no upload and no download';
  }
  if (mode === 'downloaded' && (!uploaded || !downloaded)) {
    return 'downloaded mode requires both --uploaded and --downloaded';
  }
  if (mode === 'downloaded' && draftRef === undefined) {
    return 'downloaded mode requires --draft-ref — in the one mode where the reference is retrospective and cross-checkable, its absence is a refusal, never silent';
  }
  return null;
}
