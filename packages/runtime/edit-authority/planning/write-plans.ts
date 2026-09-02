import {
  type ResourceGrant,
  type SessionRef,
  type WritePlan,
  writePlanSchema,
} from '@wojciechpiskorz/astroix-protocol';
import type { GrantFailureCode, GrantTable } from '../grants/grant-table';
import { KIND_OPERATIONS } from '../grants/grant-table';
import { type EntryWritePlan, planEntryEdit } from './entry-plans';
import { planStyleEdit, type StyleWritePlan } from './style-plans';

/**
 * The planning boundary (#223, ADR-0006 §6): the only sanctioned lift
 * from a wire write plan to a domain write plan. What it proves, in
 * order, before the executor lane (D5) may ever see a plan: the wire
 * shape is the closed protocol contract (bounds included); the
 * operation is inside the kind's species matrix; the echoed grant is an
 * exact match for a live server-side grant of this session (unknown,
 * cross-session, revoked, superseded, wrong-kind, and
 * operation-not-allowed all die here); the echo equals the issued wire
 * grant field for field — a tampered display path, baseline, or
 * operation list is a claim mismatch, never authority; and the world
 * still satisfies the revision contract — the exact SHA-256 baseline
 * for existing text, expected-absent for creation.
 *
 * Display paths are project-relative presentation only: nothing in this
 * pipeline reads `displayPath` for authority, and the domain plan that
 * leaves here carries the server's canonical target, never the echo.
 */
export type DomainWritePlan = StyleWritePlan | EntryWritePlan;

/** The planning failure codes: every grant failure plus the boundary's own. */
export type PlanFailureCode =
  | GrantFailureCode
  | 'invalid-plan'
  | 'claim-mismatch'
  | 'range-outside-baseline';

export type PlanResult =
  | { ok: true; plan: DomainWritePlan }
  | { ok: false; code: PlanFailureCode; message: string };

const PLAN_MESSAGES: Record<'invalid-plan' | 'claim-mismatch', string> = {
  'invalid-plan': 'the write plan does not satisfy the protocol write-plan contract',
  'claim-mismatch': 'the echoed grant differs from the grant the server issued',
};

const SPECIES_MESSAGE = 'the operation is not among the kind\u2019s permitted operations';

/**
 * Plans one edit. `plan` is the untrusted wire object (the browser's
 * `apply-edit` body); `session` is the caller's current SessionRef —
 * the control plane's truth, compared against the grant's bound pair.
 */
export async function planEdit(
  table: GrantTable,
  input: { session: SessionRef; plan: unknown },
): Promise<PlanResult> {
  const parsed = writePlanSchema.safeParse(input.plan);
  if (!parsed.success) return planFailure('invalid-plan');
  const wire: WritePlan = parsed.data;
  // The kind×operation species matrix, checked before any table state:
  // a wire plan outside the domain matrix never touches grant records.
  if (!KIND_OPERATIONS[wire.grant.kind].includes(wire.operation)) {
    return { ok: false, code: 'operation-not-allowed', message: SPECIES_MESSAGE };
  }
  const authorized = table.authorize({
    token: wire.grant.token,
    session: input.session,
    kind: wire.grant.kind,
    operation: wire.operation,
  });
  if (!authorized.ok) return authorized;
  // Echo equality: the browser's grant must be the grant the server
  // issued, field for field. Authority never consults the echoed
  // display path — but a drifted echo of ANY field is a protocol
  // violation and fails closed.
  if (!wireGrantEquals(wire.grant, authorized.grant)) return planFailure('claim-mismatch');
  const world = await table.verify(authorized.resource);
  if (!world.ok) return world;
  return authorized.resource.kind === 'css'
    ? planStyleEdit(authorized.resource, wire, world)
    : planEntryEdit(authorized.resource, wire);
}

/**
 * Field-for-field equality of an echoed wire grant against the issued
 * one: token, kind, the full ordered operations list, display path, and
 * the revision contract.
 */
function wireGrantEquals(echoed: ResourceGrant, issued: ResourceGrant): boolean {
  if (
    echoed.token !== issued.token ||
    echoed.kind !== issued.kind ||
    echoed.displayPath !== issued.displayPath ||
    echoed.baseline.type !== issued.baseline.type
  ) {
    return false;
  }
  if (echoed.baseline.type === 'sha256' && issued.baseline.type === 'sha256') {
    if (echoed.baseline.sha256 !== issued.baseline.sha256) return false;
  }
  return (
    echoed.operations.length === issued.operations.length &&
    echoed.operations.every((operation, index) => operation === issued.operations[index])
  );
}

function planFailure(code: 'invalid-plan' | 'claim-mismatch'): PlanResult {
  return { ok: false, code, message: PLAN_MESSAGES[code] };
}
