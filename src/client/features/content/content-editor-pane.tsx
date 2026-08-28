/**
 * The Content vertical's editor pane — the dock slot for the generated
 * entry form. The form itself lands with #72; this slice only reserves
 * the slot so the shell swaps whole.
 */
export function ContentEditorPane() {
  return (
    <div
      data-astroix-content-form="pending"
      className="flex min-h-0 flex-1 items-center justify-center text-xs text-slate-600"
    >
      The entry form lands in the next slice.
    </div>
  );
}
