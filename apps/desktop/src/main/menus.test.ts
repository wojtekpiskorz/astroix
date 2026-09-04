import type { ProjectKey, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import type { GrantedProjectSummary } from './child-protocol.ts';
import { buildApplicationMenu, dispatchMenuAction, type NativeMenuActions } from './menus.ts';

/**
 * The menu currency law's focused units (#243; ADR-0006 §5; #362 H7's
 * activation entries): the capture freezes the `SessionRef` visible at
 * menu creation; the click executes later against whatever session is
 * current — an exact epoch+generation match executes, everything else
 * rejects without executing. The activation items are the composition's
 * native surface (#362): one per registered project, enabled only while
 * idle, carrying their project keys at build time.
 */

const REF_A: SessionRef = { runtimeEpoch: 'epoch-1', generation: 3 };
const REF_B: SessionRef = { runtimeEpoch: 'epoch-1', generation: 4 };
const REF_RESTARTED: SessionRef = { runtimeEpoch: 'epoch-2', generation: 1 };
const PROJECT_KEY: ProjectKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const REGISTERED: GrantedProjectSummary[] = [
  { projectKey: PROJECT_KEY, displayName: 'managed-project', availability: 'available' },
];

/** Records every action the dispatcher drives — the fake host actions. */
class RecordingActions implements NativeMenuActions {
  readonly addExisting: number[] = [];
  readonly activations: ProjectKey[] = [];
  readonly deactivations: SessionRef[] = [];
  readonly quits: number[] = [];
  readonly rejections: string[] = [];
  addExistingProject(): void {
    this.addExisting.push(1);
  }
  activate(projectKey: ProjectKey): void {
    this.activations.push(projectKey);
  }
  deactivate(sessionRef: SessionRef): void {
    this.deactivations.push(sessionRef);
  }
  quit(): void {
    this.quits.push(1);
  }
  menuActionRejected(reason: 'no-active-session' | 'stale-session'): void {
    this.rejections.push(reason);
  }
}

describe('buildApplicationMenu', () => {
  it('disables the deactivate item and captures nothing while no session is active', () => {
    const menu = buildApplicationMenu(null);
    expect(menu.deactivateCapture).toBeNull();
    const sessionSection = menu.sections.find((section) => section.label === 'Session');
    const deactivate = sessionSection?.items.find((item) => item.actionId === 'deactivate');
    expect(deactivate?.enabled).toBe(false);
  });

  it('captures the visible session reference at creation and enables the item', () => {
    const menu = buildApplicationMenu(REF_A);
    expect(menu.deactivateCapture).not.toBeNull();
    expect(menu.deactivateCapture?.sessionRef).toEqual(REF_A);
    expect(menu.deactivateCapture?.action).toBe('deactivate');
    const sessionSection = menu.sections.find((section) => section.label === 'Session');
    const deactivate = sessionSection?.items.find((item) => item.actionId === 'deactivate');
    expect(deactivate?.enabled).toBe(true);
  });

  it('carries the native registration entry point and the quit action', () => {
    const menu = buildApplicationMenu(null);
    const fileItems = menu.sections.find((section) => section.label === 'File')?.items ?? [];
    const appItems = menu.sections.find((section) => section.label === 'Astroix')?.items ?? [];
    expect(fileItems.some((item) => item.actionId === 'add-existing-project')).toBe(true);
    expect(appItems.some((item) => item.actionId === 'quit')).toBe(true);
  });

  it('carries one activation entry per registered project — enabled while idle, disabled under a session (#362)', () => {
    const idle = buildApplicationMenu(null, REGISTERED);
    const idleSession = idle.sections.find((section) => section.label === 'Session')?.items ?? [];
    const activate = idleSession.find((item) => item.actionId === 'activate');
    expect(activate?.label).toBe('Activate managed-project');
    expect(activate?.enabled).toBe(true);
    expect(activate?.projectKey).toBe(PROJECT_KEY);
    // Under an active session the activation entries stand disabled — an
    // activation is an idle-state transition; switches go through
    // deactivate first.
    const active = buildApplicationMenu(REF_A, REGISTERED);
    const activeSession =
      active.sections.find((section) => section.label === 'Session')?.items ?? [];
    expect(activeSession.find((item) => item.actionId === 'activate')?.enabled).toBe(false);
    // No registered projects: no activation surface at all — the menu
    // never carries a dead entry.
    const empty = buildApplicationMenu(null, []);
    const emptySession = empty.sections.find((section) => section.label === 'Session')?.items ?? [];
    expect(emptySession.some((item) => item.actionId === 'activate')).toBe(false);
  });
});

describe('dispatchMenuAction', () => {
  it('executes add-existing-project and quit directly — no session currency involved', () => {
    const actions = new RecordingActions();
    const menu = buildApplicationMenu(REF_A);
    dispatchMenuAction(menu, 'add-existing-project', REF_A, actions);
    dispatchMenuAction(menu, 'quit', REF_A, actions);
    expect(actions.addExisting).toHaveLength(1);
    expect(actions.quits).toHaveLength(1);
    expect(actions.deactivations).toHaveLength(0);
  });

  it('executes deactivate when the captured pair is exactly current', () => {
    const actions = new RecordingActions();
    const menu = buildApplicationMenu(REF_A);
    dispatchMenuAction(menu, 'deactivate', REF_A, actions);
    expect(actions.deactivations).toEqual([REF_A]);
    expect(actions.rejections).toEqual([]);
  });

  it('rejects a stale action after a switch — the exact ADR-0006 §5 stale case', () => {
    const actions = new RecordingActions();
    const menu = buildApplicationMenu(REF_A);
    dispatchMenuAction(menu, 'deactivate', REF_B, actions);
    expect(actions.deactivations).toEqual([]);
    expect(actions.rejections).toEqual(['stale-session']);
  });

  it('rejects a stale action after a control-plane restart (new epoch)', () => {
    const actions = new RecordingActions();
    const menu = buildApplicationMenu(REF_A);
    dispatchMenuAction(menu, 'deactivate', REF_RESTARTED, actions);
    expect(actions.deactivations).toEqual([]);
    expect(actions.rejections).toEqual(['stale-session']);
  });

  it('rejects with no-active-session when the session ended since the menu was built', () => {
    const actions = new RecordingActions();
    const menu = buildApplicationMenu(REF_A);
    dispatchMenuAction(menu, 'deactivate', null, actions);
    expect(actions.deactivations).toEqual([]);
    expect(actions.rejections).toEqual(['no-active-session']);
  });

  it('rejects with no-active-session when a captureless menu is clicked', () => {
    const actions = new RecordingActions();
    const menu = buildApplicationMenu(null);
    dispatchMenuAction(menu, 'deactivate', null, actions);
    expect(actions.rejections).toEqual(['no-active-session']);
  });

  it("activates the clicked item's project through the host action (#362)", () => {
    const actions = new RecordingActions();
    const menu = buildApplicationMenu(null, REGISTERED);
    dispatchMenuAction(menu, 'activate', null, actions, PROJECT_KEY);
    expect(actions.activations).toEqual([PROJECT_KEY]);
    expect(actions.deactivations).toEqual([]);
    expect(actions.rejections).toEqual([]);
  });

  it('drops an activate click that carries no target — the dispatch never guesses', () => {
    const actions = new RecordingActions();
    const menu = buildApplicationMenu(null, REGISTERED);
    dispatchMenuAction(menu, 'activate', null, actions);
    expect(actions.activations).toEqual([]);
    expect(actions.rejections).toEqual([]);
  });
});
