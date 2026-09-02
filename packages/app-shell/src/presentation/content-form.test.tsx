import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEntryDraft } from '../../../core/src/entry-writer';
import { ContentForm } from './content-form';
import { FieldWidget } from './field-widgets';
import { editFixture, inspectionFixture } from './fixtures';
import { mount, typeInto } from './mount';
import type { FormFieldNode, ValidationIssueMap } from './types';

/**
 * The form-widget tests (#219, AC-5/6): the frozen B1 content-schemas,
 * collections, and raw-truth corpora are the prop source. The form mounts
 * on the raw truth (the file's own parse, exactly as the write loop hands
 * it over — `parseEntryDraft` over the frozen bytes), the walked tree comes
 * from the frozen schema walk, and the inline issues come from the frozen
 * B2 advisory-validation probe: every widget kind the corpus carries
 * renders, the zod defaults display without materializing (#149
 * widget-display), and the draft/blur seams report as props.
 */

const schemasFixture = inspectionFixture('content-schemas.json');
const collectionsFixture = inspectionFixture('collections.json');
const validateFixture = editFixture('content-validate.json');
const rawTruthFixture = inspectionFixture('raw-truth.json');

function fieldsFor(collection: string): FormFieldNode[] {
  const walk = schemasFixture.schemas.find((schema) => schema.collection === collection);
  if (walk === undefined) throw new Error(`frozen corpus has no schema walk for ${collection}`);
  return walk.fields as FormFieldNode[];
}

function rawTruthFor(file: string): { data: unknown; body: string } {
  const read = rawTruthFixture.reads.find((entry) => entry.file === file);
  if (read === undefined) throw new Error(`frozen corpus has no raw-truth read for ${file}`);
  const draft = parseEntryDraft(read.contents);
  if (draft === null) throw new Error(`frozen raw truth for ${file} does not parse`);
  return draft;
}

/** The frozen invalid probe's issues, in the adapter's display form. */
const frozenIssues: ValidationIssueMap = {};
for (const issue of validateFixture.invalid.response.issues) {
  frozenIssues[issue.path] = issue.message;
}

const NOOP = (): void => {};

describe('ContentForm over the frozen content corpora', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders every walked widget kind from the frozen schema tree on the raw truth', () => {
    const truth = rawTruthFor('src/content/blog/hello-builder.md');
    const { container, unmount } = mount(
      <ContentForm
        collection="blog"
        fields={fieldsFor('blog')}
        entryData={truth.data}
        projectionData={truth.data}
        issues={{}}
        onValuesChange={NOOP}
        onFlushValidation={NOOP}
      />,
    );

    // string field carries the raw truth's value
    const title = container.querySelector<HTMLInputElement>(
      '[data-astroix-form-field="title"] input',
    );
    expect(title?.value).toBe('Hello builder');

    // the raw date field renders as YAML text (the 'date' reason), and the
    // raw 'aside' subtree likewise
    expect(
      container.querySelector('[data-astroix-raw-field="date"][data-astroix-raw-reason="date"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-astroix-raw-field="aside"][data-astroix-raw-reason="union"]'),
    ).not.toBeNull();

    // array field: the truth's one row renders with its remove button, plus Add
    expect(container.querySelector('[data-astroix-form-field="tags.0"]')).not.toBeNull();
    expect(container.querySelector('[data-astroix-array-remove="0"]')).not.toBeNull();
    expect(container.querySelector('[data-astroix-array-add="tags"]')).not.toBeNull();

    // widget-display (#149): absent keys render their zod defaults as
    // placeholder text — the values never adopt them until touched
    const priority = container.querySelector<HTMLInputElement>(
      '[data-astroix-form-field="priority"] input',
    );
    expect(priority?.value).toBe('');
    expect(priority?.placeholder).toBe('0');

    // the group renders as a fieldset with its child
    expect(container.querySelector('fieldset[data-astroix-form-field="meta"]')).not.toBeNull();
    expect(container.querySelector('[data-astroix-form-field="meta.source"] input')).not.toBeNull();

    // required markers on the walked tree
    expect(
      container.querySelector('[data-astroix-form-field="title"] label')?.textContent,
    ).toContain(' *');

    unmount();
  });

  it('renders the frozen B2 advisory issues inline per field, gating nothing', () => {
    const { container, unmount } = mount(
      <ContentForm
        collection="blog"
        fields={fieldsFor('blog')}
        entryData={validateFixture.invalid.draft}
        projectionData={validateFixture.invalid.draft}
        issues={frozenIssues}
        onValuesChange={NOOP}
        onFlushValidation={NOOP}
      />,
    );

    // the frozen probe's three issues render on their fields verbatim
    expect(container.querySelector('[data-astroix-field-issue="title"]')?.textContent).toContain(
      'Too small',
    );
    expect(container.querySelector('[data-astroix-field-issue="tags.1"]')?.textContent).toContain(
      'expected string',
    );
    expect(container.querySelector('[data-astroix-field-issue="tone"]')?.textContent).toContain(
      'bold',
    );

    // advisory means advisory: the invalid draft still renders editable
    expect(
      container.querySelector<HTMLInputElement>('[data-astroix-form-field="title"] input')?.value,
    ).toBe('ab');

    unmount();
  });

  it('emits the draft through the values seam on mount and on every change', () => {
    const truth = rawTruthFor('src/content/blog/hello-builder.md');
    const onValuesChange = vi.fn<(values: unknown) => void>();
    const { container, unmount } = mount(
      <ContentForm
        collection="blog"
        fields={fieldsFor('blog')}
        entryData={truth.data}
        projectionData={truth.data}
        issues={{}}
        onValuesChange={onValuesChange}
        onFlushValidation={NOOP}
      />,
    );

    // the mount emission carries the raw truth's draft
    expect(onValuesChange).toHaveBeenCalledTimes(1);
    expect(onValuesChange.mock.calls[0]?.[0]).toEqual(truth.data);

    const titleInput = container.querySelector<HTMLInputElement>(
      '[data-astroix-form-field="title"] input',
    );
    if (titleInput === null) throw new Error('title input did not render');
    typeInto(titleInput, 'Hello builder, retitled');
    expect(onValuesChange).toHaveBeenCalledTimes(2);
    expect(onValuesChange.mock.calls[1]?.[0]).toEqual({
      ...(truth.data as Record<string, unknown>),
      title: 'Hello builder, retitled',
    });

    unmount();
  });

  it('reports blur through the flush seam (validate now, ahead of the debounce)', () => {
    const truth = rawTruthFor('src/content/blog/hello-builder.md');
    const onFlushValidation = vi.fn<() => void>();
    const { container, unmount } = mount(
      <ContentForm
        collection="blog"
        fields={fieldsFor('blog')}
        entryData={truth.data}
        projectionData={truth.data}
        issues={{}}
        onValuesChange={NOOP}
        onFlushValidation={onFlushValidation}
      />,
    );
    expect(onFlushValidation).not.toHaveBeenCalled();
    container
      .querySelector<HTMLInputElement>('[data-astroix-form-field="title"] input')
      // React maps blur to the bubbling focusout (blur itself never bubbles)
      ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(onFlushValidation).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('renders the schema-less collection as one root raw field over the frozen raw truth', () => {
    const truth = rawTruthFor('src/content/notes/scratch.md');
    const { container, unmount } = mount(
      <ContentForm
        collection="notes"
        fields={fieldsFor('notes')}
        entryData={truth.data}
        projectionData={truth.data}
        issues={{}}
        onValuesChange={NOOP}
        onFlushValidation={NOOP}
      />,
    );
    const root = container.querySelector<HTMLTextAreaElement>('[data-astroix-raw-field=""]');
    expect(root).not.toBeNull();
    expect(root?.value).toContain('kind: scratchpad');
    expect(root?.value).toContain('pinned: true');
    unmount();
  });

  it('FieldWidget renders image() metadata read-only from the projection', () => {
    const galleryFields = fieldsFor('gallery');
    const showcase = collectionsFixture.collections
      .find((collection) => collection.name === 'gallery')
      ?.entries.find((entry) => entry.id === 'showcase');
    if (showcase === undefined) throw new Error('frozen corpus has no showcase entry');
    const hero = galleryFields.find((field) => field.path === 'hero');
    if (hero === undefined || hero.kind !== 'image') throw new Error('no hero image field');

    const { container, unmount } = mount(
      <FieldWidget
        node={hero}
        value="/src/assets/pixel.png"
        onChange={NOOP}
        issues={{}}
        display={(showcase.data as Record<string, unknown>).hero}
      />,
    );
    const meta = container.querySelector('[data-astroix-image-field="meta"]');
    expect(meta?.textContent).toContain('/src/assets/pixel.png');
    expect(meta?.textContent).toContain('width');
    unmount();
  });
});
