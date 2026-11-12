/**
 * 事项记忆 files: what a matter's sessions learned, one Markdown file per item in a category folder of the matter's memory folder, each
 * opening with a frontmatter block (`name`, `description`, `by`, `sources`, `verified`, `updated`). Pure: the folder names, reading and
 * checking one file's text, and writing a new file's text. The frontmatter reader is lenient, as people and models write it by hand; a
 * file it cannot read, one over 100 KB and one that looks like it holds a secret stay out of the index, with the reason the page shows.
 */
import { createHash } from 'node:crypto';
import { NOTE_KINDS, type NoteKind } from './remote.js';

/** The category folders, by the note kinds they replace. */
export const CATEGORIES: Readonly<Record<NoteKind, string>> = { rule: '规则', decision: '定下的', answer: '答过的', trap: '坑', todo: '没做完' };
/** The category folders in the order the index lists them. */
export const CATEGORY_ORDER: readonly string[] = NOTE_KINDS.map(kind => CATEGORIES[kind]);
/** The index at the folder's top, and the full list a folded category gets; the Host writes both. */
export const INDEX_FILE = 'MEMORY.md';
export const CATEGORY_INDEX = 'INDEX.md';
/** Bytes: a bigger file stays out of the index; files aim at the target. */
export const FILE_MAX = 100 * 1024;
export const FILE_TARGET = 4 * 1024;
/** Characters of a description, which is the file's line in the index. */
export const DESCRIPTION_MAX = 150;
/** `by` of an entry the user said; only the matter's conversation changes it, on the user's word. */
export const USER_BY = '你说的';
/** `by` of what the Host writes after the sessions stop, and in the daily merge. */
export const CAPTURE_BY = '补记';
export const MERGE_BY = '合并';

/** A file's frontmatter fields (keys lowercased) and its body. */
export interface Frontmatter {
  fields: Record<string, string>;
  sources: string[];
  body: string;
}

const FENCE = /^---\s*$/;
const END = /^(?:---|\.\.\.)\s*$/;
const FIELD = /^([A-Za-z_][\w-]*)\s*[:：]\s*(.*)$/;
const ITEM = /^\s*-\s+(.*)$/;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : value.slice(1, -1);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith('\'') && value.endsWith('\'')) return value.slice(1, -1).replace(/''/g, '\'');
  return value;
}

/** A list written `[a, b]`, `a, b` or as `- a` lines under the key. */
function listOf(raw: string, items: readonly string[] | undefined): string[] {
  if (items?.length) return items.map(item => unquote(item.trim())).filter(Boolean);
  const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return inner.split(/[,，\s]+/).map(item => unquote(item.trim())).filter(Boolean);
}

/**
 * Read a file's frontmatter: a `---` line first (blank lines and a BOM before it are fine), `key: value` lines, and a closing `---` or
 * `...`. Values may be quoted, continue on indented lines, or be `- item` lines under an empty key; lines that are none of these are
 * skipped, and keys are matched without case.
 * @returns the fields and the body after the block, or undefined when the text does not open with a closed block.
 */
export function parseFrontmatter(text: string): Frontmatter | undefined {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start += 1;
  if (start >= lines.length || !FENCE.test(lines[start]!)) return undefined;
  let end = start + 1;
  while (end < lines.length && !END.test(lines[end]!)) end += 1;
  if (end >= lines.length) return undefined;
  const raw: Record<string, string> = {};
  const items: Record<string, string[]> = {};
  let current: string | undefined;
  for (const line of lines.slice(start + 1, end)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const item = ITEM.exec(line);
    if (item && current !== undefined && (raw[current] === '' || items[current])) {
      (items[current] ??= []).push(item[1]!);
      continue;
    }
    if (/^\s/.test(line) && current !== undefined) {
      raw[current] = `${raw[current]} ${line.trim()}`.trim();
      continue;
    }
    const field = FIELD.exec(line);
    if (!field) continue;
    current = field[1]!.toLowerCase();
    const value = field[2]!.trim();
    raw[current] = /^[|>][+-]?$/.test(value) ? '' : value;
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    fields[key] = value === '' && items[key] ? items[key].map(entry => unquote(entry.trim())).join('、') : unquote(value);
  }
  return { fields, sources: listOf(raw.sources ?? '', items.sources), body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

/** Keys and tokens people paste by mistake: private keys, the common API key and token prefixes, JWTs, and `key = long-random` lines. */
const SECRETS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\b["']?\s*[:=]\s*["']?(?=[A-Za-z0-9_\-/+=]*\d)(?=[A-Za-z0-9_\-/+=]*[A-Za-z])[A-Za-z0-9_\-/+=]{20,}/i,
];

/** The text holds something that looks like a key, a token or a private key. */
export function looksSecret(text: string): boolean {
  return SECRETS.some(pattern => pattern.test(text));
}

/** A short hash of a file's whole text: what a pass saw, checked again before it writes. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** `verified` says it was checked: not empty, and not 否, 没, 未, 不, 待, 无, no or false. */
export function isVerified(value: string): boolean {
  const text = value.trim();
  return text !== '' && !/^(?:否|没|未|不|待|无|no\b|false\b|unverified\b)/i.test(text);
}

/** `by` marks an entry the user said. */
export const isUserBy = (by: string): boolean => by.trim().startsWith(USER_BY);

/** One file that made it into the index. */
export interface MemoryEntry {
  /** Relative to the memory folder, with `/`: `规则/差距报告格式.md`. */
  path: string;
  category: string;
  name: string;
  /** Whitespace collapsed, as written; the index clips it. */
  description: string;
  by: string;
  sources: string[];
  /** As written; empty when missing. */
  verified: string;
  /** Epoch ms of `updated`, when it reads as a date. */
  updated?: number;
  mtime: number;
  /** Bytes. */
  size: number;
  hash: string;
  userOwned: boolean;
  isVerified: boolean;
  /** Soft: over the 4 KB target, a description over 150 characters. */
  warnings: string[];
}

/** A file left out of the index, with why. */
export interface FlaggedFile {
  path: string;
  reason: string;
}

const collapse = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

/**
 * The category a relative path files under: `<category>/<name>.md`, one level down, not hidden and not a category's INDEX.md.
 * @returns the category, or undefined for any other path.
 */
export function categoryOf(path: string): string | undefined {
  const parts = path.split('/');
  if (parts.length !== 2) return undefined;
  const [category, file] = parts as [string, string];
  if (!CATEGORY_ORDER.includes(category) || !file.toLowerCase().endsWith('.md') || file.length <= 3 || file.startsWith('.')) return undefined;
  if (file.toUpperCase() === CATEGORY_INDEX.toUpperCase()) return undefined;
  return category;
}

/**
 * Check one file of a category folder.
 * @param path - relative to the memory folder.
 * @param text - its whole text; not read for a file over {@link FILE_MAX}.
 * @returns the entry for the index, or why the file stays out of it.
 */
export function checkMemoryFile(path: string, text: string, info: { size: number; mtime: number }): { entry: MemoryEntry } | { flagged: FlaggedFile } {
  const category = categoryOf(path);
  if (!category) return { flagged: { path, reason: '不在类别目录里' } };
  if (info.size > FILE_MAX) return { flagged: { path, reason: '超过 100 KB' } };
  if (looksSecret(text)) return { flagged: { path, reason: '内容像密钥' } };
  const parsed = parseFrontmatter(text);
  if (!parsed) return { flagged: { path, reason: '开头格式不对' } };
  const name = collapse(parsed.fields.name);
  const description = collapse(parsed.fields.description);
  if (!name) return { flagged: { path, reason: '开头缺 name' } };
  if (!description) return { flagged: { path, reason: '开头缺 description' } };
  const by = collapse(parsed.fields.by);
  const verified = collapse(parsed.fields.verified);
  const updated = Date.parse(collapse(parsed.fields.updated));
  const warnings = [
    ...(info.size > FILE_TARGET ? ['超过 4 KB'] : []),
    ...([...description].length > DESCRIPTION_MAX ? [`描述超过 ${DESCRIPTION_MAX} 字`] : []),
  ];
  return {
    entry: {
      path, category, name, description, by, sources: parsed.sources, verified, ...(Number.isFinite(updated) ? { updated } : {}),
      mtime: info.mtime, size: info.size, hash: contentHash(text), userOwned: isUserBy(by), isVerified: isVerified(verified), warnings,
    },
  };
}

/** A frontmatter value on one line, quoted when it would read back differently here or in a YAML reader. */
function scalar(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return /^["'[\]{}>|#\-*&!%@`]/.test(line) || /: | #/.test(line) ? JSON.stringify(line) : line;
}

/** What a new file says. */
export interface MemoryFileInput {
  name: string;
  description: string;
  by: string;
  sources: readonly string[];
  verified: string;
  /** `YYYY-MM-DD`. */
  updated: string;
  body: string;
}

/** A file's text: the frontmatter block, then the body. */
export function renderMemoryFile(input: MemoryFileInput): string {
  return [
    '---',
    `name: ${scalar(input.name)}`,
    `description: ${scalar(input.description)}`,
    `by: ${scalar(input.by)}`,
    `sources: [${input.sources.map(source => scalar(source)).join(', ')}]`,
    `verified: ${scalar(input.verified)}`,
    `updated: ${input.updated}`,
    '---',
    input.body.trim(),
    '',
  ].join('\n');
}

/**
 * Set frontmatter fields of a file's text: each given key's line is replaced, or added before the closing line.
 * @returns the new text, or undefined when the text has no frontmatter block.
 */
export function setFields(text: string, values: Readonly<Record<string, string>>): string | undefined {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start += 1;
  if (start >= lines.length || !FENCE.test(lines[start]!)) return undefined;
  let end = start + 1;
  while (end < lines.length && !END.test(lines[end]!)) end += 1;
  if (end >= lines.length) return undefined;
  const head = lines.slice(start + 1, end);
  for (const [key, value] of Object.entries(values)) {
    const at = head.findIndex(line => FIELD.exec(line)?.[1]?.toLowerCase() === key);
    const line = `${key}: ${scalar(value)}`;
    if (at < 0) {
      head.push(line);
      continue;
    }
    head[at] = line;
    // Lines that continued the old value go with it.
    while (at + 1 < head.length && (/^\s/.test(head[at + 1]!) || ITEM.test(head[at + 1]!))) head.splice(at + 1, 1);
  }
  return [...lines.slice(0, start + 1), ...head, ...lines.slice(end)].join('\n');
}

/**
 * A short file name from a line of text: its first sentence without characters file names cannot hold, at most `max` characters; a
 * longer sentence ends at its last comma within them, when that leaves a name of some length.
 */
export function shortName(text: string, max = 20): string {
  const first = text.split(/[。！？!?；;\n]/).find(part => part.trim() !== '') ?? '';
  // Quotes, brackets and backticks make paths awkward to type in a shell; they go with the characters file names cannot hold.
  const cleaned = first.replace(/[\\/:*?"<>|`'“”‘’()（）[\]【】「」『』《》\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const characters = [...cleaned];
  let cut = characters.slice(0, max);
  if (characters.length > max) {
    const comma = cut.findLastIndex(character => character === '，' || character === ',' || character === '、');
    if (comma >= 4) cut = cut.slice(0, comma);
    // A cut inside a Latin word or number drops that word's piece.
    else if (/[A-Za-z0-9]/.test(cut.at(-1) ?? '') && /[A-Za-z0-9]/.test(characters[cut.length] ?? '')) {
      const start = cut.findLastIndex(character => !/[A-Za-z0-9._-]/.test(character));
      if (start >= 4) cut = cut.slice(0, start);
    }
  }
  const name = cut.join('').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  return name || '记忆';
}

/**
 * A path in the category that no file takes yet, compared without case (macOS folders ignore it): `<category>/<name>.md`, else
 * `<name> 2.md` and on.
 */
export function freePath(category: string, name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(path => path.toLowerCase()));
  const reserved = name.toUpperCase() === 'INDEX' || name.toUpperCase() === 'MEMORY';
  let candidate = reserved ? `${category}/${name} 2.md` : `${category}/${name}.md`;
  for (let n = reserved ? 3 : 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${category}/${name} ${n}.md`;
  return candidate;
}

/** Characters the index description keeps. */
export const clipDescription = (description: string): string => {
  const characters = [...collapse(description)];
  return characters.length > DESCRIPTION_MAX ? `${characters.slice(0, DESCRIPTION_MAX - 1).join('')}…` : characters.join('');
};
