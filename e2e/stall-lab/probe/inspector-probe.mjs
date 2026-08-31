// Inspector sampler for the stalled dev server (#171). WARNING: the `pause`
// mode freezes the dev server between samples — it can manufacture the very
// red it hunts (see ../NOTES.md); prefer `profile` unless the run is
// sacrificial.
//   node inspector-probe.mjs <ws-port> pause [samples]   — repeated Debugger.pause sampling: where does the main thread sit?
//   node inspector-probe.mjs <ws-port> profile [secs]    — CPU profile over a window: computing or idle?
const mode = process.argv[3] ?? 'pause';
const port = process.argv[2] ?? '9373';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === 'node');
if (!target) throw new Error('no node target: ' + JSON.stringify(list.map((t) => t.type)));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let mid = 0;
const pending = new Map();
let onEvent = () => {};
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
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else {
    onEvent(msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (s || '').replace(/^.*node_modules/, 'nm');

if (mode === 'pause') {
  const samples = Number(process.argv[4] ?? 20);
  await send('Debugger.enable');
  for (let i = 0; i < samples; i++) {
    const framesP = new Promise((res) => {
      onEvent = (msg) => {
        if (msg.method === 'Debugger.paused') res(msg.params.callFrames);
      };
    });
    ws.send(JSON.stringify({ id: 900000 + i, method: 'Debugger.pause' }));
    const frames = await Promise.race([framesP, sleep(1500).then(() => null)]);
    if (frames === null) {
      console.log(`#${i} no pause within 1.5s (event loop busy or already paused elsewhere)`);
      continue;
    }
    console.log(`#${i} ${new Date().toISOString()}`);
    for (const f of frames.slice(0, 10)) {
      const loc = f.location ?? {};
      console.log(
        `    ${f.functionName || '(anon)'} ${clean(f.url)}:${loc.lineNumber}:${loc.columnNumber}`,
      );
    }
    await send('Debugger.resume');
    await sleep(150);
  }
} else if (mode === 'profile') {
  const secs = Number(process.argv[4] ?? 8);
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 10_000 });
  const { profile } = await (async () => {
    await send('Profiler.start');
    await sleep(secs * 1000);
    return send('Profiler.stop');
  })();
  // aggregate self time per function
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const total = profile.samples.length;
  let timeDeltas = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    timeDeltas += profile.timeDeltas[i] ?? 0;
    if (!node) continue;
    const cf = node.callFrame;
    const key = `${cf.functionName || '(anon)'} ${clean(cf.url)}:${cf.location?.lineNumber ?? 0}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  console.log(`profile: ${total} samples over ~${(timeDeltas / 1000).toFixed(1)}s of deltas`);
  const sorted = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [key, us] of sorted) console.log(`${(us / 1000).toFixed(0)}ms  ${key}`);
} else {
  throw new Error('mode must be pause|profile');
}
ws.close();
process.exit(0);
