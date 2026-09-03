import { describe, expect, it } from 'vitest';
import {
  capabilitiesOf,
  ROLE_CAPABILITIES,
  roleCan,
  SHELL_CAPABILITIES,
  type ShellRole,
  shellRoleFromServerRole,
} from './capabilities.ts';

/**
 * The role capability table's focused lane (#241's AC): the permitted
 * controls per target — pinned per capability, with the diagnostic row's
 * four denials named exactly as the AC names them (no activate, no
 * deactivate, no edit scheduling, no editor grants).
 */

describe('the role capability table', () => {
  it('carries every capability on the authoritative row', () => {
    expect(capabilitiesOf('authoritative')).toEqual([...SHELL_CAPABILITIES]);
  });

  it('carries exactly the two read paths on the diagnostic row', () => {
    expect(capabilitiesOf('diagnostic')).toEqual(['inspect', 'subscribe-events']);
  });

  describe('the authoritative editing client may', () => {
    const cases: readonly [string, boolean][] = [
      ['inspect', true],
      ['subscribe-events', true],
      ['activate', true],
      ['deactivate', true],
      ['schedule-edit', true],
      ['receive-editor-grants', true],
    ];
    for (const [capability, permitted] of cases) {
      it(`${permitted ? 'exercise' : 'be denied'} ${capability}`, () => {
        expect(roleCan('authoritative', capability as (typeof SHELL_CAPABILITIES)[number])).toBe(
          permitted,
        );
      });
    }
  });

  describe('a diagnostic target', () => {
    const cases: readonly [string, boolean][] = [
      ['inspect', true],
      ['subscribe-events', true],
      ['activate', false],
      ['deactivate', false],
      ['schedule-edit', false],
      ['receive-editor-grants', false],
    ];
    for (const [capability, permitted] of cases) {
      it(`${permitted ? 'may exercise' : 'cannot'} ${capability}`, () => {
        expect(roleCan('diagnostic', capability as (typeof SHELL_CAPABILITIES)[number])).toBe(
          permitted,
        );
      });
    }
  });

  it('covers both roles and every capability in the table', () => {
    expect(Object.keys(ROLE_CAPABILITIES).sort()).toEqual(['authoritative', 'diagnostic']);
    for (const role of Object.keys(ROLE_CAPABILITIES) as ShellRole[]) {
      for (const capability of capabilitiesOf(role)) {
        expect(SHELL_CAPABILITIES, `unknown capability in table: ${capability}`).toContain(
          capability,
        );
      }
    }
  });

  it('maps the server role vocabulary onto the shell terms', () => {
    expect(shellRoleFromServerRole('editor')).toBe('authoritative');
    expect(shellRoleFromServerRole('diagnostic')).toBe('diagnostic');
  });
});
