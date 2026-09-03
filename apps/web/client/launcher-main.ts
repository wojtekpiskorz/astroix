import { createAppClient } from '@wojciechpiskorz/astroix-app-shell/app-client';
import type { ProjectSummary } from '@wojciechpiskorz/astroix-protocol';
import {
  byTestId,
  readBootstrap,
  renderProjects,
  sessionLabelOf,
  setText,
  showCommandError,
  showFailure,
} from './page-kit.ts';

/**
 * The launcher document's module (#240): the neutral trusted page
 * (ADR-0005) — lists the registry's projects, activates through the
 * settled transition protocol, and observes lifecycle progress on the
 * launcher-scoped events stream. Every exchange goes through the ONE
 * AppClient; after a committed activation the client closes its
 * streams and the top level replaces to the project app origin
 * (ADR-0006 §4 step 6's web-host shape).
 */

const bootstrap = readBootstrap();
const client = createAppClient({ clientCapability: bootstrap.clientCapability });

client.events({
  onEvent: (envelope) => {
    if (envelope.event.type === 'registry-changed') void refreshProjects();
    if (envelope.event.type === 'session-state') {
      setText('session-label', sessionLabelOf(envelope.event.snapshot));
      const failure = envelope.event.snapshot.lastFailure;
      if (failure !== undefined) showFailure('activation', failure);
    }
  },
});

renderProjects([], activate);
void refreshProjects();

function activate(projectKey: ProjectSummary['projectKey']): void {
  byTestId('command-error').hidden = true;
  client
    .activate(projectKey)
    .then((outcome) => {
      setText('session-label', sessionLabelOf(outcome.snapshot));
      // An active session WINS (ADR-0006 §4): a staged-candidate
      // failure while a session is ready is a notification, never the
      // global state — a committed activation navigates regardless of
      // any lastFailure the snapshot still carries.
      if (outcome.snapshot.active === undefined) {
        const failure = outcome.snapshot.lastFailure;
        if (failure !== undefined) showFailure('activation', failure);
        return;
      }
      // The commit reset (ADR-0006 §5): close old streams, then the top
      // level replaces to the project app origin.
      client.close();
      const origin = location.origin.replace(
        'launcher.localhost',
        `${outcome.target.projectKey}.localhost`,
      );
      location.replace(`${origin}/__astroix/app/`);
    })
    .catch((error) => showCommandError(error));
}

async function refreshProjects(): Promise<void> {
  try {
    renderProjects(await client.projects(), activate);
  } catch (error) {
    showCommandError(error);
  }
}
