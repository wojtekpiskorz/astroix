import { z } from 'zod';
import {
  COMMAND_SESSION_PRESENCE,
  commandSchema,
  RESULT_SESSION_PRESENCE,
  resultSchema,
  sessionPresenceError,
} from './commands';
import { publicErrorSchema } from './errors';
import { sessionRefSchema } from './session';

/**
 * The three envelopes of protocol v1 (ADR-0006 §7): request, response, and
 * error. Every envelope carries `protocolVersion: 1` (the literal schema
 * rejects anything else), every object is strict (unknown fields are
 * rejected, not stripped), and the session field's presence is bound to
 * the payload kind by the presence tables — a session-scoped success
 * without its `SessionRef` does not parse, and neither does an idle
 * registry read that invented one.
 */

/**
 * Correlation id, chosen by the requester and echoed by the responder and
 * the error envelope. Free-form (a UUID, a counter — the protocol does not
 * constrain it); the envelope byte limits bound its size.
 */
export const requestIdSchema = z.string().min(1);

export const requestEnvelopeSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    session: sessionRefSchema.optional(),
    command: commandSchema,
  })
  .superRefine((envelope, ctx) => {
    const error = sessionPresenceError(
      COMMAND_SESSION_PRESENCE[envelope.command.kind],
      envelope.session,
    );
    if (error !== null) {
      ctx.addIssue({ code: 'custom', path: ['session'], message: error });
    }
  });

export const responseEnvelopeSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    session: sessionRefSchema.optional(),
    result: resultSchema,
  })
  .superRefine((envelope, ctx) => {
    const error = sessionPresenceError(
      RESULT_SESSION_PRESENCE[envelope.result.kind],
      envelope.session,
    );
    if (error !== null) {
      ctx.addIssue({ code: 'custom', path: ['session'], message: error });
    }
  });

/**
 * The error envelope (ADR-0006 §7): `session` is optional — an error
 * carries the pair when the failing traffic was session-scoped, and the
 * closed `error` union sanitizes everything else by construction.
 */
export const errorEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(1),
  requestId: requestIdSchema,
  session: sessionRefSchema.optional(),
  error: publicErrorSchema,
});

export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;
export type ResponseEnvelope = z.infer<typeof responseEnvelopeSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
