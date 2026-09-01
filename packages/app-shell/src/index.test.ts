import { describe, expect, it } from 'vitest';
import * as appShell from './index';

/**
 * The extraction seam (#218, AC-4): the public surface is generic UI/editor
 * contracts only — the primitive set, the cn helper, the mobile hook, and
 * the CodeMirror/markdown infrastructure. A contract dropped or renamed at
 * the barrel breaks the Electron app-shell renderer the moment it consumes
 * this package, so the surface is pinned by name here.
 */
describe('app-shell public surface', () => {
  it('exposes the shadcn/Base UI primitive contracts', () => {
    for (const name of [
      'Button',
      'buttonVariants',
      'Checkbox',
      'Dialog',
      'DialogContent',
      'DialogTrigger',
      'Field',
      'FieldLabel',
      'FieldError',
      'Input',
      'Label',
      'Select',
      'SelectItem',
      'SelectTrigger',
      'Separator',
      'Sheet',
      'SheetContent',
      'Sidebar',
      'SidebarProvider',
      'Skeleton',
      'Tabs',
      'TabsList',
      'TabsTrigger',
      'Textarea',
      'Tooltip',
      'TooltipContent',
      'TooltipTrigger',
    ]) {
      expect(appShell, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it('exposes the generic editor and helper contracts', () => {
    for (const name of [
      'cn',
      'useIsMobile',
      'createEditorView',
      'replaceDoc',
      'revealRange',
      'MarkdownEditor',
      'MarkdownToolbar',
    ]) {
      expect(appShell, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it('exports no stylesheet delivery or astroix-branded runtime values', () => {
    // chromeSheet (the constructed stylesheet) is the host's delivery
    // mechanic (src/client/styles.ts) — never re-exported here; anything
    // astroix-branded at runtime is domain coupling
    expect(appShell).not.toHaveProperty('chromeSheet');
    expect(Object.keys(appShell).filter((name) => /astroix/i.test(name))).toEqual([]);
  });
});
