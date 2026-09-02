import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Test-only mount helper for the presentation widget tests (#219): happy-dom
 * + React 19's own `act`, the thinnest renderer that can assert rendered
 * structure without pulling a testing library into the manifest.
 */

export interface Mounted {
  container: HTMLElement;
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

/** Types into an input the way a user does: native value + input event. */
export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (setter === undefined) throw new Error('no native value setter');
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
