/**
 * The Content vertical's sidebar body — a placeholder in this slice: the
 * collections→entries list lands with the content-navigation work (#71).
 */
export function ContentSidebar() {
  return (
    <div
      data-astroix-entries="pending"
      className="flex min-h-0 flex-1 flex-col gap-3 text-slate-500"
    >
      <p>The collections and entries list lands in the next slice.</p>
    </div>
  );
}
