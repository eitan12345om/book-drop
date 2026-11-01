import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parse, type Node } from 'acorn';

// The download page runs on old Kobo WebKit (538.1, roughly Safari 8). One unsupported
// construct is a SyntaxError that stops the whole script, so these are banned outright.
// `const` is fine there; the rest of ES2015+ syntax is not.

const ROOT = path.resolve(import.meta.dirname, '..');
const DOWNLOAD_HTML = path.join(ROOT, 'client', 'views', 'download.html');

const UNSUPPORTED_OPERATORS = new Set(['??', '**', '??=', '**=', '||=', '&&=']);

// acorn's node types are a union; reading the handful of fields we need loosely is simpler.
type AnyNode = Node & Record<string, unknown>;

function unsupported(node: AnyNode): string | null {
  switch (node.type) {
    case 'VariableDeclaration':
      return node.kind === 'const' || node.kind === 'var' ? null : `\`${String(node.kind)}\``;
    case 'ArrowFunctionExpression':
      return 'arrow function';
    case 'TemplateLiteral':
      return 'template literal';
    case 'CatchClause':
      return node.param ? null : '`catch` without a binding';
    case 'ClassDeclaration':
    case 'ClassExpression':
      return 'class';
    case 'ObjectPattern':
    case 'ArrayPattern':
      return 'destructuring';
    case 'SpreadElement':
    case 'RestElement':
      return 'spread or rest';
    case 'AssignmentPattern':
      return 'default value';
    case 'ForOfStatement':
      return '`for...of`';
    case 'Property':
      if (node.computed) {
        return 'computed property name';
      }
      return node.shorthand || node.method ? 'shorthand property or method' : null;
    case 'ChainExpression':
      return 'optional chaining';
    case 'LogicalExpression':
    case 'BinaryExpression':
    case 'AssignmentExpression':
      return UNSUPPORTED_OPERATORS.has(node.operator as string)
        ? `\`${String(node.operator)}\``
        : null;
    case 'AwaitExpression':
      return '`async`/`await`';
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      if (node.async) {
        return '`async`/`await`';
      }
      return node.generator ? 'generator' : null;
    default:
      return null;
  }
}

function childNodes(node: AnyNode): AnyNode[] {
  return Object.values(node)
    .flat()
    .filter((v): v is AnyNode => typeof v === 'object' && v !== null && 'type' in v);
}

function koboSyntaxProblems(fileName: string, source: string): string[] {
  let program: AnyNode;
  try {
    program = parse(source, { ecmaVersion: 'latest', locations: true }) as AnyNode;
  } catch (err) {
    return [`${fileName}: ${(err as Error).message}`];
  }
  const problems: string[] = [];
  const visit = (node: AnyNode): void => {
    const what = unsupported(node);
    if (what) {
      problems.push(`${fileName}:${node.loc?.start.line}: ${what}`);
    }
    childNodes(node).forEach(visit);
  };
  visit(program);
  return problems;
}

/** External scripts the download page loads, plus its inline scripts padded so line numbers match the HTML. */
function downloadPageScripts(): { fileName: string; source: string }[] {
  const html = fs.readFileSync(DOWNLOAD_HTML, 'utf8');
  const scripts: { fileName: string; source: string }[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const [, attrs, body] = match;
    const src = /\bsrc="([^"]+)"/.exec(attrs)?.[1];
    if (src) {
      const file = path.join(ROOT, 'client', 'public', src);
      scripts.push({ fileName: path.relative(ROOT, file), source: fs.readFileSync(file, 'utf8') });
    } else if (!/\btype="(?!text\/javascript)/.test(attrs)) {
      const linesBefore = html.slice(0, match.index).split('\n').length - 1;
      scripts.push({
        fileName: path.relative(ROOT, DOWNLOAD_HTML),
        source: '\n'.repeat(linesBefore) + body,
      });
    }
  }
  return scripts;
}

describe('Kobo syntax check', () => {
  it('flags syntax old Kobo WebKit cannot parse', () => {
    const samples: [string, string][] = [
      ['let a = 1;', '`let`'],
      ['var f = () => 1;', 'arrow function'],
      ['var s = `x`;', 'template literal'],
      ['try {} catch {}', '`catch` without a binding'],
      ['class A {}', 'class'],
      ['var [a] = o;', 'destructuring'],
      ['f(...a);', 'spread or rest'],
      ['function f(a = 1) {}', 'default value'],
      ['for (var x of a) {}', '`for...of`'],
      ['var o = { a };', 'shorthand property or method'],
      ['var o = { [k]: 1 };', 'computed property name'],
      ['var v = o?.a;', 'optional chaining'],
      ['var v = a ?? b;', '`??`'],
      ['async function f() {}', '`async`/`await`'],
      ['function* g() {}', 'generator'],
    ];
    for (const [source, expected] of samples) {
      assert.deepStrictEqual(koboSyntaxProblems('sample.js', source), [`sample.js:1: ${expected}`]);
    }
  });

  it('allows the ES5 syntax plus `const` the download page relies on', () => {
    const source = [
      'const A = 1;',
      'var o = { a: 1, get b() { return 2; } };',
      'try { f(); } catch (_) {}',
      'document.addEventListener("load", function () {});',
    ].join('\n');
    assert.deepStrictEqual(koboSyntaxProblems('sample.js', source), []);
  });

  it('reports scripts that do not parse at all', () => {
    assert.strictEqual(koboSyntaxProblems('sample.js', 'var = ;').length, 1);
  });

  it('download page scripts only use syntax old Kobo WebKit supports', () => {
    const scripts = downloadPageScripts();
    assert.ok(scripts.some((s) => s.fileName.endsWith('download.js')));
    const problems = scripts.flatMap((s) => koboSyntaxProblems(s.fileName, s.source));
    assert.deepStrictEqual(problems, []);
  });
});
