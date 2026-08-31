import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHardenedWindowOptions,
  createMainFrameNavigationPolicy,
  isAllowedMainFrameNavigation,
} from '../src/security-policy.mjs';

test('returns an explicit renderer policy with no native bridge', () => {
  const options = createHardenedWindowOptions();

  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.nodeIntegrationInWorker, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(options.webPreferences.allowRunningInsecureContent, false);
  assert.equal(options.webPreferences.experimentalFeatures, false);
  assert.equal(options.webPreferences.webviewTag, false);
  assert.equal('preload' in options.webPreferences, false);
});

test('allows only the active app route as a renderer-initiated top-level navigation', () => {
  const activeOrigin = 'http://alpha.localhost:48131';

  assert.equal(
    isAllowedMainFrameNavigation(
      'http://alpha.localhost:48131/__astroix/app/?generation=2',
      activeOrigin,
    ),
    true,
  );
  assert.equal(
    isAllowedMainFrameNavigation('http://alpha.localhost:48131/lab/home/', activeOrigin),
    false,
  );
  assert.equal(
    isAllowedMainFrameNavigation('http://beta.localhost:48131/__astroix/app/', activeOrigin),
    false,
  );
  assert.equal(
    isAllowedMainFrameNavigation('https://alpha.localhost:48131/__astroix/app/', activeOrigin),
    false,
  );
  assert.equal(isAllowedMainFrameNavigation('https://example.com/', activeOrigin), false);
  assert.equal(isAllowedMainFrameNavigation('not a URL', activeOrigin), false);
});

test('commits one exact project-switch navigation permit and retires the old origin', () => {
  const alpha = 'http://alpha.localhost:48131';
  const beta = 'http://beta.localhost:48131';
  const policy = createMainFrameNavigationPolicy(alpha);

  policy.permitTransition(beta);

  assert.equal(policy.allow('http://beta.localhost:48131/lab/home/'), false);
  assert.equal(policy.allow('https://example.com/'), false);
  assert.equal(policy.allow('http://beta.localhost:48131/__astroix/app/'), true);
  assert.equal(policy.activeOrigin(), alpha);
  assert.equal(policy.allow('http://beta.localhost:48131/__astroix/app/'), false);
  assert.equal(policy.commitTransition('http://beta.localhost:48131/__astroix/app/'), true);
  assert.equal(policy.activeOrigin(), beta);
  assert.equal(policy.allow('http://alpha.localhost:48131/__astroix/app/'), false);
  assert.equal(policy.allow('http://beta.localhost:48131/__astroix/app/'), true);
});

test('cancels an uncommitted transition without retiring the active origin', () => {
  const alpha = 'http://alpha.localhost:48131';
  const beta = 'http://beta.localhost:48131';
  const policy = createMainFrameNavigationPolicy(alpha);

  policy.permitTransition(beta);
  assert.equal(policy.allow('http://beta.localhost:48131/__astroix/app/'), true);
  assert.equal(policy.cancelTransition(), true);
  assert.equal(policy.activeOrigin(), alpha);
  assert.equal(policy.allow('http://alpha.localhost:48131/__astroix/app/'), true);
  assert.equal(policy.allow('http://beta.localhost:48131/__astroix/app/'), false);
  assert.equal(policy.cancelTransition(), false);
});
