import type { ResourceGrant } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import type { GrantedResource } from '../../edit-authority/grants/grant-table';
import { planStyleEdit } from '../../edit-authority/planning/style-plans';

/**
 * Style-domain planning (#223): the pure lift of an authorized css wire
 * plan — splice ranges proven against the verified baseline text,
 * replacement/whole-text contents carried untouched, creation failing
 * closed (the css species set, #203's placement deferral).
 */

const resource = {
  canonicalRoot: '/canonical/root',
  session: { runtimeEpoch: 'epoch-a', generation: 1 },
  kind: 'css',
  operations: ['replace-contents', 'splice'],
  displayPath: 'src/styles/global.css',
  baseline: { type: 'sha256', sha256: 'a'.repeat(64) },
  target: { type: 'existing', canonicalPath: '/canonical/root/src/styles/global.css' },
} as const satisfies GrantedResource;

const TEXT = '.hero { color: red; }';

function world(text: string | null) {
  return { ok: true as const, text };
}

describe('planStyleEdit', () => {
  it('carries a replace-contents plan untouched', () => {
    const result = planStyleEdit(
      resource,
      { operation: 'replace-contents', grant: stubGrant(), contents: '.hero { color: blue; }' },
      world(TEXT),
    );
    expect(result).toEqual({
      ok: true,
      plan: {
        operation: 'replace-contents',
        resource,
        contents: '.hero { color: blue; }',
      },
    });
  });

  it('accepts a splice range that fits the verified baseline text', () => {
    const result = planStyleEdit(
      resource,
      {
        operation: 'splice',
        grant: stubGrant(),
        range: { start: 15, end: 18 },
        replacement: 'blue',
      },
      world(TEXT),
    );
    expect(result).toEqual({
      ok: true,
      plan: {
        operation: 'splice',
        resource,
        range: { start: 15, end: 18 },
        replacement: 'blue',
      },
    });
  });

  it('accepts a range ending exactly at the text length (end-exclusive bound)', () => {
    const result = planStyleEdit(
      resource,
      {
        operation: 'splice',
        grant: stubGrant(),
        range: { start: 0, end: TEXT.length },
        replacement: 'x',
      },
      world(TEXT),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a splice range beyond the baseline text', () => {
    const result = planStyleEdit(
      resource,
      {
        operation: 'splice',
        grant: stubGrant(),
        range: { start: 0, end: TEXT.length + 1 },
        replacement: 'x',
      },
      world(TEXT),
    );
    expect(result).toEqual({
      ok: false,
      code: 'range-outside-baseline',
      message: expect.any(String),
    });
  });

  it('fails closed on a null world text (creation-shaped misuse)', () => {
    const result = planStyleEdit(
      resource,
      { operation: 'splice', grant: stubGrant(), range: { start: 0, end: 3 }, replacement: 'x' },
      world(null),
    );
    expect(result).toEqual({
      ok: false,
      code: 'range-outside-baseline',
      message: expect.any(String),
    });
  });

  it('fails closed on a create-contents wire plan (species guard)', () => {
    const result = planStyleEdit(
      resource,
      { operation: 'create-contents', grant: stubGrant(), contents: 'x' },
      world(null),
    );
    expect(result).toEqual({
      ok: false,
      code: 'operation-not-allowed',
      message: expect.any(String),
    });
  });
});

/** The wire grant shape the planners carry — only the fields the plan echoes. */
function stubGrant(): ResourceGrant {
  return {
    token: 't'.repeat(43),
    kind: 'css',
    operations: ['replace-contents', 'splice'],
    displayPath: 'src/styles/global.css',
    baseline: { type: 'sha256', sha256: 'a'.repeat(64) },
  };
}
