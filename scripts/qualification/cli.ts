import { describeArgumentRejection, parseQualificationArguments, USAGE } from './args.ts';
import { runQualification } from './qualify.ts';

/**
 * The packaged-qualification CLI (#258, L1; ADR-0008 minimal
 * qualification): qualifies SUPPLIED candidate bytes black-box —
 *
 *   npm run qualify -- --artifact <zip> --expected-sha256 <sha> --evidence <dir>
 *
 * The artifact, the expected checksum, and the evidence directory are
 * accepted exclusively through those explicit flags (implicit paths
 * and environment-derived candidates are rejected — the argument law,
 * `args.ts`). The harness contains no product-feature knowledge: no
 * CSS/Content/route/fixture/workflow/Forge/release-publication
 * surface; it verifies the packaging laws (checksum, ZIP integrity,
 * extracted shape, strict ad-hoc signatures, fuses, resource manifest
 * hashes, bundled-Node identity), launches and terminates the packaged
 * app, audits owned processes, and records complete evidence. It never
 * edits or rebuilds the supplied artifact, and it runs locally against
 * H6's output as-is.
 *
 * Exit codes: 0 — qualified; 1 — a check failed (fail-closed, evidence
 * recorded); 2 — argument or environment misuse.
 */

const parsed = parseQualificationArguments(process.argv.slice(2));
if ('code' in parsed) {
  console.error(`qualification: ${describeArgumentRejection(parsed)}\n\n${USAGE}`);
  process.exit(2);
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  // the artifact this harness qualifies is the one macOS arm64 product
  // (ADR-0008); the check tools (codesign/plutil/lipo/ditto) are macOS
  console.error(
    `qualification: the packaged product is macOS arm64 only (ADR-0008) — this host is ${process.platform}/${process.arch}`,
  );
  process.exit(2);
}

const result = await runQualification({
  args: parsed,
  onLog: (line) => {
    console.log(line);
  },
});
for (const failure of result.failures) {
  console.error(`qualification: FAILURE — ${failure}`);
}
process.exit(result.ok ? 0 : 1);
