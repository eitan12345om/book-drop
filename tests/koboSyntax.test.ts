import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { es5SyntaxError } from '../oxlint-plugins/es5.js';

// The download page runs on e-reader browsers as old as Kobo WebKit 538.1 (roughly
// Safari 8). One unsupported construct is a SyntaxError that stops the whole script, so
// its scripts must parse as plain ES5. Even `const` is out: old engines only accepted it
// outside strict mode, scoped to the function rather than the block.

const ROOT = path.resolve(import.meta.dirname, '..');
const DOWNLOAD_HTML = path.join(ROOT, 'client', 'views', 'download.html');
const THEME_JS = path.join(ROOT, 'client', 'public', 'theme.js');

function es5SyntaxProblems(fileName: string, source: string): string[] {
  const err = es5SyntaxError(source) as Error | null;
  return err ? [`${fileName}: ${err.message}`] : [];
}

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi;
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i'
  ).exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/** External scripts a page loads, plus its inline scripts padded so line numbers match the HTML. */
function pageScripts(html: string, htmlName: string): { fileName: string; source: string }[] {
  const scripts: { fileName: string; source: string }[] = [];
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const [, attrs, body] = match;
    if (!JS_TYPES.has((attribute(attrs, 'type') ?? '').trim().toLowerCase())) {
      continue;
    }
    const src = attribute(attrs, 'src');
    if (src !== undefined) {
      const file = path.join(ROOT, 'client', 'public', src.replace(/^\//, ''));
      scripts.push({ fileName: path.relative(ROOT, file), source: fs.readFileSync(file, 'utf8') });
    } else {
      const linesBefore = html.slice(0, match.index).split('\n').length - 1;
      scripts.push({ fileName: htmlName, source: '\n'.repeat(linesBefore) + body });
    }
  }
  return scripts;
}

describe('download page ES5 check', () => {
  it('rejects syntax newer than ES5', () => {
    const samples = [
      'const a = 1;',
      'let a = 1;',
      'var f = () => 1;',
      'var s = `x`;',
      'try {} catch {}',
      'class A {}',
      'var [a] = o;',
      'f(...a);',
      'function f(a = 1) {}',
      'for (var x of a) {}',
      'var o = { a };',
      'var o = { [k]: 1 };',
      'var v = o?.a;',
      'var v = a ?? b;',
      'async function f() {}',
      'function* g() {}',
      'var n = 1_000;',
      'var n = 1n;',
      'var n = 0b1;',
      'var r = /a/u;',
      "var s = '\\u{1F600}';",
    ];
    for (const source of samples) {
      assert.strictEqual(es5SyntaxProblems('sample.js', source).length, 1, source);
    }
  });

  it('allows the ES5 syntax the download page relies on', () => {
    const source = [
      'var o = { a: 1, get b() { return 2; } };',
      'try { f(); } catch (_) {}',
      'document.addEventListener("load", function () {});',
    ].join('\n');
    assert.deepStrictEqual(es5SyntaxProblems('sample.js', source), []);
  });

  it('finds every executable script in a page', () => {
    const html = [
      '<SCRIPT>var upper = 1;</SCRIPT>',
      '<script type="application/javascript">var typed = 1;</script >',
      "<script src='theme.js' defer></script>",
      '<script type="application/ld+json">{"not": "js"}</script>',
    ].join('\n');
    const scripts = pageScripts(html, 'page.html');
    assert.deepStrictEqual(
      scripts.map((s) => [s.fileName, s.source.trim()]),
      [
        ['page.html', 'var upper = 1;'],
        ['page.html', 'var typed = 1;'],
        [path.join('client', 'public', 'theme.js'), fs.readFileSync(THEME_JS, 'utf8').trim()],
      ]
    );
    assert.strictEqual(scripts[1].source.split('\n').length, 2);
  });

  it('download page scripts are plain ES5', () => {
    const scripts = pageScripts(
      fs.readFileSync(DOWNLOAD_HTML, 'utf8'),
      path.relative(ROOT, DOWNLOAD_HTML)
    );
    assert.ok(scripts.some((s) => s.fileName.endsWith('download.js')));
    const problems = scripts.flatMap((s) => es5SyntaxProblems(s.fileName, s.source));
    assert.deepStrictEqual(problems, []);
  });
});
