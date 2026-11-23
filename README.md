# mend

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Node.js](https://img.shields.io/badge/Node.js-22-green.svg)](https://nodejs.org/) [![make.fun](https://img.shields.io/badge/make.fun-bounty-blue.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format. It reads a patch in one
of four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool calls as
JSON — finds the lines each edit names, and writes every change or none.

Node 22 and its standard library only. No dependencies, no install step.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is
  absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

An edit's old lines are found in the file at the first of three tiers at
which they occur at least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed;
- tier 2: every line equal once leading and trailing spaces and tabs are
  removed (added lines are re-indented to the file's indent).

A unified hunk takes the occurrence nearest to the line number it names;
a SEARCH/REPLACE block fails as `ambiguous` when its old lines occur more
than once; a V4A chunk takes the first occurrence at or after its cursor.

## Output and exit codes

- Exit 0: the tree is written. One line per changed path (`A`, `D`, `M`,
  or `R <old> -> <new>` for a move), then `ok: <n> files`.
- Exit 1: nothing is written. One `error: <code> <path>` line per failed
  edit, in the patch's order, then `failed: <k> of <n> edits`. The codes
  are `no-match`, `ambiguous`, `missing`, `exists` and `unsafe`.
- Exit 2: nothing is written. Exactly one line: `error: usage`,
  `error: no-patch`, `error: format`, or `error: parse <N>`.

Edits apply in the patch's order to the tree as earlier edits left it. A
failed edit changes nothing and the edits after it still run; when any edit
failed, no file is written. The run is deterministic: the same check gives
the same exit code, stdout and files every time.

## Files

- `main.ts` — the CLI (this is the whole implementation).
- `runner.ts` — the competition's trial runner, kept as issued in the kit.
  When `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.

## Testing

The kit's practice set (100 checks with the house reference's expected
results) is run with the kit's `check.ts` beside a copy of `runner.ts`:

    node check.ts <kit>/program/generator/practice.json

The full trial protocol — the kit's env server plus its scorer — scores the
same 100 checks at 1000 (100 passed: 30 unified, 20 search_replace,
20 v4a, 15 json, 15 cli).
