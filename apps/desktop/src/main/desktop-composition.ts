import type {
  PublicError,
  RequestEnvelope,
  ResponseEnvelope,
} from '@wojciechpiskorz/astroix-protocol';
import type { PrivateIpcChannel } from '@wojciechpiskorz/astroix-runtime/private-boot';
import {
  type ControlPlaneComposition,
  createControlPlaneComposition,
  type HostDocumentIdentity,
  type HostMainFrameHandshake,
} from '../../../web/src/control-plane.ts';
import {
  type AuthorityObservation,
  authorityObservationResultReport,
  bootedReport,
  type DesktopChildRequest,
  documentCapabilityReport,
  observeDocumentRequest,
  parseDesktopChildRequest,
  type RegisterResult,
  registerResultReport,
  replaceTopLevelRequest,
  sessionStateReport,
  type TransitionOutcome,
  transitionResultReport,
} from './child-protocol.ts';

/**
 * The desktop child's composition driver (#362, H7): boots the SHARED
 * control-plane composition (`apps/web/src/control-plane.ts` — ONE
 * seam, two hosts) inside the privately-booted child, over the
 * PRODUCTION registry (userData kernel-leased — never an injected
 * registry), and maps the private channel onto it —
 *
 * - `register-root` stays the registry validation it always was (the
 *   composition's own registry store);
 * - `activate`/`deactivate` drive the SAME executor the browser
 *   command set drives (synthesized protocol-v1 envelopes — the
 *   settled transition protocol, never a second driver), mapped onto
 *   the private channel's transition vocabulary;
 * - the adoption handshake (the composition's host seam) rides the
 *   channel: the child asks, MAIN observes the authoritative window,
 *   the composition binds and rebinds through the observed documents;
 * - the supervisor's snapshots flow out as `session-state` reports;
 * - MAIN's authority observations (the H4 mirror's invalidation
 *   forwards) drive the composition's document authority.
 *
 * The retired H1 refusal (`unavailable-composition`) is gone: the
 * composition answers. Electron-free by construction — the channel is
 * the injected seam; `control-plane-child.ts` remains the boot entry
 * (the child's argv carries the config, never the environment).
 */

/** The composition's child-side construction input. */
export interface DesktopCompositionInput {
  readonly channel: PrivateIpcChannel;
  readonly registryDirectory: string;
  /** The built client documents the origin listener serves (packaged resources or the dev checkout's web build). */
  readonly clientDist: string;
}

/** The booted desktop composition — the child's whole service surface. */
export interface DesktopComposition {
  readonly composition: ControlPlaneComposition;
  /** The ordered teardown the child's exit path runs before exiting. */
  close(): Promise<void>;
}

/**
 * Boots the desktop child's composition, reports the booted port, and
 * serves the private channel for the rest of the child's lifetime.
 */
export async function bootDesktopComposition(
  input: DesktopCompositionInput,
): Promise<DesktopComposition> {
  const { channel } = input;
  /** The handshake waiters — one per outstanding child→main observation ask. */
  const observationWaiters = new Map<number, (identity: HostDocumentIdentity | null) => void>();
  let nextObservationId = 0;
  /** The last identity the injection feed addressed — the clear's addressee when the seat dies. */
  let lastDocumentWebContentsId: number | null = null;

  const handshake: HostMainFrameHandshake = {
    currentDocument: () => askForDocument(),
    replaceTopLevel: (ask) => askForDocument(ask),
  };

  const composition = await createControlPlaneComposition({
    registryDirectory: input.registryDirectory,
    clientDist: input.clientDist,
    hostHandshake: handshake,
    // The dev-checkout register discipline: this child's own execArgv is
    // exactly what its worker children need (the raw-Node register in
    // dev, nothing in the packaged rebased entry).
    workerExecArgv: process.execArgv,
    // The ordered-exit window: main's graceful bound is ADR-0006 §8's
    // 5 s — the plane's stop must converge inside it, or main's
    // escalation kills this child mid-teardown and orphans the plane.
    planeBounds: { stopTimeoutMs: 2000, termGraceMs: 1500, killReapMs: 800 },
  });

  composition.supervisor.subscribe((snapshot) => {
    channel.send(sessionStateReport(snapshot.active?.ref ?? null));
    reportDocumentCapability();
  });

  channel.on('message', (message) => {
    const request = parseDesktopChildRequest(message);
    if (request === null) return; // a drifted or hostile message is dropped, never parsed
    void dispatch(request);
  });

  channel.send(bootedReport(composition.port));

  return {
    composition,
    close: () => composition.close(),
  };

  /** One handshake ask over the channel — resolved by main's observation reply. */
  function askForDocument(
    ask?: Parameters<HostMainFrameHandshake['replaceTopLevel']>[0],
  ): Promise<HostDocumentIdentity | null> {
    nextObservationId += 1;
    const requestId = nextObservationId;
    const asked = new Promise<HostDocumentIdentity | null>((resolve) => {
      observationWaiters.set(requestId, resolve);
    });
    channel.send(
      ask === undefined
        ? observeDocumentRequest(requestId)
        : replaceTopLevelRequest({
            requestId,
            sessionRef: ask.sessionRef,
            projectKey: ask.projectKey,
            origin: ask.origin,
          }),
    );
    return asked;
  }

  /** The H4 injection's feed: the live editor document binding, or the clear. */
  function reportDocumentCapability(): void {
    const editor = composition.editorDocument();
    if (editor !== null) {
      lastDocumentWebContentsId = editor.webContentsId;
      channel.send(documentCapabilityReport(editor.webContentsId, editor.capability));
      return;
    }
    if (lastDocumentWebContentsId !== null) {
      channel.send(documentCapabilityReport(lastDocumentWebContentsId, null));
    }
  }

  async function dispatch(request: DesktopChildRequest): Promise<void> {
    switch (request.kind) {
      case 'register-root':
        channel.send(registerResultReport(request.requestId, await registerRoot(request.root)));
        return;
      case 'activate':
      case 'deactivate':
        channel.send(transitionResultReport(request.requestId, await driveTransition(request)));
        reportDocumentCapability();
        return;
      case 'host-observation-result': {
        const settle = observationWaiters.get(request.requestId);
        if (settle === undefined) return; // an uncorrelated reply is dropped, never guessed
        observationWaiters.delete(request.requestId);
        settle(
          request.observed && request.document !== undefined
            ? {
                webContentsId: request.document.webContentsId,
                navigationId: request.document.navigationId,
              }
            : null,
        );
        return;
      }
      case 'authority-observation':
        applyAuthorityObservation(request.observation);
        channel.send(authorityObservationResultReport(request.requestId));
        return;
    }
  }

  /** One delegated transition through the SAME executor the browser drives. */
  async function driveTransition(
    request: Extract<DesktopChildRequest, { kind: 'activate' | 'deactivate' }>,
  ): Promise<TransitionOutcome> {
    const envelope: RequestEnvelope =
      request.kind === 'activate'
        ? {
            protocolVersion: 1,
            requestId: `desktop-${request.requestId}`,
            command: { kind: 'activate', projectKey: request.projectKey },
          }
        : {
            protocolVersion: 1,
            requestId: `desktop-${request.requestId}`,
            session: request.sessionRef,
            command: { kind: 'deactivate' },
          };
    return outcomeOf(await composition.executor.execute(envelope));
  }

  /** MAIN's mirror-side observation applied to the composition's document authority (both truths, in lockstep). */
  function applyAuthorityObservation(observation: AuthorityObservation): void {
    switch (observation.kind) {
      case 'document-navigated':
        composition.authority.documentNavigated(
          observation.webContentsId,
          observation.navigationId,
        );
        return;
      case 'renderer-lost':
        composition.authority.rendererLost(observation.webContentsId);
        return;
      case 'target-destroyed':
        composition.authority.targetDestroyed(observation.webContentsId);
        return;
      case 'revoked':
        composition.authority.revoke(observation.capability);
        return;
    }
  }

  /** One native directory grant → registry validation → the sanitized wire summary (never a root). */
  async function registerRoot(root: string): Promise<RegisterResult> {
    const result = await composition.registry.execute({ kind: 'register', root });
    // The register command's own success shape carries the record; any other
    // ok-shape would be a registry divergence — fail closed, never guess.
    if (!result.ok || result.kind !== 'registered') {
      const code = result.ok ? 'root-unavailable' : result.code;
      return { ok: false, code: code === 'quarantined' ? 'quarantined' : 'root-unavailable' };
    }
    // A freshly registered root was just realpath'd by the registry itself — it is available.
    return {
      ok: true,
      summary: {
        projectKey: result.record.projectKey,
        displayName: result.record.displayName,
        availability: 'available',
      },
    };
  }
}

/**
 * The settled transition outcome for one executor answer — the
 * envelope's snapshot is the truth, never the reply shape: a committed
 * activation reports the ACTIVE pair; a failed one (ADR-0006 §4's
 * `failed` label, carried by the snapshot) never masquerades as a
 * completed pair.
 */
function outcomeOf(response: ResponseEnvelope | PublicError): TransitionOutcome {
  if ('result' in response) {
    if (response.result.kind === 'activation') {
      const active = response.result.snapshot.active;
      return active === undefined
        ? { kind: 'refused', reason: 'transition-failed' }
        : { kind: 'completed', sessionRef: active.ref };
    }
    if (response.result.kind === 'deactivation') {
      return { kind: 'completed', sessionRef: null };
    }
    return { kind: 'refused', reason: 'control-plane-unavailable' };
  }
  if (response.code === 'concurrent-activation') {
    return { kind: 'refused', reason: 'concurrent-activation' };
  }
  if (response.code === 'stale-session') {
    return { kind: 'refused', reason: 'stale-session' };
  }
  return { kind: 'refused', reason: 'transition-failed' };
}
