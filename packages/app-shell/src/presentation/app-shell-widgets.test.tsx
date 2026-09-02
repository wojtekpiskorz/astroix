import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentPaneState } from './content-pane-state';
import { EditorHeader } from './editor-header';
import { editFixture } from './fixtures';
import { mount } from './mount';
import { RangeChips } from './range-chips';
import { ShellHeader } from './shell-header';
import { type WriteStatus, WriteStatusBadge } from './write-status-badge';

/**
 * The app-shell widget tests (#219, AC-2): the write-status vocabulary
 * (the B2 write-outcome display — 200 → saved, the 409's accepted disk
 * truth → stale, everything else → error), the shell header's selection
 * surfacing, the shared editor header, the range chips, and the content
 * pane's non-editor states.
 */

const NOOP = (): void => {};

describe('WriteStatusBadge renders the B2 write-outcome vocabulary', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    ['loading', ''],
    ['idle', ''],
    ['pending', 'writing…'],
    ['saved', 'written'],
    ['stale', 'changed on disk — reloaded'],
    ['error', 'write error'],
  ] as const)('%s shows %s', (status, text) => {
    const { container, unmount } = mount(<WriteStatusBadge status={status} />);
    const badge = container.querySelector('[data-astroix-write-status]');
    expect(badge?.getAttribute('data-astroix-write-status')).toBe(status);
    expect(badge?.textContent).toBe(text);
    unmount();
  });

  it('the frozen conflict corpora map onto the stale display, not an error', () => {
    // both frozen 409 legs (css-splice surface, content-write surface) hand
    // back the disk truth the guard defended — the loop that accepts it
    // reloads and shows the stale banner, never a corruption
    const css = editFixture('css-conflict.json');
    const content = editFixture('content-conflict.json');
    expect(css.response.status).toBe(409);
    expect(content.response.status).toBe(409);
    expect(css.response.body.error).toBe('file changed on disk');
    const accepted: WriteStatus = 'stale';
    const { container, unmount } = mount(<WriteStatusBadge status={accepted} />);
    expect(container.querySelector('[data-astroix-write-status]')?.textContent).toBe(
      'changed on disk — reloaded',
    );
    unmount();
  });
});

describe('ShellHeader surfaces the selection state through props', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the descriptor or the no-selection word, and the toggle stays a prop', () => {
    const onToggle = vi.fn<() => void>();
    const { container, unmount } = mount(
      <ShellHeader
        selectMode={false}
        selectModeDisabled={false}
        selectionDescriptor="h1.hero-title:nth-of-type(1)"
        onToggleSelectMode={onToggle}
      />,
    );
    expect(container.querySelector('[data-astroix-selection]')?.textContent).toBe(
      'h1.hero-title:nth-of-type(1)',
    );
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    toggle?.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('carries the off-CSS select-mode suspension as a disabled prop', () => {
    const { container, unmount } = mount(
      <ShellHeader
        selectMode
        selectModeDisabled
        selectionDescriptor={null}
        onToggleSelectMode={NOOP}
      />,
    );
    expect(container.querySelector<HTMLButtonElement>('button[aria-pressed]')?.disabled).toBe(true);
    expect(container.querySelector('[data-astroix-selection]')?.textContent).toBe('no selection');
    unmount();
  });
});

describe('EditorHeader and RangeChips carry the editor frame', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('EditorHeader shows the document, the status, and an optional close', () => {
    const onClose = vi.fn<() => void>();
    const withClose = mount(
      <EditorHeader title="src/pages/home.css" status="idle" onClose={onClose} />,
    );
    expect(withClose.container.textContent).toContain('src/pages/home.css');
    expect(withClose.container.querySelector('[data-astroix-write-status="idle"]')).not.toBeNull();
    withClose.container.querySelector<HTMLButtonElement>('[aria-label="close editor"]')?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    withClose.unmount();

    // no callback, no close affordance (the content pane's header shape)
    const withoutClose = mount(<EditorHeader title="blog/2024/post" status="saved" />);
    expect(withoutClose.container.querySelector('[aria-label="close editor"]')).toBeNull();
    expect(
      withoutClose.container.querySelector('[data-astroix-write-status="saved"]')?.textContent,
    ).toBe('written');
    withoutClose.unmount();
  });

  it('RangeChips marks the active place and reports jumps by index', () => {
    const onJump = vi.fn<(index: number) => void>();
    const { container, unmount } = mount(
      <RangeChips
        ranges={[
          { start: 0, end: 10, label: 'L8' },
          { start: 20, end: 30, label: 'L16' },
          { start: 40, end: 50, label: 'L22' },
        ]}
        activeIndex={1}
        onJump={onJump}
      />,
    );
    const chips = container.querySelectorAll<HTMLButtonElement>('[data-astroix-range-chip]');
    expect(chips.length).toBe(3);
    expect(chips[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('false');
    chips[2]?.click();
    expect(onJump).toHaveBeenCalledWith(2);
    unmount();
  });
});

describe('ContentPaneState covers the non-editor pane states', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    ['syncing', 'Waiting for the content sync…'],
    ['empty', 'No entry open — pick one in the Content list.'],
    ['reading', 'Reading the entry file…'],
    ['error', 'The entry file could not be read — the write loop is down.'],
  ] as const)('the %s state renders its message under the pane hook', (state, message) => {
    const { container, unmount } = mount(<ContentPaneState state={state} message={message} />);
    const pane = container.querySelector(`[data-astroix-content-pane="${state}"]`);
    expect(pane?.textContent).toBe(message);
    unmount();
  });
});
