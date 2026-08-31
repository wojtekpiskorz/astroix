// Evaluate live vite state inside the dev server during a stall (#171).
// Reads environment._pendingRequests and the module-graph entry for the
// chrome module via Runtime.evaluate. Needs a temporary global stash in the
// plugin's configureServer (globalThis.__astroix171 = { server }) — without
// it, reports 'no __astroix171 stash'. The inspector must already be listening
// on the dev server (post-hoc: node -e "process._debugProcess(<pid>)").
// Usage: node inspect-pending.mjs <ws-port>
const port = process.argv[2] ?? '9373';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === 'node');
if (!target) throw new Error('no node target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg);
  }
};
await send('Runtime.enable');
const expression = `(() => {
  const g = globalThis.__astroix171;
  if (!g) return 'no __astroix171 stash';
  const client = g.server.environments?.client ?? {};
  const pendingUrls = [...(client._pendingRequests?.keys?.() ?? [])];
  const mod = client.moduleGraph?.getModuleById?.('virtual:astroix/chrome');
  const crawl = g.crawl;
  return JSON.stringify({
    now: performance.now().toFixed(0),
    pendingUrls,
    chromeModule: mod ? {
      id: mod.id,
      url: mod.url,
      hasTransformResult: !!mod.transformResult,
      lastInvalidationTimestamp: mod.lastInvalidationTimestamp,
      lastHMRTimestamp: mod.lastHMRTimestamp,
      invalidationState: typeof mod.invalidationState,
      importedModules: [...mod.importedModules].map((m) => m.url).slice(0, 8),
    } : null,
    crawlRegistered: crawl.registered.length,
    crawlDone: crawl.done.length,
    crawlOpen: crawl.registered.filter((id) => !crawl.done.includes(id) && !crawl.done.includes(id + '#failed')).slice(-12),
    optimizer: client.depsOptimizer ? {
      closed: client.depsOptimizer.closed,
      scanProcessing: client.depsOptimizer.scanProcessing,
    } : null,
  }, null, 1);
})()`;
const { result, exceptionDetails } = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: false,
});
console.log(result?.value ?? JSON.stringify({ exceptionDetails }));
ws.close();
process.exit(0);
