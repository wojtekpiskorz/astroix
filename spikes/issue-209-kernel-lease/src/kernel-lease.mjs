import {
  chmodSync,
  closeSync,
  fchmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { classifySqliteBusyError } from './sqlite-error-shape.mjs';

export const CERTIFIED_NODE_VERSION = 'v24.20.0';

const LEASE_FILES = Object.freeze({
  'registry-writer': 'registry-writer.sqlite',
  'edit-writer': 'edit-writer.sqlite',
});

function createPublicError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function notifyObserver(observer, snapshot) {
  try {
    void Promise.resolve(observer(snapshot)).catch(() => {});
  } catch {
    // Proof instrumentation never participates in the authority transition.
  }
}

function prepareLeaseFile(privateStateDirectory, leaseName) {
  mkdirSync(privateStateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(privateStateDirectory, 0o700);
  const path = join(privateStateDirectory, LEASE_FILES[leaseName]);
  const descriptor = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw createPublicError(
      'ASTROIX_KERNEL_LEASE_STORAGE_UNSUPPORTED',
      `Astroix cannot establish the ${leaseName} lease on this private state filesystem. Use a supported local filesystem.`,
    );
  }
  return path;
}

function qualificationFailure(leaseName, step) {
  return createPublicError(
    'ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED',
    `Astroix cannot start because bundled Node ${process.version} failed kernel-lease qualification at ${step} for ${leaseName}. Requalify the bundled-Node pin before release.`,
  );
}

export function createKernelLeaseModule({
  privateStateDirectory,
  runtimeVersion = process.version,
  onContention = () => {},
  onQualified = () => {},
}) {
  if (runtimeVersion !== CERTIFIED_NODE_VERSION) {
    const error = new Error(
      `Astroix cannot start because bundled Node ${runtimeVersion} is not qualified for kernel leases. Expected ${CERTIFIED_NODE_VERSION}. Requalify the bundled-Node pin before release.`,
    );
    error.code = 'ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED';
    throw error;
  }

  if (typeof privateStateDirectory !== 'string' || privateStateDirectory.length === 0) {
    throw new TypeError('privateStateDirectory is required');
  }

  const heldConnections = new Map();

  function hold(leaseName) {
    if (heldConnections.size !== 0) {
      throw createPublicError(
        'ASTROIX_KERNEL_LEASE_ALREADY_HELD',
        'This process already owns its lifetime-held kernel lease.',
      );
    }

    let database;
    try {
      const path = prepareLeaseFile(privateStateDirectory, leaseName);
      database = new DatabaseSync(path, {
        allowExtension: false,
        defensive: true,
        open: true,
        readOnly: false,
        timeout: 0,
      });
      const journalMode = database.prepare('PRAGMA journal_mode').get()?.journal_mode;
      if (journalMode !== 'delete') {
        throw qualificationFailure(leaseName, `journal-mode:${String(journalMode)}`);
      }

      let extensionsDisabled = false;
      try {
        database.enableLoadExtension(true);
      } catch (error) {
        extensionsDisabled = error?.code === 'ERR_INVALID_STATE';
      }
      if (!extensionsDisabled) {
        throw qualificationFailure(leaseName, 'extension-disablement');
      }

      const sqlite = database
        .prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId')
        .get();
      database.exec('BEGIN IMMEDIATE');
      if (!database.isTransaction) {
        throw qualificationFailure(leaseName, 'transaction-state');
      }

      heldConnections.set(leaseName, database);
      notifyObserver(onQualified, {
        extensionsDisabled,
        journalMode,
        leaseName,
        sqliteSourceId: sqlite.sourceId,
        sqliteVersion: sqlite.version,
      });
    } catch (error) {
      if (database !== undefined && !heldConnections.has(leaseName)) {
        try {
          if (database.isTransaction) database.exec('ROLLBACK');
        } finally {
          database.close();
        }
      }
      const busyClassification = classifySqliteBusyError(error);
      if (busyClassification === 'qualified-contention') {
        notifyObserver(onContention, {
          code: error.code,
          errcode: error.errcode,
          errstr: error.errstr,
        });
        throw createPublicError(
          'ASTROIX_KERNEL_LEASE_UNAVAILABLE',
          `Astroix cannot acquire the ${leaseName} lease because another live process owns it. Astroix will not continue without exclusive ownership.`,
        );
      }
      if (busyClassification === 'unqualified-busy') {
        throw qualificationFailure(leaseName, 'sqlite-busy-error-shape');
      }
      if (error?.code?.startsWith?.('ASTROIX_KERNEL_LEASE_')) throw error;
      throw createPublicError(
        'ASTROIX_KERNEL_LEASE_FAILED',
        `Astroix cannot establish the ${leaseName} lease on the private local state filesystem. Astroix will not continue.`,
      );
    }
  }

  return Object.freeze({
    holdRegistryWriter() {
      hold('registry-writer');
    },
    holdEditWriter() {
      hold('edit-writer');
    },
  });
}
