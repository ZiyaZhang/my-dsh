/**
 * MEMORY.md, the index of a matter's memory: the Host writes it from each file's frontmatter, never a model, so sessions writing memory
 * at the same time never contend for one file. Grouped by category; in a group the user's entries first, then the newest. Each line is
 * `- [name](path) — description`, with ` · 你说的` or ` · 没核实` after it. Over 200 lines or 16 KB, the largest group folds: it keeps
 * its first entries and points at its own INDEX.md, which lists all of them; this repeats until the index fits. Pure.
 */
import { CATEGORY_INDEX, CATEGORY_ORDER, USER_BY, clipDescription } from './memory-files.js';

export const INDEX_LINES_MAX = 200;
export const INDEX_BYTES_MAX = 16 * 1024;
/** At this share of either cap the index counts as near it, and the next merge brings it back under {@link COMPACT_TO}. */
export const NEAR_CAP = 0.8;
export const COMPACT_TO = 0.7;
/** The second line of every generated index. */
export const GENERATED_NOTE = '<!-- my dsh 按各文件开头生成，改记忆请改那些文件 -->';

/** What the index reads of one file. */
export interface IndexItem {
  path: string;
  category: string;
  name: string;
  description: string;
  userOwned: boolean;
  isVerified: boolean;
  /** Epoch ms of `updated`; the file's mtime stands in when it is missing. */
  updated?: number;
  mtime: number;
}

export interface MemoryIndex {
  /** MEMORY.md. */
  text: string;
  /** INDEX.md of each folded category, by category. */
  categoryIndexes: Record<string, string>;
  /** Every item in index order, folded ones included. */
  order: IndexItem[];
  /** How many entries each folded category leaves out of MEMORY.md. */
  folded: Record<string, number>;
  /** Lines and bytes of the index with nothing folded, which the caps and the near-cap mark are measured on. */
  lines: number;
  bytes: number;
  nearCap: boolean;
}

const bytesOf = (text: string) => Buffer.byteLength(text, 'utf8');

/** The user's entries first, then the newest `updated` (else mtime), then the newest mtime, then by path. */
function byIndexOrder(a: IndexItem, b: IndexItem): number {
  if (a.userOwned !== b.userOwned) return a.userOwned ? -1 : 1;
  return (b.updated ?? b.mtime) - (a.updated ?? a.mtime) || b.mtime - a.mtime || a.path.localeCompare(b.path);
}

const linkText = (name: string) => name.replace(/([\\[\]])/g, '\\$1');
const linkTarget = (path: string) => (/[\s()<>]/.test(path) ? `<${path.replace(/[<>]/g, '')}>` : path);

/** One line of an index; `base` is the folder the index sits in, which the link is relative to. */
export function indexLine(item: IndexItem, base = ''): string {
  const target = base && item.path.startsWith(`${base}/`) ? item.path.slice(base.length + 1) : item.path;
  const suffix = item.userOwned ? ` · ${USER_BY}` : item.isVerified ? '' : ' · 没核实';
  const description = clipDescription(item.description);
  // A name that is only the start of its description (a migrated note's, with quotes and brackets dropped) would say the same thing
  // twice: the description is the link.
  const bare = (text: string) => text.replace(/[\s`'"“”‘’()（）[\]【】「」『』《》…]/g, '');
  if (bare(description).startsWith(bare(item.name))) return `- [${linkText(description)}](${linkTarget(target)})${suffix}`;
  return `- [${linkText(item.name)}](${linkTarget(target)}) — ${description}${suffix}`;
}

/** A group's fold line. */
const foldLine = (category: string, hidden: number) => `- 还有 ${hidden} 条，见 ${category}/${CATEGORY_INDEX}`;

/**
 * Build MEMORY.md and the folded categories' INDEX.md.
 * @param caps - lines and bytes MEMORY.md must stay within.
 */
export function buildIndex(matterName: string, items: readonly IndexItem[], caps = { lines: INDEX_LINES_MAX, bytes: INDEX_BYTES_MAX }): MemoryIndex {
  const header = [`# ${matterName} · 记忆索引`, GENERATED_NOTE];
  const groups = CATEGORY_ORDER.flatMap((category) => {
    const members = items.filter(item => item.category === category).sort(byIndexOrder);
    if (members.length === 0) return [];
    const lines = members.map(item => indexLine(item));
    // prefix[k]: bytes of the first k lines with their newlines.
    const prefix = [0];
    for (const line of lines) prefix.push(prefix.at(-1)! + bytesOf(line) + 1);
    return [{ category, members, lines, prefix, heading: `## ${category} ${members.length}` }];
  });
  const shown = groups.map(group => group.members.length);
  const headerBytes = header.reduce((sum, line) => sum + bytesOf(line) + 1, 0);
  const measure = () => {
    let lines = header.length;
    let bytes = headerBytes;
    groups.forEach((group, index) => {
      const hidden = group.members.length - shown[index]!;
      // A blank line, the heading, the shown lines and the fold line.
      lines += 2 + shown[index]! + (hidden > 0 ? 1 : 0);
      bytes += 1 + bytesOf(group.heading) + 1 + group.prefix[shown[index]!]! + (hidden > 0 ? bytesOf(foldLine(group.category, hidden)) + 1 : 0);
    });
    if (groups.length === 0) { lines += 2; bytes += 1 + bytesOf('还没有记忆。') + 1; }
    return { lines, bytes };
  };
  const full = measure();
  for (let size = full; size.lines > caps.lines || size.bytes > caps.bytes; size = measure()) {
    let pick = -1;
    groups.forEach((group, index) => {
      if (shown[index]! === 0) return;
      if (pick < 0 || shown[index]! > shown[pick]! || (shown[index]! === shown[pick]! && group.prefix[shown[index]!]! > groups[pick]!.prefix[shown[pick]!]!)) pick = index;
    });
    if (pick < 0) break;
    shown[pick] = shown[pick]! - 1;
  }
  const body: string[] = [];
  const folded: Record<string, number> = {};
  const categoryIndexes: Record<string, string> = {};
  groups.forEach((group, index) => {
    const hidden = group.members.length - shown[index]!;
    body.push('', group.heading, ...group.lines.slice(0, shown[index]!));
    if (hidden === 0) return;
    body.push(foldLine(group.category, hidden));
    folded[group.category] = hidden;
    categoryIndexes[group.category] = [
      `# ${matterName} · ${group.category} · 全部 ${group.members.length} 条`, GENERATED_NOTE, '',
      ...group.members.map(item => indexLine(item, group.category)), '',
    ].join('\n');
  });
  if (groups.length === 0) body.push('', '还没有记忆。');
  return {
    text: `${[...header, ...body].join('\n')}\n`,
    categoryIndexes,
    order: groups.flatMap(group => group.members),
    folded,
    lines: full.lines,
    bytes: full.bytes,
    nearCap: full.lines >= caps.lines * NEAR_CAP || full.bytes >= caps.bytes * NEAR_CAP,
  };
}
