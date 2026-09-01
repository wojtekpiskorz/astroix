import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CERTIFIED_NODE_VERSION, createKernelLeaseModule } from '../src/kernel-lease.mjs';
import {
  assertRequiredCaseSet,
  REQUIRED_QUALIFICATION_CASES,
} from '../src/qualification-contract.mjs';
import { classifySqliteBusyError } from '../src/sqlite-error-shape.mjs';

test('exposes only fixed process-lifetime acquisition calls', async () => {
  const privateStateDirectory = await mkdtemp(join(tmpdir(), 'astroix-lease-interface-'));
  try {
    const leases = createKernelLeaseModule({
      privateStateDirectory,
      runtimeVersion: CERTIFIED_NODE_VERSION,
    });

    assert.deepEqual(Object.keys(leases).sort(), ['holdEditWriter', 'holdRegistryWriter']);
    assert.equal(typeof leases.holdRegistryWriter, 'function');
    assert.equal(typeof leases.holdEditWriter, 'function');
    assert.equal('release' in leases, false);
    assert.equal('path' in leases, false);
    assert.equal('database' in leases, false);
  } finally {
    await rm(privateStateDirectory, { recursive: true, force: true });
  }
});

test('rejects an unqualified bundled Node pin before touching private state', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'astroix-lease-version-'));
  const privateStateDirectory = join(parent, 'must-not-exist');
  try {
    assert.throws(
      () =>
        createKernelLeaseModule({
          privateStateDirectory,
          runtimeVersion: 'v24.20.1',
        }),
      (error) => {
        assert.equal(error?.code, 'ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
        assert.equal(
          error?.message,
          `Astroix cannot start because bundled Node v24.20.1 is not qualified for kernel leases. Expected ${CERTIFIED_NODE_VERSION}. Requalify the bundled-Node pin before release.`,
        );
        assert.equal(error?.message.includes(privateStateDirectory), false);
        return true;
      },
    );

    await assert.rejects(
      import('node:fs/promises').then(({ stat }) => stat(privateStateDirectory)),
      (error) => error?.code === 'ENOENT',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('accepts only the exact Node 24.20.0 SQLite contention error shape', () => {
  const exact = {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
    errstr: 'database is locked',
  };
  assert.equal(classifySqliteBusyError(exact), 'qualified-contention');
  assert.equal(classifySqliteBusyError({ ...exact, errcode: 261 }), 'unqualified-busy');
  assert.equal(
    classifySqliteBusyError({ ...exact, errstr: 'database is busy' }),
    'unqualified-busy',
  );
  assert.equal(classifySqliteBusyError({ ...exact, errstr: undefined }), 'unqualified-busy');
  assert.equal(classifySqliteBusyError({ ...exact, code: 'OTHER' }), 'other');
});

test('the qualification gate rejects any missing or duplicate required case', () => {
  const completeTap = REQUIRED_QUALIFICATION_CASES.map((name) => `# Subtest: ${name}`).join('\n');
  assert.deepEqual(assertRequiredCaseSet(completeTap), REQUIRED_QUALIFICATION_CASES);

  assert.throws(
    () =>
      assertRequiredCaseSet(
        REQUIRED_QUALIFICATION_CASES.slice(1)
          .map((name) => `# Subtest: ${name}`)
          .join('\n'),
      ),
    (error) => error?.code === 'ASTROIX_QUALIFICATION_MATRIX_INCOMPLETE',
  );
  assert.throws(
    () => assertRequiredCaseSet(`${completeTap}\n# Subtest: ${REQUIRED_QUALIFICATION_CASES[0]}`),
    (error) => error?.code === 'ASTROIX_QUALIFICATION_MATRIX_INCOMPLETE',
  );
});
