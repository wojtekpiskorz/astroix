import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative, resolve, sep } from 'node:path';
import postcss from 'postcss';
import type { ViteDevServer } from 'vite';
import { buildCssIndex, type SourceFile } from '../core/indexer';
import type { IndexPayloadRecord } from '../core/matcher';
import { SpliceRangeError, spliceText } from '../core/splice-writer';

const API_PREFIX = '/__astroix';
const MAX_BODY_BYTES = 1_000_000;

export interface RestOptions {
  /** Absolute project root (Vite root). */
  root: string;
  /** Absolute Astro src dir holding the css/astro sources to index. */
  srcDir: string;
}

/**
 * Registers the chrome↔node contract on the Vite connect middleware
 * (core-reuse §2 — like core's `/_astro/status`, not Astro app middleware):
 *
 * - `GET /__astroix/index` — the index payload: edit-truth records joined
 *   with compiled scoped forms from the client module graph.
 * - `POST /__astroix/edit` — `{ file, range, replacement }` spliced to disk.
 *
 * Same-origin only: a browser `sec-fetch-site` header that is not
 * same-origin/none is rejected (T2).
 */
export function registerRestEndpoints(server: ViteDevServer, options: RestOptions): void {
  server.middlewares.use(API_PREFIX, (req, res, next) => {
    void handleApiRequest(req, res, next, server, options);
  });
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
  server: ViteDevServer,
  options: RestOptions,
): Promise<void> {
  try {
    const secFetchSite = req.headers['sec-fetch-site'];
    if (
      typeof secFetchSite === 'string' &&
      secFetchSite !== 'same-origin' &&
      secFetchSite !== 'none'
    ) {
      json(res, 403, { error: 'cross-origin builder traffic is not allowed' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://astroix.internal');

    // The middleware is mounted at /__astroix (connect strips the prefix),
    // so the GET path arrives as /index.
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index')) {
      const payload = await buildIndexPayload(collectSources(options.srcDir), (file, blockIndex) =>
        resolveCompiledCss(server, options.root, file, blockIndex),
      );
      // Payload paths are project-relative; the join worked in absolute space.
      json(
        res,
        200,
        payload.map((record) => ({ ...record, file: toRelative(options.root, record.file) })),
      );
      return;
    }

    // File content for the editor pane — a dedicated endpoint (not payload
    // fields) so contents are fresh exactly when a rule is opened and the
    // payload stays small. Same root confinement as the edit endpoint.
    if (req.method === 'GET' && url.pathname === '/file') {
      const file = url.searchParams.get('file');
      const absPath = file === null ? null : safeResolve(options.root, file);
      if (file === null || absPath === null || !existsSync(absPath)) {
        json(res, 400, { error: `file is missing or outside the project root: ${file ?? ''}` });
        return;
      }
      json(res, 200, { file, contents: readFileSync(absPath, 'utf8') });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/edit') {
      const body = await readJsonBody(req);
      const { file, range, replacement } = parseEditBody(body);
      if (file === null || range === null || replacement === null) {
        json(res, 400, { error: 'expected { file, range: { start, end }, replacement }' });
        return;
      }
      const absPath = safeResolve(options.root, file);
      if (absPath === null) {
        json(res, 400, { error: `file is outside the project root: ${file}` });
        return;
      }
      const contents = readFileSync(absPath, 'utf8');
      try {
        writeFileSync(
          absPath,
          spliceText(contents, { start: range[0], end: range[1], replacement }),
        );
      } catch (error) {
        if (error instanceof SpliceRangeError) {
          json(res, 400, { error: error.message });
          return;
        }
        throw error;
      }
      json(res, 200, { ok: true });
      return;
    }

    next();
  } catch (error) {
    next(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Supplies the compiled css of a scoped style module, or null when absent. */
export type CompiledCssResolver = (file: string, styleBlockIndex: number) => Promise<string | null>;

/**
 * The module-graph hybrid join: static records plus effective selectors for
 * scoped rules. Scoped records of one style block correlate with the compiled
 * rules of module `{file}.astro?astro&type=style&index={N}` in rule order; a
 * block with no compiled module (not loaded on the current route, or a rule
 * count mismatch) stays listed without an effective selector — the liveness
 * line of v1.
 */
export async function buildIndexPayload(
  sources: SourceFile[],
  resolveCompiledCss: CompiledCssResolver,
): Promise<IndexPayloadRecord[]> {
  const payload: IndexPayloadRecord[] = buildCssIndex(sources).map((record) => ({
    ...record,
    effectiveSelector: null,
  }));

  const blocks = new Map<string, { file: string; styleBlockIndex: number; positions: number[] }>();
  payload.forEach((record, position) => {
    if (!record.scoped || record.styleBlockIndex === null) return;
    const key = `${record.file}\u0000${record.styleBlockIndex}`;
    const block = blocks.get(key) ?? {
      file: record.file,
      styleBlockIndex: record.styleBlockIndex,
      positions: [],
    };
    block.positions.push(position);
    blocks.set(key, block);
  });

  for (const block of blocks.values()) {
    const css = await resolveCompiledCss(block.file, block.styleBlockIndex);
    if (css === null) continue;
    const selectors = compiledSelectors(css);
    block.positions.forEach((position, ruleOrder) => {
      const effectiveSelector = selectors[ruleOrder];
      const record = payload[position];
      if (effectiveSelector !== undefined && record !== undefined) {
        record.effectiveSelector = effectiveSelector;
      }
    });
  }
  return payload;
}

/** Selectors of the compiled css in rule order — the join's correlation key. */
export function compiledSelectors(css: string): string[] {
  const selectors: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    selectors.push(rule.selector);
  });
  return selectors;
}

/** Pulls the css text out of a dev-transformed css module's code. */
export function extractCssFromModuleCode(code: string): string | null {
  const match = code.match(/__vite__css = ("(?:[^"\\]|\\.)*")/);
  if (match?.[1] === undefined) return null;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return null;
  }
}

async function resolveCompiledCss(
  server: ViteDevServer,
  root: string,
  file: string,
  styleBlockIndex: number,
): Promise<string | null> {
  const moduleUrl = `/${toRelative(root, file)}?astro&type=style&index=${styleBlockIndex}&lang.css`;
  const module = await server.environments.client.moduleGraph.getModuleByUrl(moduleUrl);
  const code = module?.transformResult?.code;
  if (code === undefined || code === null) return null;
  return extractCssFromModuleCode(code);
}

/** Walks `src/**` collecting the css/astro sources the indexer consumes. */
export function collectSources(srcDir: string): SourceFile[] {
  if (!existsSync(srcDir)) return [];
  const sources: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.css') || entry.name.endsWith('.astro')) {
        sources.push({ file: full, contents: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(srcDir);
  return sources;
}

function toRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

function safeResolve(root: string, file: string): string | null {
  const absPath = resolve(root, file);
  if (absPath !== root && !absPath.startsWith(`${root}${sep}`)) return null;
  return absPath;
}

function parseEditBody(body: unknown): {
  file: string | null;
  range: [number, number] | null;
  replacement: string | null;
} {
  if (body === null || typeof body !== 'object') {
    return { file: null, range: null, replacement: null };
  }
  const { file, range, replacement } = body as Record<string, unknown>;
  const validRange =
    typeof range === 'object' &&
    range !== null &&
    typeof (range as Record<string, unknown>).start === 'number' &&
    typeof (range as Record<string, unknown>).end === 'number'
      ? ([(range as Record<string, unknown>).start, (range as Record<string, unknown>).end] as [
          number,
          number,
        ])
      : null;
  return {
    file: typeof file === 'string' ? file : null,
    range: validRange,
    replacement: typeof replacement === 'string' ? replacement : null,
  };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
