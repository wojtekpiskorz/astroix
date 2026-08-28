import { SMOKE_STEPS } from './smoke-steps';

/** Everything the report builder needs from the outside world, injected so
 * the function stays pure — time/URL/UA are not fixtures. */
export interface SmokeReportContext {
  url: string;
  userAgent: string;
  /** ISO timestamp; the header renders it as `YYYY-MM-DD HH:mm`. */
  isoTimestamp: string;
}

export function verifiedCount(done: Readonly<Partial<Record<string, boolean>>>): number {
  return SMOKE_STEPS.filter((step) => done[step.id]).length;
}

/** The Copy-report payload: a markdown document ready to paste into a GitHub
 * issue for an agent session to pick up. */
export function buildSmokeReport(
  done: Readonly<Partial<Record<string, boolean>>>,
  note: Readonly<Partial<Record<string, string>>>,
  context: SmokeReportContext,
): string {
  const stamp = context.isoTimestamp.replace('T', ' ').slice(0, 16);
  const lines: string[] = [
    `## Manual smoke report — ${stamp} UTC`,
    '',
    `- URL: ${context.url}`,
    `- UA: ${context.userAgent}`,
    '- Source: in-chrome smoke checklist',
    '',
    '### Steps',
  ];
  const outstanding: string[] = [];
  for (const step of SMOKE_STEPS) {
    const ok = done[step.id] === true;
    if (!ok) outstanding.push(step.id);
    lines.push(`- [${ok ? 'x' : ' '}] ${step.id} — ${step.title}`);
    const text = note[step.id]?.trim();
    if (text) lines.push(`  - note: ${text}`);
  }
  lines.push(
    '',
    '### Result',
    `${verifiedCount(done)}/${SMOKE_STEPS.length} verified${
      outstanding.length > 0 ? ` · outstanding: ${outstanding.join(', ')}` : ' · all clear'
    }.`,
    '',
    '<!-- paste into a GitHub issue; an agent session picks it up from there -->',
  );
  return lines.join('\n');
}
