/**
 * The Content vertical's editor pane — the dock slot for the generated
 * entry form. The form itself lands with #72; this slice only reserves
 * the slot so the shell swaps whole.
 */
export function ContentEditorPane() {
  return (
    <div
      data-astroix-content-form="pending"
      className="flex w-[480px] shrink-0 items-center justify-center border-r border-slate-800 bg-slate-950 text-xs text-slate-600"
    >
      The entry form lands in the next slice.
    </div>
  );
}
