# Contributing to BookDrop

Thanks for helping out! Bug reports, fixes, and ideas are all welcome.

## Before you start

- **Bugs:** open an [issue](https://github.com/eitan12345om/book-drop/issues/new/choose) with your e-reader model and the file type you were sending.
- **New features:** please open an issue first so we can agree on the approach before you spend time on it.
- **Security problems:** see [SECURITY.md](SECURITY.md) — don't open a public issue.

## Development setup

You'll need Node.js 26+ and pnpm 12 (see [pnpm installation](https://pnpm.io/installation), or `pnpm self-update` from pnpm 11.10+).

```sh
pnpm install
cp .env.example .env
pnpm dev        # watches SCSS and TypeScript; starts the server on :3001
```

The optional conversion tools (kepubify, kindling, pdfCropMargins) are only needed if you're working on conversions — see the [README](README.md#prerequisites).

## Before opening a pull request

Run the same checks CI runs:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build && pnpm e2e   # end-to-end tests (run `pnpm exec playwright install --with-deps chromium` once first)
```

A pre-commit hook formats staged files with Prettier and oxlint automatically.

The download page (`client/views/download.html` and the scripts it loads, `client/public/download.js` and `theme.js`) runs in old e-reader browsers (as old as Kobo WebKit 538.1), so it must be plain ES5: `var` only (no `let` or `const`), and no arrow functions, template literals, `catch {}` without a binding, classes, destructuring, spread, default parameters, shorthand properties, `?.`, or `??`. The `es5/syntax` lint rule (`oxlint-plugins/es5.js`) flags this in the two script files, `tests/koboSyntax.test.ts` also checks the page's inline scripts, and lint rules that would rewrite those files into newer syntax are turned off for them.

Please keep pull requests focused on one change, and add or update tests when you change behavior. PRs are squash-merged, so don't worry about tidying up your commit history.
