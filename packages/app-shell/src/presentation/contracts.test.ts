import { describe, expect, it } from 'vitest';
import type { ContentValidateFixture } from '../../../../e2e/behavior-contracts/schema/edit-contract.ts';
import { editFixtureSchemas } from '../../../../e2e/behavior-contracts/schema/edit-contract.ts';
import type {
  CollectionsFixture,
  ContentSchemasFixture,
  CssIndexFixture,
  RouteResolutionFixture,
} from '../../../../e2e/behavior-contracts/schema/inspection-contract.ts';
import { fixtureSchemas } from '../../../../e2e/behavior-contracts/schema/inspection-contract.ts';
import * as appShell from '../index';
import { editFixture, inspectionFixture } from './fixtures';
import * as presentation from './index';
import type {
  CollectionListingView,
  RuleMatchView,
  RuleRecordView,
  SchemaFieldsView,
  ValidationIssueSource,
} from './types';

/**
 * The contract-derivation pin (#219, AC-4/AC-6): the presentation widgets'
 * prop types claim to be derived from the frozen B1/B2 behavior contracts.
 * That claim is held honest three ways here — (a) the zod-inferred contract
 * shapes and the prop types are assignable in BOTH directions at compile
 * time (the declarations below fail typecheck on drift), (b) every frozen
 * fixture the widget tests consume parses against its versioned schema at
 * runtime, and (c) the export-surface boundary holds: the presentation
 * barrel carries the retained widgets by name while the domain-deaf barrel
 * (`src/index.ts`) gains none of them.
 */

// --- (a) type-level pins: contract shape ↔ prop shape ---
//
// The pins are conditional-typed booleans — pure type-level assertions that
// stay valid runtime code (a `true` literal), so they fail TYPECHECK on
// drift while never touching the module's runtime behavior.

/** `true` when `From` is assignable to `To`; `never` (a compile error at the pin) otherwise. */
type Assignable<From, To> = [From] extends [To] ? true : never;

type ContractCssRecord = CssIndexFixture['records'][number];
type ContractField = ContentSchemasFixture['schemas'][number]['fields'][number];
type ContractIssue = ContentValidateFixture['invalid']['response']['issues'][number];

// The B1 css-index record vs the rule list's row model — both directions.
const pinCssRecordToView: Assignable<ContractCssRecord, RuleRecordView> = true;
const pinViewToCssRecord: Assignable<RuleRecordView, ContractCssRecord> = true;
void pinCssRecordToView;
void pinViewToCssRecord;

// The rule-list row model composes the contract record.
const pinMatchView: Assignable<RuleMatchView['record'], ContractCssRecord> = true;
void pinMatchView;

// The B1 content-schemas field tree vs the form's fields prop — the schema
// union is annotated to the walked-tree type, so this pins both at once.
const pinFieldsToView: Assignable<ContractField, SchemaFieldsView[number]> = true;
const pinViewToFields: Assignable<SchemaFieldsView[number], ContractField> = true;
void pinFieldsToView;
void pinViewToFields;

// The B2 content-validate issue records vs the adapter's issue source.
const pinIssuesToSource: Assignable<ContractIssue, ValidationIssueSource[number]> = true;
const pinSourceToIssues: Assignable<ValidationIssueSource[number], ContractIssue> = true;
void pinIssuesToSource;
void pinSourceToIssues;

describe('presentation props are derived from the frozen contracts', () => {
  it('every frozen fixture the presentation tests consume parses against its versioned schema', () => {
    // the B1 corpus legs the widget tests mount against
    expect(inspectionFixture('css-index.attribute.json').kind).toBe('css-index');
    expect(inspectionFixture('collections.json').kind).toBe('collections');
    expect(inspectionFixture('content-schemas.json').kind).toBe('content-schemas');
    expect(inspectionFixture('route-resolution.json').kind).toBe('route-resolution');
    // the B2 corpus legs: the advisory-validation issues and the conflict shapes
    expect(editFixture('content-validate.json').kind).toBe('content-validate');
    expect(editFixture('css-conflict.json').kind).toBe('edit-conflict');
    expect(editFixture('content-conflict.json').kind).toBe('edit-conflict');
    // the manifest registries stay the enumeration of what can load
    expect(Object.keys(fixtureSchemas).length).toBeGreaterThan(0);
    expect(Object.keys(editFixtureSchemas).length).toBeGreaterThan(0);
  });

  it('derives the entry-tree listing view from the frozen collections payload', () => {
    const fixture: CollectionsFixture = inspectionFixture('collections.json');
    const listings: readonly CollectionListingView[] = fixture.collections.map((collection) => ({
      name: collection.name,
      entryIds: collection.entries.map((entry) => entry.id),
    }));
    expect(listings.map((listing) => listing.name)).toEqual([
      'blog',
      'gallery',
      'homepage',
      'notes',
    ]);
  });

  it('derives the unrouted marker truth from the frozen route-resolution payload', () => {
    const fixture: RouteResolutionFixture = inspectionFixture('route-resolution.json');
    const unrouted = new Set(
      fixture.entryResolutions.filter((row) => row.unrouted).map((row) => row.entryId),
    );
    expect([...unrouted].sort()).toEqual(['index', 'scratch', 'showcase']);
  });
});

describe('the export-surface boundary', () => {
  it('the presentation barrel exposes the retained widget contracts by name', () => {
    for (const name of [
      'ArrayRows',
      'CheckboxWidget',
      'ContentForm',
      'ContentPaneState',
      'EditorHeader',
      'EntryTree',
      'EnumWidget',
      'FieldWidget',
      'IndexStatus',
      'NumberWidget',
      'RangeChips',
      'RawField',
      'RuleList',
      'SchemaField',
      'ShellHeader',
      'StringWidget',
      'WriteStatusBadge',
    ]) {
      expect(presentation, `presentation barrel missing export: ${name}`).toHaveProperty(name);
    }
  });

  it('the domain-deaf barrel gains no presentation export', () => {
    // ADR-0002's package-level boundary: the primitive/editor barrel stays
    // domain-deaf; the presentation surface is its own subpath. A widget
    // leaking onto the deaf barrel re-couples every primitive consumer to
    // the product domain.
    for (const name of [
      'ArrayRows',
      'ContentForm',
      'ContentPaneState',
      'EditorHeader',
      'EntryTree',
      'FieldWidget',
      'IndexStatus',
      'RangeChips',
      'RuleList',
      'SchemaField',
      'ShellHeader',
      'WriteStatusBadge',
    ]) {
      expect(appShell, `domain-deaf barrel must not export: ${name}`).not.toHaveProperty(name);
    }
    // `WriteStatus` is a type-only export of the presentation surface — the
    // compile-time proof it never crosses the deaf barrel is the import in
    // chrome-widgets.test.tsx resolving from this package's presentation
    // barrel alone.
  });
});
