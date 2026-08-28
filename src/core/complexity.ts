import { parseSync } from 'oxc-parser';
import * as ts from 'typescript';

/**
 * The cyclomatic-complexity engine of the crap4ts risk layer (engine decision:
 * wayfinder #54; wiring: #55). Two visitors implement the same counting rule:
 *
 * - `analyzeComplexity` — the primary engine, over `oxc-parser`'s
 *   ESTree-flavored AST (in-process, sub-millisecond per file; lines come
 *   from a local code-unit line index — see unitLineIndexer).
 * - `analyzeComplexityTsc` — the TypeScript-compiler-API oracle, kept as the
 *   zero-dependency fallback. The probe test asserts both engines agree, so
 *   AST drift in either parser surfaces the day it happens.
 *
 * Counting convention (ESLint-classic, pinned by the probe fixtures in
 * `complexity.test.ts` — "cyclomatic complexity" is not one number across
 * tools, and this one is ours):
 *
 * - base 1 per function; +1 for each `if` (an `else if` is an `if`), `for`,
 *   `for-in`, `for-of`, `while`, `do-while`, `switch` case (not `default`),
 *   `catch`, ternary, and each short-circuit operator `&&` `||` `??`
 *   (including the assignment forms `||=` `&&=` `??=`).
 * - deliberately NOT counted: optional chaining (`?.`), labeled
 *   break/continue, and default parameter values — a pinned deviation from
 *   current ESLint docs, recorded so the pin reads as a decision.
 *
 * Decisions are attributed to the innermost enclosing function (arrows,
 * methods, and accessors are functions), so a callback's branching never
 * inflates its host. Names are display-only — the coverage join keys on line
 * ranges, because v8-derived coverage names anonymous functions lossily
 * (research #54): declared name, else the declaration-site hint (the
 * variable/property/method it is bound to), else `(anonymous)`.
 */

export interface FunctionComplexity {
  name: string;
  /** 1-based line of the function node's first line. */
  lineStart: number;
  /** 1-based line of the function node's last line. */
  lineEnd: number;
  cc: number;
}

// ——— shared bits ———

type EstreeNode = Record<string, unknown> & { type: string };

const SHORT_CIRCUIT_OPS = new Set(['&&', '||', '??', '||=', '&&=', '??=']);

function estreeIdentifierName(node: unknown): string | null {
  if (
    node !== null &&
    typeof node === 'object' &&
    (node as { type?: unknown }).type === 'Identifier'
  ) {
    const name = (node as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return null;
}

/** Maps offsets to 1-based lines over a precomputed table of line-start offsets. */
function lineLookup(lineStarts: number[]): (offset: number) => number {
  return (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Line index over UTF-16 code units — the unit both oxc offsets and tsc
 * positions live in. Not bytes: an empirically pinned probe (non-ASCII
 * comments before the function) places oxc's node start at the unit offset
 * of the `function` keyword, which a byte-indexed table would miss by the
 * non-ASCII prefix. The probe keeps this pinned; the tsc oracle needs no
 * table (`getLineAndCharacterOfPosition` is authoritative).
 */
function unitLineIndexer(source: string): (offset: number) => number {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return lineLookup(lineStarts);
}

// ——— primary engine (oxc-parser, ESTree flavor) ———

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const DECISION_TYPES = new Set([
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'CatchClause',
  'ConditionalExpression',
]);

function isEstreeDecision(node: EstreeNode): boolean {
  if (DECISION_TYPES.has(node.type)) return true;
  if (node.type === 'SwitchCase') return node.test !== null && node.test !== undefined;
  return (
    (node.type === 'LogicalExpression' ||
      node.type === 'BinaryExpression' ||
      node.type === 'AssignmentExpression') &&
    typeof node.operator === 'string' &&
    SHORT_CIRCUIT_OPS.has(node.operator)
  );
}

/** A container node lends its variable/property/method name to a direct function child. */
function estreeChildHint(node: EstreeNode): string | null {
  switch (node.type) {
    case 'VariableDeclarator':
      return estreeIdentifierName(node.id);
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition': {
      const keyName = estreeIdentifierName(node.key);
      if (keyName !== null) return keyName;
      const key = node.key;
      if (
        key !== null &&
        typeof key === 'object' &&
        (key as { type?: unknown }).type === 'Literal'
      ) {
        const value = (key as { value?: unknown }).value;
        if (typeof value === 'string' || typeof value === 'number') return String(value);
      }
      return null;
    }
    case 'AssignmentExpression':
      return estreeIdentifierName(node.left);
    default:
      return null;
  }
}

export function analyzeComplexity(source: string, filename: string): FunctionComplexity[] {
  const { program, errors } = parseSync(filename, source);
  const firstError = errors[0];
  if (firstError !== undefined) throw new SyntaxError(`${filename}: ${firstError.message}`);

  const lineOf = unitLineIndexer(source);
  const fns: FunctionComplexity[] = [];
  const counters: number[] = [];

  const bump = (): void => {
    const top = counters.length - 1;
    if (top >= 0) counters[top] = (counters[top] ?? 0) + 1;
  };

  const visit = (node: unknown, hint: string | null): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, hint);
      return;
    }
    if (
      node === null ||
      typeof node !== 'object' ||
      typeof (node as { type?: unknown }).type !== 'string'
    )
      return;
    const n = node as EstreeNode;

    if (isEstreeDecision(n)) bump();

    if (FUNCTION_TYPES.has(n.type)) {
      const start = typeof n.start === 'number' ? n.start : 0;
      const end = typeof n.end === 'number' ? n.end : start;
      const rec: FunctionComplexity = {
        name:
          (n.type === 'FunctionDeclaration' ? estreeIdentifierName(n.id) : null) ??
          hint ??
          '(anonymous)',
        lineStart: lineOf(start),
        lineEnd: lineOf(end),
        cc: 0,
      };
      fns.push(rec);
      counters.push(1); // base 1: a function with no decisions has cc 1
      for (const [key, value] of Object.entries(n)) {
        if (key === 'id') continue; // the name identifier holds no decisions
        visit(value, null);
      }
      rec.cc = counters.pop() ?? 0;
      return;
    }

    const childHint = estreeChildHint(n);
    for (const [key, value] of Object.entries(n)) {
      if (key === 'loc' || key === 'range') continue;
      visit(value, childHint);
    }
  };

  visit(program, null);
  return fns;
}

// ——— oracle engine (TypeScript compiler API, zero extra deps) ———

function tscScriptKind(filename: string): ts.ScriptKind {
  if (filename.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function isTscDecision(node: ts.Node): boolean {
  if (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCaseClause(node) // DefaultClause is a separate kind and stays free
  )
    return true;
  if (ts.isBinaryExpression(node)) {
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
      case ts.SyntaxKind.BarBarEqualsToken:
      case ts.SyntaxKind.QuestionQuestionEqualsToken:
        return true;
      default:
        return false;
    }
  }
  return false;
}

function isTscFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function tscFunctionName(node: ts.FunctionLikeDeclaration, hint: string | null): string {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const name = node.name;
  if (name !== undefined && ts.isIdentifier(name)) return name.text;
  return hint ?? '(anonymous)';
}

function tscChildHint(node: ts.Node): string | null {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
    const name = node.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
      return name.text;
    return null;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.left)
  )
    return node.left.text;
  return null;
}

export function analyzeComplexityTsc(source: string, filename: string): FunctionComplexity[] {
  const sf = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    false,
    tscScriptKind(filename),
  );
  const fns: FunctionComplexity[] = [];
  const counters: number[] = [];

  const bump = (): void => {
    const top = counters.length - 1;
    if (top >= 0) counters[top] = (counters[top] ?? 0) + 1;
  };

  const visit = (node: ts.Node, hint: string | null): void => {
    if (isTscDecision(node)) bump();

    if (isTscFunction(node)) {
      const rec: FunctionComplexity = {
        name: tscFunctionName(node, hint),
        lineStart: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        lineEnd: sf.getLineAndCharacterOfPosition(node.end).line + 1,
        cc: 0,
      };
      fns.push(rec);
      counters.push(1); // base 1: a function with no decisions has cc 1
      node.forEachChild((child) => visit(child, null));
      rec.cc = counters.pop() ?? 0;
      return;
    }

    const childHint = tscChildHint(node);
    node.forEachChild((child) => visit(child, childHint));
  };

  visit(sf, null);
  return fns;
}
