/**
 * my-dsh Host: the `mydsh/call` and `mydsh/watch` Remotes over the matter store and the session index, my dsh's session and preset, and
 * what my dsh's tools do. The plugin writes into sessions only through `startSession` and `sendToSession`, called by my dsh's tools in a
 * turn a person started; it writes into my dsh's own session the cards it leaves and the answers picked on them.
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { SessionRequestId, SessionSummary } from '@deepseek-ai/dsh-api-session-controller';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendPluginRecord, type Session, type SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-storage-domain';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import {
  activityView, appendActivity, fileEntry, manageEntry, markUndone, receiptCards, recentActivity, sendEntry, startEntry, undoChange, unfileEntry,
} from './activity.js';
import { AssistantStore } from './assistant-store.js';
import { buildBoardIndex, chooseWorkspace, fillWorkspaces, indexContext, type BoardIndex, type IndexInput } from './board-index.js';
import { CorrectionLog, declineCorrection, membershipCorrection, pickCorrection, undoCorrection } from './corrections.js';
import { ChangeFeed } from './feed.js';
import { checkPath, resolveSources, type ReadUpload } from './matter-files.js';
import {
  addAlias, addSession, archiveMatter, createMatter, linkOf, removeSession, renameMatter, setContext, setGoal, unarchiveMatter, type MatterContext,
} from './matters.js';
import { MY_DSH_PRESET, PRESET_ID } from './prompt.js';
import {
  PROPOSALS_MAX, QUESTIONS_MAX, answerQuestion, applyProposal, decideProposal, keepNewest, proposalCard, proposalLine, questionCard,
} from './proposals.js';
import {
  ALIAS_MAX, RequestError, line, matterGoal, matterName, parseRequest,
  type ActivityView, type AssistantView, type BoardSnapshot, type CardPlace, type ContextInput, type Matter, type MyDshRequest, type MyDshResponse, type Proposal,
  type ProposalChange, type WatchNotice, type WhichCandidate, type WhichQuestion,
} from './remote.js';
import { recentReplies, trackTurn, type TurnState } from './session-text.js';
import { SessionIndex, sessionView, type SessionRow } from './sessions.js';
import { buildSnapshot, displayTitle, type WorkspaceFacts } from './snapshot.js';
import { MatterStore } from './store.js';

export interface Config { dataDirectory?: string }
declare module '@deepseek-ai/cordis' { interface Context { mydsh: MyDsh } }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A task or message my dsh sent to a session on the user's request. */
    'my-dsh': { kind: 'my-dsh' };
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** A card my dsh left in its own conversation: a proposal, a candidate question or a receipt. Its state lives in the plugin. */
    'plugin:my-dsh/card': { id: string; type: 'proposal' | 'which' | 'receipt' };
  }
}

/** Who called one of my dsh's tools. */
export interface ToolCaller {
  agent: Agent | undefined;
  signal: AbortSignal;
}

/** The title my dsh's session gets when the plugin makes it. */
const ASSISTANT_TITLE = 'my dsh';
const TITLE_MAX = 60;
const WHY_MAX = 200;
const TASK_MAX = 20_000;
const CANDIDATES_MAX = 6;
/** Cards the snapshot carries for the dock and 全部记录. */
const CARDS_MAX = 300;
/** History records read for `session_recent`; enough for its last few replies. */
const RECENT_MESSAGES = 16;

/** A session list row as the index reads it. A projection block that leaves the title out says nothing about it. */
function toRow(summary: SessionSummary): SessionRow {
  const values = summary.projections?.values;
  return {
    sessionId: summary.sessionId, updatedAt: summary.updatedAt, running: summary.running, blank: summary.blank,
    ...(summary.origin ? { origin: summary.origin } : {}),
    ...(values && 'title' in values ? { title: values.title ?? null } : {}),
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const required = (raw: string, label: string, max: number) => line(raw, label, 1, max);

/** A tool argument the model left out. */
function given<T>(value: T | undefined, field: string): T {
  if (value === undefined || value === '') throw new RequestError(`缺少 ${field}`);
  return value;
}

export default class MyDsh extends TypertRemoteService {
  static inject = ['typert', 'sessionController', 'workspaceRegistry'];
  /** `config.dataDirectory`, else `$DSH_HOME/my-dsh`, else `~/.dsh/my-dsh`. */
  readonly directory: string;
  private readonly store: MatterStore;
  private readonly assistant: AssistantStore;
  private readonly corrections: CorrectionLog;
  private readonly sessions: SessionIndex;
  /** The turn each session is in, from its events. */
  private readonly turns = new Map<string, TurnState>();
  private readonly ready: Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly feed = new ChangeFeed();
  /** The first session listing; cleared when it fails, so the next snapshot tries again. */
  private listing: Promise<void> | undefined;
  private workspacesFilled = false;
  /** Settles once the `my-dsh` preset is registered. */
  private readonly preset: Promise<void>;
  private presetRegistered!: () => void;
  /** The preset registry, held while its injection is live: the service's own context does not inject it, so reading it there throws. */
  private presets: Context['agentPresets'] | undefined;
  /** The running check-or-create of my dsh's session. */
  private ensuring: Promise<string> | undefined;
  /** Cards a click is being applied to, so a second click cannot apply it twice. */
  private readonly clicking = new Set<string>();

  constructor(ctx: Context, public config: Config = {}) {
    super(ctx, 'mydsh');
    this.directory = resolve(config.dataDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'my-dsh'));
    this.store = new MatterStore(this.directory, () => { this.changed(); });
    this.assistant = new AssistantStore(this.directory, () => { this.changed(); });
    this.corrections = new CorrectionLog(this.directory, (error) => { ctx.logger.warn('my-dsh: a correction could not be written: %s', message(error)); });
    this.sessions = new SessionIndex(() => { this.changed(); });
    this.preset = new Promise((resolve) => { this.presetRegistered = resolve; });
    // Listen before the first listing, so nothing that happens while it runs is lost.
    ctx.on('api-session/added', (summary) => { this.sessions.added(toRow(summary)); });
    ctx.on('api-session/removed', (sessionId) => { this.sessions.removed(sessionId); });
    ctx.on('api-session/status', (sessionId, running) => { this.sessions.status(sessionId, running); });
    ctx.on('api-session/activity', (sessionId, updatedAt) => { this.sessions.activity(sessionId, updatedAt); });
    ctx.on('session/event', (session, event) => {
      this.sessions.event(session.id, event);
      const turn = trackTurn(this.turns.get(session.id), event);
      if (turn) this.turns.set(session.id, turn);
    }, { global: true });
    // Workspace titles, membership and the archive set live in the workspace domain.
    ctx.on('domain/changed', (change) => { if (change.domain === 'workspace') this.changed(); });
    ctx.effect(() => () => { this.lifetime.abort(); this.feed.close(); }, 'my-dsh: lifetime');
    // The preset's own row injects this service; registration does not wait for that row, which starts once this service is up.
    ctx.inject(['agentPresets'], (inner) => {
      inner.effect(async () => {
        const unregister = await inner.agentPresets.register(MY_DSH_PRESET);
        this.presets = inner.agentPresets;
        this.presetRegistered();
        return () => { this.presets = undefined; return unregister(); };
      }, 'my-dsh: preset');
    });
    this.ready = Promise.all([this.store.open(), this.assistant.open()]).then(() => undefined);
    void this.ready.catch(() => undefined); // reported by [Service.init] and by every call
  }

  /** A matter file or my dsh record that cannot be read fails the plugin start with the reason, rather than starting empty and overwriting it later. */
  async [Service.init](): Promise<void> {
    await this.ready;
    void this.loadSessions().catch(() => undefined); // a failure reaches the page through the next snapshot
  }

  /** Every board read and change; the client mounts its descriptor (`MY_DSH_REMOTE`), the Gateway finds it through `@Remote`. */
  @Remote
  async call(request: MyDshRequest, signal: AbortSignal): Promise<MyDshResponse> {
    signal.throwIfAborted();
    try {
      const parsed = parseRequest(request);
      await this.ready;
      const now = () => new Date().toISOString();
      switch (parsed.action) {
        case 'snapshot': return await this.snapshot();
        case 'createMatter': {
          const id = randomUUID();
          const context = await this.matterContext(parsed, id, signal);
          return await this.store.update(matters => createMatter(matters, { name: parsed.name, goal: parsed.goal, ...context }, { id, at: now() }));
        }
        case 'setContext': {
          if (!this.store.list().some(matter => matter.id === parsed.id)) throw new RequestError('没有这个事项');
          const context = await this.matterContext(parsed, parsed.id, signal);
          return await this.store.update(matters => setContext(matters, parsed.id, context));
        }
        case 'checkPath': return await checkPath(parsed.path);
        case 'renameMatter': return await this.store.update(matters => renameMatter(matters, parsed.id, parsed.name));
        case 'setGoal': return await this.store.update(matters => setGoal(matters, parsed.id, parsed.goal));
        case 'archiveMatter': return await this.store.update(matters => archiveMatter(matters, parsed.id, now()));
        case 'unarchiveMatter': return await this.store.update(matters => unarchiveMatter(matters, parsed.id));
        case 'addSession': return await this.fileByHand(parsed.matterId, parsed.sessionId);
        case 'removeSession': return await this.unfileByHand(parsed.sessionId);
        case 'assistant': return { sessionId: await this.ensureAssistant(signal) };
        case 'activity': return activityView(this.assistant.peek().activity, this.store.list());
        case 'undo': return await this.undo(parsed.id);
        case 'acceptProposal': return await this.once(parsed.id, () => this.acceptProposal(parsed.id));
        case 'declineProposal': return await this.once(parsed.id, () => this.declineProposal(parsed.id));
        case 'answerWhich': return await this.once(parsed.id, () => this.answerWhich(parsed.id, parsed.candidateId, signal));
      }
    } catch (error) {
      if (error instanceof RequestError) throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error });
      throw error;
    }
  }

  /**
   * Change notices for the board: one when the stream opens, then at most one per 300 ms while sessions, matters or my dsh's records
   * change; the client reads a new snapshot on each. The client mounts the hand-written `MY_DSH_WATCH_DESCRIPTOR`. The Gateway finds
   * this method through `@Remote` and reads its parameter names (SRC mode), so `signal` must stay the only parameter.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncGenerator<WatchNotice, void, undefined> {
    yield* this.feed.follow(signal);
  }

  // ── what my dsh's tools do ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The board as `board_index` returns it. */
  boardIndex(): BoardIndex {
    return buildBoardIndex(this.indexInput());
  }

  /** What each model step of my dsh reads: the board index, then the newest entries of 做事记录. */
  contextText(): string {
    const clock = { now: Date.now(), timeZone: this.timeZone() };
    const activity = recentActivity(this.assistant.peek().activity, clock);
    return [indexContext(this.boardIndex(), clock), ...(activity ? [activity] : [])].join('\n\n');
  }

  /** A session's title, state, matter and workspace, with its last replies. State is this process's view; `liveHere` says whether it runs here. */
  async sessionRecent(sessionId: string, signal: AbortSignal) {
    await this.requireSession(sessionId);
    if (sessionId === this.assistant.peek().sessionId) throw new RequestError('这是 my dsh 自己的会话');
    const view = this.sessions.view(sessionId)!;
    const index = this.boardIndex();
    const indexed = index.sessions.find(session => session.id === sessionId);
    const link = linkOf(this.store.list(), sessionId);
    const page = await this.ctx.sessionController.events({ address: { kind: 'session', sessionId: sessionId as SessionId }, maxMessages: RECENT_MESSAGES }, signal);
    let liveHere = false;
    try {
      liveHere = (await this.ctx.sessionController.state({ sessionId: sessionId as SessionId }, signal)).active;
    } catch {
      // A session whose state cannot be read here is not live here.
    }
    const workspace = indexed?.workspaceId ? index.workspaces.find(candidate => candidate.id === indexed.workspaceId)?.title : undefined;
    return {
      id: sessionId, title: displayTitle(view), state: view.state, ...(view.wait ? { wait: view.wait } : {}),
      lastActivity: new Date(view.lastActivity).toISOString(), liveHere,
      ...(link ? { matter: { id: link.matter.id, name: link.matter.name, by: link.link.by } } : {}),
      ...(workspace ? { workspace } : {}),
      ...recentReplies(page.records),
    };
  }

  /** Start a session in a matter's workspace, send it the task, put it in the matter, and leave a receipt. */
  async startSession(args: { matterId: string; title: string; task: string; why: string }, caller: ToolCaller) {
    const session = this.callerSession(caller, true);
    const title = required(args.title, '标题', TITLE_MAX);
    const task = args.task.trim();
    if (!task) throw new RequestError('task 不能为空');
    if ([...task].length > TASK_MAX) throw new RequestError(`task 最多 ${TASK_MAX} 个字`);
    const why = required(args.why, 'why', WHY_MAX);
    const matter = this.store.list().find(candidate => candidate.id === args.matterId);
    if (!matter) throw new RequestError(`没有这个事项：${args.matterId}`);
    const choice = chooseWorkspace(matter, this.boardIndex());
    if ('problem' in choice) throw new RequestError(choice.problem);

    const { sessionId } = await this.ctx.sessionController.create({ workspaceId: choice.workspace.id as WorkspaceId });
    await this.ctx.sessionController.rename({ sessionId, title });
    const live = await this.ctx.sessionController.resolveAgent(sessionId);
    if ('error' in live) throw live.error;
    live.agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'my-dsh' } }));

    const at = new Date().toISOString();
    const joined = await this.store.update(matters => addSession(matters, matter.id, { sessionId, by: 'mydsh', at, why }));
    const id = randomUUID();
    const card = this.leaveCard(session, id, 'receipt');
    const entry = startEntry({ id, at, matterId: joined.id, matterName: joined.name, sessionId, title, why, task, card });
    await this.assistant.update(state => ({ state: { ...state, activity: appendActivity(state.activity, entry) }, result: undefined }));
    return { sessionId, matterId: joined.id, workspace: choice.workspace.title, receipt: entry.text };
  }

  /** Send a follow-up into an existing session and leave a receipt. */
  async sendToSession(args: { sessionId: string; text: string; why: string }, caller: ToolCaller) {
    const session = this.callerSession(caller, true);
    const text = args.text.trim();
    if (!text) throw new RequestError('text 不能为空');
    if ([...text].length > TASK_MAX) throw new RequestError(`text 最多 ${TASK_MAX} 个字`);
    const why = required(args.why, 'why', WHY_MAX);
    if (args.sessionId === session.id) throw new RequestError('不能发给 my dsh 自己');
    await this.requireSession(args.sessionId);
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(args.sessionId as SessionId)) throw new RequestError('这条会话已归档，发不进去。先在侧栏恢复它。');
    const live = await this.ctx.sessionController.resolveAgent(args.sessionId as SessionId);
    if ('error' in live) {
      if (live.error.code === 'session/writer-held') {
        throw new RequestError('这条会话正被另一个 DSH 进程打开（比如桌面端），这里发不进去。到那个进程里发，或者先在那边关掉它。');
      }
      throw live.error;
    }
    live.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'my-dsh' } }));

    const at = new Date().toISOString();
    const link = linkOf(this.store.list(), args.sessionId);
    const title = displayTitle(this.sessions.view(args.sessionId)!);
    const id = randomUUID();
    const card = this.leaveCard(session, id, 'receipt');
    const entry = sendEntry({
      id, at, sessionId: args.sessionId, title, why, task: text, card,
      ...(link ? { matterId: link.matter.id, matterName: link.matter.name } : {}),
    });
    await this.assistant.update(state => ({ state: { ...state, activity: appendActivity(state.activity, entry) }, result: undefined }));
    return { sessionId: args.sessionId, receipt: entry.text };
  }

  /** Store a proposal for the user to accept or decline on its card. Nothing changes here. */
  async proposeChange(args: {
    kind: ProposalChange['kind']; name?: string; goal?: string; workspaceId?: string; matterId?: string; fromId?: string; intoId?: string;
    phrase?: string; why: string;
  }, caller: ToolCaller) {
    const session = this.callerSession(caller, false);
    const why = required(args.why, 'why', WHY_MAX);
    const phrase = args.phrase?.trim() ? line(args.phrase, 'phrase', 1, ALIAS_MAX) : undefined;
    const matters = this.store.list();
    const find = (id: string | undefined, field: string): Matter => {
      const matter = matters.find(candidate => candidate.id === given(id, field));
      if (!matter) throw new RequestError(`没有这个事项：${id}`);
      return matter;
    };
    let change: ProposalChange;
    switch (args.kind) {
      case 'new': {
        const workspaceId = args.workspaceId?.trim() || undefined;
        if (workspaceId && !this.ctx.workspaceRegistry.get(workspaceId as WorkspaceId)) throw new RequestError(`没有这个工作区：${workspaceId}`);
        change = { kind: 'new', name: matterName(given(args.name, 'name')), goal: matterGoal(args.goal ?? ''), ...(workspaceId ? { workspaceId } : {}) };
        break;
      }
      case 'merge': {
        const from = find(args.fromId, 'fromId');
        const into = find(args.intoId, 'intoId');
        if (from.id === into.id) throw new RequestError('一件事项不能并进自己');
        change = { kind: 'merge', fromId: from.id, fromName: from.name, intoId: into.id, intoName: into.name };
        break;
      }
      case 'rename': {
        const matter = find(args.matterId, 'matterId');
        const name = matterName(given(args.name, 'name'));
        if (name === matter.name) throw new RequestError('新名字和现在的一样');
        change = { kind: 'rename', matterId: matter.id, oldName: matter.name, name };
        break;
      }
      default: throw new RequestError(`kind 只能是 new、merge 或 rename`);
    }
    const id = randomUUID();
    const proposal: Proposal = {
      id, change, why, ...(phrase ? { phrase } : {}), at: new Date().toISOString(), state: 'pending', ...this.leaveCard(session, id, 'proposal'),
    };
    await this.assistant.update(state => ({ state: { ...state, proposals: keepNewest([...state.proposals, proposal], PROPOSALS_MAX) }, result: undefined }));
    return { proposalId: id, change: proposalLine(change), next: '等用户确认。' };
  }

  /** Store a candidate question for the user to answer on its card. */
  async askWhich(args: { phrase: string; candidates: { kind: 'matter' | 'session'; id: string }[]; why: string }, caller: ToolCaller) {
    const session = this.callerSession(caller, false);
    const phrase = line(args.phrase, 'phrase', 1, ALIAS_MAX);
    const why = required(args.why, 'why', WHY_MAX);
    if (args.candidates.length < 1 || args.candidates.length > CANDIDATES_MAX) throw new RequestError(`candidates 要有 1 到 ${CANDIDATES_MAX} 个`);
    const matters = this.store.list();
    const candidates: WhichCandidate[] = [];
    for (const candidate of args.candidates) {
      if (candidates.some(seen => seen.id === candidate.id)) continue;
      if (candidate.kind === 'matter') {
        const matter = matters.find(item => item.id === candidate.id);
        if (!matter) throw new RequestError(`没有这个事项：${candidate.id}`);
        candidates.push({ kind: 'matter', id: matter.id, label: matter.name });
      } else {
        const view = this.sessions.view(candidate.id);
        if (!view || candidate.id === session.id) throw new RequestError(`没有这个会话：${candidate.id}`);
        candidates.push({ kind: 'session', id: candidate.id, label: displayTitle(view) });
      }
    }
    const id = randomUUID();
    const question: WhichQuestion = {
      id, phrase, candidates, why, at: new Date().toISOString(), state: 'pending', ...this.leaveCard(session, id, 'which'),
    };
    await this.assistant.update(state => ({ state: { ...state, questions: keepNewest([...state.questions, question], QUESTIONS_MAX) }, result: undefined }));
    return { questionId: id, candidates: candidates.map(candidate => `${candidate.kind === 'matter' ? '事项' : '会话'}「${candidate.label}」`), next: '等用户选。' };
  }

  // ── my dsh's session ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * my dsh's session: the stored one while it exists and is not archived, else a new one in `<data directory>/assistant`, outside every
   * workspace, running the `my-dsh` preset with the user's default model.
   */
  private ensureAssistant(signal: AbortSignal): Promise<string> {
    this.ensuring ??= this.checkAssistant(signal).finally(() => { this.ensuring = undefined; });
    return this.ensuring;
  }

  private async checkAssistant(signal: AbortSignal): Promise<string> {
    const stored = this.assistant.peek().sessionId;
    if (stored && await this.alive(stored)) return stored;
    await Promise.race([this.preset, new Promise((_resolve, reject) => {
      const timer = setTimeout(() => { reject(new RequestError('my dsh 的预设还没加载好，稍后再试')); }, 15_000);
      signal.addEventListener('abort', () => { clearTimeout(timer); }, { once: true });
      void this.preset.then(() => { clearTimeout(timer); });
    })]);
    const presets = this.presets;
    if (!presets) throw new RequestError('my dsh 的预设还没加载好，稍后再试');
    const preset = await presets.resolve(PRESET_ID);
    if (preset.broken) throw new RequestError(`my dsh 的预设没加载成功：${preset.broken}`);
    const cwd = join(this.directory, 'assistant');
    await mkdir(cwd, { recursive: true });
    const { sessionId } = await this.ctx.sessionController.create({ cwd, agentPreset: PRESET_ID });
    await this.assistant.update(state => ({ state: { ...state, sessionId }, result: undefined }));
    // A title set by rename is pinned, so the first question does not give the session an automatic title.
    try {
      await this.ctx.sessionController.rename({ sessionId, title: ASSISTANT_TITLE });
    } catch (error) {
      this.ctx.logger.warn('my-dsh: my dsh\'s session could not be titled: %s', message(error));
    }
    return sessionId;
  }

  /** The session is listed and not archived. An archived session cannot run turns. */
  private async alive(sessionId: string): Promise<boolean> {
    await this.loadSessions();
    if (!this.sessions.has(sessionId)) await this.listSessions();
    return this.sessions.has(sessionId) && !this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId as SessionId);
  }

  /** The tool runs in my dsh's own session; with `userTurn`, in a turn a person's prompt started. */
  private callerSession(caller: ToolCaller, userTurn: boolean): Session {
    const session = caller.agent?.session;
    if (!session) throw new RequestError('这个工具要在会话里调用');
    if (session.id !== this.assistant.peek().sessionId) throw new RequestError('这个工具只在看板的 my dsh 对话里能用');
    if (userTurn && !this.turns.get(session.id)?.byUser) throw new RequestError('这一轮不是用户发起的，my dsh 不往会话里写');
    return session;
  }

  /** Mark where a card belongs: a record in my dsh's log, and the turn it is under. */
  private leaveCard(session: Session, id: string, type: 'proposal' | 'which' | 'receipt'): CardPlace {
    try {
      appendPluginRecord(session, 'plugin:my-dsh/card', { id, type });
    } catch (error) {
      this.ctx.logger.warn('my-dsh: the card record could not be written: %s', message(error));
    }
    return { sessionId: session.id, turn: this.turns.get(session.id)?.turn ?? -1 };
  }

  // ── changes by hand and on cards ──────────────────────────────────────────────────────────────────────────────────────────────

  /** A context from a dialog, checked: the workspace exists, paths exist, links are read again, uploads are copied into the matter's folder. */
  private async matterContext(input: Partial<ContextInput>, matterId: string, signal: AbortSignal): Promise<MatterContext> {
    const workspaceId = input.workspaceId ?? undefined;
    if (workspaceId && !this.ctx.workspaceRegistry.get(workspaceId as WorkspaceId)) throw new RequestError('没有这个工作区');
    const sources = await resolveSources(input.sources ?? [], { read: this.uploads(), files: join(this.directory, 'matters', matterId, 'files'), signal });
    return { ...(workspaceId ? { workspaceId } : {}), sources, ...(input.instructions ? { instructions: input.instructions } : {}) };
  }

  /** Reads files uploaded through DSH, when this DSH keeps an attachment store. */
  private uploads(): ReadUpload | undefined {
    const attachments = this.ctx.get('attachments');
    if (!attachments) return undefined;
    return (upload, signal) => attachments.readFileStream({ attachmentId: upload.attachmentId, name: upload.name, bytes: upload.bytes } as FileAttachmentRef, signal);
  }

  private async fileByHand(matterId: string, sessionId: string): Promise<Matter> {
    await this.requireSession(sessionId);
    if (sessionId === this.assistant.peek().sessionId) throw new RequestError('my dsh 自己不能放进事项');
    const at = new Date().toISOString();
    const { matter, before } = await this.store.update((matters) => {
      const before = linkOf(matters, sessionId);
      const changed = addSession(matters, matterId, { sessionId, by: 'manual', at });
      return { matters: changed.matters, matter: { matter: changed.matter, before } };
    });
    const correction = membershipCorrection(before, matter.id, sessionId, at);
    if (correction) {
      await this.corrections.append(correction);
      const entry = fileEntry({
        id: randomUUID(), at, matterId: matter.id, matterName: matter.name, sessionId, title: this.titleOf(sessionId),
        ...(before ? { from: before.matter.name } : {}),
      });
      await this.assistant.update(state => ({ state: { ...state, activity: appendActivity(state.activity, entry) }, result: undefined }));
    }
    return matter;
  }

  private async unfileByHand(sessionId: string): Promise<Matter | null> {
    const at = new Date().toISOString();
    const { matter, before } = await this.store.update((matters) => {
      const before = linkOf(matters, sessionId);
      const changed = removeSession(matters, sessionId);
      return { matters: changed.matters, matter: { matter: changed.matter, before } };
    });
    const correction = membershipCorrection(before, null, sessionId, at);
    if (correction && before) {
      await this.corrections.append(correction);
      const entry = unfileEntry({ id: randomUUID(), at, matterId: before.matter.id, matterName: before.matter.name, sessionId, title: this.titleOf(sessionId) });
      await this.assistant.update(state => ({ state: { ...state, activity: appendActivity(state.activity, entry) }, result: undefined }));
    }
    return matter;
  }

  /** Take back a session my dsh started or one filed by hand: it leaves the matter and is kept; a started one stops its turn. */
  private async undo(id: string): Promise<ActivityView> {
    const entry = this.assistant.peek().activity.find(candidate => candidate.id === id);
    if (!entry) throw new RequestError('没有这条记录');
    await this.store.update(matters => undoChange(matters, entry));
    if (entry.kind === 'start' && entry.sessionId) await this.stop(entry.sessionId);
    const at = new Date().toISOString();
    const record = await this.assistant.update((state) => {
      const { entries, record } = markUndone(state.activity, id, { id: randomUUID(), at });
      return { state: { ...state, activity: entries }, result: record };
    });
    await this.corrections.append(undoCorrection(entry, at));
    return { ...record, undoable: false };
  }

  /** Stop the session's turn and drop what it had queued, when it runs in this process. */
  private async stop(sessionId: string): Promise<void> {
    const state = this.sessions.view(sessionId)?.state;
    if (state !== 'running' && state !== 'waiting') return;
    try {
      const live = await this.ctx.sessionController.resolveAgent(sessionId as SessionId);
      if (!('error' in live)) live.agent.cancel({ kind: 'user' });
    } catch (error) {
      this.ctx.logger.warn('my-dsh: could not stop %s: %s', sessionId, message(error));
    }
  }

  /** One click per card at a time. */
  private async once<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.clicking.has(id)) throw new RequestError('正在处理这张卡');
    this.clicking.add(id);
    try {
      return await run();
    } finally {
      this.clicking.delete(id);
    }
  }

  private async acceptProposal(id: string): Promise<Proposal> {
    const proposal = this.assistant.peek().proposals.find(candidate => candidate.id === id);
    if (!proposal) throw new RequestError('没有这个提议');
    if (proposal.state !== 'pending') throw new RequestError('这个提议已经处理过了');
    const at = new Date().toISOString();
    const workspaceId = proposal.change.kind === 'new' ? (proposal.change.workspaceId ?? this.recentWorkspaceId()) : undefined;
    const { matter, text } = await this.store.update((matters) => {
      const applied = applyProposal(matters, proposal, { id: randomUUID(), at, ...(workspaceId ? { workspaceId } : {}) });
      return { matters: applied.matters, matter: { matter: applied.matter, text: applied.text } };
    });
    return await this.assistant.update((state) => {
      const decided = decideProposal(state.proposals, id, { state: 'accepted', at, ...(proposal.change.kind === 'new' ? { matterId: matter.id } : {}) });
      const entry = manageEntry({ id: randomUUID(), at, matterId: matter.id, matterName: matter.name, text, why: proposal.why });
      return { state: { ...state, proposals: decided.proposals, activity: appendActivity(state.activity, entry) }, result: decided.proposal };
    });
  }

  private async declineProposal(id: string): Promise<Proposal> {
    const at = new Date().toISOString();
    const proposal = await this.assistant.update((state) => {
      const decided = decideProposal(state.proposals, id, { state: 'declined', at });
      return { state: { ...state, proposals: decided.proposals }, result: decided.proposal };
    });
    await this.corrections.append(declineCorrection(proposal, at));
    return proposal;
  }

  /** Send the pick back into my dsh's conversation as the user's answer, then record it; a picked matter keeps the phrase as an alias. */
  private async answerWhich(id: string, candidateId: string | null, signal: AbortSignal): Promise<WhichQuestion> {
    const at = new Date().toISOString();
    const checked = answerQuestion(this.assistant.peek().questions, id, candidateId, at);
    await this.ctx.sessionController.prompt({
      requestId: randomUUID() as SessionRequestId, sessionId: checked.question.sessionId as SessionId, mode: 'queue',
      content: [{ type: 'text', text: checked.reply }],
    }, signal);
    const { question, answer } = await this.assistant.update((state) => {
      const answered = answerQuestion(state.questions, id, candidateId, at);
      return { state: { ...state, questions: answered.questions }, result: answered };
    });
    if (answer?.kind === 'matter') {
      await this.store.update(matters => addAlias(matters, answer.id, question.phrase)).catch(() => undefined); // merged away since
    }
    await this.corrections.append(pickCorrection(question, answer, at));
    return question;
  }

  // ── reading the board ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Something the board shows changed. */
  private changed(): void {
    this.feed.touch();
  }

  private async snapshot(): Promise<BoardSnapshot> {
    await this.loadSessions();
    return buildSnapshot({
      matters: this.store.list(),
      sessions: this.sessions.all().map(sessionView),
      workspaces: this.workspaceFacts(),
      assistant: this.assistantView(),
      now: Date.now(),
      timeZone: this.timeZone(),
    });
  }

  /** my dsh's session and the newest cards in it; cards from an earlier my dsh session stay out. */
  private assistantView(): AssistantView {
    const state = this.assistant.peek();
    const matters = this.store.list();
    const cards = [...state.proposals.map(proposalCard), ...state.questions.map(questionCard), ...receiptCards(state.activity, matters)]
      .filter(card => card.sessionId === state.sessionId)
      .sort((a, b) => a.turn - b.turn);
    return { sessionId: state.sessionId ?? null, cards: keepNewest(cards, CARDS_MAX) };
  }

  private indexInput(): IndexInput {
    const state = this.assistant.peek();
    const sent = new Map<string, string[]>();
    for (const entry of state.activity) {
      if ((entry.kind === 'start' || entry.kind === 'send') && entry.sessionId && entry.task) sent.set(entry.sessionId, [...(sent.get(entry.sessionId) ?? []), entry.task]);
    }
    return {
      matters: this.store.list(),
      sessions: this.sessions.all().map(sessionView),
      workspaces: this.ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds })),
      archived: new Set(this.ctx.workspaceRegistry.archivedSessionIds),
      hidden: new Set(state.sessionId ? [state.sessionId] : []),
      sent,
      now: Date.now(),
    };
  }

  /** The workspace of the most recently active session that has one. */
  private recentWorkspaceId(): string | undefined {
    const index = this.boardIndex();
    return index.sessions.find(session => session.workspaceId)?.workspaceId;
  }

  private titleOf(sessionId: string): string {
    const view = this.sessions.view(sessionId);
    return view ? displayTitle(view) : '未命名';
  }

  private timeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private loadSessions(): Promise<void> {
    if (!this.listing) {
      const run = this.listSessions();
      this.listing = run;
      run.catch(() => { if (this.listing === run) this.listing = undefined; });
    }
    return this.listing;
  }

  private async listSessions(): Promise<void> {
    const { items } = await this.ctx.sessionController.list({}, this.lifetime.signal);
    this.sessions.load(items.map(toRow));
    if (!this.workspacesFilled) {
      this.workspacesFilled = true;
      await this.fillWorkspaces();
    }
  }

  /** Matters from M1 have no main workspace; once the sessions are known, each gets the workspace of its most recent session. */
  private async fillWorkspaces(): Promise<void> {
    const index = this.boardIndex();
    if (fillWorkspaces(this.store.list(), index).filled.length === 0) return;
    await this.store.update((matters) => {
      const filled = fillWorkspaces(matters, index);
      return { matters: filled.matters, matter: filled.filled };
    }).catch((error: unknown) => { this.ctx.logger.warn('my-dsh: main workspaces were not filled in: %s', message(error)); });
  }

  /** A session the index does not know may come from another DSH process after the first listing, so list once more before refusing. */
  private async requireSession(sessionId: string): Promise<void> {
    await this.loadSessions();
    if (!this.sessions.has(sessionId)) await this.listSessions();
    if (!this.sessions.has(sessionId)) throw new RequestError('没有这个会话');
  }

  private workspaceFacts(): WorkspaceFacts {
    const workspaceOf = new Map<string, { id: string; title: string }>();
    const list = this.ctx.workspaceRegistry.list();
    for (const workspace of list) {
      for (const sessionId of workspace.sessionIds) if (!workspaceOf.has(sessionId)) workspaceOf.set(sessionId, { id: workspace.id, title: workspace.title });
    }
    return {
      workspaceOf, archived: new Set(this.ctx.workspaceRegistry.archivedSessionIds),
      list: list.map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path })),
    };
  }
}
