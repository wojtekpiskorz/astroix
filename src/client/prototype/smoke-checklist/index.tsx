// PROTOTYPE (issue #46) — in-chrome owner smoke checklist, throwaway.
// Three structurally different variants of the checklist (docked panel /
// keyboard-summoned wizard / bottom status strip), switchable via a floating
// pill + ←/→ keys + the ?variant= URL param. Mounted from app.tsx, gated on
// ?smoke=1 — nothing renders without it.
import { useEffect, useState } from 'react';
import { PrototypeSwitcher } from './prototype-switcher';
import { VariantA } from './variant-a';
import { VariantB } from './variant-b';
import { VariantC } from './variant-c';

const VARIANTS = [
  { key: 'A', name: 'Docked panel', component: VariantA },
  { key: 'B', name: 'Wizard dialog (S)', component: VariantB },
  { key: 'C', name: 'Bottom strip', component: VariantC },
] as const;

type VariantKey = (typeof VARIANTS)[number]['key'];

const params = new URLSearchParams(window.location.search);

export const smokePrototypeEnabled: boolean = params.has('smoke');

function initialVariant(): VariantKey {
  const value = params.get('variant');
  return VARIANTS.some((variant) => variant.key === value) ? (value as VariantKey) : 'A';
}

function isTyping(): boolean {
  const element = document.activeElement;
  if (element === null) return false;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

function variantAfter(key: VariantKey, direction: 1 | -1) {
  const index = VARIANTS.findIndex((variant) => variant.key === key);
  return VARIANTS[(index + direction + VARIANTS.length) % VARIANTS.length] ?? VARIANTS[0];
}

function switchUrlVariant(nextKey: string): void {
  // shareable + reload-stable; canvasSrc strips this param so the iframe
  // src stays stable across switches
  const url = new URL(window.location.href);
  url.searchParams.set('smoke', '1');
  url.searchParams.set('variant', nextKey);
  window.history.replaceState(null, '', url);
}

export function SmokeChecklistRoot() {
  const [key, setKey] = useState<VariantKey>(initialVariant);

  const cycle = (direction: 1 | -1): void => {
    const next = variantAfter(key, direction);
    setKey(next.key);
    switchUrlVariant(next.key);
  };

  // ←/→ cycle variants, but never while typing (editor, notes, CodeMirror's
  // hidden textarea). setKey's functional update reads the freshest key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || isTyping()) return;
      event.preventDefault();
      setKey((currentKey) => {
        const next = variantAfter(currentKey, event.key === 'ArrowRight' ? 1 : -1);
        switchUrlVariant(next.key);
        return next.key;
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const current = VARIANTS.find((variant) => variant.key === key) ?? VARIANTS[0];
  const Variant = current.component;

  return (
    <>
      <Variant />
      <PrototypeSwitcher current={current.key} name={current.name} onCycle={cycle} />
    </>
  );
}
