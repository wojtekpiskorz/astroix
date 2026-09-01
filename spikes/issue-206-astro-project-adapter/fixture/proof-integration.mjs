import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs';

let processLocalConfigSetupCount = 0;

export function observableIntegration(options) {
  return {
    name: 'adapter-proof:observable-project-integration',
    hooks: {
      'astro:config:setup': ({ command, config }) => {
        processLocalConfigSetupCount += 1;
        record(options, {
          command,
          cwd: process.cwd(),
          hook: 'astro:config:setup',
          pid: process.pid,
          ppid: process.ppid,
          processLocalConfigSetupCount,
          projectRoot: config.root.href,
          role: options.role,
        });
        if (options.mode !== 'exclusive') return;
        if (!options.exclusivePath) {
          throw new Error('proof integration exclusive mode has no exclusive path');
        }
        try {
          const descriptor = openSync(options.exclusivePath, 'wx');
          writeFileSync(descriptor, `${options.role}:${process.pid}\n`);
          closeSync(descriptor);
        } catch (error) {
          if (error?.code === 'EEXIST') {
            throw new Error(
              `proof integration incompatible duplicate hook: exclusive side effect already claimed at ${options.exclusivePath}`,
              { cause: error },
            );
          }
          throw error;
        }
      },
      'astro:server:setup': ({ server }) => {
        record(options, {
          address: server.httpServer?.address() ?? null,
          cwd: process.cwd(),
          hook: 'astro:server:setup',
          pid: process.pid,
          role: options.role,
        });
      },
    },
  };
}

function record(options, event) {
  if (!options.hookLog) {
    throw new Error('proof integration has no hook log');
  }
  appendFileSync(options.hookLog, `${JSON.stringify(event)}\n`);
}
