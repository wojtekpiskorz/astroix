# Issue 208: Service Worker control of the project origin

Date: 2026-09-01

## Verdict

A managed project's active root-scoped Service Worker can control the Astroix app shell, every HTTP control path under `/__astroix/`, the natural canvas navigation, and fetches made by controlled app or canvas documents. That includes `EventSource` at `/__astroix/events`. A Vite HMR WebSocket is the exception: the WebSocket standard sets its opening request's Service Worker mode to `none`, so the worker cannot intercept or Cache-API-cache the upgrade. [Service Worker scope and fetch handling](https://w3c.github.io/ServiceWorker/#handle-fetch), [EventSource fetch steps](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-eventsource-interface), [WebSocket opening handshake](https://websockets.spec.whatwg.org/#opening-handshake)

The narrow v1 policy should be explicit: **Astroix's Electron editor bypasses project Service Workers for the whole app-shell target.** Use one fresh, non-persistent Electron session partition for the app shell and its plain same-origin iframe, then attach Electron's supported `webContents.debugger` before the first project-origin navigation and send stable CDP 1.3 `Network.setBypassServiceWorker({ bypass: true })`. This preserves the current direct `iframe.contentDocument` contract while making app-shell, control, SSE, canvas, and resource requests reach the Astroix proxy or managed dev server. It deliberately does not reproduce a project's Service Worker behavior inside Astroix. [Electron session partitions](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options), [Electron Debugger](https://www.electronjs.org/docs/latest/api/debugger), [CDP 1.3 bypass command](https://chromedevtools.github.io/devtools-protocol/1-3/Network/#method-setBypassServiceWorker)

This is a compatibility policy, not a security boundary against developer-trusted project code. The debugger attachment is operationally fragile because opening DevTools detaches it. v1 must treat a detach as loss of the editor's network invariant: stop or disable editing, close the project target, and only resume after a new target has the bypass attached before navigation. Electron documents the DevTools-detach behavior. [Electron Debugger `detach` event](https://www.electronjs.org/docs/latest/api/debugger#event-detach)

## What a root scope reaches

A registration associates a worker with a scope URL and storage key. Matching chooses the longest scope URL whose serialized value is a prefix of the client URL. A `/` scope on `http://<project-key>.localhost:<port>` therefore covers `/__astroix/app/`, `/__astroix/*`, and every natural canvas path on that exact origin. A script below the root can request `/` only when its response permits that broader scope through `Service-Worker-Allowed`; a root-level worker script needs no broader allowance. [Scope matching algorithm](https://w3c.github.io/ServiceWorker/#scope-match-algorithm), [registration scope restriction](https://w3c.github.io/ServiceWorker/#register-algorithm), [Service-Worker-Allowed](https://w3c.github.io/ServiceWorker/#service-worker-allowed)

For a matching navigation, the browser assigns the active worker to the new window client. Requests from that controlled client, including scripts, styles, images, modules, and `fetch()`, route through the controller's fetch handler. Chromium's own implementation overview distinguishes this controlled-client path from main-resource scope matching. [Service Worker client control](https://w3c.github.io/ServiceWorker/#service-worker-client-concept), [Chromium Service Worker implementation overview](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/service_worker/README.md)

This creates two takeover timings. A worker normally controls a matching document on a later navigation. `clients.claim()` can assign the active worker to already-open matching clients without waiting for reload. Registration state persists until explicit unregistration in a persistent storage key. [Clients claim algorithm](https://w3c.github.io/ServiceWorker/#clients-claim), [registration lifetime](https://w3c.github.io/ServiceWorker/#service-worker-registration-lifetime)

Service Workers do not cache responses automatically. A worker can return any constructed `Response`, read a response from Cache Storage, or fetch the network and write the result into Cache Storage. The interception risk does not depend on caching; a fetch handler can spoof or suppress a control response directly. [CacheStorage and Cache](https://w3c.github.io/ServiceWorker/#cache-storage), [FetchEvent `respondWith`](https://w3c.github.io/ServiceWorker/#fetch-event-respondwith)

### Request matrix

| Request | Root worker can intercept? | Consequence |
| --- | --- | --- |
| `/__astroix/app/` navigation and assets | Yes | It can replace or stale-cache the app shell before the proxy handles the request. |
| `/__astroix/*` fetch/control calls | Yes | A controlled app document's calls pass through its controller. Request authorization remains necessary but does not guarantee the proxy receives the request. |
| Natural canvas navigation and resources | Yes | The root scope matches the navigation; the resulting controlled client sends its resources through the controller. |
| `/__astroix/events` via `EventSource` | Yes | EventSource creates a Fetch request with the document as client. `cache mode: no-store` governs HTTP caching, not Service Worker dispatch. |
| Vite HMR WebSocket | No | The opening request has Service Worker mode `none` and cache mode `no-store`; it goes to the proxy's upgrade path. |

Sources for the matrix: [Service Worker fetch handling](https://w3c.github.io/ServiceWorker/#handle-fetch), [EventSource constructor algorithm](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-eventsource-interface), [Fetch request Service Worker mode](https://fetch.spec.whatwg.org/#requests), [WebSocket opening handshake](https://websockets.spec.whatwg.org/#opening-handshake).

## Electron and Chromium mechanisms

### Fresh in-memory partition: useful isolation, not bypass

`session.fromPartition(name)` creates an in-memory session when the name lacks the `persist:` prefix. A BrowserWindow's `webPreferences.partition` selects that session. A fresh partition prevents Astroix from inheriting registrations and Cache Storage from Electron's default or a prior app process. It does not stop a loaded project page from registering a worker inside that partition. [Electron Session](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options), [Electron WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences#partition-string-optional)

The partition must belong to the whole BrowserWindow. A plain iframe inherits its containing page's browser session and retains direct same-origin DOM access. Moving the canvas to Electron's partitioned `<webview>` creates a separate guest and replaces direct DOM access with asynchronous guest APIs; Electron also recommends avoiding `<webview>`. [Electron `<webview>` warning and guest boundary](https://www.electronjs.org/docs/latest/api/webview-tag)

### Clearing registrations: deterministic cleanup, not an ongoing block

Electron supports origin-scoped `session.clearStorageData({ origin, storages: ['serviceworkers', 'cachestorage'] })`. Clear both stores if the goal is a clean editor session: removing a registration does not itself remove Cache Storage. Unregistration does not detach existing controlled clients immediately, so cleanup must occur after every client for that origin has unloaded and before the next project-origin navigation. [Electron `clearStorageData`](https://www.electronjs.org/docs/latest/api/session#sesclearstoragedataoptions), [Service Worker unregister algorithm and client lifetime](https://w3c.github.io/ServiceWorker/#service-worker-registration-unregister)

Electron's `session.serviceWorkers` API queries running workers and can start one; it exposes no stable unregister or deny-registration method. CDP has `ServiceWorker.unregister`, but the whole CDP ServiceWorker domain labels itself experimental. Neither worker enumeration nor stop-after-start closes the `clients.claim()` race. [Electron ServiceWorkers API](https://www.electronjs.org/docs/latest/api/service-workers), [CDP ServiceWorker domain](https://chromedevtools.github.io/devtools-protocol/tot/ServiceWorker/)

### CDP network bypass: the only proved continuous bypass

Electron exposes a `Debugger` object on each WebContents and allows it to send Chrome DevTools Protocol commands. Stable CDP 1.3 defines `Network.setBypassServiceWorker` as bypassing the worker and loading each request from the network. The focused proof below applied it to the BrowserWindow target and observed network delivery for the top-level page, same-origin iframe navigation, fetches, and EventSource. [Electron `webContents.debugger`](https://www.electronjs.org/docs/latest/api/web-contents#contentsdebugger-readonly), [Electron `debugger.sendCommand`](https://www.electronjs.org/docs/latest/api/debugger#debuggersendcommandmethod-commandparams-sessionid), [CDP 1.3 bypass command](https://chromedevtools.github.io/devtools-protocol/1-3/Network/#method-setBypassServiceWorker)

`webRequest` and proxy middleware are not substitutes. They operate on requests that reach the network stack; a Service Worker can satisfy a controlled fetch before the Astroix HTTP proxy sees it. Chromium exposes `fromServiceWorker` separately from network/cache response provenance, and its implementation overview shows the worker before the network fallback. [CDP Network Response provenance](https://chromedevtools.github.io/devtools-protocol/1-3/Network/#type-Response), [Chromium Service Worker implementation overview](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/service_worker/README.md)

## Focused Electron proof

The proof ran in a temporary directory, outside the repository. It used Electron 44.1.0, an HTTP server on loopback, `proof.localhost`, one root-scoped worker, a plain same-origin iframe, EventSource, and a raw WebSocket upgrade. The worker returned distinct `service-worker` bodies for the app path, control path, canvas navigation, natural resource, and SSE. The server recorded every HTTP request and WebSocket upgrade it actually received.

Command:

```sh
rtk proxy bunx electron@44.1.0 /tmp/astroix-sw-proof/main.mjs
```

Results:

- Controlled case: `navigator.serviceWorker.controller === true`; app, control, iframe canvas, natural resource, and SSE all returned the worker's markers. The server received only `/install`, `/sw.js`, `/probe`, and `/hmr`. The `/hmr` WebSocket opened through the server.
- CDP bypass case: `controller === false`; the top-level probe, app, control, iframe canvas, natural resource, and SSE all reached the server and returned network markers. `/hmr` still opened through the server.
- Cleanup case: after navigating the target to `about:blank`, clearing `serviceworkers` plus `cachestorage`, and returning to the origin, all probes reached the network and `controller === false`.
- Fresh-partition case: a second non-persistent partition had no controller and all probes reached the network.

These are focused observations, not claims of full Astro/Vite parity. The proof did not run Vite, exercise a persistent partition across app restarts, test Chromium versions other than Electron 44.1.0, or test a worker that continuously re-registers. The WebSocket negative result rests on the WebSocket standard as well as the raw-upgrade observation. The bypass proof covers a same-origin child frame in the BrowserWindow target; v1 still needs a regression test that opens the real canvas and the real Vite HMR client.

## v1 contract and negative tests

The implementation charter should carry these requirements:

1. Create one non-persistent partition for the Electron app window before any URL loads. Keep the app shell and plain iframe in that same BrowserWindow so direct DOM access remains intact.
2. Attach the debugger and set Service Worker bypass before the first active-project navigation. A failed command or later debugger detach makes the project target unready and editing unavailable.
3. Do not advertise offline, PWA, or project Service Worker fidelity inside Astroix. Show a compatibility diagnostic when a project registers a worker, but keep requests bypassed.
4. On project stop and switch, navigate away or destroy the target before clearing that origin's `serviceworkers` and `cachestorage`. Cleanup is defense in depth and test determinism; bypass is the live invariant.
5. Keep authorization, active-session generation, Host and Origin checks, and reserved-path ownership on `/__astroix/*`. Bypass prevents a worker from hiding or forging the browser-side response, but it does not replace server-side authority checks.

Required negative tests:

- a root worker uses `clients.claim()` and attempts to replace `/__astroix/app/`, a control fetch, the SSE stream, canvas navigation, and a canvas subresource; every request must reach the intended network owner;
- the same worker writes stale entries to Cache Storage, the editor reloads, switches away and back, and no cached response appears;
- HMR still completes its real `vite-hmr` WebSocket handshake while bypass is active;
- opening DevTools detaches the debugger, editing becomes unavailable before another control request, and resumption creates or reloads a target only after bypass succeeds;
- cleanup runs only after the old target unloads, then a new target on the same project hostname has neither registration nor Cache Storage;
- a fresh app process cannot see a prior process's in-memory worker state;
- the app shell can still read `iframe.contentDocument`, run `Element.matches()`, and observe natural canvas navigation under the bypass policy.

The direct recommendation is intentionally narrow. Do not split the app shell and canvas into different origins or guest partitions. Do not claim full project-page fidelity. Bypass Service Workers inside the editor, preserve same-origin DOM, and keep raw HMR WebSockets on the existing transparent proxy path.
