import { createAppClient } from '@wojciechpiskorz/astroix-app-shell/app-client';
import { byTestId, readBootstrap, setText, showCommandError } from './page-kit.ts';

/**
 * The project-app document's module (#240): the active project's app
 * page — bound at its exact `SessionRef` (the document surface
 * injected it), inspecting through the ONE AppClient's session client,
 * observing the session-scoped events stream, and deactivating through
 * the settled transition protocol. A stale pair (a switch happened
 * elsewhere) surfaces as the protocol's `stale-session` code and the
 * stream's terminal `stale` reason — never as silent dead UI.
 */

const bootstrap = readBootstrap();
if (bootstrap.session === undefined) throw new Error('the project document carries no session');
const session = bootstrap.session;

const client = createAppClient({ clientCapability: bootstrap.clientCapability });
client.adoptSession(session);
const sessionClient = client.forSession(session);

setText('session-generation', String(session.generation));

const subscription = sessionClient.events({
  onEvent: () => setText('stream-state', 'open'),
  onStale: () => setText('stream-state', 'stale'),
  onTransportError: () => setText('stream-state', 'unavailable'),
});
void subscription.closed.then((reason) => {
  if (reason !== 'aborted') setText('stream-state', reason);
});

void sessionClient
  .inspect({ kind: 'project' })
  .then((result) => setText('inspect-revision', String(result.revision)))
  .catch((error) => showCommandError(error));

byTestId('reinspect').addEventListener('click', () => {
  byTestId('command-error').hidden = true;
  sessionClient
    .inspect({ kind: 'project' })
    .then((result) => setText('inspect-revision', String(result.revision)))
    .catch((error) => showCommandError(error));
});

byTestId('deactivate').addEventListener('click', () => {
  byTestId('command-error').hidden = true;
  client
    .deactivate()
    .then(() => {
      client.close();
      location.replace(`http://launcher.localhost:${location.port}/__astroix/app/`);
    })
    .catch((error) => showCommandError(error));
});
