import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * The checksum law of the restricted-candidate workflow (#259, L2):
 * ONE build, THREE checksum observations that must all agree — the
 * locally assembled ZIP, the uploaded asset (dispatch mode), and the
 * downloaded bytes a tester receives. `verifyTransfer` is the pure
 * conjunction; the workflow's own steps (and the local dry run's
 * staged-receipt proof) feed it. A byte-rebuilt artifact anywhere on
 * that path is `rebuilt-bytes`, never a silent substitution.
 */

/** The streamed SHA-256 of one file (the ZIP is ~170 MB — never buffered whole). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** One file's identity facts: path, byte size, SHA-256. */
export interface FileFacts {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export async function fileFacts(path: string): Promise<FileFacts> {
  const [sha256, info] = await Promise.all([sha256File(path), stat(path)]);
  return { path, bytes: info.size, sha256 };
}

/** Why a transfer failed — one code per law, the finding the matrix records. */
export type TransferFailureCode = 'checksum-mismatch-assembled' | 'rebuilt-bytes';

export interface TransferVerdict {
  readonly ok: boolean;
  readonly failure: { readonly code: TransferFailureCode; readonly detail: string } | null;
}

/**
 * The one-build law as a pure verdict: the expected checksum (stated
 * up front, from the build's own candidate manifest), the assembled
 * checksum (re-observed at qualification time), and the received
 * checksum (the staged copy in a dry run, or the downloaded asset in
 * dispatch mode) must be THE SAME VALUE. The assembled drift is
 * `rebuilt-bytes` — the bytes under qualification are not the bytes
 * that were built; the received drift is the tester's-side mismatch.
 */
export function verifyTransfer(input: {
  readonly expected: string;
  readonly assembled: string;
  readonly received: string;
}): TransferVerdict {
  if (input.assembled !== input.expected) {
    return {
      ok: false,
      failure: {
        code: 'rebuilt-bytes',
        detail: `the assembled checksum ${input.assembled} is not the expected ${input.expected} — the artifact was rebuilt or replaced after the build (the one-build law)`,
      },
    };
  }
  if (input.received !== input.expected) {
    return {
      ok: false,
      failure: {
        code: 'checksum-mismatch-assembled',
        detail: `the received checksum ${input.received} is not the expected ${input.expected} — the uploaded/downloaded bytes differ from the assembled ones`,
      },
    };
  }
  return { ok: true, failure: null };
}
