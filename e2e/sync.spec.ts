import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The write-staleness REST guard. The file→chrome IDE-edit half of sync
// moved to live-refresh.spec.ts on the source lane (#150): the pushed
// invalidation rides the vite hot channel, which the prebuilt chrome this
// lane boots cannot subscribe to.
test.describe.configure({ mode: 'serial' });

const FILE_PATH = join('e2e', 'fixture', 'src', 'pages', 'home.css');

test('stale write guard: a chrome edit based on outdated disk content is refused, never spliced', async ({
  page,
}) => {
  const original = readFileSync(FILE_PATH, 'utf8');
  try {
    // direct REST probe of the optimistic-write check: an `expected` hash
    // that cannot match disk → 409 with the current contents, file untouched
    const at = original.indexOf('font-weight: 800');
    const response = await page.request.post('/__astroix/edit', {
      data: {
        file: 'src/pages/home.css',
        range: { start: at, end: at + 1 },
        replacement: 'X',
        expected: '0'.repeat(64),
      },
    });
    expect(response.status()).toBe(409);
    const body = (await response.json()) as { contents?: string };
    expect(body.contents).toContain('font-weight: 800');
    expect(readFileSync(FILE_PATH, 'utf8')).toBe(original);
  } finally {
    writeFileSync(FILE_PATH, original);
  }
});
