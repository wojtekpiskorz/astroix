import type { QueryClient } from '@tanstack/react-query';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppClient } from '../../../app-client.ts';
import { ShellProvider } from '../../../app-shell/shell-provider.tsx';
import {
  actAsync,
  byTestId,
  click,
  type Mounted,
  mount,
  waitFor,
} from '../../../app-shell/test-mount.tsx';
import { inspectionFixture } from '../../../presentation/fixtures.ts';
import { typeInto } from '../../../presentation/mount.tsx';
import { createShellQueryClient } from '../../../query/shell-query-client.ts';
import { clearShellStores } from '../../../state/shell-stores.ts';
import { type DiscoveryWire, scriptDiscoveryWire } from '../discovery/test-wire.ts';
import { useContentNavigationStore } from '../navigation/navigation-store.ts';
import { ContentEntryForm } from './content-entry-form.tsx';
import { useFormDraftStore } from './form-draft-store.ts';

/**
 * The entry-form pane's focused component lane (#252's AC): the real
 * provider, the real AppClient, and the real scripted wire (J1's
 * discipline), with the content payload carrying the E4 entry truth —
 * the frozen corpora's walked trees and inspected values plus the
 * revision/issues fields the runtime serves. Every leg drives the pane
 * the way a user does; no leg writes anything (no mutation command
 * exists on this surface).
 */

const ORIGIN = 'http://project.localhost:4426';
const CAPABILITY = 'client-capability-fixture';
const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 4 };
const NEXT_SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 5 };

const collectionsFixture = inspectionFixture('collections.json');
const schemasFixture = inspectionFixture('content-schemas.json');

const REVISION = 'f'.repeat(64);
const COLLECTION_REVISION = 'e'.repeat(64);

/** Builds one E4-shaped content payload over the frozen corpora, with per-entry overrides. */
function contentPayload(input?: {
  readonly entryRevision?: (id: string) => string | null;
  readonly entryData?: (collection: string, id: string) => unknown;
  readonly entryIssues?: (collection: string, id: string) => unknown;
}): unknown {
  return {
    collections: collectionsFixture.collections.map((collection) => ({
      name: collection.name,
      entries: collection.entries.map((entry) => ({
        id: entry.id,
        filePath: `src/content/${collection.name}/${entry.id}.md`,
        data: input?.entryData?.(collection.name, entry.id) ?? entry.data,
        body: entry.body,
        revision: input?.entryRevision?.(entry.id) ?? REVISION,
        issues: input?.entryIssues?.(collection.name, entry.id) ?? [],
      })),
      schema: {
        declared: collection.hasSchema,
        fields:
          schemasFixture.schemas.find((schema) => schema.collection === collection.name)?.fields ??
          [],
      },
      revision: COLLECTION_REVISION,
    })),
    diagnostics: [],
    revision: 'd'.repeat(64),
  };
}

const realFetch = globalThis.fetch;
let wire: DiscoveryWire = scriptDiscoveryWire();
let mounted: Mounted | null = null;
let queryClient: QueryClient = createShellQueryClient();

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  globalThis.fetch = realFetch;
  clearShellStores();
  // the feature stores are document-scoped: clear them between legs
  useContentNavigationStore.setState({ activeEntry: null, feedback: { kind: 'none' } });
  useFormDraftStore.getState().clear();
  wire = scriptDiscoveryWire();
  queryClient = createShellQueryClient();
});

/** Mounts the pane inside the real provider over the scripted wire (a test-owned query client). */
function mountPane(session: SessionRef = SESSION): HTMLElement {
  globalThis.fetch = wire.fetch;
  const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
  mounted = mount(
    <ShellProvider client={client} sessionRef={session} queryClient={queryClient}>
      <ContentEntryForm />
    </ShellProvider>,
  );
  return mounted.container;
}

/** Selects an entry the way the navigation slice does (the pane's input). */
function openEntry(collection: string, entryId: string): void {
  act(() => {
    useContentNavigationStore.getState().setActiveEntry({ collection, entryId });
  });
}

/** The pane's root. */
function pane(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[data-astroix-entry-form]');
  if (root === null) throw new Error('the pane did not render');
  return root as HTMLElement;
}

/** Resolves the content inspection and waits for the pane's given state. */
async function settleReady(
  container: HTMLElement,
  payload: unknown,
  status = 'ready',
): Promise<void> {
  await actAsync(async () => {
    wire.resolveInspect('content', payload);
  });
  await waitFor(() => pane(container).getAttribute('data-form-status') === status);
}

describe('the pane states', () => {
  it('renders the no-entry state until an entry is open', () => {
    const container = mountPane();
    expect(pane(container).getAttribute('data-form-status')).toBe('no-entry');
    expect(byTestId(container, 'entry-form-status').textContent).toContain('select an entry');
  });

  it('renders the loading state while the inspection is in flight, then the ready form', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    expect(pane(container).getAttribute('data-form-status')).toBe('loading');
    await settleReady(container, contentPayload());
    expect(pane(container).getAttribute('data-form-status')).toBe('ready');
    expect(pane(container).getAttribute('data-form-mode')).toBe('form');
  });

  it('renders the absent state for an entry the payload does not carry', async () => {
    const container = mountPane();
    openEntry('blog', 'ghost-entry');
    await settleReady(container, contentPayload(), 'absent');
    expect(byTestId(container, 'entry-form-status').textContent).toContain('not in the content');
  });

  it('fails closed on payload drift — the sanitized diagnostic, never a guess', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(container, { collections: 'not an array' }, 'drift');
    expect(byTestId(container, 'entry-form-diagnostic').textContent).toContain('drift');
  });
});

describe('the form state (typed schema + inspected values)', () => {
  it('renders the supported widgets from the frozen blog walk over the inspected values', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(container, contentPayload());

    const title = container.querySelector<HTMLInputElement>(
      '[data-astroix-form-field="title"] input',
    );
    expect(title?.value).toBe('Hello builder');
    // enum select renders the inspected value's option
    expect(container.querySelector('[data-astroix-form-field="tone"]')).not.toBeNull();
    // number + boolean + array rows render
    expect(container.querySelector('[data-astroix-form-field="priority"] input')).not.toBeNull();
    expect(container.querySelector('[data-astroix-form-field="tags.0"]')).not.toBeNull();
    expect(container.querySelector('[data-astroix-form-field="featured"]')).not.toBeNull();
    // the unsupported shapes render as raw fields (date, aside)
    expect(
      container.querySelector('[data-astroix-raw-field="date"][data-astroix-raw-reason="date"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-astroix-raw-field="aside"][data-astroix-raw-reason="union"]'),
    ).not.toBeNull();
    // the revision carries into the header
    expect(byTestId(container, 'entry-revision').textContent).toContain(REVISION.slice(0, 12));
  });

  it('renders nested group values (the homepage cta) and optional absents without issues', async () => {
    const container = mountPane();
    openEntry('homepage', 'index');
    await settleReady(container, contentPayload());

    expect(
      container.querySelector<HTMLInputElement>('[data-astroix-form-field="cta.label"] input')
        ?.value,
    ).toBe('Get started');
    expect(
      container.querySelector<HTMLInputElement>('[data-astroix-form-field="cta.href"] input')
        ?.value,
    ).toBe('https://astro.build');
    // the optional image is absent: no widget issue, no document issue
    expect(byTestId(container, 'intent-state').getAttribute('data-intent-state')).toBe('none');
    expect(container.querySelector('[data-astroix-document-issues]')).toBeNull();
  });

  it('renders the unknown-fields raw section and preserves its values through widget edits', async () => {
    const payload = contentPayload({
      entryData: (collection, id) =>
        collection === 'blog' && id === 'hello-builder'
          ? {
              ...(collectionsFixture.collections
                .find((c) => c.name === 'blog')
                ?.entries.find((entry) => entry.id === 'hello-builder')?.data as object),
              unmapped: { keeps: ['everything', true] },
            }
          : undefined,
    });
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(container, payload);

    // the explicit raw representation of the unclaimed shape
    expect(container.querySelector('[data-astroix-unknown-fields]')).not.toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-astroix-raw-field="__unknown__"]')?.value,
    ).toContain('keeps');

    // a widget edit never drops the unknown half (the never-drop law, live)
    const title = container.querySelector<HTMLInputElement>(
      '[data-astroix-form-field="title"] input',
    );
    if (title === null) throw new Error('title widget missing');
    await actAsync(async () => {
      typeInto(title, 'Edited title');
    });
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );
    const intentPre = byTestId(container, 'edit-intent').querySelector('pre');
    if (intentPre === null) throw new Error('intent json missing');
    const intent = JSON.parse(intentPre.textContent ?? '') as {
      values: { unmapped?: unknown; title?: unknown };
    };
    expect(intent.values.unmapped).toEqual({ keeps: ['everything', true] });
    expect(intent.values.title).toBe('Edited title');
  });

  it('renders the schema-less collection as the single root raw field (the every-collection-opens law)', async () => {
    const container = mountPane();
    openEntry('notes', 'scratch');
    await settleReady(container, contentPayload());
    // the root raw widget holds the whole frontmatter as YAML
    const rootRaw = container.querySelector<HTMLTextAreaElement>('[data-astroix-raw-field=""]');
    expect(rootRaw).not.toBeNull();
    expect(rootRaw?.value).toContain('kind: scratchpad');
    expect(rootRaw?.value).toContain('pinned: true');
  });
});

describe('form/raw switching', () => {
  it('carries form edits into the raw text and raw edits back into the form — nothing drops', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(container, contentPayload());

    // form edit
    const title = container.querySelector<HTMLInputElement>(
      '[data-astroix-form-field="title"] input',
    );
    if (title === null) throw new Error('title widget missing');
    await actAsync(async () => {
      typeInto(title, 'Form edit');
    });
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );

    // switch to raw: the text is the current values
    click(byAttr(container, '[data-astroix-form-mode-button="raw"]'));
    expect(pane(container).getAttribute('data-form-mode')).toBe('raw');
    const raw = container.querySelector<HTMLTextAreaElement>('[data-astroix-raw-text]');
    if (raw === null) throw new Error('raw text missing');
    expect(raw.value).toContain('title: Form edit');
    expect(raw.value).toContain('tags');
    expect(raw.value).toContain('tone: bold');

    // raw edit: a known key AND an unknown key
    const edited = raw.value.replace('title: Form edit', 'title: Raw edit');
    await actAsync(async () => {
      typeInto(raw, edited);
    });
    // the unknown key arrives through the YAML itself
    const withUnknown = `${edited.trimEnd()}\nfromRaw: true\n`;
    await actAsync(async () => {
      typeInto(raw, withUnknown);
    });

    // back to form: the form remounts on the current values
    click(byAttr(container, '[data-astroix-form-mode-button="form"]'));
    await waitFor(
      () =>
        container.querySelector<HTMLInputElement>('[data-astroix-form-field="title"] input')
          ?.value === 'Raw edit',
    );
    // the raw-added unknown key rides the unknown section now
    expect(container.querySelector('[data-astroix-unknown-fields]')).not.toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-astroix-raw-field="__unknown__"]')?.value,
    ).toContain('fromRaw: true');
  });

  it('reports the parse diagnostic on broken YAML and keeps the last parsed values', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(container, contentPayload());
    click(byAttr(container, '[data-astroix-form-mode-button="raw"]'));
    const raw = container.querySelector<HTMLTextAreaElement>('[data-astroix-raw-text]');
    if (raw === null) throw new Error('raw text missing');
    await actAsync(async () => {
      typeInto(raw, 'title: "unterminated');
    });
    await waitFor(() => pane(container).querySelector('[data-astroix-parse-issue]') !== null);
    // the document-level parse issue names its kind; the raw pane prefixes the YAML source
    expect(pane(container).querySelector('[data-issue-kind="parse"]')).not.toBeNull();
    expect(pane(container).querySelector('[data-astroix-parse-issue]')?.textContent).toContain(
      'YAML:',
    );
    // the intent is blocked while the diagnostic stands
    expect(byTestId(container, 'intent-state').getAttribute('data-intent-state')).toBe('invalid');
    // recovery: the text parses again — and a complete document (the
    // required title and date present) restores the ready intent
    await actAsync(async () => {
      typeInto(raw, 'title: fixed\ndate: 2026-08-26T00:00:00.000Z');
    });
    await waitFor(() => pane(container).querySelector('[data-astroix-parse-issue]') === null);
    expect(byTestId(container, 'intent-state').getAttribute('data-intent-state')).toBe('ready');
  });
});

describe('validation display', () => {
  it('renders the inspected issue verdict verbatim beside the draft validation', async () => {
    const payload = contentPayload({
      entryIssues: (collection, id) =>
        collection === 'blog' && id === 'hello-builder'
          ? [{ path: 'title', code: 'too_small', message: 'too short!' }]
          : undefined,
    });
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(container, payload);
    expect(container.querySelector('[data-astroix-inspected-issues]')).not.toBeNull();
    expect(
      container.querySelector('[data-astroix-inspected-issue="title"]')?.textContent,
    ).toContain('too short!');
  });

  it('reports a deleted required key inline (schema) and blocks the intent', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(container, contentPayload());
    // a cleared STRING widget holds '' — a present value the walked
    // tree cannot judge; required-missing is the raw space's honest
    // edit (the key deleted), which is exactly how this leg drives it
    click(byAttr(container, '[data-astroix-form-mode-button="raw"]'));
    const raw = container.querySelector<HTMLTextAreaElement>('[data-astroix-raw-text]');
    if (raw === null) throw new Error('raw text missing');
    await actAsync(async () => {
      typeInto(raw, 'tags:\n  - meta\n');
    });
    // back to form: the inline schema issue renders on the field
    click(byAttr(container, '[data-astroix-form-mode-button="form"]'));
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'invalid',
    );
    expect(container.querySelector('[data-astroix-field-issue="title"]')?.textContent).toContain(
      'required',
    );
  });

  it('reports a stale baseline when the inspection revision moves under the draft', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(container, contentPayload());

    // the background refetch the SSE invalidation bridge drives: same
    // generation-scoped key, a moved entry revision in the fresh payload
    const invalidation = queryClient.invalidateQueries({
      queryKey: ['astroix', SESSION.runtimeEpoch, SESSION.generation, 'content'],
    });
    await waitFor(() => wire.openCount('content') === 1);
    await actAsync(async () => {
      wire.resolveInspect('content', contentPayload({ entryRevision: () => 'a'.repeat(64) }));
      await invalidation;
    });
    await waitFor(
      () => pane(container).querySelector('[data-issue-kind="stale-baseline"]') !== null,
    );
    // the draft itself survives untouched
    expect(
      container.querySelector<HTMLInputElement>('[data-astroix-form-field="title"] input')?.value,
    ).toBe('Hello builder');
    expect(byTestId(container, 'intent-state').getAttribute('data-intent-state')).toBe('none');
  });
});

describe('the generation-bound draft reset', () => {
  it('resets the draft when the entry changes — edits die with the selection', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(container, contentPayload());
    const title = container.querySelector<HTMLInputElement>(
      '[data-astroix-form-field="title"] input',
    );
    if (title === null) throw new Error('title widget missing');
    await actAsync(async () => {
      typeInto(title, 'DOOMED EDIT');
    });
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );

    openEntry('blog', '2024/post');
    await waitFor(
      () =>
        container.querySelector<HTMLInputElement>('[data-astroix-form-field="title"] input')
          ?.value === 'Nested post',
    );
    expect(byTestId(container, 'intent-state').getAttribute('data-intent-state')).toBe('none');

    // back to the first entry: the inspected truth, not the dead draft
    openEntry('blog', 'hello-builder');
    await waitFor(
      () =>
        container.querySelector<HTMLInputElement>('[data-astroix-form-field="title"] input')
          ?.value === 'Hello builder',
    );
  });

  it('resets the draft when the generation changes — a new document never inherits one', async () => {
    // generation 4: edit an entry
    const first = mountPane(SESSION);
    openEntry('blog', 'hello-builder');
    await settleReady(first, contentPayload());
    const title = first.querySelector<HTMLInputElement>('[data-astroix-form-field="title"] input');
    if (title === null) throw new Error('title widget missing');
    await actAsync(async () => {
      typeInto(title, 'STALE DOCUMENT EDIT');
    });
    await waitFor(
      () => byTestId(first, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );
    mounted?.unmount();
    mounted = null;

    // the next document (generation 5) opens the SAME entry: the binding
    // check resets the module-lived draft before anything renders from it
    const second = mountPane(NEXT_SESSION);
    openEntry('blog', 'hello-builder');
    await settleReady(second, contentPayload());
    await waitFor(
      () =>
        second.querySelector<HTMLInputElement>('[data-astroix-form-field="title"] input')?.value ===
        'Hello builder',
    );
    expect(byTestId(second, 'intent-state').getAttribute('data-intent-state')).toBe('none');
  });
});

/** One element by attribute selector — the testid helper's sibling for product attributes. */
function byAttr(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector(selector);
  if (element === null) throw new Error(`missing element: ${selector}`);
  return element as HTMLElement;
}
