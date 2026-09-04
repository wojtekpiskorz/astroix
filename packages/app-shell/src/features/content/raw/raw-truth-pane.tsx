import { Textarea } from '#components/ui/textarea.tsx';

/**
 * The raw-truth pane (#252, J2; CONTEXT.md "raw truth"/"raw field"):
 * the entry's draft document presented RAW — the whole draft values as
 * editable YAML text. Prop-driven: the text in, the text report out,
 * the parse diagnostic rendered when the owner carries one; the parse
 * itself and the values live with the owner (the draft store), never
 * here. The body is NOT part of this surface (J2 edits values; the
 * body rides the intent untouched).
 */

interface RawTruthPaneProps {
  /** The draft values serialized as YAML — the pane's one text truth. */
  readonly text: string;
  /** Every text change reports up — the owner parses, validates, and stores. */
  readonly onText: (text: string) => void;
  /** The standing parse diagnostic, or null while the text parses. */
  readonly parseError: string | null;
  /** The draft's baseline revision (SHA-256 display) — the raw truth's anchor. */
  readonly revision: string | null;
}

export function RawTruthPane({ text, onText, parseError, revision }: RawTruthPaneProps) {
  return (
    <div data-astroix-raw-truth className="flex flex-col gap-2">
      <p className="text-[10px] text-muted-foreground">
        raw truth — the entry's values as YAML, exactly as the draft holds them
        {revision === null ? ' (no file revision)' : ` (baseline ${revision.slice(0, 12)}…)`}
      </p>
      <Textarea
        data-astroix-raw-text
        aria-label="raw truth"
        value={text}
        onChange={(event) => onText(event.target.value)}
        spellCheck={false}
        className="min-h-48 font-mono text-xs"
      />
      {parseError !== null && (
        <p data-astroix-parse-issue className="text-xs text-destructive">
          YAML: {parseError}
        </p>
      )}
    </div>
  );
}
