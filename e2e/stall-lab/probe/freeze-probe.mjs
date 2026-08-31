// Renderer-freeze experiment (#171): load the chrome page, SIGSTOP the tab's
// renderer process mid-boot for N seconds (an exact emulator of CPU
// starvation: the renderer gets zero CPU while the server stays healthy),
// SIGCONT, and observe whether the #158 family signature reproduces:
//   - marker (#astroix-canvas) waits for the freeze duration + epsilon
//   - server-side module request finish is delayed by socket backpressure
//   - after CONT everything completes; a fresh page boots in seconds
// Usage: node freeze-probe.mjs <url> <freeze-secs> <run-name>

import { execSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4383/';
const freezeSecs = Number(process.argv[3] ?? 25);
const run = process.argv[4] ?? 'freeze1';
const out = `${process.env.OUT_DIR ?? '/tmp/astroix-stall-lab'}/browser-${run}.log`;
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
  appendFileSync(out, line + '\n');
};
writeFileSync(out, '');

const browser = await chromium.launch();
const page = await browser.newPage();
const pending = new Map();
page.on('request', (r) => {
  pending.set(r, Date.now());
  if (r.url().includes('virtual:astroix')) log(`REQ  ${r.url()}`);
});
page.on('requestfinished', (r) => {
  const t = pending.get(r);
  pending.delete(r);
  if (r.url().includes('virtual:astroix'))
    log(`DONE ${((Date.now() - t) / 1000).toFixed(1)}s ${r.url()}`);
});
page.on('requestfailed', (r) => {
  const t = pending.get(r);
  pending.delete(r);
  if (r.url().includes('virtual:astroix'))
    log(`FAIL ${((Date.now() - t) / 1000).toFixed(1)}s ${r.url()}`);
});

const findRenderer = () => {
  // the browser is a child of this probe process; its renderer grandchildren
  // carry --type=renderer — scoped to MY tree so sibling lanes never match
  const ps = execSync('ps -axo pid=,ppid=,command=').toString().split('\n');
  const procs = ps
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null;
    })
    .filter(Boolean);
  const mine = new Set([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (mine.has(p.ppid) && !mine.has(p.pid)) {
        mine.add(p.pid);
        grew = true;
      }
    }
  }
  const renderers = procs.filter((p) => mine.has(p.pid) && p.cmd.includes('--type=renderer'));
  if (renderers.length === 0) throw new Error('no renderer in probe process tree');
  return renderers[0].pid;
};

const t0 = Date.now();
const nav = page.goto(url, { timeout: 120_000, waitUntil: 'commit' }).then(() => log('commit'));
await new Promise((r) => setTimeout(r, 400)); // let the document + module fetch start
const rpid = findRenderer();
log(`renderer pid ${rpid} — SIGSTOP for ${freezeSecs}s`);
execSync(`kill -STOP ${rpid}`);
const stoppedAt = Date.now();
await nav.catch((e) => log(`nav error: ${e.message.split('\n')[0]}`));
await new Promise((r) => setTimeout(r, freezeSecs * 1000));
execSync(`kill -CONT ${rpid}`);
log(`SIGCONT after ${((Date.now() - stoppedAt) / 1000).toFixed(1)}s freeze`);
try {
  await page.waitForSelector('#astroix-canvas', { timeout: 90_000, state: 'visible' });
  log(`CANVAS VISIBLE after ${((Date.now() - t0) / 1000).toFixed(1)}s (freeze was ${freezeSecs}s)`);
} catch (e) {
  log(`ERROR after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message.split('\n')[0]}`);
}
// recovery discriminator: a fresh page on the same (warm) server
const t2 = Date.now();
const page2 = await browser.newPage();
try {
  await page2.goto(url, { timeout: 60_000, waitUntil: 'commit' });
  await page2.waitForSelector('#astroix-canvas', { timeout: 60_000, state: 'visible' });
  log(`FRESH PAGE CANVAS after ${((Date.now() - t2) / 1000).toFixed(1)}s`);
} catch (e) {
  log(
    `FRESH PAGE ERROR after ${((Date.now() - t2) / 1000).toFixed(1)}s: ${e.message.split('\n')[0]}`,
  );
}
await browser.close();
