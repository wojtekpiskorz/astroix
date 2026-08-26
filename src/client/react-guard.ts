import { version } from 'react';

// ADR-0001 warn-only tripwire: in source mode the chrome must run on this
// repo's React 19; any other version means something shadowed it. Warn-only
// by decision — foreign hosts load the prebuilt bundle with its own React.
if (!version.startsWith('19.')) {
  console.warn(
    `astroix: chrome loaded React ${version} — expected React 19 (ADR-0001 warn-only guard)`,
  );
}
