import type {
  GrantedProjectSummary,
  RegisterRefusalCode,
  RegisterResult,
} from './child-protocol.ts';

/**
 * Native project selection (#243, H1; ADR-0006 §1 "Registration accepts a
 * native directory grant, never a browser-supplied path"; ADR-0004):
 * the native directory picker hands the granted root to registry
 * validation in the control-plane child — main keeps the granted path for
 * exactly that call, and the result surfaced onward carries only the
 * sanitized wire summary (project key, display name, availability): no
 * filesystem root ever reaches the renderer, and none is stored.
 *
 * The picker seam is Electron's `dialog.showOpenDialog` adapted by the
 * wiring (`index.ts`); the registration channel is the private
 * child-protocol client the native host owns. Both are injected — the
 * focused units fake exactly these seams.
 */

/** The native directory-picker seam. */
export interface DirectoryPickerSeam {
  /**
   * Shows the native open-directory dialog against the host window.
   * Resolves `canceled` with no directory when the user dismisses it.
   */
  showOpenDirectory(title: string): Promise<{ canceled: boolean; directory: string | null }>;
}

/** The control-plane registration channel the selection result flows through. */
export interface ProjectRegistrationChannel {
  /** Validates and registers one granted root; resolves sanitized-only. */
  registerRoot(root: string): Promise<RegisterResult>;
}

/** The sanitized surface selection outcomes are reported on — no root crosses it. */
export interface NativeSelectionObserver {
  onRegistered(summary: GrantedProjectSummary): void;
  onRegistrationRefused(code: RegisterRefusalCode): void;
  onSelectionCanceled(): void;
}

/**
 * Runs the whole native flow behind "Add Existing Project…": native
 * directory grant → registry validation → sanitized surface report. A
 * canceled picker touches the channel; a refused grant is surfaced with
 * its sanitized code; a validated grant is surfaced as the wire-safe
 * summary.
 */
export async function addExistingProject(
  picker: DirectoryPickerSeam,
  channel: ProjectRegistrationChannel,
  observer: NativeSelectionObserver,
): Promise<void> {
  const choice = await picker.showOpenDirectory('Add Existing Project');
  if (choice.canceled || choice.directory === null) {
    observer.onSelectionCanceled();
    return;
  }
  const result = await channel.registerRoot(choice.directory);
  if (result.ok) {
    observer.onRegistered(result.summary);
    return;
  }
  observer.onRegistrationRefused(result.code);
}
