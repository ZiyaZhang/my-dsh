/**
 * A matter's context: what a pasted link is, what a checked path is called, how a source reads, and the bounds on instructions. No
 * Node imports, so the client bundle uses the same rules when it shows a source before saving.
 */
import { RequestError, type MatterSource, type SourceKind } from './remote.js';

export const INSTRUCTIONS_MAX = 2_000;
export const SOURCES_MAX = 30;

/** Feishu and Lark hosts, and the paths their documents live under. */
const DOC_HOST = /(^|\.)(feishu\.cn|feishu\.net|larksuite\.com|larksuite\.cn|larkoffice\.com)$/i;
const DOC_PATH = /^\/(docx|docs|doc|wiki|sheets|sheet|base|mindnotes|slides|file|drive)\//i;
const PULL_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;

/** A pasted link: a GitHub pull request, a Feishu or Lark document, or any other web link. */
export function classifyUrl(raw: string): MatterSource {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RequestError('链接要以 http:// 或 https:// 开头');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RequestError('链接要以 http:// 或 https:// 开头');
  const host = url.hostname.toLowerCase();
  const pull = PULL_PATH.exec(url.pathname);
  if ((host === 'github.com' || host === 'www.github.com') && pull) {
    const [, owner, repo, number] = pull;
    return { kind: 'pr', value: `https://github.com/${owner}/${repo}/pull/${number}`, title: `${owner}/${repo}#${number}` };
  }
  if (DOC_HOST.test(host) && DOC_PATH.test(url.pathname)) return { kind: 'doc', value: url.href };
  return { kind: 'link', value: url.href };
}

/** A path the Host checked, named by its last part. */
export function pathSource(path: string, kind: Extract<SourceKind, 'folder' | 'file'>): MatterSource {
  const value = path.length > 1 ? path.replace(/[\\/]+$/, '') : path;
  const title = value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
  return { kind, value, title };
}

/** How a source reads on a chip: its title, or the host and path of its link. */
export function sourceLabel(source: MatterSource): string {
  if (source.title) return source.title;
  try {
    const url = new URL(source.value);
    return `${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return source.value;
  }
}

/** Trimmed instructions, or undefined when there are none. */
export function matterInstructions(raw: string): string | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  if ([...text].length > INSTRUCTIONS_MAX) throw new RequestError(`指令最多 ${INSTRUCTIONS_MAX} 个字`);
  return text;
}
