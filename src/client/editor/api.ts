// Pre-Query legacy (ADR-0002 Consequences): raw fetches moved here as-is by
// the restructure; they migrate to Query hooks in this file when editor data
// handling is next touched — deliberately not the mechanical move's job.

/** Browser-side sha256 hex — the optimistic-write currency of both verticals. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** GET /__astroix/file — the file's current on-disk contents, null on failure. */
export async function fetchFileContents(file: string): Promise<string | null> {
  const response = await fetch(`/__astroix/file?file=${encodeURIComponent(file)}`);
  if (!response.ok) return null;
  const { contents } = (await response.json()) as { contents: string };
  return contents;
}

export interface FileRangeEdit {
  file: string;
  /** believed-on-disk baseline — hashed into the optimistic-write guard */
  baseline: string;
  range: { start: number; end: number };
  replacement: string;
}

export type FileRangeEditResult =
  | { status: 'written' }
  /** a 409: the disk moved first — `contents` carries its truth when present */
  | { status: 'conflict'; contents: string | null }
  | { status: 'error' };

/** POST /__astroix/edit — one contiguous splice per pause. */
export async function putFileRangeEdit(edit: FileRangeEdit): Promise<FileRangeEditResult> {
  const response = await fetch('/__astroix/edit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      file: edit.file,
      range: edit.range,
      replacement: edit.replacement,
      // optimistic write: what we believe is on disk — a mismatch means
      // the file changed under us (IDE edit racing the debounce)
      expected: await sha256Hex(edit.baseline),
    }),
  });
  if (response.status === 409) {
    const body = (await response.json()) as { contents?: string };
    return {
      status: 'conflict',
      contents: typeof body.contents === 'string' ? body.contents : null,
    };
  }
  if (response.ok) return { status: 'written' };
  return { status: 'error' };
}
