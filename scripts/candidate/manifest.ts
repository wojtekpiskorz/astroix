/**
 * The evidence-manifest law of the restricted-candidate workflow
 * (#259, L2): every run — dry or dispatched — writes a COMPLETE,
 * immutable evidence manifest tied to the commit and the checksum, and
 * `validateManifest` re-reads it fail-closed: missing evidence, a
 * mismatched checksum, a pin drift, a dirty source, rebuilt bytes, an
 * unverified macOS claim, a skipped matrix leg, an unrejected
 * unsupported dependency, or an unexecuted native fixture each fail
 * the qualification by name. The manifest is written incrementally (a
 * crashed run leaves the record it earned) and sealed once.
 */

export const MANIFEST_SCHEMA = 1;

/** Every matrix leg a complete run records, in run order. */
export const MATRIX_LEGS = [
  'unsupported-node-sass',
  'l1-qualification',
  'registry-lease',
  'packaged-smoke',
  'native-better-sqlite3',
  'web-checkpoint',
  'workflow-cleanup',
] as const;

export type MatrixLegName = (typeof MATRIX_LEGS)[number];

export interface MatrixLegRecord {
  readonly leg: MatrixLegName;
  readonly status: 'passed' | 'failed';
  readonly summary: string;
  readonly exitCode: number | null;
  readonly logFile: string;
  /** Optional leg counts (battery passed/failed/skipped, checkpoint cases). */
  readonly counts?: Readonly<Record<string, number>>;
}

/** The whole-run evidence manifest — `manifest.json`'s shape. */
export interface CandidateManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly workflow: 'astroix-pre-alpha-candidate';
  readonly lane: 'L2 restricted candidate workflow (#259)';
  readonly label: string;
  readonly mode: 'dry-run' | 'downloaded';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly source: {
    readonly commit: string;
    readonly clean: boolean;
    readonly porcelain: readonly string[];
  };
  readonly pins: {
    readonly charter: Readonly<Record<string, unknown>>;
    readonly repo: Readonly<Record<string, unknown>>;
    readonly reconciled: boolean;
    readonly findings: readonly unknown[];
  };
  readonly build: {
    readonly command: string;
    readonly zip: { readonly path: string; readonly bytes: number; readonly sha256: string };
    readonly builtOnce: boolean;
  };
  readonly transfer: {
    readonly mode: 'dry-run' | 'downloaded';
    readonly checksumBefore: string;
    readonly checksumAfter: string;
    readonly match: boolean;
    readonly uploaded: boolean;
    readonly downloaded: boolean;
    readonly draftAsset: {
      readonly repository: string;
      readonly tag: string;
      readonly asset: string;
      readonly url: string;
      readonly visibility: string;
    };
  };
  readonly host: Readonly<Record<string, unknown>>;
  readonly minimumMacOS: {
    readonly metadata: string;
    readonly verifiedAs: 'metadata-only' | 'host';
    readonly testedOn: {
      readonly swVersProduct: string;
      readonly swVersBuild: string;
      readonly unameMachine: string;
    };
    readonly controlledMinimumHost: boolean;
    readonly disclosure: string;
  };
  readonly matrix: readonly MatrixLegRecord[];
  readonly fixtures: {
    readonly betterSqlite3: {
      readonly executed: boolean;
      readonly packageVersion: string | null;
      readonly runtime: { readonly node: string | null; readonly abi: string | null } | null;
      readonly builtFromSource: boolean;
      readonly builtUnder: string | null;
      readonly inMemory: Readonly<Record<string, unknown>> | null;
      readonly detail: string | null;
    };
    readonly nodeSass: {
      readonly rejected: boolean;
      readonly installed: boolean;
      readonly diagnostic: Readonly<Record<string, unknown>> | null;
    };
  };
  readonly verdict: { readonly ok: boolean; readonly failures: readonly string[] } | null;
}

/** The fixed serialization: two-space indent, one trailing newline — byte-stable. */
export function serializeManifest(manifest: CandidateManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** The fail-closed completeness verdict — every problem named, never a bare boolean. */
export interface ManifestVerdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Validates a manifest for the completeness law (#259's focused test:
 * "a successful dry run produces a complete evidence manifest
 * referencing the restricted draft asset" — and the failure-mode test:
 * qualification fails on missing evidence). Pure over the parsed
 * record; the CLI re-reads the written file from disk before sealing.
 */
export function validateManifest(
  manifest: CandidateManifest,
  charterMinimumMacOS: string,
): ManifestVerdict {
  const problems: string[] = [];
  const push = (problem: string): void => {
    problems.push(problem);
  };

  if (manifest.schema !== MANIFEST_SCHEMA) push('the manifest is not schema 1');
  if (manifest.label === '') push('the manifest carries no candidate label');
  if (manifest.mode !== 'dry-run' && manifest.mode !== 'downloaded') {
    push(`the manifest mode "${String(manifest.mode)}" is neither dry-run nor downloaded`);
  }

  // ——— source: identified, clean ———
  if (!COMMIT_PATTERN.test(manifest.source.commit)) {
    push(`the source commit "${manifest.source.commit}" is not a 40-hex git commit`);
  }
  if (manifest.source.clean !== true) {
    push(`the source tree was dirty at build time: ${manifest.source.porcelain.join('; ')}`);
  }

  // ——— pins: reconciled ———
  if (manifest.pins.reconciled !== true) {
    push(`the pin reconciliation failed: ${JSON.stringify(manifest.pins.findings)}`);
  }

  // ——— build: one ZIP, identified ———
  if (!SHA256_PATTERN.test(manifest.build.zip.sha256)) {
    push('the build zip checksum is not 64 lower-case hex digits');
  }
  if (!(manifest.build.zip.bytes > 0)) push('the build zip byte count is missing');
  if (manifest.build.builtOnce !== true) push('the build is not recorded as the one build');

  // ——— transfer: one checksum across assembled/uploaded/downloaded ———
  const transfer = manifest.transfer;
  if (
    !SHA256_PATTERN.test(transfer.checksumBefore) ||
    !SHA256_PATTERN.test(transfer.checksumAfter)
  ) {
    push('the transfer checksums are not 64 lower-case hex digits');
  }
  if (transfer.checksumBefore !== manifest.build.zip.sha256) {
    push('the checksum-before is not the build checksum (the one-build law)');
  }
  if (transfer.match !== true || transfer.checksumAfter !== transfer.checksumBefore) {
    push(
      `the received checksum does not match the assembled one (${transfer.checksumAfter} vs ${transfer.checksumBefore})`,
    );
  }
  if (
    manifest.mode === 'dry-run' &&
    (transfer.uploaded !== false || transfer.downloaded !== false)
  ) {
    push('a dry run must not record an upload or a download');
  }
  if (
    manifest.mode === 'downloaded' &&
    (transfer.uploaded !== true || transfer.downloaded !== true)
  ) {
    push('a downloaded-mode run must record both the upload and the download');
  }
  const draft = transfer.draftAsset;
  if (
    draft.repository === '' ||
    draft.tag === '' ||
    draft.asset === '' ||
    !draft.url.includes(draft.repository) ||
    !draft.url.includes(draft.tag)
  ) {
    push('the draft asset reference is incomplete (repository, tag, asset, or url)');
  }
  if (draft.visibility !== 'restricted-draft') {
    push(`the draft asset visibility "${String(draft.visibility)}" is not restricted-draft`);
  }

  // ——— host + the macOS-13.5 honesty law ———
  const claim = manifest.minimumMacOS;
  if (claim.metadata !== charterMinimumMacOS) {
    push(
      `the artifact's minimum-OS metadata "${claim.metadata}" is not the charter's ${charterMinimumMacOS}`,
    );
  }
  if (claim.controlledMinimumHost && claim.testedOn.swVersProduct !== charterMinimumMacOS) {
    push(
      `the manifest claims a controlled ${charterMinimumMacOS} host but actually tested ${claim.testedOn.swVersProduct}`,
    );
  }
  if (claim.verifiedAs === 'host' && claim.testedOn.swVersProduct !== charterMinimumMacOS) {
    push(
      'macOS host verification is claimed without an exact-version host (metadata-only is the only honest form here)',
    );
  }
  if (
    !claim.disclosure.includes(claim.testedOn.swVersProduct) ||
    !claim.disclosure.includes(claim.testedOn.swVersBuild)
  ) {
    push('the macOS disclosure does not name the actually-tested sw_vers product and build');
  }

  // ——— matrix: every leg recorded and passed ———
  const recorded = new Map(manifest.matrix.map((leg) => [leg.leg, leg]));
  for (const leg of MATRIX_LEGS) {
    const record = recorded.get(leg);
    if (record === undefined) {
      push(`the matrix carries no record for leg ${leg}`);
      continue;
    }
    if (record.status !== 'passed') {
      push(`matrix leg ${leg} did not pass (${String(record.summary)})`);
    }
    if (record.logFile === '') push(`matrix leg ${leg} names no log file`);
  }

  // ——— fixtures ———
  const sqlite = manifest.fixtures.betterSqlite3;
  if (sqlite.executed !== true) {
    push(`the better-sqlite3 fixture did not execute (${String(sqlite.detail)})`);
  } else {
    if (sqlite.builtFromSource !== true) {
      push('the better-sqlite3 fixture was not built from source');
    }
    if (sqlite.runtime?.node === null || sqlite.runtime?.abi === null) {
      push('the better-sqlite3 fixture recorded no runtime identity');
    }
    const memory = sqlite.inMemory ?? {};
    if (
      memory.created !== true ||
      Number(memory.inserted ?? 0) < 1 ||
      Number(memory.selected ?? 0) < 1 ||
      memory.closed !== true
    ) {
      push('the better-sqlite3 in-memory create/insert/select/close sequence is not complete');
    }
  }
  const sass = manifest.fixtures.nodeSass;
  if (sass.rejected !== true) push('the node-sass fixture was not rejected');
  if (sass.installed !== false) push('the node-sass fixture must never be installed');
  const diagnostic = sass.diagnostic ?? {};
  for (const field of ['package', 'version', 'runtime', 'os', 'architecture', 'upstream-support']) {
    if (diagnostic[field] === undefined) {
      push(`the node-sass diagnostic is missing the ${field} field`);
    }
  }

  // ——— verdict ———
  if (manifest.verdict === null) push('the manifest carries no sealed verdict');
  else if (manifest.verdict.ok !== true && manifest.verdict.failures.length === 0) {
    push('the verdict is red with no named failures');
  }

  return { ok: problems.length === 0, problems };
}
