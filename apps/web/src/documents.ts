import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import type { ProjectKey, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import {
  type ClientBindings,
  type HostCapabilityGrants,
  hostCapabilitySetCookie,
} from '@wojciechpiskorz/astroix-runtime/api/http';
import { LAUNCHER_HOSTNAME, projectHostname } from '@wojciechpiskorz/astroix-runtime/origin';

/**
 * The document surface of the web host (#240): the reserved-namespace
 * pages every renderer host serves — the neutral launcher document and
 * the active project's app document (ADR-0005 "Origin and proxy
 * contract") — plus their built assets. It stands where the Electron
 * host's `webContents` injection will stand (#246): it binds the
 * document's client capability server-side and hands it to the document
 * at serve time, and it sets the host capability as the `HttpOnly`
 * cookie the browser attaches to every exchange (ADR-0006 §3).
 *
 * What a served document therefore carries — and nothing more:
 * - the per-document client capability (a `meta` tag: it must ride the
 *   `x-astroix-client` header, which is exactly why the value may live
 *   in the document at all);
 * - on the project host, the exact `SessionRef` the document is bound
 *   at (public correlation data, never authority);
 * - the `HttpOnly` host-capability cookie, which never becomes a
 *   JavaScript value.
 */

/** The reserved app-document path (ADR-0005): the launcher and the project app both live here. */
export const APP_PATH = '/__astroix/app/';

/** One page's bootstrap facts, injected as `meta` tags at serve time. */
export interface DocumentBootstrap {
  /** The document's client capability — the header value the AppClient injects. */
  readonly clientCapability: string;
  /** The exact pair a project document is bound at; absent on the launcher. */
  readonly session?: SessionRef;
}

/** The session-facing view the document surface needs: whose document is current. */
export interface DocumentSessions {
  /** The active session's pair and key, or null while idle. */
  current(): { readonly sessionRef: SessionRef; readonly projectKey: ProjectKey } | null;
  /** The active session's editor HTTP-binding capability (minted at commit by the composition). */
  editorCapability(): string | null;
}

/** The documents' construction inputs. */
export interface DocumentSurfaceOptions {
  /** The directory the built client assets live under (vite output). */
  readonly clientDist: string;
  /** The launcher's client capability — bound once at composition boot. */
  readonly launcherClient: string;
  /** The launcher host capability — the cookie every launcher document sets. */
  readonly launcherCapability: string;
  readonly grants: HostCapabilityGrants;
  readonly sessions: DocumentSessions;
}

/** Builds the reserved document handler — the composition mounts it ahead of the events surface. */
export function createDocumentSurface(options: DocumentSurfaceOptions) {
  return {
    /**
     * Serves the app documents and their assets; every other reserved
     * target is somebody else's (the composition delegates onward).
     */
    handle: (request: IncomingMessage, response: ServerResponse): boolean => {
      const url = request.url ?? '';
      if (url === APP_PATH || url === `${APP_PATH}index.html`) {
        serveDocument(request, response, options);
        return true;
      }
      if (url.startsWith('/__astroix/app/assets/')) {
        void serveAsset(url, response, options.clientDist);
        return true;
      }
      return false;
    },
  };
}

/** Serves the launcher or project document for this request's (listener-validated) host. */
function serveDocument(
  request: IncomingMessage,
  response: ServerResponse,
  options: DocumentSurfaceOptions,
): void {
  const hostname = hostnameOf(request);
  const current = options.sessions.current();
  const onProjectHost = current !== null && hostname === projectHostname(current.projectKey);
  if (hostname !== LAUNCHER_HOSTNAME && !onProjectHost) {
    respond(response, 404, 'text/plain', 'not found');
    return;
  }
  const page = onProjectHost ? 'project.html' : 'launcher.html';
  const editorCapability = onProjectHost ? options.sessions.editorCapability() : null;
  if (onProjectHost && (current === null || editorCapability === null)) {
    // The host is current but no document authority exists — a
    // composition inconsistency, never a fallback to the launcher page.
    respond(response, 404, 'text/plain', 'not found');
    return;
  }
  const cookie = onProjectHost
    ? (options.grants.current({
        host: 'project',
        projectKey: (current as NonNullable<typeof current>).projectKey,
      }) ?? '')
    : options.launcherCapability;
  const bootstrap: DocumentBootstrap = onProjectHost
    ? {
        clientCapability: editorCapability as string,
        session: (current as NonNullable<typeof current>).sessionRef,
      }
    : { clientCapability: options.launcherClient };
  void servePage(page, bootstrap, cookie, response, options.clientDist);
}

/** Reads one built page, injects the bootstrap metas, sets the cookie, and serves it no-store. */
async function servePage(
  page: string,
  bootstrap: DocumentBootstrap,
  cookie: string,
  response: ServerResponse,
  clientDist: string,
): Promise<void> {
  const html = await readFileOrNull(join(clientDist, page));
  if (html === null) {
    respond(response, 500, 'text/plain', 'the web client build is missing');
    return;
  }
  const metas = [
    `<meta name="astroix-client" content="${escapeAttribute(bootstrap.clientCapability)}">`,
    ...(bootstrap.session !== undefined
      ? [
          `<meta name="astroix-epoch" content="${escapeAttribute(bootstrap.session.runtimeEpoch)}">`,
          `<meta name="astroix-generation" content="${String(bootstrap.session.generation)}">`,
        ]
      : []),
  ].join('');
  const injected = html.replace('<!--ASTROIX_BOOTSTRAP-->', metas);
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-astroix-generated': '1',
    'set-cookie': hostCapabilitySetCookie(cookie),
  });
  response.end(injected);
}

/** Serves one built asset by exact name — no traversal, no listing. */
async function serveAsset(
  url: string,
  response: ServerResponse,
  clientDist: string,
): Promise<void> {
  const name = basename(url.slice('/__astroix/app/assets/'.length));
  if (name.length === 0) {
    respond(response, 404, 'text/plain', 'not found');
    return;
  }
  const bytes = await readBytesOrNull(join(clientDist, 'assets', name));
  if (bytes === null) {
    respond(response, 404, 'text/plain', 'not found');
    return;
  }
  response.writeHead(200, {
    'content-type': contentTypeOf(name),
    'cache-control': 'no-store',
    'x-astroix-generated': '1',
  });
  response.end(bytes);
}

/** The hostname of a Host header the listener already validated (port stripped, lowercased). */
function hostnameOf(request: IncomingMessage): string {
  const host = request.headers.host ?? '';
  const colon = host.lastIndexOf(':');
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
}

/** One small plain refusal — never a body worth reading. */
function respond(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type, 'x-astroix-generated': '1' });
  response.end(body);
}

async function readFileOrNull(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

async function readBytesOrNull(path: string): Promise<Buffer | null> {
  return readFile(path).catch(() => null);
}

/** The content types the built client can carry — a closed set, no sniffing. */
function contentTypeOf(name: string): string {
  if (name.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (name.endsWith('.css')) return 'text/css; charset=utf-8';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** Escapes one attribute value — the capability is server-minted, the guard is defense in depth. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Mints the one launcher document binding — the session-spanning
 * `launcher` role (ADR-0006 §3). Called once at composition boot; the
 * capability outlives page reloads exactly like the host cookie does.
 */
export function bindLauncherDocument(bindings: ClientBindings): string {
  const bound = bindings.bind({ role: 'launcher', host: 'launcher', sessionRef: null });
  if (bound.kind !== 'bound')
    throw new Error('the launcher document binding could not be installed');
  return bound.capability;
}
