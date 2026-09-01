import { z } from 'zod';
import {
  CID_FORM,
  cssIndexRecord,
  projectRelativeFile,
  sourceRange,
} from './inspection-contract.ts';

/**
 * The edit behavior-contract schema (#217, lane B2, ADR-0010): the versioned
 * description of what the retired integration's WRITE surfaces did over the
 * canonical plain fixture — CSS text-splices and Content whole-file writes,
 * their optimistic expected-hash guard, and the exact bytes each cycle left
 * on disk. Where the inspection corpus (#216) froze what the system showed,
 * this one freezes what it wrote: request/response pairs plus before/after
 * file bytes, so the replacement edit authority and the app-shell presenting
 * write state are judged against observed output bytes, never against the
 * old implementation (CONTEXT.md: behavior contract).
 *
 * Vocabulary is CONTEXT.md's: splice-writer, raw truth, auto-write, zod
 * projection, expected-hash guard. Every leg encodes the identity invariants
 * the corpus must preserve rather than normalize away (#217 AC-5):
 * project-relative paths, the byte window a splice leaves untouched, the
 * posted-bytes-equal-disk-bytes whole-file write, the hash chain that
 * revisions a file, and the disk retention a rejected write owes.
 *
 * Derived-vs-observed (documented per leg in the PR): the observed side is
 * every REST response and every disk read; the derived side is the client
 * half of each write cycle — the splice range located over observed bytes
 * and the posted `contents` computed by the pure entry-writer over the
 * observed baseline, exactly what the chrome's auto-write loop sends.
 */

/**
 * Semver `contractVersion` stamped on every frozen edit fixture. The edit
 * corpus shares the inspection corpus's version line (1.0.0 at the freeze);
 * it moves independently when an edit-side shape changes.
 */
export const EDIT_CONTRACT_VERSION = '1.0.0';

const contractVersion = z.string().regex(/^\d+\.\d+\.\d+$/, 'contractVersion must be semver');

/** sha256 hex — the optimistic-write guard's currency and the corpus's revision state. */
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');

/** A file's observed bytes plus the hash that revisions them (AC-4). */
const fileBytes = z.object({
  contents: z.string(),
  hash: sha256Hex,
});

/** The write endpoints' success answer. */
const okResponse = z.object({
  status: z.literal(200),
  body: z.object({ ok: z.literal(true) }),
});

/** The expected-hash guard's rejection — `contents` hands back the disk truth. */
const conflictResponse = z.object({
  status: z.literal(409),
  body: z.object({ error: z.literal('file changed on disk'), contents: z.string() }),
});

/** The malformed-request taxonomy (range, body shape, confinement, missing file). */
const badRequestResponse = z.object({
  status: z.literal(400),
  body: z.object({ error: z.string().min(1) }),
});

/**
 * The untouched-bytes invariant every splice leg freezes (AC-1): every byte
 * before `range.start` and after `range.end` survives the edit identically.
 * The replacement edit authority is held to exactly this window.
 */
function refineUntouchedBytes(
  fixture: {
    baseline: { contents: string };
    after: { contents: string };
    edit: { range: { start: number; end: number } };
  },
  ctx: z.RefinementCtx,
): void {
  const prefix = fixture.baseline.contents.slice(0, fixture.edit.range.start);
  const suffix = fixture.baseline.contents.slice(fixture.edit.range.end);
  if (!fixture.after.contents.startsWith(prefix) || !fixture.after.contents.endsWith(suffix)) {
    ctx.addIssue({
      code: 'custom',
      path: ['after', 'contents'],
      message: 'the bytes outside the splice range must survive byte-identical',
    });
  }
}

/** The real-edit guard: a frozen cycle changed something, and against the baseline it hashed. */
function refineRealEdit(
  fixture: {
    baseline: { contents: string; hash: string };
    after: { contents: string };
    edit: { expectedHash: string };
  },
  ctx: z.RefinementCtx,
): void {
  if (fixture.edit.expectedHash !== fixture.baseline.hash) {
    ctx.addIssue({
      code: 'custom',
      path: ['edit', 'expectedHash'],
      message:
        'a success write hashes the baseline it serialized from — the guard accepted it, so the fixture must carry that hash',
    });
  }
  if (fixture.after.contents === fixture.baseline.contents) {
    ctx.addIssue({
      code: 'custom',
      path: ['after', 'contents'],
      message:
        'a frozen write cycle changed the file — identical before/after bytes are not contract shape',
    });
  }
}

// --- CSS splice (the splice-writer's write cycle through POST /__astroix/edit) ---

/** One frozen CSS splice: request/response pair, before/after bytes, and the served index after. */
export const cssSpliceFixtureSchema = z
  .object({
    contractVersion,
    kind: z.literal('css-splice'),
    file: projectRelativeFile,
    /** The disk truth the cycle serialized against. */
    baseline: fileBytes,
    /** The chrome's edit: a located range over baseline bytes plus the replacement text. */
    edit: z.object({
      range: sourceRange,
      /** What the replaced slice held — the request's semantic twin, frozen for the diff. */
      replaced: z.string(),
      replacement: z.string(),
      expectedHash: sha256Hex,
    }),
    response: okResponse,
    after: fileBytes,
    /** The served index records of `file` after the write — post-edit selector/range truth. */
    indexAfter: z.array(cssIndexRecord).min(1),
  })
  .superRefine((fixture, ctx) => {
    refineUntouchedBytes(fixture, ctx);
    refineRealEdit(fixture, ctx);
    const slice = fixture.baseline.contents.slice(fixture.edit.range.start, fixture.edit.range.end);
    if (slice !== fixture.edit.replaced) {
      ctx.addIssue({
        code: 'custom',
        path: ['edit', 'replaced'],
        message: 'the frozen replaced slice must be the baseline bytes at the splice range',
      });
    }
    if (fixture.edit.replaced === fixture.edit.replacement) {
      ctx.addIssue({
        code: 'custom',
        path: ['edit', 'replacement'],
        message: 'a frozen splice replaces with different bytes',
      });
    }
    for (const [index, record] of fixture.indexAfter.entries()) {
      if (record.file !== fixture.file) {
        ctx.addIssue({
          code: 'custom',
          path: ['indexAfter', index, 'file'],
          message: "indexAfter freezes the edited file's records — no other file belongs here",
        });
      }
      if (record.range.end > fixture.after.contents.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['indexAfter', index, 'range'],
          message: 'a post-edit record range must fit the post-edit bytes',
        });
      }
    }
  });

// --- CSS scoped splice (a rule inside a scoped <style> block) ---

/**
 * The scoped-rule leg (AC-1): a selector rename inside a component's scoped
 * `<style>` block. Freezes the served record before and after — the renamed
 * selector in source space and its compiled form carrying the cid — plus the
 * splice invariants. The edit corpus runs the main (attribute-strategy)
 * oracle only: splice behavior is strategy-independent in source space, and
 * the joined form is pinned by CID_FORM.attribute the same way the
 * inspection corpus pins it per strategy.
 */
export const cssScopedSpliceFixtureSchema = z
  .object({
    contractVersion,
    kind: z.literal('css-scoped-splice'),
    file: projectRelativeFile,
    baseline: fileBytes,
    /** The scoped rule's served record before the edit — selector, range, and the joined cid form. */
    indexBefore: cssIndexRecord,
    edit: z.object({
      range: sourceRange,
      replaced: z.string(),
      replacement: z.string(),
      expectedHash: sha256Hex,
    }),
    response: okResponse,
    after: fileBytes,
    /** The same block's served record after the edit: the renamed selector re-joined with its cid. */
    indexAfter: cssIndexRecord,
  })
  .superRefine((fixture, ctx) => {
    refineUntouchedBytes(fixture, ctx);
    refineRealEdit(fixture, ctx);
    const slice = fixture.baseline.contents.slice(fixture.edit.range.start, fixture.edit.range.end);
    if (slice !== fixture.edit.replaced) {
      ctx.addIssue({
        code: 'custom',
        path: ['edit', 'replaced'],
        message: 'the frozen replaced slice must be the baseline bytes at the splice range',
      });
    }
    for (const [name, record] of [
      ['indexBefore', fixture.indexBefore],
      ['indexAfter', fixture.indexAfter],
    ] as const) {
      if (!record.scoped) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'the scoped leg freezes scoped rules — an unscoped record is not contract shape',
        });
      }
      if (
        record.effectiveSelector === null ||
        !record.effectiveSelector.includes(CID_FORM.attribute)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [name, 'effectiveSelector'],
          message: `a joined scoped selector under the attribute strategy must carry ${CID_FORM.attribute}… — selector identity is not normalizable`,
        });
      }
    }
    if (fixture.indexAfter.selector !== fixture.edit.replacement) {
      ctx.addIssue({
        code: 'custom',
        path: ['indexAfter', 'selector'],
        message:
          'the renamed rule serves the replacement selector text — source space, no cid synthesis',
      });
    }
    const effective = fixture.indexAfter.effectiveSelector;
    if (effective !== null && !effective.startsWith(fixture.indexAfter.selector)) {
      ctx.addIssue({
        code: 'custom',
        path: ['indexAfter', 'effectiveSelector'],
        message:
          'the compiled form must name the source selector it compiles — a positionally-joined stale module is a broken join, not contract shape',
      });
    }
  });

// --- Content whole-file write (POST /__astroix/content-write) ---

/** The raw-truth draft the auto-write loop serializes: the file parse with one truth changed. */
const entryDraft = z.object({
  /** The raw frontmatter parse (json space) — never the zod projection. */
  data: z.unknown(),
  /** The trimmed body string the payload serves. */
  body: z.string(),
});

/**
 * The frontmatter write leg (AC-2): one data key edited over a commented,
 * flow-styled frontmatter — the raw-truth serialization cycle. `preserved`
 * freezes the baseline lines that survived verbatim (comments and untouched
 * keys among them): the replacement serializer is held to byte-identical
 * untouched lines.
 */
export const contentWriteFixtureSchema = z
  .object({
    contractVersion,
    kind: z.literal('content-write'),
    file: projectRelativeFile,
    baseline: fileBytes,
    draft: entryDraft,
    /** The posted bytes — the entry-writer's output over the baseline (derived; the endpoint observes them land). */
    written: z.object({ contents: z.string(), expectedHash: sha256Hex }),
    response: okResponse,
    after: fileBytes,
    /** Baseline frontmatter lines that appear unchanged in the written bytes — the preservation evidence. */
    preserved: z.array(z.string().min(1)).min(1),
  })
  .superRefine((fixture, ctx) => {
    if (fixture.after.contents !== fixture.written.contents) {
      ctx.addIssue({
        code: 'custom',
        path: ['after', 'contents'],
        message:
          'the whole-file write lands the posted bytes verbatim — any server-side munging is a contract break',
      });
    }
    refineRealEdit(
      {
        baseline: fixture.baseline,
        after: fixture.after,
        edit: { expectedHash: fixture.written.expectedHash },
      },
      ctx,
    );
    const carriedComments = fixture.baseline.contents
      .split('\n')
      .filter((line) => line.trimStart().startsWith('#'));
    for (const comment of carriedComments) {
      if (!fixture.preserved.includes(comment)) {
        ctx.addIssue({
          code: 'custom',
          path: ['preserved'],
          message: `every baseline comment line must be frozen as preserved: ${JSON.stringify(comment)}`,
        });
      }
    }
    for (const [index, line] of fixture.preserved.entries()) {
      if (!fixture.baseline.contents.includes(line) || !fixture.after.contents.includes(line)) {
        ctx.addIssue({
          code: 'custom',
          path: ['preserved', index],
          message:
            'a preserved line must appear byte-identical in both the baseline and the written bytes',
        });
      }
    }
  });

/**
 * The body-write leg (AC-2): a body-only edit. `preservedPrefix` is the
 * entire frontmatter block of the baseline — the byte-surgical claim is
 * that a body write re-anchors the body while the frontmatter slice
 * survives byte-identical.
 */
export const contentBodyWriteFixtureSchema = z
  .object({
    contractVersion,
    kind: z.literal('content-body-write'),
    file: projectRelativeFile,
    baseline: fileBytes,
    draft: entryDraft,
    written: z.object({ contents: z.string(), expectedHash: sha256Hex }),
    response: okResponse,
    after: fileBytes,
    /** The baseline's whole frontmatter block — both files start with these exact bytes. */
    preservedPrefix: z.string().min(1),
  })
  .superRefine((fixture, ctx) => {
    if (fixture.after.contents !== fixture.written.contents) {
      ctx.addIssue({
        code: 'custom',
        path: ['after', 'contents'],
        message:
          'the whole-file write lands the posted bytes verbatim — any server-side munging is a contract break',
      });
    }
    refineRealEdit(
      {
        baseline: fixture.baseline,
        after: fixture.after,
        edit: { expectedHash: fixture.written.expectedHash },
      },
      ctx,
    );
    if (!fixture.preservedPrefix.startsWith('---')) {
      ctx.addIssue({
        code: 'custom',
        path: ['preservedPrefix'],
        message:
          'the body leg writes a content entry — its preserved prefix is the frontmatter fence',
      });
    }
    if (
      !fixture.baseline.contents.startsWith(fixture.preservedPrefix) ||
      !fixture.after.contents.startsWith(fixture.preservedPrefix)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['preservedPrefix'],
        message:
          'the frontmatter block must survive a body write byte-identical — baseline and written bytes both start with it',
      });
    }
  });

/** One advisory-validation probe: the draft posted and the issues served. */
const validateProbe = z.object({
  draft: z.unknown(),
  response: z.object({
    ok: z.boolean(),
    issues: z.array(
      z.object({
        path: z.string(),
        code: z.string(),
        message: z.string(),
      }),
    ),
  }),
});

/**
 * The advisory-validation leg (AC-2): the schema's safeParse answers inline
 * and never gates the write. Frozen as two probes (a clean draft and a
 * multi-issue draft) plus the byte-level proof: the SAME invalid data,
 * written through the content-write endpoint, lands 200 — advisory means
 * the write authority never consults the issues.
 */
export const contentValidateFixtureSchema = z
  .object({
    contractVersion,
    kind: z.literal('content-validate'),
    collection: z.string().min(1),
    valid: validateProbe,
    invalid: validateProbe,
    /** The never-gated proof: a write of the invalid draft succeeds and lands verbatim. */
    advisoryWrite: z.object({
      file: projectRelativeFile,
      baseline: fileBytes,
      written: z.object({ contents: z.string(), expectedHash: sha256Hex }),
      response: okResponse,
      after: fileBytes,
    }),
  })
  .superRefine((fixture, ctx) => {
    if (fixture.valid.response.ok !== true || fixture.valid.response.issues.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['valid'],
        message:
          'the valid probe serves ok:true with no issues — a projected issue is not contract shape',
      });
    }
    if (fixture.invalid.response.ok !== false || fixture.invalid.response.issues.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['invalid'],
        message:
          'the invalid probe serves ok:false with its issues — the advisory loop\u2019s whole signal',
      });
    }
    const write = fixture.advisoryWrite;
    if (write.after.contents !== write.written.contents) {
      ctx.addIssue({
        code: 'custom',
        path: ['advisoryWrite', 'after', 'contents'],
        message: 'the advisory proof write lands its posted bytes verbatim',
      });
    }
    // the same real-edit refinement as the other write legs: the proof
    // write hashed the baseline it serialized from AND changed the bytes
    refineRealEdit(
      {
        baseline: write.baseline,
        after: write.after,
        edit: { expectedHash: write.written.expectedHash },
      },
      ctx,
    );
  });

// --- Stale-baseline conflict (the expected-hash guard's rejection) ---

/**
 * The conflict leg (AC-3): an out-of-band disk change under the write's
 * baseline. The interference bytes are the scenario's IDE/agent edit
 * (written to the oracle copy directly — the exact race the guard exists
 * for); the attempt carries the STALE expected hash; the endpoint must
 * reject with the disk truth and leave every interference byte on disk.
 */
export const editConflictFixtureSchema = z
  .object({
    contractVersion,
    kind: z.literal('edit-conflict'),
    /** Which write surface the stale attempt rode. */
    surface: z.enum(['css-splice', 'content-write']),
    file: projectRelativeFile,
    baseline: fileBytes,
    /** The disk change that raced the write — the state the guard must defend. */
    interference: fileBytes,
    /** The stale attempt: a full edit whose expectedHash still names the baseline. */
    attempt: z.object({
      range: sourceRange.optional(),
      replaced: z.string().optional(),
      replacement: z.string().optional(),
      contents: z.string().optional(),
      expectedHash: sha256Hex,
    }),
    response: conflictResponse,
    /** The disk after the rejection — byte-identical to the interference. */
    retained: fileBytes,
  })
  .superRefine((fixture, ctx) => {
    if (fixture.surface === 'css-splice') {
      if (
        fixture.attempt.range === undefined ||
        fixture.attempt.replaced === undefined ||
        fixture.attempt.replacement === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message: 'a css-splice conflict attempt carries range, replaced, and replacement',
        });
      }
    } else if (fixture.attempt.contents === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['attempt', 'contents'],
        message: 'a content-write conflict attempt carries the posted contents',
      });
    }
    if (fixture.attempt.expectedHash !== fixture.baseline.hash) {
      ctx.addIssue({
        code: 'custom',
        path: ['attempt', 'expectedHash'],
        message: 'the stale attempt hashes the baseline — that is what makes it stale',
      });
    }
    if (fixture.baseline.contents === fixture.interference.contents) {
      ctx.addIssue({
        code: 'custom',
        path: ['interference', 'contents'],
        message: 'the interference changed the disk — identical bytes are not a race',
      });
    }
    if (fixture.attempt.expectedHash === fixture.interference.hash) {
      ctx.addIssue({
        code: 'custom',
        path: ['attempt', 'expectedHash'],
        message:
          'the attempt\u2019s hash must mismatch the raced disk state — otherwise nothing is stale',
      });
    }
    if (fixture.response.body.contents !== fixture.interference.contents) {
      ctx.addIssue({
        code: 'custom',
        path: ['response', 'body', 'contents'],
        message: 'the 409 hands back the current disk truth — the interference bytes',
      });
    }
    if (fixture.retained.contents !== fixture.interference.contents) {
      ctx.addIssue({
        code: 'custom',
        path: ['retained', 'contents'],
        message: 'a rejected write retains the raced disk bytes — the write never partially lands',
      });
    }
  });

// --- Malformed-request negatives ---

/**
 * The negative-request battery: the 400 taxonomy (invalid ranges, missing
 * body fields, root-confinement violations, missing files) with the disk
 * proven untouched after the whole battery. `request.file` is a plain
 * string on purpose — these legs freeze NON-conforming inputs (traversal
 * paths among them), which the confinement shape exists to reject.
 */
export const editNegativesFixtureSchema = z
  .object({
    contractVersion,
    kind: z.literal('edit-negatives'),
    disk: z.object({
      file: projectRelativeFile,
      before: fileBytes,
      after: fileBytes,
    }),
    cases: z
      .array(
        z.object({
          surface: z.enum(['css-splice', 'content-write']),
          request: z.object({
            file: z.string().min(1),
            range: z.object({ start: z.number(), end: z.number() }).optional(),
            replacement: z.string().optional(),
            contents: z.string().optional(),
            expected: sha256Hex.optional(),
          }),
          response: badRequestResponse,
        }),
      )
      .min(4),
  })
  .superRefine((fixture, ctx) => {
    if (fixture.disk.before.contents !== fixture.disk.after.contents) {
      ctx.addIssue({
        code: 'custom',
        path: ['disk', 'after', 'contents'],
        message:
          'no negative request writes — the disk bytes must be identical before and after the battery',
      });
    }
  });

// --- The corpus manifest: every frozen edit fixture name → its schema ---

export type CssSpliceFixture = z.infer<typeof cssSpliceFixtureSchema>;
export type CssScopedSpliceFixture = z.infer<typeof cssScopedSpliceFixtureSchema>;
export type ContentWriteFixture = z.infer<typeof contentWriteFixtureSchema>;
export type ContentBodyWriteFixture = z.infer<typeof contentBodyWriteFixtureSchema>;
export type ContentValidateFixture = z.infer<typeof contentValidateFixtureSchema>;
export type EditConflictFixture = z.infer<typeof editConflictFixtureSchema>;
export type EditNegativesFixture = z.infer<typeof editNegativesFixtureSchema>;

export const editFixtureSchemas = {
  'css-splice.json': cssSpliceFixtureSchema,
  'css-scoped-splice.json': cssScopedSpliceFixtureSchema,
  'css-conflict.json': editConflictFixtureSchema,
  'content-frontmatter-write.json': contentWriteFixtureSchema,
  'content-body-write.json': contentBodyWriteFixtureSchema,
  'content-validate.json': contentValidateFixtureSchema,
  'content-conflict.json': editConflictFixtureSchema,
  'edit-negatives.json': editNegativesFixtureSchema,
} as const;

export type EditFixtureName = keyof typeof editFixtureSchemas;
