import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Test-only mount helper for the shell tests (#241): the presentation
 * lane's idiom — happy-dom + React 19's own `act`, no testing library.
 * `actAsync` wraps the async flushes query resolution and transition
 * promises need.
 */

export interface Mounted {
  readonly container: HTMLElement;
  unmount(): void;
}

export function mount(ui: ReactElement): Mounted {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Flushes async work inside act — awaited promises, query resolution, subscription settling. */
export async function actAsync(work: () => Promise<void>): Promise<void> {
  await act(async () => {
    await work();
  });
}

/**
 * Waits until `condition` holds — and FAILS the test when it never does
 * (bounded, ~2s). The deterministic companion for asserting state whose
 * final hop is timer-scheduled — query notifications and SSE frame
 * renders — where a fixed hop count races the library's notification
 * batch. Each iteration is one macrotask hop (letting the scheduled
 * notification fire) followed by an empty synchronous act (flushing
 * whatever landed): holding ONE act scope open across the whole poll
 * would queue — and starve — the very renders being waited on.
 */
export async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: the condition did not hold within 2s');
    // One hop inside ONE-iteration act scope: the timer-scheduled
    // notification fires and its update lands — queued and flushed —
    // inside that scope, never outside every act.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Clicks a button the way a user does — inside act. */
export function click(element: Element): void {
  act(() => {
    (element as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

/** One element by testid, from the mounted container's document. */
export function byTestId(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${id}"]`);
  if (element === null) throw new Error(`missing testid: ${id}`);
  return element as HTMLElement;
}
