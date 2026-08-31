import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

const SERVER_SYMBOL = Symbol.for('astroix.runtime-spine.vite-server');

function appendObservation(observation) {
  const log = process.env.ASTROIX_RUNTIME_SPINE_HOOK_LOG;
  if (log) appendFileSync(log, `${JSON.stringify(observation)}\n`);
}

function watcherSnapshot(server) {
  const watched = server.watcher.getWatched?.() ?? {};
  const watchedDirectories = Object.keys(watched);
  const watchedEntries = Object.values(watched).reduce(
    (count, entries) => count + entries.length,
    0,
  );
  const watcherListeners = server.watcher
    .eventNames()
    .reduce((count, event) => count + server.watcher.listenerCount(event), 0);
  return { watchedDirectories: watchedDirectories.length, watchedEntries, watcherListeners };
}

function proofObserver() {
  return {
    name: 'runtime-spine:observer',
    hooks: {
      'astro:config:setup': ({ command, config, updateConfig }) => {
        appendObservation({
          hook: 'astro:config:setup',
          command,
          base: config.base,
          srcDir: fileURLToPath(config.srcDir),
          serverPort: config.server.port,
        });
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'runtime-spine:expose-vite-server',
                configureServer(server) {
                  globalThis[SERVER_SYMBOL] = server;
                  server.httpServer?.once('listening', () => {
                    const address = server.httpServer?.address();
                    appendObservation({
                      hook: 'runtime-spine:server-listening',
                      actualPort:
                        typeof address === 'object' && address !== null ? address.port : null,
                    });
                    setTimeout(() => {
                      appendObservation({
                        hook: 'runtime-spine:watcher-snapshot',
                        ...watcherSnapshot(server),
                      });
                    }, 250);
                  });
                },
              },
            ],
          },
        });
      },
      'astro:routes:resolved': ({ routes }) => {
        appendObservation({
          hook: 'astro:routes:resolved',
          routes: routes.map((route) => ({
            pattern: route.pattern.source,
            entrypoint: route.entrypoint,
            params: route.params,
            type: route.type,
            isPrerendered: route.isPrerendered,
          })),
        });
      },
    },
  };
}

export default defineConfig({
  srcDir: './site',
  base: '/lab',
  scopedStyleStrategy: 'where',
  integrations: [proofObserver()],
  vite: {
    resolve: {
      alias: {
        '@fixture': fileURLToPath(new URL('./site/lib', import.meta.url)),
      },
    },
  },
});
