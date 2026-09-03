import { describe, expect, it } from 'vitest';
import type { RegisterResult } from './child-protocol.ts';
import {
  addExistingProject,
  type DirectoryPickerSeam,
  type NativeSelectionObserver,
  type ProjectRegistrationChannel,
} from './project-picker.ts';

/**
 * Native selection's focused units (#243; ADR-0006 §1): the native
 * directory grant flows to registry validation verbatim; the surface the
 * renderer ever sees carries only sanitized fields — no filesystem root
 * crosses it in any direction.
 */

/** The fake picker — scripted dialog outcomes. */
function pickerWith(choice: { canceled: boolean; directory: string | null }): DirectoryPickerSeam {
  return {
    showOpenDirectory: async () => choice,
  };
}

/** The fake channel — records forwarded roots, scripts replies. */
class RecordingChannel implements ProjectRegistrationChannel {
  readonly forwarded: string[] = [];
  reply: RegisterResult = {
    ok: true,
    summary: { projectKey: 'abc123', displayName: 'fixture', availability: 'available' },
  };
  async registerRoot(root: string): Promise<RegisterResult> {
    this.forwarded.push(root);
    return this.reply;
  }
}

/** The recording observer — the renderer-facing surface stand-in. */
class RecordingObserver implements NativeSelectionObserver {
  readonly summaries: unknown[] = [];
  readonly refusals: string[] = [];
  readonly cancellations: number[] = [];
  onRegistered(summary: never): void {
    this.summaries.push(summary);
  }
  onRegistrationRefused(code: never): void {
    this.refusals.push(code);
  }
  onSelectionCanceled(): void {
    this.cancellations.push(1);
  }
}

describe('addExistingProject', () => {
  it('forwards the granted directory verbatim to registry validation', async () => {
    const channel = new RecordingChannel();
    const observer = new RecordingObserver();
    await addExistingProject(
      pickerWith({ canceled: false, directory: '/Users/dev/Projects/site' }),
      channel,
      observer,
    );
    expect(channel.forwarded).toEqual(['/Users/dev/Projects/site']);
  });

  it('surfaces the sanitized summary on a validated grant — no root anywhere in the payload', async () => {
    const observer = new RecordingObserver();
    await addExistingProject(
      pickerWith({ canceled: false, directory: '/Users/dev/Projects/site' }),
      new RecordingChannel(),
      observer,
    );
    expect(observer.summaries).toEqual([
      { projectKey: 'abc123', displayName: 'fixture', availability: 'available' },
    ]);
    expect(JSON.stringify(observer.summaries)).not.toContain('/Users/dev');
  });

  it('surfaces the sanitized refusal code when validation refuses the grant', async () => {
    const channel = new RecordingChannel();
    channel.reply = { ok: false, code: 'root-unavailable' };
    const observer = new RecordingObserver();
    await addExistingProject(
      pickerWith({ canceled: false, directory: '/not/a/project' }),
      channel,
      observer,
    );
    expect(observer.refusals).toEqual(['root-unavailable']);
    expect(observer.summaries).toEqual([]);
  });

  it('touches the registry not at all when the dialog is dismissed', async () => {
    const channel = new RecordingChannel();
    const observer = new RecordingObserver();
    await addExistingProject(pickerWith({ canceled: true, directory: null }), channel, observer);
    expect(channel.forwarded).toEqual([]);
    expect(observer.cancellations).toHaveLength(1);
    expect(observer.summaries).toEqual([]);
    expect(observer.refusals).toEqual([]);
  });

  it('treats a canceled dialog with a directory still present as canceled (defense in depth)', async () => {
    const channel = new RecordingChannel();
    const observer = new RecordingObserver();
    await addExistingProject(
      pickerWith({ canceled: true, directory: '/some/dir' }),
      channel,
      observer,
    );
    expect(channel.forwarded).toEqual([]);
    expect(observer.cancellations).toHaveLength(1);
  });
});
