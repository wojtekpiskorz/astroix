import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs';

/**
 * The certification fixture's observable project integration (the #206
 * duplicate-hook probe): a plain project-owned Astro integration that
 * records every `astro:config:setup` execution to an append-only log —
 * one JSON line per real config execution, with the executing pid and a
 * process-local counter (state separation evidence across the two real
 * executions: the composition inspector and the managed dev server).
 *
 * In `exclusive` mode it claims a file with `wx` on first execution and
 * fails with the named diagnostic on any later execution — the
 * charter-accepted incompatibility boundary: a project integration with
 * a shared exclusive side effect is unsupported and must fail with a
 * clear diagnostic (#202/#206), never silently corrupt.
 *
 * This file is certification machinery staged INTO the disposable temp
 * project copy — it never lands in the canonical fixture and carries no
 * Astroix dependency (plain `node:fs`, plain Astro integration shape).
 */

let processLocalConfigSetupCount = 0;

export function observableIntegration(options) {
  return {
    name: 'astroix-certification:observable-project-integration',
    hooks: {
      'astro:config:setup': ({ command }) => {
        processLocalConfigSetupCount += 1;
        appendFileSync(
          options.hookLog,
          `${JSON.stringify({
            command,
            hook: 'astro:config:setup',
            mode: options.mode ?? 'append',
            pid: process.pid,
            processLocalConfigSetupCount,
          })}\n`,
        );
        if (options.mode !== 'exclusive') return;
        try {
          const descriptor = openSync(options.exclusivePath, 'wx');
          writeFileSync(descriptor, `${process.pid}\n`);
          closeSync(descriptor);
        } catch (error) {
          if (error?.code === 'EEXIST') {
            throw new Error(
              'certification incompatible duplicate hook: exclusive side effect already claimed',
              { cause: error },
            );
          }
          throw error;
        }
      },
    },
  };
}
