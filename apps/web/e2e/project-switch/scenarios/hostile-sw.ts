import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { stagedCopyRoot } from '../../../src/stage-e2e.ts';

/**
 * The K3 hostile Service Worker scenario (#256): a genuinely hostile
 * root worker the page registers on the LIVE project origin — the
 * web host has no bypass (that is the Electron host's H5 law), so the
 * worker really intercepts, and the scenarios prove the system's laws
 * hold under the interception: replays of dead-authority mutations
 * are refused at the retired origin, header-tampered live requests
 * are refused and the failure surfaces on the write line, and a
 * spoofed stale SUCCESS response cannot make the live document
 * believe a write landed (the request pairing drops it; the disk
 * truth never moved).
 *
 * The script lands in the STAGED copy's `public/` directory at test
 * time — test-owned bytes in the disposable copy, the runtime-tier
 * harness's staged-marker idiom; the canonical `e2e/fixture` is never
 * touched, and the scratch root's teardown disposes of it. The worker
 * passes everything through by default (a broken passthrough would
 * sink the whole battery); every attack is armed single-shot through
 * a controller message, and the worker reports each outcome back to
 * the page it controls.
 */

/** One worker report — replays, tamper outcomes, stale deliveries, and dumps. */
export interface SwReport {
  readonly kind: string;
  readonly status?: number;
  readonly body?: string;
  readonly log?: { readonly origins: readonly string[] };
}

/** The worker's own source — no interpolation, a self-contained classic script. */
const SW_SOURCE = [
  '// The K3 hostile worker (#256): passthrough by default, armed single-shot attacks.',
  'var LOG = { origins: [], reports: [] };',
  'var capturedMutation = null;',
  'var mode = "passthrough";',
  'var rewriteValue = null;',
  '',
  'self.addEventListener("activate", function (event) {',
  '  event.waitUntil(self.clients.claim());',
  '});',
  '',
  'async function post(report) {',
  '  LOG.reports.push(report);',
  '  var clients = await self.clients.matchAll({ type: "window" });',
  '  for (const client of clients) client.postMessage(report);',
  '}',
  '',
  'async function doReplay() {',
  '  try {',
  '    var response = await fetch(capturedMutation.url, {',
  '      method: "POST",',
  '      headers: capturedMutation.headers,',
  '      body: capturedMutation.body,',
  '      cache: "no-store",',
  '    });',
  '    var text = await response.text();',
  '    await post({ kind: "replay", status: response.status, body: text.slice(0, 400) });',
  '  } catch (error) {',
  '    await post({ kind: "replay", status: 0, body: String(error) });',
  '  }',
  '}',
  '',
  'self.addEventListener("message", function (event) {',
  '  var data = event.data || {};',
  '  if (data.cmd === "arm-replay" && capturedMutation !== null) {',
  '    void doReplay();',
  '  } else if (data.cmd === "arm-rewrite") {',
  '    mode = "rewrite";',
  '    rewriteValue = data.value;',
  '  } else if (data.cmd === "arm-stale-mutation") {',
  '    mode = "stale-mutation";',
  '  } else if (data.cmd === "dump") {',
  '    void post({ kind: "dump", log: { origins: LOG.origins } });',
  '  }',
  '});',
  '',
  'self.addEventListener("fetch", function (event) {',
  '  var url = new URL(event.request.url);',
  '  if (LOG.origins.indexOf(url.origin) === -1) LOG.origins.push(url.origin);',
  '  if (event.request.method !== "POST" || url.pathname !== "/__astroix/api/v1") {',
  '    event.respondWith(fetch(event.request));',
  '    return;',
  '  }',
  '  event.respondWith((async function () {',
  '    var body = await event.request.clone().text();',
  '    var headers = {};',
  '    event.request.headers.forEach(function (value, name) { headers[name] = value; });',
  '    var isMutation = body.includes("\\"apply-edit\\"");',
  '    if (!isMutation) {',
  '      return fetch(event.request);',
  '    }',
  '    if (mode === "stale-mutation" && capturedMutation !== null) {',
  '      mode = "passthrough";',
  '      await post({ kind: "stale-delivered", body: capturedMutation.responseBody.slice(0, 200) });',
  '      return new Response(capturedMutation.responseBody, {',
  '        status: capturedMutation.responseStatus,',
  '        headers: { "content-type": "application/json" },',
  '      });',
  '    }',
  '    if (mode === "rewrite") {',
  '      mode = "passthrough";',
  '      var rewritten = Object.assign({}, headers, { "x-astroix-client": rewriteValue });',
  '      try {',
  '        var response = await fetch(event.request.url, {',
  '          method: "POST",',
  '          headers: rewritten,',
  '          body: body,',
  '          cache: "no-store",',
  '        });',
  '        var text = await response.text();',
  '        await post({ kind: "rewrite-outcome", status: response.status, body: text.slice(0, 400) });',
  '        return new Response(text, {',
  '          status: response.status,',
  '          headers: { "content-type": "application/json" },',
  '        });',
  '      } catch (error) {',
  '        await post({ kind: "rewrite-outcome", status: 0, body: String(error) });',
  '        throw error;',
  '      }',
  '    }',
  '    if (capturedMutation === null && mode === "passthrough") {',
  '      var forwarded = await fetch(event.request);',
  '      var forwardedText = await forwarded.text();',
  '      capturedMutation = {',
  '        url: event.request.url,',
  '        headers: headers,',
  '        body: body,',
  '        responseStatus: forwarded.status,',
  '        responseBody: forwardedText,',
  '      };',
  '      return new Response(forwardedText, {',
  '        status: forwarded.status,',
  '        headers: { "content-type": "application/json" },',
  '      });',
  '    }',
  '    return fetch(event.request);',
  '  })());',
  '});',
  '',
].join('\n');

/**
 * Stages the hostile worker's script into the project's served public
 * directory — BEFORE the plane's activation boots its dev server:
 * vite's public middleware gates on the boot-time file listing, so a
 * file that lands after the dev server started would 404 and the
 * registration would fail. The disposable-copy idiom (test-owned
 * bytes; the canonical `e2e/fixture` is never touched).
 */
export async function stageHostileWorker(): Promise<void> {
  const publicDir = join(stagedCopyRoot('project-a'), 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, 'k3-hostile-sw.js'), `${SW_SOURCE}\n`, 'utf8');
}

/**
 * Registers the staged worker on the page's origin: root scope, the
 * worker claims its clients, and the page begins collecting the
 * worker's reports. Fails loudly when the origin never becomes
 * controlled.
 */
export async function claimHostileWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const holder = window as unknown as { __k3SwReports?: unknown[] };
    holder.__k3SwReports = [];
    navigator.serviceWorker.addEventListener('message', (event) => {
      holder.__k3SwReports?.push(event.data);
    });
    await navigator.serviceWorker.register('/k3-hostile-sw.js', { scope: '/' });
    const deadline = Date.now() + 30_000;
    while (navigator.serviceWorker.controller === null) {
      if (Date.now() > deadline) {
        throw new Error('the hostile worker never claimed the document');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
}

/** Arms one single-shot attack on the controlling worker. */
export async function armSwAttack(page: Page, command: Record<string, unknown>): Promise<void> {
  await page.evaluate((cmd) => {
    navigator.serviceWorker.controller?.postMessage(cmd);
  }, command);
}

/** The reports the worker has posted so far. */
export async function swReports(page: Page): Promise<SwReport[]> {
  return await page.evaluate(() => {
    const holder = window as unknown as { __k3SwReports?: unknown[] };
    return (holder.__k3SwReports ?? []) as SwReport[];
  });
}

/**
 * Plants the dying document's DELAYED callback — a timer that fires a
 * hostile session-scoped mutation long after the switch replaced its
 * authority. The outcome lands in the page's slot for the spec to
 * read once it fired; the request carries the document's own bootstrap
 * capability (the only authority a hostile callback could reach).
 */
export async function plantDelayedCallback(page: Page, delayMs: number): Promise<void> {
  await page.evaluate((delay) => {
    const capability = document
      .querySelector('meta[name="astroix-client"]')
      ?.getAttribute('content');
    const epoch = document.querySelector('meta[name="astroix-epoch"]')?.getAttribute('content');
    const generation = document
      .querySelector('meta[name="astroix-generation"]')
      ?.getAttribute('content');
    setTimeout(async () => {
      const holder = window as unknown as { __k3DelayedCallback?: { status: number } };
      try {
        const response = await fetch('/__astroix/api/v1', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-astroix-client': capability ?? '',
            'x-astroix-request': '1',
          },
          body: JSON.stringify({
            protocolVersion: 1,
            requestId: 'k3-delayed-callback',
            session:
              epoch !== null &&
              epoch !== undefined &&
              generation !== null &&
              generation !== undefined
                ? {
                    runtimeEpoch: epoch,
                    generation: Number.parseInt(generation, 10),
                  }
                : undefined,
            command: { kind: 'deactivate' },
          }),
        });
        holder.__k3DelayedCallback = { status: response.status };
      } catch {
        holder.__k3DelayedCallback = { status: 0 };
      }
    }, delay);
  }, delayMs);
}

/** The delayed callback's observed outcome, once it fired. */
export async function delayedCallbackOutcome(
  page: Page,
): Promise<{ readonly status: number } | undefined> {
  return await page.evaluate(() => {
    const holder = window as unknown as { __k3DelayedCallback?: { status: number } };
    return holder.__k3DelayedCallback;
  });
}
