import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { RoutesState } from './routes';

export const API_PREFIX = '/__astroix';

/** The shared server context every `/__astroix` handler may touch. */
export interface ApiContext {
  server: ViteDevServer;
  /** Absolute project root (Vite root) — the confinement root for file paths. */
  root: string;
  /** Absolute Astro src dir (css/astro sources to index, content config). */
  srcDir: string;
  /** Routes captured by the integration's `astro:routes:resolved` hook. */
  routes: RoutesState;
}

/**
 * One endpoint of the builder API. `path` is mount-relative (connect strips
 * the `/__astroix` prefix, so `GET /__astroix/index` arrives as `/index`).
 * A handler answers its request fully or throws — it never calls `next()`.
 */
export interface ApiHandler {
  method: 'GET' | 'POST';
  path: string;
  handle(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiContext): Promise<void>;
}

export interface ApiOptions {
  root: string;
  srcDir: string;
  routes: RoutesState;
  /** Endpoint handlers, contributed by the owning modules (rest, content, routes). */
  handlers: readonly ApiHandler[];
}

/**
 * Registers the chrome↔node contract on the Vite connect middleware
 * (core-reuse §2 — like core's `/_astro/status`, not Astro app middleware):
 * one `/__astroix` mount dispatching over a handler table keyed by
 * `method + path`, so the same-origin invariant is structural (checked once,
 * in the dispatcher) instead of conventional (per registrar). The endpoints:
 *
 * - `GET /__astroix/index` — the index payload: edit-truth records joined
 *   with compiled scoped forms from the client module graph (`rest.ts`).
 * - `GET /__astroix/file` — root-confined file contents for the editor
 *   pane (`rest.ts`).
 * - `POST /__astroix/edit` — `{ file, range, replacement }` spliced to
 *   disk (`rest.ts`).
 * - `GET /__astroix/collections` — collections + entries through core's
 *   `astro:content` module (`content.ts`).
 * - `GET /__astroix/routes` — the routes captured from
 *   `astro:routes:resolved` (`routes.ts`).
 *
 * Same-origin only: a browser `sec-fetch-site` header that is not
 * same-origin/none is rejected (T2).
 */
export function registerApiEndpoints(server: ViteDevServer, options: ApiOptions): void {
  const table = new Map(
    options.handlers.map((handler) => [handlerKey(handler.method, handler.path), handler]),
  );
  // Two modules registering the same route would silently shadow — fail at
  // boot instead of at request time.
  if (table.size !== options.handlers.length) {
    throw new Error('astroix: duplicate route in the /__astroix handler table');
  }
  const ctx: ApiContext = {
    server,
    root: options.root,
    srcDir: options.srcDir,
    routes: options.routes,
  };
  server.middlewares.use(API_PREFIX, (req, res, next) => {
    void dispatchApi(req, res, next, table, ctx);
  });
}

async function dispatchApi(
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
  table: ReadonlyMap<string, ApiHandler>,
  ctx: ApiContext,
): Promise<void> {
  try {
    if (isCrossOriginTraffic(req)) {
      json(res, 403, { error: 'cross-origin builder traffic is not allowed' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://astroix.internal');
    // The middleware is mounted at /__astroix (connect strips the prefix), so
    // GET /__astroix/index arrives as /index; the bare mount serves the index.
    const path = url.pathname === '/' ? '/index' : url.pathname;
    const handler = table.get(handlerKey(req.method ?? '', path));
    if (handler === undefined) {
      next();
      return;
    }
    await handler.handle(req, res, url, ctx);
  } catch (error) {
    next(error instanceof Error ? error : new Error(String(error)));
  }
}

function handlerKey(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * The builder endpoints serve same-origin chrome traffic only: a browser
 * `sec-fetch-site` header that is not same-origin/none means cross-origin
 * (T2). Enforced once, by the `/__astroix` dispatcher.
 */
export function isCrossOriginTraffic(req: IncomingMessage): boolean {
  const secFetchSite = req.headers['sec-fetch-site'];
  return (
    typeof secFetchSite === 'string' && secFetchSite !== 'same-origin' && secFetchSite !== 'none'
  );
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
