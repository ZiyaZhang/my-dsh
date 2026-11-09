/**
 * The board index my dsh reads: matters, sessions and workspaces, and the links between matters and sessions with how each was made.
 * `board_index` returns it whole; each model step gets a compact text of it as context. Pure, so the content and the wording can be
 * tested with a fixed clock and time zone. States are what this DSH process has seen.
 */
import type { LinkSource, Matter, MatterSource, SessionState, WaitKind } from './remote.js';
import type { SessionView } from './sessions.js';
import { dayKey, displayTitle } from './snapshot.js';

export interface IndexWorkspace {
  id: string;
  title: string;
  path: string;
}

/** A workspace with its sessions, as the workspace registry lists it. */
export interface WorkspaceRecord extends IndexWorkspace {
  sessionIds: readonly string[];
}

export interface IndexSession {
  id: string;
  title: string;
  state: SessionState;
  wait?: WaitKind;
  /** ISO time of its latest prompt, turn start or turn end. */
  lastActivity: string;
  workspaceId?: string;
  /** Archived in DSH. */
  archived?: true;
}

export interface IndexMatter {
  id: string;
  name: string;
  goal: string;
  aliases: string[];
  archived: boolean;
  /** Its main workspace, when it has one that still exists. */
  workspaceId?: string;
  /** Folders, files, PRs, documents and links the user attached to it. */
  sources: MatterSource[];
  /** The user's standing requests for it. */
  instructions?: string;
  /** `#1234`, as far as the plugin knows them: from the name, the goal, session titles and what my dsh sent. */
  prs: string[];
  /** Links and document paths from the same places. */
  docs: string[];
  /** ISO time of its newest session activity, or its creation. */
  lastActivity: string;
}

export interface IndexLink {
  matterId: string;
  sessionId: string;
  by: LinkSource;
  at: string;
  why?: string;
}

export interface BoardIndex {
  /** ISO time the index was read. */
  at: string;
  /** In-progress matters by newest activity, then archived ones. */
  matters: IndexMatter[];
  /** Sessions in matters and loose sessions active in the last {@link RECENT_DAYS} days, newest first. */
  sessions: IndexSession[];
  /** Only the workspaces those sessions belong to and the matters' main workspaces, in the registry's order. */
  workspaces: IndexWorkspace[];
  links: IndexLink[];
}

export interface IndexInput {
  matters: readonly Matter[];
  sessions: readonly SessionView[];
  workspaces: readonly WorkspaceRecord[];
  /** Sessions archived in DSH. */
  archived: ReadonlySet<string>;
  /** Sessions the index never shows: my dsh's own. */
  hidden: ReadonlySet<string>;
  /** What my dsh sent to each session. */
  sent: ReadonlyMap<string, readonly string[]>;
  now: number;
}

export const RECENT_DAYS = 14;
export const RECENT_MAX = 40;

const iso = (ms: number) => new Date(ms).toISOString();
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

/** URLs end at whitespace, quotes, brackets and Chinese punctuation. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`，。；：、！？）)」』》\]]+/g;
const PULL_URL = /\/pull\/(\d+)/;
const PR_PATTERN = /#(\d{2,7})\b/g;
const DOC_PATTERN = /(?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|markdown|txt|pdf|docx?|xlsx?|pptx?|csv|html?)\b/g;

/** PR numbers and documents named in some texts, each once, in the order they first appear. */
export function extractRefs(texts: readonly string[]): { prs: string[]; docs: string[] } {
  const prs: string[] = [];
  const docs: string[] = [];
  for (const text of texts) {
    let rest = text;
    for (const [url] of text.matchAll(URL_PATTERN)) {
      const pull = PULL_URL.exec(url);
      if (pull) prs.push(`#${pull[1]}`);
      else docs.push(url);
      rest = rest.replace(url, ' ');
    }
    for (const [, number] of rest.matchAll(PR_PATTERN)) prs.push(`#${number}`);
    for (const [path] of rest.matchAll(DOC_PATTERN)) docs.push(path);
  }
  return { prs: unique(prs), docs: unique(docs) };
}

export function buildBoardIndex(input: IndexInput): BoardIndex {
  const views = new Map(input.sessions.filter(view => !input.hidden.has(view.id)).map(view => [view.id, view]));
  const workspaceOf = new Map<string, WorkspaceRecord>();
  for (const workspace of input.workspaces) for (const id of workspace.sessionIds) if (!workspaceOf.has(id)) workspaceOf.set(id, workspace);
  const existing = new Set(input.workspaces.map(workspace => workspace.id));

  const included = new Map<string, SessionView>();
  const links: IndexLink[] = [];
  const matters: IndexMatter[] = input.matters.map((matter) => {
    const known = matter.sessions.filter(link => views.has(link.sessionId));
    for (const link of known) {
      included.set(link.sessionId, views.get(link.sessionId)!);
      links.push({ matterId: matter.id, sessionId: link.sessionId, by: link.by, at: link.at, ...(link.why ? { why: link.why } : {}) });
    }
    const titles = known.map(link => views.get(link.sessionId)!.title ?? '');
    const sent = known.flatMap(link => input.sent.get(link.sessionId) ?? []);
    const newest = Math.max(...known.map(link => views.get(link.sessionId)!.lastActivity));
    return {
      id: matter.id, name: matter.name, goal: matter.goal, aliases: [...matter.aliases], archived: matter.archivedAt !== undefined,
      ...(matter.workspaceId && existing.has(matter.workspaceId) ? { workspaceId: matter.workspaceId } : {}),
      sources: matter.sources.map(source => ({ ...source })), ...(matter.instructions ? { instructions: matter.instructions } : {}),
      ...extractRefs([matter.name, matter.goal, ...titles, ...sent]),
      lastActivity: iso(known.length ? newest : Date.parse(matter.createdAt)),
    };
  });
  const order = (a: IndexMatter, b: IndexMatter) => Number(a.archived) - Number(b.archived) || Date.parse(b.lastActivity) - Date.parse(a.lastActivity) || a.id.localeCompare(b.id);
  matters.sort(order);

  const since = input.now - RECENT_DAYS * 86_400_000;
  const loose = [...views.values()]
    .filter(view => !included.has(view.id) && !view.blank && !view.subagent && !input.archived.has(view.id) && view.lastActivity >= since)
    .sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id))
    .slice(0, RECENT_MAX);
  for (const view of loose) included.set(view.id, view);

  const sessions: IndexSession[] = [...included.values()]
    .sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id))
    .map((view) => {
      const workspace = workspaceOf.get(view.id);
      return {
        id: view.id, title: displayTitle(view), state: view.state, ...(view.wait ? { wait: view.wait } : {}), lastActivity: iso(view.lastActivity),
        ...(workspace ? { workspaceId: workspace.id } : {}), ...(input.archived.has(view.id) ? { archived: true as const } : {}),
      };
    });
  const used = new Set([
    ...sessions.flatMap(session => session.workspaceId ? [session.workspaceId] : []),
    ...matters.flatMap(matter => matter.workspaceId ? [matter.workspaceId] : []),
  ]);
  const workspaces = input.workspaces.filter(workspace => used.has(workspace.id)).map(({ id, title, path }) => ({ id, title, path }));
  return { at: iso(input.now), matters, sessions, workspaces, links };
}

/** Sessions of one matter listed in the per-turn context; the rest are a count. */
export const CONTEXT_SESSIONS = 6;
/** Loose sessions listed in the per-turn context. */
export const CONTEXT_LOOSE = 12;

/** Instructions longer than this are cut in the per-turn context; board_index has them whole. */
export const CONTEXT_INSTRUCTIONS = 200;

const STATE: Record<SessionState, string> = { waiting: '在等你', running: '在跑', failed: '上一轮失败', idle: '空闲' };
const KIND: Record<MatterSource['kind'], string> = { folder: '文件夹', file: '文件', pr: 'PR', doc: '文档', link: '链接' };

/** A source in the context: paths and links in full, a PR by its name. */
const sourceText = (source: MatterSource) => `${KIND[source.kind]} ${source.kind === 'pr' && source.title ? source.title : source.value}`;

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const characters = [...flat];
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : flat;
}
const WAIT: Record<WaitKind, string> = { question: '在等你回答', approval: '在等你批准' };
const BY: Record<LinkSource, string> = { manual: '', mydsh: 'my dsh 开的', origin: '按来头归的', model: '模型归的' };

/** `HH:mm` on the same local day, `M月D日 HH:mm` this year, `YYYY年M月D日` before. */
export function stamp(ms: number, now: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms).map(part => [part.type, part.value]));
  const clock = `${parts.hour}:${parts.minute}`;
  if (dayKey(ms, timeZone) === dayKey(now, timeZone)) return clock;
  // The en-CA parts can come zero-padded; dates are written 11月8日.
  const [month, day] = [Number(parts.month), Number(parts.day)];
  if (dayKey(ms, timeZone).slice(0, 4) === dayKey(now, timeZone).slice(0, 4)) return `${month}月${day}日 ${clock}`;
  return `${parts.year}年${month}月${day}日`;
}

/**
 * The index as the compact text each model step reads. Times are absolute, so the text changes only when the board does.
 * @param clock - the time to compare days against and the zone to write times in.
 */
export function indexContext(index: BoardIndex, clock: { now: number; timeZone: string }): string {
  const sessions = new Map(index.sessions.map(session => [session.id, session]));
  const workspaces = new Map(index.workspaces.map(workspace => [workspace.id, workspace.title]));
  const sessionLine = (session: IndexSession, link?: IndexLink, withWorkspace = false) => {
    const state = session.archived ? '已归档' : session.state === 'waiting' && session.wait ? WAIT[session.wait] : STATE[session.state];
    const parts = [`- ${session.title} id=${session.id} ${state} ${stamp(Date.parse(session.lastActivity), clock.now, clock.timeZone)}`];
    if (link && BY[link.by]) parts.push(BY[link.by]);
    if (withWorkspace && session.workspaceId) parts.push(`工作区：${workspaces.get(session.workspaceId)}`);
    return parts.join(' ');
  };

  const lines = ['看板索引。状态是这个 DSH 进程看到的；别的 DSH 进程里在跑的会话，这里显示空闲。', ''];
  const active = index.matters.filter(matter => !matter.archived);
  const archived = index.matters.filter(matter => matter.archived);
  if (index.matters.length === 0) lines.push('还没有事项。');
  for (const matter of active) {
    const own = index.links.filter(link => link.matterId === matter.id)
      .map(link => ({ link, session: sessions.get(link.sessionId)! }))
      .sort((a, b) => Date.parse(b.session.lastActivity) - Date.parse(a.session.lastActivity));
    const used = unique(own.flatMap(({ session }) => session.workspaceId ? [workspaces.get(session.workspaceId)!] : []));
    const head = [`事项「${matter.name}」 id=${matter.id}`];
    if (matter.goal) head.push(`目标：${matter.goal}`);
    if (matter.aliases.length) head.push(`别名：${matter.aliases.join('、')}`);
    if (matter.prs.length) head.push(`PR：${matter.prs.join('、')}`);
    if (matter.docs.length) head.push(`文档：${matter.docs.join('、')}`);
    if (matter.workspaceId) head.push(`主工作区：${workspaces.get(matter.workspaceId)}`);
    else if (used.length) head.push(`工作区：${used.join('、')}`);
    lines.push(head.join(' '));
    if (matter.sources.length) lines.push(`来源：${matter.sources.map(sourceText).join('；')}`);
    if (matter.instructions) lines.push(`指令：${cut(matter.instructions, CONTEXT_INSTRUCTIONS)}`);
    if (own.length === 0) lines.push('- 还没有会话');
    for (const { link, session } of own.slice(0, CONTEXT_SESSIONS)) lines.push(sessionLine(session, link));
    if (own.length > CONTEXT_SESSIONS) lines.push(`- 还有 ${own.length - CONTEXT_SESSIONS} 条，用 board_index 看全部`);
  }
  if (archived.length) lines.push(`已归档的事项：${archived.map(matter => `「${matter.name}」 id=${matter.id}`).join('；')}`);

  const linked = new Set(index.links.map(link => link.sessionId));
  const loose = index.sessions.filter(session => !linked.has(session.id));
  if (loose.length) {
    lines.push('', '不在事项里的会话（最近 14 天）：');
    for (const session of loose.slice(0, CONTEXT_LOOSE)) lines.push(sessionLine(session, undefined, true));
    if (loose.length > CONTEXT_LOOSE) lines.push(`- 还有 ${loose.length - CONTEXT_LOOSE} 条，用 board_index 看全部`);
  }
  return lines.join('\n');
}

/** The workspace of the matter's most recent session that belongs to one. */
function sessionWorkspace(matter: Matter, index: BoardIndex): IndexWorkspace | undefined {
  const sessions = new Map(index.sessions.map(session => [session.id, session]));
  const workspaces = new Map(index.workspaces.map(workspace => [workspace.id, workspace]));
  const newest = matter.sessions
    .flatMap(link => { const session = sessions.get(link.sessionId); return session ? [session] : []; })
    .sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  for (const session of newest) {
    const workspace = session.workspaceId ? workspaces.get(session.workspaceId) : undefined;
    if (workspace) return workspace;
  }
  return undefined;
}

/**
 * Where start_session opens a session: the matter's main workspace while it exists, else the workspace of its most recent session
 * that belongs to one.
 * @returns the workspace, or a problem the tool reports.
 */
export function chooseWorkspace(matter: Matter, index: BoardIndex): { workspace: IndexWorkspace } | { problem: string } {
  const main = matter.workspaceId ? index.workspaces.find(workspace => workspace.id === matter.workspaceId) : undefined;
  const workspace = main ?? sessionWorkspace(matter, index);
  if (workspace) return { workspace };
  return { problem: `「${matter.name}」没有主工作区，里面也没有在工作区里的会话，定不了新会话开在哪个工作区。告诉用户在事项页的“编辑上下文”里选主工作区。` };
}

/**
 * Give each matter without a main workspace the workspace of its most recent session, when that is known. Matters from M1 have none.
 * @returns the matters and the ids of those that got one.
 */
export function fillWorkspaces(matters: readonly Matter[], index: BoardIndex): { matters: Matter[]; filled: string[] } {
  const filled: string[] = [];
  const next = matters.map((matter) => {
    if (matter.workspaceId) return matter;
    const workspace = sessionWorkspace(matter, index);
    if (!workspace) return matter;
    filled.push(matter.id);
    return { ...matter, workspaceId: workspace.id };
  });
  return { matters: next, filled };
}
