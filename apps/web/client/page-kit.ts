import type { AppClientError } from '@wojciechpiskorz/astroix-app-shell/app-client';
import {
  type ProjectSummary,
  type SessionRef,
  type SessionSnapshot,
  sessionLabel,
} from '@wojciechpiskorz/astroix-protocol';

/**
 * The shared document bootstrap of the web host's pages (#240): the
 * meta-tag facts the document surface injects (the client capability,
 * and on the project host the exact `SessionRef`), the testid-bearing
 * DOM helpers, and the label derivation the protocol owns
 * (`sessionLabel`, ADR-0006 §4). The launcher document stays plain DOM —
 * deliberately not a React surface; the project document is the React
 * shell host (#241, `app-entry.tsx`). Every exchange, either way, goes
 * through the ONE AppClient.
 */

/** The document's bootstrap facts, as the document surface injected them. */
export interface PageBootstrap {
  readonly clientCapability: string;
  readonly session?: SessionRef;
}

/** Reads the injected bootstrap metas. */
export function readBootstrap(): PageBootstrap {
  const clientCapability = meta('astroix-client');
  if (clientCapability === null) throw new Error('the document carries no client capability');
  const epoch = meta('astroix-epoch');
  const generation = meta('astroix-generation');
  if (epoch === null || generation === null) return { clientCapability };
  return {
    clientCapability,
    session: { runtimeEpoch: epoch, generation: Number.parseInt(generation, 10) },
  };
}

function meta(name: string): string | null {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;
}

/** One element by testid — the pages' whole DOM vocabulary. */
export function byTestId(id: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (element === null) throw new Error(`missing testid: ${id}`);
  return element as HTMLElement;
}

/** Sets one element's text. */
export function setText(id: string, text: string): void {
  byTestId(id).textContent = text;
}

/** Shows a failure's sanitized category + message under the shared testid. */
export function showFailure(prefix: string, failure: { category: string; message: string }): void {
  setText('last-failure', `${prefix}: ${failure.category} — ${failure.message}`);
  byTestId('last-failure').hidden = false;
}

/** Shows a command error's public code under the shared testid. */
export function showCommandError(error: unknown): void {
  const code = isAppClientError(error) ? (error.envelope?.error.code ?? error.kind) : 'unknown';
  setText('command-error', code);
  byTestId('command-error').hidden = false;
}

function isAppClientError(error: unknown): error is AppClientError {
  return error instanceof Error && error.name === 'AppClientError';
}

/** Derives the launcher label through the protocol's own canonical derivation (ADR-0006 §4). */
export function sessionLabelOf(snapshot: SessionSnapshot): string {
  return sessionLabel(snapshot);
}

/** Renders the launcher's project list with one activate button per project. */
export function renderProjects(
  projects: readonly ProjectSummary[],
  onActivate: (projectKey: ProjectSummary['projectKey']) => void,
): void {
  const list = byTestId('project-list');
  list.replaceChildren();
  for (const project of projects) {
    const item = document.createElement('li');
    item.dataset.projectKey = project.projectKey;
    const name = document.createElement('span');
    name.textContent = `${project.displayName} (${project.availability})`;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.testid = 'activate';
    button.textContent = 'Activate';
    button.addEventListener('click', () => onActivate(project.projectKey));
    item.append(name, document.createTextNode(' '), button);
    list.append(item);
  }
}
