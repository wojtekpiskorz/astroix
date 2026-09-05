/**
 * The restricted-draft reference of the restricted-candidate workflow
 * (#259, L2; ADR-0008's access-limited draft release): the ONE
 * delivery shape a candidate may take — a DRAFT release asset on this
 * repository, visible to collaborators only, never published, never
 * npm. The dry run references the exact asset it WOULD upload (the
 * ticket's focused test); the dispatch workflow's own steps perform
 * the upload/download and hand the same reference back so the evidence
 * manifest can name what a tester would receive.
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
