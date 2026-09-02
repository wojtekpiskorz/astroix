import type { WritePlan } from '@wojciechpiskorz/astroix-protocol';
import type { GrantedResource, WorldVerification } from '../grants/grant-table';

/**
 * Style-domain planning (#223): lifting an authorized, world-verified
 * css wire plan onto a domain write plan. The splice content stays
 * domain-specific — the range is JavaScript string indices (UTF-16 code
 * units) into the resource's current string contents, exactly the
 * frozen splice-window contract core's splice-writer re-derives; this
 * boundary only proves the range fits the exact baseline bytes the
 * grant bound, so an incoherent plan fails before any write. The
 * replacement text is the caller's domain truth, carried untouched.
 * New-rule placement is deferred beyond the pre-alpha (#203): css
 * creation is outside the kind's species set and fails closed here too.
 */

/** The style domain's write plans — the wire payload bound to the server-side grant truth. */
export type StyleWritePlan =
  | {
      readonly operation: 'replace-contents';
      readonly resource: GrantedResource;
      readonly contents: string;
    }
  | {
      readonly operation: 'splice';
      readonly resource: GrantedResource;
      /** Offsets into the resource's current string contents (UTF-16 code units, end-exclusive). */
      readonly range: { readonly start: number; readonly end: number };
      readonly replacement: string;
    };

/** The planning failure shape shared by the domain planners. */
export interface StylePlanFailure {
  ok: false;
  code: 'operation-not-allowed' | 'range-outside-baseline';
  message: string;
}

export type StylePlanResult = { ok: true; plan: StyleWritePlan } | StylePlanFailure;

const STYLE_MESSAGES: Record<StylePlanFailure['code'], string> = {
  'operation-not-allowed': 'the css kind does not permit this operation',
  'range-outside-baseline':
    'the splice range does not fit the grant\u2019s exact baseline contents',
};

/**
 * Plans a style edit: `replace-contents` carries the whole next text;
 * `splice` carries a range proven to fit the verified current contents
 * (`world.text` — the exact baseline bytes as string indices).
 * `create-contents` fails closed even on direct call — the css species
 * set has no creation.
 */
export function planStyleEdit(
  resource: GrantedResource,
  wire: WritePlan,
  world: WorldVerification & { ok: true },
): StylePlanResult {
  switch (wire.operation) {
    case 'replace-contents':
      return {
        ok: true,
        plan: { operation: 'replace-contents', resource, contents: wire.contents },
      };
    case 'splice': {
      // The range must fit the exact baseline the grant bound — a range
      // beyond the verified contents is incoherent with the revision
      // contract (planned against different bytes than the world holds).
      // A null world text cannot happen for an existing target through
      // the boundary; on direct misuse it fails closed rather than splice.
      if (world.text === null || wire.range.end > world.text.length) {
        return styleFailure('range-outside-baseline');
      }
      return {
        ok: true,
        plan: { operation: 'splice', resource, range: wire.range, replacement: wire.replacement },
      };
    }
    case 'create-contents':
      return styleFailure('operation-not-allowed');
  }
}

function styleFailure(code: StylePlanFailure['code']): StylePlanFailure {
  return { ok: false, code, message: STYLE_MESSAGES[code] };
}
