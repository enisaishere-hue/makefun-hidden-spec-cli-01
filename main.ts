// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It implements all of SPEC.md: the command line, the output and exit codes, safe paths, format detection,
// three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing
// write. It is fully deterministic: no network, no wall clock, no unseeded randomness.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful move edit made, as [old, new] pairs, in the patch's order. */
  readonly moves: [string, string][] = [];
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

type Edit = (tree: Tree) => void;

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
  const exists = (tree: Tree): string => {
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

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

// ---------------------------------------------------------------------------
// SPEC.md section 5: matching lines, and the file line model (section 3).
// ---------------------------------------------------------------------------

/** Spaces and tabs only: the whitespace section 5 trims. */
const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file's text as lines, its line break, and whether it ends with one (section 3). */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** The occurrences of O in the file's lines at the first tier where one occurs. */
interface Occurrences {
  tier: number;
  positions: number[];
}
function findOccurrences(fileLines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): Occurrences | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trimEndST : trimST;
    const want = o.map(norm);
    const positions: number[] = [];
    for (let i = from; i + o.length <= fileLines.length; i++) {
      if (eofOnly && i + o.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (norm(fileLines[i + j]!) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NItem {
  text: string;
  ctx: boolean;
  /** Index within O of the context line; -1 when not a context line. */
  oIdx: number;
}

/** Re-indent one non-context line of N at tier 2 (section 5). */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** N written out at a match at position `at`, found at `tier`. */
function buildN(n: NItem[], fileLines: string[], at: number, tier: number, oFirst: string): string[] {
  const p = leadST(oFirst);
  const f = leadST(fileLines[at]!);
  return n.map((it) => {
    if (it.ctx) return fileLines[at + it.oIdx]!;
    if (tier === 2) return reindent(it.text, p, f);
    return it.text;
  });
}

// ---------------------------------------------------------------------------
// SPEC.md section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  /** The -A start line of the hunk header. */
  a: number;
  /** Context and `-` lines, in body order. */
  o: { text: string; oIdx: number }[];
  /** Context and `+` lines, in body order. */
  n: NItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
  /** A `\` line follows the hunk's last `+` line; null when the hunk has no `+` line. */
  plusNoNl: boolean | null;
}

/** Whether the last body line matching `pred` is followed by a `\` line. */
function lastFollowsBackslash(body: string[], pred: (l: string) => boolean): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    if (pred(body[k]!)) return k + 1 < body.length && body[k + 1]!.startsWith('\\');
  }
  return false;
}

function parseHunkBody(body: string[]): { o: Hunk['o']; n: NItem[] } {
  const o: Hunk['o'] = [];
  const n: NItem[] = [];
  for (const l of body) {
    if (l.startsWith(' ') || l === '') {
      const t = l.startsWith(' ') ? l.slice(1) : '';
      const idx = o.length;
      o.push({ text: t, oIdx: idx });
      n.push({ text: t, ctx: true, oIdx: idx });
    } else if (l.startsWith('-')) {
      o.push({ text: l.slice(1), oIdx: o.length });
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
    }
    // A `\` line is no line of O or N; it only marks the end of the file (section 6).
  }
  return { o, n };
}

interface USection {
  /** Null when the path is /dev/null (no file). */
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

interface RawUSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  inHeader: boolean;
  hunks: Hunk[];
}

function parseDiffGit(line: string): [string, string] | null {
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: RawUSection | null = null;
  const close = (): void => {
    if (cur === null) return;
    const oldPath = cur.pairOld !== undefined ? cur.pairOld : cur.renameFrom !== undefined ? cur.renameFrom : cur.diffOld;
    const newPath = cur.pairNew !== undefined ? cur.pairNew : cur.renameTo !== undefined ? cur.renameTo : cur.diffNew;
    sections.push({ oldPath, newPath, isCreate: cur.isCreate, isDelete: cur.isDelete, hunks: cur.hunks });
    cur = null;
  };
  const fresh = (diffOld: string | null, diffNew: string | null): RawUSection => ({
    diffOld,
    diffNew,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    isCreate: false,
    isDelete: false,
    inHeader: true,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      close();
      cur = fresh(dg[0], dg[1]);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length) {
        const l = lines[j]!;
        // The body ends at a `--- ` line followed by a `+++ ` line (section 6),
        // even though such a line starts with `-`.
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
          body.push(l);
          j++;
        } else break;
      }
      while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
      const { o, n } = parseHunkBody(body);
      cur.hunks.push({
        a: Number(hm[1]),
        o,
        n,
        noNl: lastFollowsBackslash(body, (l) => l.startsWith(' ') || l === '' || l.startsWith('+')),
        plusNoNl: body.some((l) => l.startsWith('+')) ? lastFollowsBackslash(body, (l) => l.startsWith('+')) : null,
      });
      cur.inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('--- ')) {
        const nx = lines[i + 1];
        if (nx !== undefined && nx.startsWith('+++ ')) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(nx);
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length);
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length);
        i++;
        continue;
      }
      if (/^new file mode($| )/.test(line)) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (/^deleted file mode($| )/.test(line)) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nx = lines[i + 1];
      if (nx !== undefined && nx.startsWith('+++ ')) {
        close();
        cur = fresh(null, null);
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(nx);
        i += 2;
        continue;
      }
    }
    i++;
  }
  close();
  return sections;
}

/** A section's hunks applied in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const st = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const oText = h.o.map((x) => x.text);
    if (oText.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, st.lines.length));
      const atEnd = pos === st.lines.length;
      st.lines.splice(pos, 0, ...h.n.map((it) => it.text));
      if (atEnd) st.final = !h.noNl;
      d += h.n.length;
    } else {
      const occ = findOccurrences(st.lines, oText, strict);
      if (occ === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = occ.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of occ.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const at = best;
      const out = buildN(h.n, st.lines, at, occ.tier, oText[0]!);
      const toEnd = at + oText.length === st.lines.length;
      st.lines.splice(at, oText.length, ...out);
      if (toEnd) st.final = !h.noNl;
      d += h.n.length - oText.length;
    }
  }
  return joinFile(st);
}

function unifiedEdits(sections: USection[], strict: boolean): Edit[] {
  return sections.map((sec) => (tree: Tree) => {
    if (sec.oldPath === null && sec.newPath === null) return;
    if (sec.oldPath === null || sec.isCreate) {
      const np = sec.newPath!;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.n) if (!it.ctx) plus.push(it.text);
      let noNl = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const pn = sec.hunks[hi]!.plusNoNl;
        if (pn !== null) {
          noNl = pn;
          break;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : `${plus.join('\n')}${noNl ? '' : '\n'}`);
      return;
    }
    if (sec.newPath === null || sec.isDelete) {
      const op = sec.oldPath!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (sec.oldPath !== sec.newPath) {
      const op = sec.oldPath;
      const np = sec.newPath;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const result = applyHunks(cur, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, result);
      tree.moves.push([op, np]);
      return;
    }
    const p = sec.oldPath;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(cur, sec.hunks, strict, p));
  });
}

// ---------------------------------------------------------------------------
// SPEC.md section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function searchReplaceEdits(blocks: SRBlock[], strict: boolean): Edit[] {
  return blocks.map((b) => (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const st = splitFile(cur);
    const occ = findOccurrences(st.lines, b.oldLines, strict);
    if (occ === null) throw new Fail('no-match', p);
    if (occ.positions.length > 1) throw new Fail('ambiguous', p);
    const at = occ.positions[0]!;
    const nItems: NItem[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const out = buildN(nItems, st.lines, at, occ.tier, b.oldLines[0]!);
    st.lines.splice(at, b.oldLines.length, ...out);
    tree.now.set(p, joinFile(st));
  });
}

// ---------------------------------------------------------------------------
// SPEC.md section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** 1-based line of the section's header line. */
  pathLine: number;
  /** Raw lines after the header, trailing blank lines stripped. */
  lines: { no: number; text: string }[];
}

function parseV4a(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  const flush = (): void => {
    if (cur === null) return;
    while (cur.lines.length > 0 && blank(cur.lines[cur.lines.length - 1]!.text)) cur.lines.pop();
    sections.push(cur);
    cur = null;
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      flush();
      cur = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), pathLine: i + 1, lines: [] };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      flush();
      cur = { kind: 'delete', path: line.slice('*** Delete File: '.length).trim(), pathLine: i + 1, lines: [] };
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      flush();
      cur = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), pathLine: i + 1, lines: [] };
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.lines.push({ no: i + 1, text: line });
  }
  flush();
  return sections;
}

interface VChunk {
  /** Null when the chunk has no anchor. */
  anchor: string | null;
  o: { text: string; oIdx: number }[];
  n: NItem[];
  eof: boolean;
}

function parseUpdateChunks(sec: V4ASection): { moveTo: string | null; chunks: VChunk[] } {
  const raw = sec.lines;
  let idx = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; body: { no: number; text: string }[]; eof: boolean } | null = null;
  const pushChunk = (): void => {
    if (cur === null) return;
    const { o, n } = parseHunkBody(cur.body.map((b) => b.text));
    chunks.push({ anchor: cur.anchor, o, n, eof: cur.eof });
    cur = null;
  };
  for (; idx < raw.length; idx++) {
    const { no, text } = raw[idx]!;
    if (text.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      pushChunk();
      continue;
    }
    if (text.startsWith('@@')) {
      pushChunk();
      cur = { anchor: text.slice(2).trim(), body: [], eof: false };
      continue;
    }
    if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
      if (cur === null) {
        if (chunks.length === 0) cur = { anchor: null, body: [], eof: false };
        else throw new Exit2(`error: parse ${no}`);
      }
      cur.body.push({ no, text });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  pushChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.pathLine}`);
  return { moveTo, chunks };
}

function v4aEdits(sections: V4ASection[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.kind === 'add') {
      for (const l of sec.lines) {
        if (!l.text.startsWith('+') && l.text !== '') throw new Exit2(`error: parse ${l.no}`);
      }
      const fileLines = sec.lines.map((l) => (l.text === '' ? '' : l.text.slice(1)));
      edits.push((tree: Tree) => {
        const p = sec.path;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
      continue;
    }
    if (sec.kind === 'delete') {
      for (const l of sec.lines) {
        if (!blank(l.text)) throw new Exit2(`error: parse ${l.no}`);
      }
      edits.push((tree: Tree) => {
        const p = sec.path;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    const { moveTo, chunks } = parseUpdateChunks(sec);
    edits.push((tree: Tree) => {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const st = splitFile(cur);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          const aOcc = findOccurrences(st.lines, [ch.anchor], strict, cursor);
          if (aOcc === null) throw new Fail('no-match', p);
          cursor = aOcc.positions[0]! + 1;
        }
        const oText = ch.o.map((x) => x.text);
        if (oText.length === 0) {
          const pos = ch.eof ? st.lines.length : cursor;
          const ins = ch.n.map((it) => it.text);
          st.lines.splice(pos, 0, ...ins);
          cursor = pos + ins.length;
        } else {
          const occ = findOccurrences(st.lines, oText, strict, cursor, ch.eof);
          if (occ === null) throw new Fail('no-match', p);
          const at = occ.positions[0]!;
          const out = buildN(ch.n, st.lines, at, occ.tier, oText[0]!);
          st.lines.splice(at, oText.length, ...out);
          cursor = at + out.length;
        }
      }
      const result = joinFile(st);
      if (moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(moveTo, result);
        tree.moves.push([p, moveTo]);
      } else {
        tree.now.set(p, result);
      }
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// SPEC.md sections 1, 2 and 10: the command line, output and atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
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
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(parseSearchReplace(lines), strict);
    else edits = v4aEdits(parseV4a(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Snapshot what each changed path was before anything is written.
  const was = new Map<string, string | null>();
  for (const p of [...tree.now.keys()]) was.set(p, tree.original(p));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const before = was.get(p)!;
      const now = tree.now.get(p)!;
      if (before === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  // One line per changed path, in byte order; a successful move prints one R line
  // for its new path instead of the D and A pair (section 2).
  const rows = new Map<string, { sort: string; line: string }>();
  for (const p of [...tree.now.keys()]) {
    const before = was.get(p)!;
    const now = tree.now.get(p)!;
    if (before === now) continue;
    const k = before === null ? 'A' : now === null ? 'D' : 'M';
    rows.set(p, { sort: p, line: `${k} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const d = rows.get(oldP);
    const a = rows.get(newP);
    if (d !== undefined && a !== undefined && d.line.startsWith('D ') && a.line.startsWith('A ')) {
      rows.delete(oldP);
      rows.delete(newP);
      rows.set(`\u0000${newP}`, { sort: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const out = [...rows.values()]
    .sort((x, y) => Buffer.compare(Buffer.from(x.sort), Buffer.from(y.sort)) || (x.line < y.line ? -1 : x.line > y.line ? 1 : 0))
    .map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
