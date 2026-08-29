import type { EditorView } from '@codemirror/view';
import { Bold, Heading2, Link } from 'lucide-react';
import { Button } from '#components/ui/button.tsx';

const BOLD = '**';
const HEADING = '## ';
const URL_PLACEHOLDER = 'url';

/**
 * Wraps the selection in `token` (cursor between the marks when empty);
 * a selection sitting directly inside an existing pair unwraps it instead —
 * both directions are ordinary history-tracked transactions.
 */
function toggleWrap(view: EditorView, token: string): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  if (
    from >= token.length &&
    to <= doc.length - token.length &&
    doc.sliceString(from - token.length, from) === token &&
    doc.sliceString(to, to + token.length) === token
  ) {
    view.dispatch({
      changes: [
        { from: from - token.length, to: from },
        { from: to, to: to + token.length },
      ],
    });
    return;
  }
  const selected = doc.sliceString(from, to);
  view.dispatch({
    changes: { from, to, insert: `${token}${selected}${token}` },
    selection: { anchor: from + token.length, head: to + token.length },
  });
}

/** Toggles a `## ` prefix on the selection's line; other heading levels normalize to `## `. */
function toggleHeading(view: EditorView): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const level = /^(#{1,6}) /.exec(line.text)?.[1];
  if (level === undefined) {
    view.dispatch({ changes: { from: line.from, insert: HEADING } });
    return;
  }
  const levelEnd = line.from + level.length + 1;
  view.dispatch({
    changes: { from: line.from, to: levelEnd, insert: level === '##' ? '' : HEADING },
  });
}

/**
 * Wraps the selection as `[text](url)` with the placeholder selected so the
 * next keystroke replaces it; an empty selection leaves the cursor between
 * the brackets.
 */
function insertLink(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const selected = view.state.doc.sliceString(from, to);
  view.dispatch({
    changes: { from, to, insert: `[${selected}](${URL_PLACEHOLDER})` },
    selection:
      selected === ''
        ? { anchor: from + 1 }
        : {
            anchor: from + selected.length + 3,
            head: from + selected.length + 3 + URL_PLACEHOLDER.length,
          },
  });
}

/**
 * The body editor's toolbar: emits markdown around the selection through the
 * live view — bold / heading / link (owner ruling on #47: toolbar-markdown is
 * v1, rich text stays fog). Buttons never steal the editor's focus (the strip
 * prevents mousedown defaults), so every action lands in the same history
 * stream as typing and native Cmd+Z undoes through it.
 */
export function MarkdownToolbar({ view }: { view: () => EditorView | null }) {
  const act = (apply: (view: EditorView) => void): void => {
    const target = view();
    if (target === null) return;
    apply(target);
    target.focus();
  };

  return (
    <div
      data-astroix-md-toolbar
      role="toolbar"
      aria-label="Markdown formatting"
      className="flex items-center gap-1 border-b border-border px-2 py-1.5"
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Bold (markdown)"
        data-astroix-md-action="bold"
        onClick={() => act((target) => toggleWrap(target, BOLD))}
      >
        <Bold />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Heading (markdown)"
        data-astroix-md-action="heading"
        onClick={() => act(toggleHeading)}
      >
        <Heading2 />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Link (markdown)"
        data-astroix-md-action="link"
        onClick={() => act(insertLink)}
      >
        <Link />
      </Button>
    </div>
  );
}
