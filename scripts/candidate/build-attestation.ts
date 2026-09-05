/**
 * The one-build attestation law of the restricted-candidate workflow
 * (#259, L2; review round 1): the evidence manifest's `builtOnce`
 * asserts only what the recorder observed. The `run` path observed the
 * one build in this process; every other recorder — the dispatch
 * workflow's standalone `candidate qualify` — must hand an EXPLICIT
 * `--built <manifest>` attestation naming the packaging manifest the
 * bytes came from, and the attestation is VERIFIED: the named build's
 * recorded checksum must be the checksum the received bytes are held
 * to. Never trusted, never defaulted to true. Pure — the self-tests
 * pin every refusal direction.
 */

/** Why a supplied build attestation is refused. */
export type BuildAttestationProblem = 'malformed-manifest' | 'wrong-checksum';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Checks a supplied packaging manifest (already parsed) against the
 * checksum the received bytes must prove. The attestation is green only
 * when the named build recorded a well-formed checksum that IS the
 * received checksum — the bytes demonstrably came from that one build.
 */
export function verifyBuildAttestation(input: {
  readonly buildManifest: unknown;
  readonly receivedSha256: string;
}): BuildAttestationProblem | null {
  const manifest = input.buildManifest as { zip?: { file?: unknown; sha256?: unknown } } | null;
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    typeof manifest.zip?.file !== 'string' ||
    manifest.zip.file === '' ||
    typeof manifest.zip?.sha256 !== 'string' ||
    !SHA256_PATTERN.test(manifest.zip.sha256)
  ) {
    return 'malformed-manifest';
  }
  if (manifest.zip.sha256 !== input.receivedSha256) return 'wrong-checksum';
  return null;
}
