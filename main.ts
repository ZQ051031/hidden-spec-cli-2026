// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), applies its edits to the tree of text files under the
// working directory, and writes every change or none. See SPEC.md for the
// contract this implements. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A file as lines: its line break, its lines, whether it ends with a break. */
interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serialize(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** The tree as the edits leave it. `now` holds what edits changed (null: deleted); the rest is read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** An edit: applied to the tree, or throws Fail. `moves` collects successful (old, new) move pairs. */
type Edit = (tree: Tree, moves: [string, string][]) => void;

/** A line of old text matched against the file, and how it is normalised at a tier. */
function normAt(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return stripTrailing(line);
  return stripBoth(line);
}

/** Every 0-based position where O occurs in lines at one tier (occurrences may overlap). */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const want = o.map((l) => normAt(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normAt(lines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; 0 only when strict) at which O occurs at least once, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrencesAt(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of the replacement text: a context line (written as the file's own line at its index in O) or an added line. */
interface NewLine {
  text: string;
  ctx: number; // index into O when a context line, -1 when added
}

/** The lines N writes for a match of O at position `at`, at the tier it was found at. */
function replacement(o: string[], n: NewLine[], fileLines: string[], at: number, tier: number): string[] {
  if (tier !== 2) {
    return n.map((x) => (x.ctx >= 0 ? fileLines[at + x.ctx]! : x.text));
  }
  const f = leadingWs(fileLines[at]!);
  const p = leadingWs(o[0]!);
  return n.map((x) => {
    if (x.ctx >= 0) return fileLines[at + x.ctx]!;
    const t = x.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}


/** Detect the patch format from its lines, or null when none matches. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const read = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = read(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = read(tree);
      const doc = parseFile(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, serialize(doc));
    };
  }
  return null;
}

/** The JSON edits of a patch (SPEC.md section 9). */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}


/** A line of a unified hunk body: ' ' context, '-' old, '+' new, '\' newline marker. */
interface BodyLine {
  kind: string;
  text: string;
}

/** One hunk: the old start line A (1-based) and its body lines. */
interface Hunk {
  a: number;
  body: BodyLine[];
}

/** One unified section: its paths and flags from the header, and its hunks. */
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const GIT_LINE = /^diff --git a\/(.+) b\/(.+)$/;

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, spaces removed, a/ or b/ removed. */
function dashPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Read the unified sections of a patch (SPEC.md section 6). */
function unifiedSections(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let haveDash = false;

  const startGit = (i: number): void => {
    const m = GIT_LINE.exec(lines[i]!.trimEnd());
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    if (cur !== null) sections.push(cur);
    cur = { oldPath: m[1]!, newPath: m[2]!, newFile: false, deletedFile: false, hunks: [] };
    inHeader = true;
    haveDash = false;
  };
  const startDash = (i: number): void => {
    if (cur !== null) sections.push(cur);
    cur = { oldPath: dashPath(lines[i]!), newPath: dashPath(lines[i + 1]!), newFile: false, deletedFile: false, hunks: [] };
    inHeader = true;
    haveDash = true;
  };
  const readHunk = (i: number): { hunk: Hunk; next: number } => {
    const m = HUNK_HEAD.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const body: BodyLine[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
        j += 1;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
    return { hunk: { a: Number(m[1]), body }, next: j };
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      startGit(i);
      i += 1;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startDash(i);
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!haveDash) {
            cur.oldPath = dashPath(l);
            cur.newPath = dashPath(lines[i + 1]!);
            haveDash = true;
            i += 2;
            continue;
          }
          startDash(i);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        if (!haveDash) cur.newPath = dashPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!haveDash) cur.oldPath = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!haveDash) cur.newPath = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const { hunk, next } = readHunk(i);
        cur.hunks.push(hunk);
        inHeader = false;
        i = next;
        continue;
      }
      i += 1;
      continue;
    }
    // Between hunks.
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startDash(i);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const { hunk, next } = readHunk(i);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    i += 1;
  }
  if (cur !== null) sections.push(cur);
  return sections;
}

/** Whether a \ line follows the hunk's last context or + line. */
function hunkNoBreak(h: Hunk): boolean {
  let last = -1;
  for (let j = 0; j < h.body.length; j++) {
    if (h.body[j]!.kind === ' ' || h.body[j]!.kind === '+') last = j;
  }
  return last >= 0 && h.body[last + 1] !== undefined && h.body[last + 1]!.kind === '\\';
}

/** The old and new lines of a hunk, in body order. */
function hunkLines(h: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Apply a section's hunks to a file's lines, in order. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  const lines = [...doc.lines];
  let finalBreak = doc.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkLines(h);
    const noBreak = hunkNoBreak(h);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...n.map((x) => x.text));
      if (atEnd) finalBreak = !noBreak;
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const rep = replacement(o, n, lines, best, found.tier);
    const runsToEnd = best + o.length === lines.length;
    lines.splice(best, o.length, ...rep);
    if (runsToEnd) finalBreak = !noBreak;
    d += n.length - o.length;
  }
  return { br: doc.br, lines, final: finalBreak };
}

/** One unified section as an edit (SPEC.md section 6). */
function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldPath = sec.oldPath;
  const newPath = sec.newPath;
  const isCreate = oldPath === null || sec.newFile;
  const isDelete = !isCreate && (newPath === null || sec.deletedFile);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  return (tree, moves) => {
    if (isCreate) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastBackslash = false;
      let seenPlus = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          if (h.body[j]!.kind === '+') {
            plus.push(h.body[j]!.text);
            seenPlus = true;
            lastBackslash = h.body[j + 1] !== undefined && h.body[j + 1]!.kind === '\\';
          }
        }
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (seenPlus && !lastBackslash ? '\n' : '');
      tree.now.set(p, text);
      return;
    }
    const p = oldPath ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    if (isDelete) {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const q = newPath ?? '';
    if (isMove && !safe(q)) throw new Fail('unsafe', q);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(q) !== null) throw new Fail('exists', q);
    const doc = parseFile(before);
    const out = applyHunks(doc, sec.hunks, strict, p);
    const text = serialize(out);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(q, text);
      moves.push([p, q]);
    } else {
      tree.now.set(p, text);
    }
  };
}

/** The unified edits of a patch. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((s) => unifiedEdit(s, strict));
}


/** The SEARCH/REPLACE edits of a patch (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => l.trimEnd() === '=======';
  const isReplace = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (!isSearch(lines[i]!)) {
      i += 1;
      continue;
    }
    const s = i;
    let j = s + 1;
    while (j < lines.length && !isSep(lines[j]!) && !isSearch(lines[j]!) && !isReplace(lines[j]!)) j += 1;
    if (j >= lines.length || !isSep(lines[j]!)) throw new Exit2(`error: parse ${s + 1}`);
    const sep = j;
    let k = sep + 1;
    while (k < lines.length && !isReplace(lines[k]!) && !isSearch(lines[k]!)) k += 1;
    if (k >= lines.length || !isReplace(lines[k]!)) throw new Exit2(`error: parse ${s + 1}`);
    const rep = k;
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    let path: string | null = null;
    for (let m = s - 1; m >= prevEnd; m--) {
      const t = lines[m]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseFile(before);
      const found = findTier(doc.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const at = found.pos[0]!;
      const repLines = replacement(oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), doc.lines, at, found.tier);
      doc.lines.splice(at, oldLines.length, ...repLines);
      tree.now.set(p, serialize(doc));
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null: none), whether it is end-of-file, and its old/new lines. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

function isV4aSection(line: string): string | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

function v4aPath(line: string, prefix: string): string {
  return line.slice(prefix.length).trim();
}

/** The V4A edits of a patch. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const kind = isV4aSection(lines[i]!);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = v4aPath(lines[i]!, prefix);
    // Collect the section's lines, up to the next section or *** End Patch.
    let j = i + 1;
    while (j < last && isV4aSection(lines[j]!) === null) j += 1;
    const raw: { text: string; num: number }[] = [];
    for (let m = i + 1; m < j; m++) raw.push({ text: lines[m]!, num: m + 1 });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let at = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        at = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const close = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; at < raw.length; at++) {
        const r = raw[at]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          close();
          cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), eof: false, o: [], n: [] };
        } else if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          close();
        } else if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (cur === null) cur = { anchor: null, eof: false, o: [], n: [] };
          if (t.startsWith(' ')) {
            cur.o.push(t.slice(1));
            cur.n.push({ text: t.slice(1), ctx: cur.o.length - 1 });
          } else if (t.startsWith('-')) {
            cur.o.push(t.slice(1));
          } else if (t.startsWith('+')) {
            cur.n.push({ text: t.slice(1), ctx: -1 });
          } else {
            cur.o.push('');
            cur.n.push({ text: '', ctx: cur.o.length - 1 });
          }
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree, moves) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const doc = parseFile(before);
        const linesNow = [...doc.lines];
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            let found: number | null = null;
            const top = strict ? 0 : 2;
            for (let tier = 0; tier <= top && found === null; tier++) {
              for (let m = cursor; m < linesNow.length; m++) {
                if (normAt(linesNow[m]!, tier) === normAt(ch.anchor!, tier)) {
                  found = m;
                  break;
                }
              }
            }
            if (found === null) throw new Fail('no-match', p);
            cursor = found + 1;
          }
          if (ch.o.length === 0) {
            const pos = ch.eof ? linesNow.length : cursor;
            linesNow.splice(pos, 0, ...ch.n.map((x) => x.text));
            cursor = pos + ch.n.length;
            continue;
          }
          let hit: { tier: number; pos: number } | null = null;
          const top = strict ? 0 : 2;
          for (let tier = 0; tier <= top && hit === null; tier++) {
            const occ = occurrencesAt(linesNow, ch.o, tier);
            for (const pos of occ) {
              if (pos < cursor) continue;
              if (ch.eof && pos + ch.o.length !== linesNow.length) continue;
              hit = { tier, pos };
              break;
            }
          }
          if (hit === null) throw new Fail('no-match', p);
          const rep = replacement(ch.o, ch.n, linesNow, hit.pos, hit.tier);
          linesNow.splice(hit.pos, ch.o.length, ...rep);
          cursor = hit.pos + rep.length;
        }
        const out: FileDoc = { br: doc.br, lines: linesNow, final: doc.final };
        const text = serialize(out);
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, text);
          moves.push([p, mt]);
        } else {
          tree.now.set(p, text);
        }
      });
    }
    i = j;
  }
  return edits;
}


/** The outcome of one run: its exit code and its stdout lines. */
interface Outcome {
  code: number;
  out: string[];
}

function run(args: string[]): Outcome {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: [string, string][] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  const nextOf = new Map<string, string>();
  for (const [o, n] of moves) nextOf.set(o, n);
  for (const [o, n] of moves) {
    let target = n;
    const seen = new Set<string>([o]);
    while (nextOf.has(target) && !seen.has(target)) {
      seen.add(target);
      target = nextOf.get(target)!;
    }
    if (target === o) continue;
    if (covered.has(o) || covered.has(target)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(target) === null && tree.get(target) !== null) {
      rows.push({ key: target, text: `R ${o} -> ${target}` });
      covered.add(o);
      covered.add(target);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (covered.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
