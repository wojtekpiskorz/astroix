/**
 * The renderer probe scripts of the service-worker bypass lane (#247,
 * H5): the exact JavaScript the real-Electron harness executes inside
 * the loaded documents. They are TEST instrumentation, never product
 * code — and deliberately page-script PROBES (observers), not
 * interceptors: the lane's law is that nothing page-side enforces the
 * bypass, so every probe only observes what the network stack actually
 * delivered.
 */

/** Registers the hostile root SW and waits until it is fully activated — the origin now hosts a live attacker. */
export const REGISTER_HOSTILE_SW_SCRIPT = `
(async () => {
  const registration = await navigator.serviceWorker.register('/hostile-sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  // ready resolves at 'activating' — the attacker must be fully live
  // before the lane trusts it: poll to 'activated', bounded.
  const deadline = Date.now() + 10000;
  while (registration.active && registration.active.state !== 'activated' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    scope: registration.scope,
    active: registration.active !== null,
    state: registration.active ? registration.active.state : null,
  };
})()
`;

/** The document's Service Worker truth: registration, controller, caches, and the document's own bytes. */
export const SW_STATE_SCRIPT = `
(async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  return {
    registration: registration !== undefined,
    activeState: registration && registration.active ? registration.active.state : null,
    controller: navigator.serviceWorker.controller !== null,
    caches: await caches.keys(),
    appMarker: document.getElementById('app-marker') ? document.getElementById('app-marker').textContent : null,
    bodyStart: document.body.textContent.trim().slice(0, 48),
  };
})()
`;

/** One fetch probe: what the network stack actually delivered for `path`. */
export function fetchProbeScript(path: string): string {
  return `
(async () => {
  try {
    const response = await fetch(${JSON.stringify(path)}, { cache: 'no-store' });
    const body = await response.text();
    return {
      path: ${JSON.stringify(path)},
      status: response.status,
      body: body.slice(0, 512),
      spoofed: body.indexOf('SPOOFED-BY-HOSTILE-SW') !== -1,
    };
  } catch (error) {
    return { path: ${JSON.stringify(path)}, error: String(error) };
  }
})()
`;
}

/** The SSE probe: what the `/__astroix/events` stream actually delivered (spoofed bodies cannot parse as SSE). */
export const SSE_PROBE_SCRIPT = `
new Promise((resolve) => {
  const seen = [];
  const source = new EventSource('/__astroix/events');
  const finish = (endedBy) => {
    source.close();
    resolve({ events: seen, endedBy });
  };
  source.onmessage = (event) => {
    seen.push(event.data);
    if (seen.length >= 2) finish('messages');
  };
  source.onerror = () => {
    if (seen.length === 0) finish('error');
  };
  setTimeout(() => finish('timeout'), 10000);
})
`;

/** The canvas truth: the same-origin iframe's real document, its own fetches, and the direct-DOM access itself. */
export const CANVAS_STATE_SCRIPT = `
(async () => {
  const iframe = document.getElementById('canvas');
  const doc = iframe && iframe.contentDocument ? iframe.contentDocument : null;
  return {
    sameOriginDirectDom: doc !== null,
    canvasMarker: doc && doc.getElementById('canvas-marker') ? doc.getElementById('canvas-marker').textContent : null,
    iframeBodyStart: doc && doc.body ? doc.body.textContent.trim().slice(0, 48) : null,
    probe: window.__canvas_probe !== undefined ? window.__canvas_probe : null,
  };
})()
`;

/** The HMR truth: the live module label and how many hot updates replaced it in place. */
export const HMR_STATE_SCRIPT = `
({ label: window.__hmr_label !== undefined ? window.__hmr_label : null,
   updates: window.__hmr_update_count !== undefined ? window.__hmr_update_count : 0 })
`;
