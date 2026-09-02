import { describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import {
  getCollectionRejection,
  moduleEvaluationRejection,
  readContentApi,
  readContentConfig,
  readEntryRecord,
  readServedEntries,
  readZodNamespace,
  SEAM_CONTENT_API,
  SEAM_CONTENT_CONFIG,
  SEAM_ZOD_NAMESPACE,
} from '../../astro-project-adapter/content/content-probes';

/**
 * The fail-closed content probes (#228 focused tests — the
 * `seam-readers.test.ts` idiom): every probe accepts exactly the
 * certified shape and throws a `seam-rejected` AdapterError naming the
 * seam, its class, the expected shape, and a structural observed
 * description — never a guess, never a value dump.
 */

function expectSeamRejection(probe: () => unknown, seam: string, seamClass: string): AdapterError {
  let rejection: unknown;
  try {
    probe();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(AdapterError);
  const error = rejection as AdapterError;
  expect(error.code).toBe('seam-rejected');
  expect(error.details).toMatchObject({ seam, seamClass });
  expect(error.message).toContain(`seam rejection at ${seam}`);
  return error;
}

describe('readContentApi (astro:content, public seam)', () => {
  it('accepts a function getCollection export', () => {
    const api = readContentApi({ getCollection: async () => [] });
    expect(typeof api.getCollection).toBe('function');
  });

  it('fails closed when the export drifts', () => {
    expectSeamRejection(
      () => readContentApi({ getEntry: async () => null }),
      'astro:content export getCollection()',
      'public',
    );
    expectSeamRejection(
      () => readContentApi(null),
      'astro:content export getCollection()',
      'public',
    );
  });

  it('wraps a getCollection call rejection with the cause kept', () => {
    const cause = new Error('store exploded');
    const error = expectSeamRejection(
      () => {
        throw getCollectionRejection('blog', cause);
      },
      'astro:content export getCollection()',
      'public',
    );
    expect(error.details).toMatchObject({ observed: 'a getCollection rejection' });
    expect(error.cause).toBe(cause);
  });
});

describe('readZodNamespace (astro/zod, public seam)', () => {
  it('accepts a zod namespace with a string method', () => {
    const zod = readZodNamespace({
      string: () => ({ transform: (f: (v: string) => string) => f }),
    });
    expect(typeof zod.string).toBe('function');
  });

  it('fails closed when the namespace drifts', () => {
    expectSeamRejection(
      () => readZodNamespace({ object: () => ({}) }),
      'astro/zod root export',
      'public',
    );
    expectSeamRejection(() => readZodNamespace(undefined), 'astro/zod root export', 'public');
  });
});

describe('readContentConfig (content config export, fail-closed private)', () => {
  it('accepts a collections record of object definitions', () => {
    const definitions = readContentConfig({
      collections: { blog: { type: 'content_layer' }, notes: {} },
    });
    expect([...definitions.keys()]).toEqual(['blog', 'notes']);
  });

  it('fails closed when the collections export drifts', () => {
    const seam = 'content config module src/content.config.ts collections export';
    expectSeamRejection(() => readContentConfig({}), seam, 'fail-closed private');
    expectSeamRejection(() => readContentConfig({ collections: [] }), seam, 'fail-closed private');
    expectSeamRejection(
      () => readContentConfig({ collections: 'all' }),
      seam,
      'fail-closed private',
    );
  });

  it('fails closed when one collection definition is not an object', () => {
    expectSeamRejection(
      () => readContentConfig({ collections: { blog: 'defined elsewhere' } }),
      'content config module src/content.config.ts collections export',
      'fail-closed private',
    );
  });
});

describe('moduleEvaluationRejection (the import surface)', () => {
  it('wraps an evaluation rejection for each content seam with the cause kept', () => {
    const cause = new Error('vite could not resolve');
    // The constants are the seam names' single source — asserted here so
    // a renamed constant can never silently desync from a seam string.
    for (const [seam, seamClass] of [
      [SEAM_CONTENT_API, 'public'],
      [SEAM_ZOD_NAMESPACE, 'public'],
      [SEAM_CONTENT_CONFIG, 'fail-closed private'],
    ] as const) {
      const error = moduleEvaluationRejection(seam, 'a module', cause);
      expect(error.code).toBe('seam-rejected');
      expect(error.details).toMatchObject({
        seam,
        seamClass,
        observed: 'a module evaluation rejection',
      });
      expect(error.cause).toBe(cause);
      // The upstream message never leaks into the adapter's own message.
      expect(error.message).not.toContain('vite could not resolve');
    }
  });
});

describe('readServedEntries / readEntryRecord (entry serving shape, public seam)', () => {
  const seam = 'astro:content getCollection() entry export';

  it('accepts the certified entry shape, nulling absent filePath and body', () => {
    expect(
      readServedEntries([
        { id: 'post', filePath: 'src/content/blog/post.md', data: { title: 'T' }, body: 'B' },
        { id: 'store', data: { x: 1 } },
      ]),
    ).toEqual([
      { id: 'post', filePath: 'src/content/blog/post.md', data: { title: 'T' }, body: 'B' },
      { id: 'store', filePath: null, data: { x: 1 }, body: null },
    ]);
  });

  it('fails closed when the served value is not an array', () => {
    expectSeamRejection(() => readServedEntries({}), seam, 'public');
  });

  it('fails closed on entry drift: id, data, and filePath shapes', () => {
    expectSeamRejection(() => readEntryRecord({ data: {} }), seam, 'public');
    expectSeamRejection(() => readEntryRecord({ id: '', data: {} }), seam, 'public');
    expectSeamRejection(() => readEntryRecord({ id: 'x', data: null }), seam, 'public');
    expectSeamRejection(() => readEntryRecord({ id: 'x', data: ['array'] }), seam, 'public');
  });

  it('fails closed on filePaths that would leave the project root', () => {
    for (const filePath of ['/etc/passwd', '../outside.md', 'src\\content\\x.md']) {
      expectSeamRejection(() => readEntryRecord({ id: 'x', filePath, data: {} }), seam, 'public');
    }
  });
});
