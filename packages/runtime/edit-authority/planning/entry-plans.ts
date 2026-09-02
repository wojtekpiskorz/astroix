import type { WritePlan } from '@wojciechpiskorz/astroix-protocol';
import type { GrantedResource } from '../grants/grant-table';

/**
 * Entry-domain planning (#223): lifting an authorized, world-verified
 * content wire plan onto a domain write plan. Content serialization is
 * domain-specific and stays so — the entry vertical serializes through
 * core's entry-writer (the raw truth, byte-anchored) and hands the
 * resulting text here as `contents`; this boundary binds it to the
 * verified grant, never re-deriving it. Creation requires the
 * expected-absent baseline and the contained canonical parent the grant
 * proved at issuance and verify re-proved; the exclusive creation flag
 * itself is executor mechanics (D5, ADR-0006 §6).
 *
 * Two guards close the coherence gap at the authorization seam itself
 * (review round 1 on #304): an operation is only plannable against the
 * target species it was minted for — `replace-contents` needs an
 * existing-target grant under its exact SHA-256 baseline,
 * `create-contents` needs a creation-target grant under its
 * expected-absent baseline. Issuance cannot mint the crossing (the
 * existing-text default is the kind's species minus creation, and
 * creation is its own discovery branch), so these guards hold the line
 * for direct calls and any future minting path — D5's executor must
 * never be trusted to guess behavior on the crossed shape. A `splice`
 * operation fails closed separately: the content kind's species set has
 * no splice (that is the css splice-writer's primitive).
 */

/** The entry domain's write plans — the wire payload bound to the server-side grant truth. */
export type EntryWritePlan =
  | {
      readonly operation: 'replace-contents';
      readonly resource: GrantedResource;
      readonly contents: string;
    }
  | {
      readonly operation: 'create-contents';
      readonly resource: GrantedResource;
      readonly contents: string;
    };

/** The planning failure shape shared by the domain planners. */
export interface EntryPlanFailure {
  ok: false;
  code: 'operation-not-allowed' | 'operation-target-mismatch';
  message: string;
}

export type EntryPlanResult = { ok: true; plan: EntryWritePlan } | EntryPlanFailure;

const ENTRY_MESSAGES: Record<EntryPlanFailure['code'], string> = {
  'operation-not-allowed': 'the content kind does not permit this operation',
  'operation-target-mismatch': 'the operation does not fit the grant\u2019s target species',
};

/**
 * Plans an entry edit: `replace-contents` rewrites the existing entry
 * file against its exact SHA-256 baseline; `create-contents` fills the
 * verified-absent slot under its contained canonical parent. The plan
 * is the wire payload unchanged — the domain truth the caller
 * serialized — now bound to the server-side grant record.
 */
export function planEntryEdit(resource: GrantedResource, wire: WritePlan): EntryPlanResult {
  switch (wire.operation) {
    case 'replace-contents':
      if (resource.target.type !== 'existing') return entryFailure('operation-target-mismatch');
      return {
        ok: true,
        plan: { operation: 'replace-contents', resource, contents: wire.contents },
      };
    case 'create-contents':
      if (resource.target.type !== 'creation') return entryFailure('operation-target-mismatch');
      return {
        ok: true,
        plan: { operation: 'create-contents', resource, contents: wire.contents },
      };
    case 'splice':
      return entryFailure('operation-not-allowed');
  }
}

function entryFailure(code: EntryPlanFailure['code']): EntryPlanFailure {
  return { ok: false, code, message: ENTRY_MESSAGES[code] };
}
