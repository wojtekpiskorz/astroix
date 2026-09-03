import type { DocumentAuthorityPort } from '@wojciechpiskorz/astroix-runtime/client-authority';
import { originAllowsInjection, rewriteClientCapabilityHeader } from './capability-injection.ts';

/**
 * The Electron webRequest adapter for the client-capability injection
 * (#246, H4): installs ONE `onBeforeSendHeaders` listener over the real
 * session's request pipeline — the seam Chromium exposes AFTER renderer
 * JavaScript has constructed the request — and applies the pure policy
 * (`./capability-injection.ts`) per request. Electron-free beyond the
 * structural seam type: `index.ts` (or the desktop composition lane)
 * passes the real `session.defaultSession.webRequest`, the focused
 * units pass a fake, and the real-Electron truth is the
 * `e2e/desktop/document-authority*.spec.ts` lane.
 *
 * The URL filter deliberately covers `http`/`https` only: the Vite HMR
 * upgrade rides `ws://`, a browser cannot set custom headers on a
 * WebSocket handshake, and injecting the capability there would only
 * push it toward the (authority-stripping) proxy tunnel — the client
 * capability's one home is the reserved HTTP surface that validates it.
 * Foreign origins and unidentified request sources (service workers)
 * get the strip law, never an injection: a renderer-forged value must
 * not leave this host toward any server.
 */

/**
 * The structural slice of Electron's `webRequest` this seam needs —
 * `Session['webRequest']` satisfies it unchanged (the response values
 * allow `string[]` and the callback parameter is required, matching
 * Electron's `BeforeSendResponse` shape exactly; the focused units'
 * fake satisfies the same slice).
 */
export interface WebRequestListenerSeam {
  onBeforeSendHeaders(
    filter: { readonly urls: readonly string[] },
    listener:
      | ((
          details: ClientCapabilityRequestDetails,
          callback: (response: { requestHeaders?: Record<string, string | string[]> }) => void,
        ) => void)
      | null,
  ): void;
}

/** The structural slice of `OnBeforeSendHeadersDetails` the policy reads. */
export interface ClientCapabilityRequestDetails {
  readonly url: string;
  readonly webContentsId?: number;
  readonly resourceType?: string;
  /** Electron's real header shape: singular and array values both occur on the seam. */
  readonly requestHeaders: Record<string, string | string[]>;
}

/** The one filter the injection registers — HTTP(S) only, per the seam's law. */
export const CLIENT_INJECTION_FILTER_URLS: readonly string[] = ['http://*/*', 'https://*/*'];

/** Construction input: the seam, the owned origins, and the live-capability view. */
export interface ClientCapabilityInjectionOptions {
  readonly webRequest: WebRequestListenerSeam;
  /** The exact origins whose documents may carry a client capability (`http://host:port`). */
  readonly ownedOrigins: readonly string[];
  /** The port the authority exposes — `injectableCapability(webContentsId)`. */
  readonly authority: Pick<DocumentAuthorityPort, 'injectableCapability'>;
}

/** The installed injection — `detach()` unregisters the listener. */
export interface ClientCapabilityInjection {
  detach(): void;
}

/**
 * Installs the injection. One listener, one filter; every request from
 * the session passes the same two laws (overwrite at an owned origin
 * with a live binding, strip everywhere else).
 */
export function installClientCapabilityInjection(
  options: ClientCapabilityInjectionOptions,
): ClientCapabilityInjection {
  const ownedOrigins = new Set(options.ownedOrigins.map((origin) => origin.toLowerCase()));
  const listener = (
    details: ClientCapabilityRequestDetails,
    callback: (response: { requestHeaders?: Record<string, string | string[]> }) => void,
  ): void => {
    const webContentsId = details.webContentsId;
    const injectable =
      webContentsId !== undefined && originAllowsInjection(details.url, ownedOrigins)
        ? options.authority.injectableCapability(webContentsId)
        : null;
    callback({
      requestHeaders: rewriteClientCapabilityHeader(details.requestHeaders, injectable),
    });
  };
  options.webRequest.onBeforeSendHeaders({ urls: CLIENT_INJECTION_FILTER_URLS }, listener);
  return {
    detach: () => {
      // Passing null unregisters the listener (Electron's webRequest
      // contract) — the injection stops, the strip law included.
      options.webRequest.onBeforeSendHeaders({ urls: CLIENT_INJECTION_FILTER_URLS }, null);
    },
  };
}
