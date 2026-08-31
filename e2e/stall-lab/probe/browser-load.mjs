// Browser-shaped first page load against the fixture dev server, with
// pending-request tracking. Usage: browser-load.mjs <url> <run-name>

import { appendFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4383/';
const run = process.argv[3] ?? 'browser1';
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
  if (r.url().includes('virtual:astroix') || pending.size < 12)
    log(`REQ  ${r.method()} ${r.url()}`);
});
page.on('requestfinished', (r) => {
  const t = pending.get(r);
  pending.delete(r);
  log(`DONE ${((Date.now() - t) / 1000).toFixed(1)}s ${r.url()}`);
});
page.on('requestfailed', (r) => {
  const t = pending.get(r);
  pending.delete(r);
  log(`FAIL ${((Date.now() - t) / 1000).toFixed(1)}s ${r.url()} ${r.failure()?.errorText}`);
});
const t0 = Date.now();
try {
  await page.goto(url, { timeout: 120_000, waitUntil: 'commit' });
  log('commit');
  await page.waitForSelector('#astroix-canvas', { timeout: 110_000, state: 'visible' });
  log(`CANVAS VISIBLE after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  log(`ERROR after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message.split('\n')[0]}`);
  log(`pending requests at error: ${[...pending.keys()].map((r) => r.url()).join(', ')}`);
}
await browser.close();
