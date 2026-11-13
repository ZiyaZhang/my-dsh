/**
 * my-dsh Host: the `mydsh/call` and `mydsh/watch` Remotes over the matter store and the session index, my dsh's session and preset, each
 * matter's own conversation, and what my dsh's tools do. The tools run in my dsh's own session and, scoped to their matter, in a
 * matter's conversation: an ordinary session running the user's default preset. The plugin writes into sessions only through
 * `startSession` and `sendToSession`, and into a matter's memory what the user said only through `noteMatter`, all called by those tools
 * in a turn a person started; it writes into the calling session the cards it leaves and the answers picked on them. A session the
 * tools open in a hosted matter runs under the matter's permission preset from its first turn. Once the sessions a matter's
 * conversation dispatched have all stopped, the plugin wakes that conversation once with their results (往回报, reports.ts).
 *
 * 事项记忆: each matter's memory is a folder of Markdown files (memory-store.ts) that its sessions read and write with DSH's own file
 * tools. The Host builds the index, puts it into every session of the matter once per turn, writes 补记 two minutes after the matter's
 * sessions all stopped and merges once a day (memory-ops.ts), records every change with its diff in 做事记录, and keeps 产物: the files
 * the matter's sessions wrote (artifacts.ts).
 *
 * 自动归类: the first time the board is read after the Host starts while no run has finished, and then once a day from the hourly
 * check, the Host looks at the loose sessions of the last 14 days and suggests matters for them: the origin rules first
 * (grouping-rules.ts), then the user's default model for the rest (grouping-model.ts). The card under my dsh's input shows the
 * suggestions; accepting one makes the matter or files the session and goes in 做事记录, where it can be undone; a declined one is not
 * made again.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { SessionRequestId, SessionSummary } from '@deepseek-ai/dsh-api-session-controller';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendPluginRecord, type Session, type SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection-cache';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-session-turn-outline';
import type {} from '@deepseek-ai/dsh-storage-domain';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import {
  activityView, appendActivity, fileEntry, forwardEntry, groupEntry, manageEntry, markUndone, memoryEntry, noteEntry, noteFile, receiptCards, recentActivity,
  sendEntry, startEntry, undoChange, unfileEntry,
} from './activity.js';
import { ArtifactStore, artifactRows, type TimedChange } from './artifacts.js';
import { AssistantStore } from './assistant-store.js';
import { buildBoardIndex, chooseWorkspace, fillWorkspaces, indexContext, type BoardIndex, type IndexInput } from './board-index.js';
import { callerOf, checkReach, conversationContext, matterFor, sentText, type Caller, type ListedSession } from './conversation.js';
import { CorrectionLog, declineCorrection, membershipCorrection, pickCorrection, suggestionCorrection, undoCorrection } from './corrections.js';
import { unifiedDiff } from './diff.js';
import { ChangeFeed } from './feed.js';
import { FILE_TOOLS, callChanges, callTargets, resultText, within } from './file-calls.js';
import { emptyEvidence, foldEvidence, prKey, type SessionEvidence } from './grouping-evidence.js';
import { branchKey, readGit, type GitFacts } from './grouping-git.js';
import {
  GROUPING_SYSTEM, MODEL_CHUNK, MODEL_MATTERS_MAX, MODEL_SESSIONS_MAX, chunked, groupingPrompt, outlineEnds, readGrouping, triggerLabel, type ModelSession,
} from './grouping-model.js';
import { originSuggestions, prName, scheduleFacts, sessionBranch, sessionPrs, type RuleInput, type RuleSession } from './grouping-rules.js';
import { GroupingStore } from './grouping-store.js';
import { entryKey, groupingDue, looseSessions, type GroupingRun, type Made } from './grouping.js';
import { checkPath, resolveSources, type ReadUpload } from './matter-files.js';
import {
  addAlias, addSession, archiveMatter, conversationOf, createMatter, linkOf, removeSession, renameMatter, setContext, setConversation, setGoal,
  setHosting, unarchiveMatter, type MatterContext,
} from './matters.js';
import { TurnFreeze, memoryContext } from './memory-context.js';
import {
  CAPTURE_BY, CATEGORIES, MERGE_BY, USER_BY, checkMemoryFile, clipDescription, contentHash, freePath, looksSecret, parseFrontmatter, renderMemoryFile, shortName,
} from './memory-files.js';
import { indexLine } from './memory-index.js';
import {
  CAPTURE_QUIET_MS, CAPTURE_SYSTEM, MERGE_EVERY_MS, MERGE_SYSTEM, WRITE_WINDOW_MS, captureMemory, capturePrompt, captureReady, changedPaths, checkOps,
  claimWriter, eventChanges, mergeDue, mergeMemory, mergePrompt, newTurns, ownEvents, readOps, transcriptLines, turnsSince, turnsText,
  type HistoryEvent, type PassFile, type RawOp, type RecentWrite, type SessionTurns,
} from './memory-ops.js';
import { DiffStore, MemoryStore, type MemoryChange, type MemoryPlace, type MemoryScan } from './memory-store.js';
import { NoteStore, matterContext, noteText } from './notes.js';
import { MY_DSH_PRESET, PRESET_ID } from './prompt.js';
import {
  PROPOSALS_MAX, QUESTIONS_MAX, answerQuestion, applyProposal, decideProposal, keepNewest, proposalCard, proposalLine, questionCard,
} from './proposals.js';
import {
  ALIAS_MAX, NOTE_KINDS, RequestError, TASK_MAX, line, matterGoal, matterName, parseRequest,
  type ActivityEntry, type ActivityView, type ArtifactRowView, type AssistantView, type BoardSnapshot, type CardPlace, type ContextInput, type Matter,
  type MemoryAuthor, type MemoryFileView, type MemoryView, type MyDshRequest, type MyDshResponse, type NoteKind, type Proposal, type ProposalChange,
  type SessionLink, type UsageStats, type WatchNotice, type WhichCandidate, type WhichQuestion,
} from './remote.js';
import {
  WAKE_DELAY_MS, forgetDispatcher, forgetSession, noteTurnEnd, reportSummary, reportText, shouldWake, turnEndKind, userTurn, wakeSent,
  wakeTurnEnded, watch, watchersOf, type Books, type ReportNote, type WaitingSession, type WakeStates,
} from './reports.js';
import { FORWARD_MESSAGES_MAX, onlyNames, recentReplies, trackTurn, userWords, type TurnState } from './session-text.js';
import { SessionIndex, lastReply, sessionView, type SessionRow, type SessionView } from './sessions.js';
import { REVIEW_DAYS, buildSnapshot, conversationParts, dayKey, displayTitle, hostingPresets, type ScheduleEntry, type WorkspaceFacts } from './snapshot.js';
import { firstSessionAt, installedPlugins, seededSessions, sessionUsage, type UsageBundle } from './usage.js';
import { MatterStore } from './store.js';
import { coordinationTools } from './tools.js';

export interface Config { dataDirectory?: string }
declare module '@deepseek-ai/cordis' {
  interface Context { mydsh: MyDsh }
  interface Events {
    /** DSH's schedule service changed its task set (`dsh-schedule`, which this package does not depend on). */
    'schedule/changed'(): void;
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A task or message my dsh sent to a session on the user's request. */
    'my-dsh': { kind: 'my-dsh' };
    /**
     * DSH's notice that a child task settled (`SubagentSettledMessageSource` in `dsh-subagent`, which this package does not depend on;
     * the same fields). 往回报 wakes a matter's conversation with it, so DSH's chat labels the turn as a child task's update.
     */
    'subagent-settled': { readonly kind: 'subagent-settled'; readonly form: 'notice'; readonly summary: string; readonly senderSessionId: SessionId };
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** A card my dsh's tools left in the conversation they ran in, my dsh's or a matter's: a proposal, a candidate question or a receipt. Its state lives in the plugin. */
    'plugin:my-dsh/card': { id: string; type: 'proposal' | 'which' | 'receipt' | 'forward' };
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
const CANDIDATES_MAX = 6;
/** Cards the snapshot carries for the dock and 全部记录. */
const CARDS_MAX = 300;
/** History records read for `session_recent`; enough for its last few replies. */
const RECENT_MESSAGES = 16;
/** Ends every task `start_session` sends, so what the user must decide reaches 等你处理 rather than staying in a reply. */
const ASK_USER_LINE = '需要用户决定或确认时，用提问工具问，不要只写在回复里。';
/**
 * Ends every task `start_session` sends and every message `send_to_session` sends: the card under the dispatching turn shows how the
 * session's last reply starts, and a hosted matter's conversation reads it when it is woken, so the reply leads with the result.
 */
const RESULT_LINE = '做完时，最后一条回复先用一两句写清结果：做了什么、结果在哪、还差什么，不看上文也能懂。';
/** How many messages of my dsh's history a pass to a matter reads back to find the user's last few. */
const FORWARD_SCAN = 24;
/** How often the Host checks which matters' memory is due its daily merge. */
const MERGE_CHECK_MS = 60 * 60 * 1000;
/** How long the head's numbers stand before the next snapshot reads them again. */
const USAGE_EVERY_MS = 10 * 60 * 1000;
/** History pages a memory pass or a 产物 read goes back at most, and messages per page. */
const HISTORY_PAGES = 10;
const PAGE_MESSAGES = 200;
/** How long one 补记 or merge may take, model call included, before it is given up; a run of 自动归类 gets as long. */
const PASS_TIMEOUT_MS = 10 * 60 * 1000;
/** 自动归类: session logs one run reads at most (the newest loose sessions), and working directories whose git it reads. */
const GROUPING_LOGS = 60;
const GROUPING_DIRS = 120;
const DAY_MS = 86_400_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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
  static inject = ['typert', 'sessionController', 'workspaceRegistry', 'sessionQuery'];
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
  /** DSH's cache of each session's projections, held while its injection is live; a composition may leave it out. */
  private projectionCache: Context['sessionProjectionCache'] | undefined;
  /** The running check-or-create of my dsh's session. */
  private ensuring: Promise<string> | undefined;
  /** Cards a click is being applied to, so a second click cannot apply it twice. */
  private readonly clicking = new Set<string>();
  /** notes.json from before 事项记忆, read once to move each matter's lines into its memory. */
  private readonly notes: NoteStore;
  /** 事项记忆: the folders, their indexes and the Host's own writes; the diffs its 做事记录 entries keep; and 产物. */
  private readonly memory: MemoryStore;
  private readonly diffs: DiffStore;
  private readonly artifacts: ArtifactStore;
  /** The memory block each session reads, kept for the turn it is in. */
  private readonly freeze = new TurnFreeze();
  /** File tool calls waiting for their results, by session and call id; and the recent ones, which tell who changed a memory file. */
  private readonly fileCalls = new Map<string, { sessionId: string; name: string; args: string; cwd?: string }>();
  private recentWrites: RecentWrite[] = [];
  /** Recent writes already used to explain a memory change, per file (see claimWriter). */
  private readonly claimedWrites = new Set<string>();
  /** Each session's working directory, from the session list and its events. */
  private readonly cwds = new Map<string, string>();
  /** Per matter: the pending 补记 check, the time of its sessions' newest event, and the pass running now. */
  private readonly captureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastEvent = new Map<string, number>();
  private readonly passing = new Map<string, 'capture' | 'merge'>();
  /** Matters waiting for their daily merge, run one at a time, and the hourly check. */
  private mergeQueue: string[] = [];
  private draining = false;
  private mergeTimer: ReturnType<typeof setInterval> | undefined;
  /** The pending and the running set-up of the memory folders. */
  private memorySyncTimer: ReturnType<typeof setTimeout> | undefined;
  private memorySync: Promise<void> = Promise.resolve();
  /** DSH's model service and the user's default model, held while their injection is live. */
  private llm: LlmLike | undefined;
  private defaultModel: DefaultModelLike | undefined;
  /** DSH's permission preset service, held while its injection is live; a composition may leave it out, and then nothing is hosted. */
  private permissionPresets: PermissionPresetsLike | undefined;
  /** DSH's schedule service, held while its injection is live, and its task list as last read; read again after it changes. */
  private schedule: ScheduleLike | undefined;
  private pluginManager: PluginManagerLike | undefined;
  /** The head's numbers, read at most every {@link USAGE_EVERY_MS}. */
  private usageRead: { at: number; value: Promise<UsageStats> } | undefined;
  private scheduleRead: Promise<readonly ScheduleEntry[]> | undefined;
  /** The running check-or-create of each matter's conversation, by matter id. */
  private readonly conversing = new Map<string, Promise<string>>();
  /** 往回报: what each matter's conversation dispatched and what their ended turns left (reports.ts), and its pending wake check. */
  private books: Books = new Map();
  private readonly wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 自动归类: runs, suggestions and evidence (grouping.json); the run in progress; whether the board was read since the Host started. */
  private readonly grouping: GroupingStore;
  private groupingRun: Promise<void> | undefined;
  private boardRead = false;

  constructor(ctx: Context, public config: Config = {}) {
    super(ctx, 'mydsh');
    this.directory = resolve(config.dataDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'my-dsh'));
    this.store = new MatterStore(this.directory, () => { this.forgetGone(); this.changed(); this.scheduleMemorySync(); });
    this.assistant = new AssistantStore(this.directory, () => { this.changed(); });
    this.notes = new NoteStore(this.directory);
    this.memory = new MemoryStore(this.directory, {
      observed: (matterId, changes) => { void this.memoryObserved(matterId, changes).catch((error: unknown) => { ctx.logger.warn('my-dsh: memory changes were not recorded: %s', message(error)); }); },
      scanned: () => { this.changed(); },
      warn: (text) => { ctx.logger.warn('my-dsh: %s', text); },
      dateOf: ms => dayKey(ms, this.timeZone()),
    });
    this.diffs = new DiffStore(this.directory);
    this.artifacts = new ArtifactStore(this.directory, () => { this.changed(); });
    this.corrections = new CorrectionLog(this.directory, (error) => { ctx.logger.warn('my-dsh: a correction could not be written: %s', message(error)); });
    this.grouping = new GroupingStore(this.directory, () => { this.changed(); }, (text) => { ctx.logger.warn('my-dsh: %s', text); });
    // my dsh's own session is not on the board: its turns change nothing the page shows.
    this.sessions = new SessionIndex((minor) => { this.feed.touch(minor); });
    this.preset = new Promise((resolve) => { this.presetRegistered = resolve; });
    // Listen before the first listing, so nothing that happens while it runs is lost.
    ctx.on('api-session/added', (summary) => {
      this.sessions.added(toRow(summary));
      if (summary.cwd) this.cwds.set(summary.sessionId, summary.cwd);
    });
    ctx.on('api-session/removed', (sessionId) => { this.sessions.removed(sessionId); });
    ctx.on('api-session/status', (sessionId, running) => { this.sessions.status(sessionId, running); });
    ctx.on('api-session/activity', (sessionId, updatedAt) => { this.sessions.activity(sessionId, updatedAt); });
    ctx.on('session/event', (session, event) => {
      this.sessions.event(session.id, event);
      const before = this.turns.get(session.id);
      const turn = trackTurn(before, event);
      if (turn) this.turns.set(session.id, turn);
      // 往回报: a person's prompt in a dispatcher starts its wake count again; an ended turn may leave a note or allow a wake.
      if (turn?.byUser && !before?.byUser) this.books = userTurn(this.books, session.id);
      if (event.type === 'turn/end') this.turnEnded(session.id, turnEndKind(event.data) ?? 'unknown');
      // 事项记忆 and 产物: file tool calls, the memory block kept per turn, and the quiet time before 补记.
      if (session.header.cwd) this.cwds.set(session.id, session.header.cwd);
      this.fileEvent(session.id, event);
      if (event.type === 'turn/end') this.freeze.forget(session.id);
      this.memoryActivity(session.id, event.time);
      // 自动归类: the branch the turn ended on.
      if (event.type === 'turn/end' && session.header.origin !== 'subagent') {
        void this.noteBranch(session.id, session.header.cwd).catch((error: unknown) => { ctx.logger.warn('my-dsh: the branch of %s was not noted: %s', session.id, message(error)); });
      }
    }, { global: true });
    // Workspace titles, membership and the archive set live in the workspace domain.
    ctx.on('domain/changed', (change) => { if (change.domain === 'workspace') { this.forgetGone(); this.changed(); this.scheduleMemorySync(); } });
    ctx.effect(() => () => {
      this.lifetime.abort();
      this.feed.close();
      for (const timer of this.wakeTimers.values()) clearTimeout(timer);
      this.wakeTimers.clear();
      for (const timer of this.captureTimers.values()) clearTimeout(timer);
      this.captureTimers.clear();
      clearInterval(this.mergeTimer);
      clearTimeout(this.memorySyncTimer);
      this.memory.close();
    }, 'my-dsh: lifetime');
    // The preset's own row injects this service; registration does not wait for that row, which starts once this service is up.
    ctx.inject(['agentPresets'], (inner) => {
      inner.effect(async () => {
        const unregister = await inner.agentPresets.register(MY_DSH_PRESET);
        this.presets = inner.agentPresets;
        this.presetRegistered();
        return () => { this.presets = undefined; return unregister(); };
      }, 'my-dsh: preset');
    });
    ctx.inject(['sessionProjectionCache'], (inner) => {
      inner.effect(() => {
        this.projectionCache = inner.sessionProjectionCache;
        // A listing that ran before the cache was there read no replies.
        if (this.listing) void this.fillReplies();
        return () => { this.projectionCache = undefined; };
      }, 'my-dsh: projection cache');
    });
    ctx.inject(['llm', 'agentDefaultModel'], (inner) => {
      inner.effect(() => {
        const services = inner as unknown as { llm: LlmLike; agentDefaultModel: DefaultModelLike };
        this.llm = services.llm;
        this.defaultModel = services.agentDefaultModel;
        // A run of 自动归类 that had to leave the model out is due again now; read once the stores are open, which may be after this effect.
        void Promise.resolve().then(() => this.ready).then(() => { this.groupingCheck(); }, () => undefined);
        return () => { this.llm = undefined; this.defaultModel = undefined; };
      }, 'my-dsh: model');
    });
    ctx.inject(['permissionPresets'], (inner) => {
      inner.effect(() => {
        this.permissionPresets = (inner as unknown as { permissionPresets: PermissionPresetsLike }).permissionPresets;
        // The page reads the presets from the snapshot.
        this.changed();
        return () => { this.permissionPresets = undefined; this.changed(); };
      }, 'my-dsh: permission presets');
    });
    ctx.inject(['schedule'], (inner) => {
      inner.effect(() => {
        this.schedule = (inner as unknown as { schedule: ScheduleLike }).schedule;
        this.scheduleRead = undefined;
        this.changed();
        return () => { this.schedule = undefined; this.scheduleRead = undefined; this.changed(); };
      }, 'my-dsh: schedule');
    });
    ctx.on('schedule/changed', () => { this.scheduleRead = undefined; this.changed(); });
    ctx.inject(['pluginManager'], (inner) => {
      inner.effect(() => {
        this.pluginManager = (inner as unknown as { pluginManager: PluginManagerLike }).pluginManager;
        this.usageRead = undefined;
        return () => { this.pluginManager = undefined; this.usageRead = undefined; };
      }, 'my-dsh: plugin manager');
    });
    // A matter's conversation runs the user's default preset, so the tools it shares with my dsh are registered at the root as well, for
    // those conversations only. In my dsh's own session the preset's row registers the same names nearer, and those shadow these.
    ctx.inject(['tools'], (inner) => {
      for (const tool of coordinationTools(this)) {
        inner.tools.register(tool, { when: ({ agent }) => this.callerKind(agent?.session?.id)?.kind === 'conversation' });
      }
    });
    // Every session in a matter reads the matter's goal, instructions, sources and memory each step, and a matter's conversation reads
    // its rules and the matter's sessions too; other sessions read nothing.
    ctx.inject(['systemPrompt'], (inner) => {
      (inner as unknown as { systemPrompt: SystemPromptLike }).systemPrompt.context({
        name: 'my-dsh:matter', order: 910, interpolate: false,
        text: ({ agent }) => this.matterContextFor(agent?.session?.id),
      });
    });
    this.ready = Promise.all([
      this.store.open(), this.assistant.open(), this.notes.open(), this.memory.open(), this.artifacts.open(), this.grouping.open(), this.corrections.open(),
    ]).then(() => undefined);
    void this.ready.catch(() => undefined); // reported by [Service.init] and by every call
  }

  /** A matter file or my dsh record that cannot be read fails the plugin start with the reason, rather than starting empty and overwriting it later. */
  async [Service.init](): Promise<void> {
    await this.ready;
    void this.loadSessions().catch(() => undefined); // a failure reaches the page through the next snapshot
    void this.startMemory();
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
        case 'assistant': return { sessionId: parsed.matterId === undefined ? await this.ensureAssistant(signal) : await this.ensureConversation(parsed.matterId) };
        case 'activity': return activityView(this.assistant.peek().activity, this.store.list(), this.undoableNotes());
        case 'undo': return await this.undo(parsed.id);
        case 'acceptProposal': return await this.once(parsed.id, () => this.acceptProposal(parsed.id));
        case 'declineProposal': return await this.once(parsed.id, () => this.declineProposal(parsed.id));
        case 'answerWhich': return await this.once(parsed.id, () => this.answerWhich(parsed.id, parsed.candidateId, signal));
        case 'mergeMemory': return await this.mergeNow(parsed.id);
        case 'memoryFile': return await this.memoryFile(parsed.matterId, parsed.path);
        case 'activityDiff': {
          const entry = this.assistant.peek().activity.find(candidate => candidate.id === parsed.id);
          return { diff: entry?.memory ? (await this.diffs.read(entry.id)) ?? '' : '' };
        }
        case 'setHosting': return await this.changeHosting(parsed.id, parsed.preset);
        case 'acceptSuggestion': return await this.once(parsed.id, () => this.acceptSuggestion(parsed.id));
        case 'declineSuggestion': return await this.once(parsed.id, () => this.declineSuggestion(parsed.id));
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

  /**
   * A session's title, state, matter and workspace, with its last replies. State is this process's view; `liveHere` says whether it runs
   * here. A matter's conversation reads only the matter's sessions.
   */
  async sessionRecent(sessionId: string, caller: ToolCaller) {
    const { signal } = caller;
    const { scope } = this.callerSession(caller, false);
    checkReach(scope, sessionId);
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

  /**
   * Start a session in a matter's workspace, put it in the matter, send it the task with the user's words of the turn, and leave a
   * receipt. A matter's conversation starts sessions in its own matter only, and watches them for 往回报. In a hosted matter the session
   * gets the matter's permission preset before the task, so its first turn runs under it; when the preset cannot be applied, no task is
   * sent rather than one running under DSH's default.
   */
  async startSession(args: { matterId?: string; title: string; task: string; why: string }, caller: ToolCaller) {
    const { session, scope } = this.callerSession(caller, true);
    const title = required(args.title, '标题', TITLE_MAX);
    const task = args.task.trim();
    if (!task) throw new RequestError('task 不能为空');
    if ([...task].length > TASK_MAX) throw new RequestError(`task 最多 ${TASK_MAX} 个字`);
    const why = required(args.why, 'why', WHY_MAX);
    const matterId = matterFor(scope, args.matterId);
    const matter = this.store.list().find(candidate => candidate.id === matterId);
    if (!matter) throw new RequestError(`没有这个事项：${matterId}`);
    const choice = chooseWorkspace(matter, this.boardIndex());
    if ('problem' in choice) throw new RequestError(choice.problem);
    const hosting = matter.hosting ? { preset: matter.hosting.preset, service: this.presetService(matter, matter.hosting.preset) } : undefined;

    const { sessionId } = await this.ctx.sessionController.create({ workspaceId: choice.workspace.id as WorkspaceId });
    await this.ctx.sessionController.rename({ sessionId, title });
    const live = await this.ctx.sessionController.resolveAgent(sessionId);
    if ('error' in live) throw live.error;
    if (hosting) {
      try {
        hosting.service.set(live.agent.session, hosting.preset);
      } catch (error) {
        throw new RequestError(`「${matter.name}」托管用的权限预设 ${hosting.preset} 没能设到新会话上，任务没有发：${message(error)}`);
      }
    }
    // In the matter before the task goes in: its first step reads the matter's context, and 往回报 follows it from its first turn.
    const at = new Date().toISOString();
    const joined = await this.store.update(matters => addSession(matters, matter.id, { sessionId, by: 'mydsh', at, why }));
    if (scope.kind === 'conversation') this.books = watch(this.books, scope.sessionId, sessionId);
    const sent = sentText(task, this.turns.get(session.id)?.prompt, `${ASK_USER_LINE}\n${RESULT_LINE}`);
    live.agent.followup(createUserMessage({ content: [{ type: 'text', text: sent }], source: { kind: 'my-dsh' } }));

    const id = randomUUID();
    const card = this.leaveCard(session, id, 'receipt');
    const entry = startEntry({ id, at, matterId: joined.id, matterName: joined.name, sessionId, title, why, task, card });
    await this.assistant.update(state => ({ state: { ...state, activity: appendActivity(state.activity, entry) }, result: undefined }));
    return { sessionId, matterId: joined.id, workspace: choice.workspace.title, ...(hosting ? { preset: hosting.preset } : {}), receipt: entry.text };
  }

  /**
   * Send the user's words of the turn into an existing session as steering, so a running session reads them at its next step and an idle
   * one starts a turn, and leave a receipt. A matter's conversation sends to its matter's sessions only, and watches the one it sent to
   * for 往回报.
   */
  async sendToSession(args: { sessionId: string; text: string; why: string }, caller: ToolCaller) {
    const { session, scope } = this.callerSession(caller, true);
    const text = args.text.trim();
    if (!text) throw new RequestError('text 不能为空');
    if ([...text].length > TASK_MAX) throw new RequestError(`text 最多 ${TASK_MAX} 个字`);
    const why = required(args.why, 'why', WHY_MAX);
    checkReach(scope, args.sessionId);
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
    live.agent.steer(createUserMessage({ content: [{ type: 'text', text: sentText(text, this.turns.get(session.id)?.prompt, RESULT_LINE) }], source: { kind: 'my-dsh' } }));
    if (scope.kind === 'conversation') this.books = watch(this.books, scope.sessionId, args.sessionId);

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

  /**
   * Write what the user said about a matter into its memory as a file of the user's own (by 你说的), with the calling session as its
   * source, and leave a receipt. A matter's conversation writes into its own matter only.
   */
  async noteMatter(args: { matterId?: string; kind: NoteKind; text: string }, caller: ToolCaller) {
    const { session, scope } = this.callerSession(caller, true);
    if (!NOTE_KINDS.includes(args.kind)) throw new RequestError(`kind 只能是 ${NOTE_KINDS.join('、')}`);
    const text = noteText(args.text);
    const matterId = matterFor(scope, args.matterId);
    const matter = this.store.list().find(candidate => candidate.id === matterId);
    if (!matter) throw new RequestError(`没有这个事项：${matterId}`);
    const scan = this.memory.scanOf(matter.id);
    if (!scan) throw new RequestError('这件事项的记忆还没准备好，稍后再试');
    const description = clipDescription(text);
    if (scan.entries.some(entry => entry.userOwned && entry.description === description)) throw new RequestError('这件事项的记忆里已经有这一条了');
    const now = Date.now();
    const name = shortName(text);
    const path = freePath(CATEGORIES[args.kind], name, [...scan.texts.keys(), ...scan.flagged.map(file => file.path)]);
    const content = renderMemoryFile({ name, description, by: USER_BY, sources: [session.id], verified: '用户说的', updated: dayKey(now, this.timeZone()), body: text });
    const { applied, skipped } = await this.memory.apply(matter.id, [{ op: 'add', path, content }]);
    if (applied.length === 0) throw new RequestError(`没记进去：${skipped[0]?.reason ?? '写不进记忆的文件夹'}`);
    const id = randomUUID();
    const card = this.leaveCard(session, id, 'receipt');
    const at = new Date(now).toISOString();
    const entry = noteEntry({ id, at, matterId: matter.id, matterName: matter.name, note: { id: `n-${randomUUID()}`, text, path, hash: contentHash(content) }, card });
    await this.recordActivity([{ entry, diff: unifiedDiff(path, null, content) }]);
    return { matterId: matter.id, file: path, receipt: entry.text };
  }

  /**
   * Pass the user's own words to a matter's conversation, made when there is none, as the user's message there, and leave a receipt.
   * The words are the user's last `messages` messages in my dsh's conversation, as written, without card replies; only text goes. Only
   * my dsh's own session passes words on, in a turn the user started.
   */
  async forwardToMatter(args: { matterId: string; messages?: number; why: string }, caller: ToolCaller) {
    const { session } = this.callerSession(caller, true, 'assistant');
    const why = required(args.why, 'why', WHY_MAX);
    const count = args.messages ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > FORWARD_MESSAGES_MAX) throw new RequestError(`messages 只能是 1 到 ${FORWARD_MESSAGES_MAX}`);
    const matter = this.store.list().find(candidate => candidate.id === args.matterId.trim());
    if (!matter) throw new RequestError(`没有这个事项：${args.matterId}`);
    if (matter.archivedAt) throw new RequestError(`「${matter.name}」已归档，转不过去。先恢复它。`);
    const page = await this.ctx.sessionController.events({ address: { kind: 'session', sessionId: session.id }, maxMessages: FORWARD_SCAN }, caller.signal);
    const words = userWords(page.records, count);
    if (!words.text) throw new RequestError('没找到用户的原话，没有转');
    if (onlyNames(words.text, this.store.list().map(candidate => candidate.name))) {
      throw new RequestError('用户的话里只有名字，没说要那边做什么，没有转。先问用户要做什么。');
    }
    const conversationId = await this.ensureConversation(matter.id);
    try {
      await this.ctx.sessionController.prompt({
        requestId: randomUUID() as SessionRequestId, sessionId: conversationId as SessionId, mode: 'queue',
        content: [{ type: 'text', text: words.text }],
      }, caller.signal);
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'session/writer-held') {
        throw new RequestError(`「${matter.name}」的对话正被另一个 DSH 进程打开（比如桌面端），这里转不进去。到那个进程里说，或者先在那边关掉它。`);
      }
      throw error;
    }
    const at = new Date().toISOString();
    const id = randomUUID();
    const card = this.leaveCard(session, id, 'forward');
    const entry = forwardEntry({ id, at, matterId: matter.id, matterName: matter.name, sessionId: conversationId, words: words.text, why, card });
    await this.assistant.update(state => ({ state: { ...state, activity: appendActivity(state.activity, entry) }, result: undefined }));
    return {
      matterId: matter.id, matter: matter.name, messages: words.messages,
      ...(words.attachments ? { attachmentsLeft: `${words.attachments} 个附件没转过去，只转了文字` } : {}), receipt: entry.text,
    };
  }

  /** A matter's name for a tool call's title, or undefined for an id it does not know. */
  nameOfMatter(matterId: string): string | undefined {
    return this.store.list().find(matter => matter.id === matterId)?.name;
  }

  /** Store a proposal for the user to accept or decline on its card. Nothing changes here. */
  async proposeChange(args: {
    kind: ProposalChange['kind']; name?: string; goal?: string; workspaceId?: string; matterId?: string; fromId?: string; intoId?: string;
    phrase?: string; why: string;
  }, caller: ToolCaller) {
    const { session } = this.callerSession(caller, false, 'assistant');
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
    const { session } = this.callerSession(caller, false, 'assistant');
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

  /**
   * A matter's own conversation: the stored one while it is listed and not archived, else a new session in the workspace start_session
   * would choose, or in the matter's own folder when there is none. It runs the user's default preset and is titled after the matter.
   */
  private ensureConversation(matterId: string): Promise<string> {
    let running = this.conversing.get(matterId);
    if (!running) {
      running = this.checkConversation(matterId).finally(() => { this.conversing.delete(matterId); });
      this.conversing.set(matterId, running);
    }
    return running;
  }

  private async checkConversation(matterId: string): Promise<string> {
    const matter = this.store.list().find(candidate => candidate.id === matterId);
    if (!matter) throw new RequestError('没有这个事项');
    if (matter.archivedAt) throw new RequestError('这件事项已归档，先恢复它');
    if (matter.conversation && await this.alive(matter.conversation)) return matter.conversation;
    const choice = chooseWorkspace(matter, this.boardIndex());
    let where: { workspaceId: WorkspaceId } | { cwd: string };
    if ('workspace' in choice) {
      where = { workspaceId: choice.workspace.id as WorkspaceId };
    } else {
      where = { cwd: this.matterFolder(matter.id) };
      await mkdir(where.cwd, { recursive: true });
    }
    const { sessionId } = await this.ctx.sessionController.create(where);
    await this.store.update(matters => setConversation(matters, matter.id, sessionId));
    // A title set by rename is pinned, as for my dsh's own session.
    try {
      await this.ctx.sessionController.rename({ sessionId, title: matter.name });
    } catch (error) {
      this.ctx.logger.warn('my-dsh: the conversation of %s could not be titled: %s', matter.id, message(error));
    }
    return sessionId;
  }

  /** The session is listed and not archived. An archived session cannot run turns. */
  private async alive(sessionId: string): Promise<boolean> {
    await this.loadSessions();
    if (!this.sessions.has(sessionId)) await this.listSessions();
    return this.sessions.has(sessionId) && !this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId as SessionId);
  }

  /** What a session is to my dsh's tools: my dsh's own, a matter's conversation, or neither. */
  private callerKind(sessionId: string | undefined): Caller | undefined {
    return callerOf(sessionId, this.assistant.peek().sessionId, this.store.list());
  }

  /**
   * The tool runs in my dsh's own session or, unless `only` says so, in a matter's conversation; with `userTurn`, in a turn a person's
   * prompt started.
   * @returns the session and what it is, with the conversation's matter.
   */
  private callerSession(caller: ToolCaller, userTurn: boolean, only?: 'assistant'): { session: Session; scope: Caller } {
    const session = caller.agent?.session;
    if (!session) throw new RequestError('这个工具要在会话里调用');
    const scope = this.callerKind(session.id);
    if (!scope || (only && scope.kind !== only)) {
      throw new RequestError(only ? '这个工具只在首页的 my dsh 对话里能用' : '这个工具只在首页的 my dsh 和事项的对话里能用');
    }
    if (userTurn && !this.turns.get(session.id)?.byUser) throw new RequestError('这一轮不是用户发起的，my dsh 不往会话里写');
    return { session, scope };
  }

  // ── 往回报 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A turn ended: a watched session's leaves a note for its dispatcher, a dispatcher's may end a wake; each is checked for a wake soon. */
  private turnEnded(sessionId: string, outcome: string): void {
    const dispatchers = watchersOf(this.books, sessionId);
    if (dispatchers.length) {
      this.books = noteTurnEnd(this.books, this.noteFor(sessionId, outcome));
      for (const dispatcher of dispatchers) this.scheduleWake(dispatcher);
    }
    if (this.books.has(sessionId)) {
      this.books = wakeTurnEnded(this.books, sessionId, outcome);
      this.scheduleWake(sessionId);
    }
  }

  /** What a watched session's ended turn leaves: its title, how it ended, and its newest reply or its error. */
  private noteFor(sessionId: string, outcome: string): ReportNote {
    const view = this.sessions.view(sessionId);
    const preview = view?.preview;
    const text = outcome === 'completed'
      ? this.sessions.fullReply(sessionId) ?? (preview?.kind === 'reply' ? preview.text : undefined)
      : outcome === 'error' && preview?.kind === 'failed' ? preview.error : undefined;
    const refused = this.sessions.refused(sessionId);
    return { sessionId, title: this.titleOf(sessionId), outcome, ...(text ? { text } : {}), ...(refused.length ? { refused: [...refused] } : {}) };
  }

  /** Check the dispatcher for a wake {@link WAKE_DELAY_MS} from now; another event in that time starts the wait again. */
  private scheduleWake(dispatcher: string): void {
    if (this.lifetime.signal.aborted) return;
    clearTimeout(this.wakeTimers.get(dispatcher));
    this.wakeTimers.set(dispatcher, setTimeout(() => {
      this.wakeTimers.delete(dispatcher);
      void this.wake(dispatcher).catch((error: unknown) => { this.ctx.logger.warn('my-dsh: %s was not woken: %s', dispatcher, message(error)); });
    }, WAKE_DELAY_MS));
  }

  /**
   * Wake the dispatcher with its notes when its book says so, as a message DSH's chat shows as a child task's update. When its agent
   * cannot be had here (another DSH process holds it, say), the notes stay for the next event.
   */
  private async wake(dispatcher: string): Promise<void> {
    this.forgetGone();
    if (!shouldWake(this.books.get(dispatcher), this.wakeStates(dispatcher))) return;
    const live = await this.ctx.sessionController.resolveAgent(dispatcher as SessionId);
    if ('error' in live) {
      this.ctx.logger.warn('my-dsh: %s was not woken: %s', dispatcher, message(live.error));
      return;
    }
    // The book may have changed while the agent was resolved.
    const book = this.books.get(dispatcher);
    if (!book || !shouldWake(book, this.wakeStates(dispatcher))) return;
    const newest = book.notes.at(-1)!;
    live.agent.followup(createUserMessage({
      content: [{ type: 'text', text: reportText(book.notes, this.waitingOf(book.watched)) }],
      source: { kind: 'subagent-settled', form: 'notice', summary: reportSummary(book.notes), senderSessionId: newest.sessionId as SessionId },
    }));
    this.books = wakeSent(this.books, dispatcher);
  }

  /** The states the wake decision reads: the dispatcher's, whether DSH archived it, whether its matter is hosted, and each watched session's. */
  private wakeStates(dispatcher: string): WakeStates {
    const watched = this.books.get(dispatcher)?.watched ?? [];
    const matter = conversationOf(this.store.list(), dispatcher);
    return {
      dispatcher: this.sessions.view(dispatcher)?.state,
      archived: this.ctx.workspaceRegistry.archivedSessionIds.includes(dispatcher as SessionId),
      hosted: matter !== undefined && !matter.archivedAt && matter.hosting !== undefined,
      sessions: new Map(watched.map(id => [id, this.sessions.view(id)?.state])),
    };
  }

  /** The watched sessions that wait for the user now, with the tool an approval is for. */
  private waitingOf(watched: readonly string[]): WaitingSession[] {
    return watched.flatMap((sessionId): WaitingSession[] => {
      const view = this.sessions.view(sessionId);
      if (view?.state !== 'waiting' || !view.wait) return [];
      const tool = view.preview?.kind === 'approval' ? view.preview.tool : '';
      return [{ sessionId, title: displayTitle(view), wait: view.wait, ...(tool ? { tool } : {}) }];
    });
  }

  /**
   * Drop what 往回报 no longer follows: a dispatcher archived in DSH or no longer the conversation of a matter in progress, with its
   * pending check; and a watched session archived in DSH or out of its dispatcher's matter.
   */
  private forgetGone(): void {
    if (this.books.size === 0) return;
    const archived = new Set<string>(this.ctx.workspaceRegistry.archivedSessionIds);
    const matters = this.store.list();
    for (const [dispatcher, book] of this.books) {
      const caller = callerOf(dispatcher, this.assistant.peek().sessionId, matters);
      if (caller?.kind !== 'conversation' || archived.has(dispatcher)) {
        this.books = forgetDispatcher(this.books, dispatcher);
        clearTimeout(this.wakeTimers.get(dispatcher));
        this.wakeTimers.delete(dispatcher);
        continue;
      }
      for (const sessionId of book.watched) {
        if (archived.has(sessionId) || !caller.matter.sessions.some(link => link.sessionId === sessionId)) this.books = forgetSession(this.books, dispatcher, sessionId);
      }
    }
  }

  /** Mark where a card belongs: a record in my dsh's log, and the turn it is under. */
  private leaveCard(session: Session, id: string, type: 'proposal' | 'which' | 'receipt' | 'forward'): CardPlace {
    try {
      appendPluginRecord(session, 'plugin:my-dsh/card', { id, type });
    } catch (error) {
      this.ctx.logger.warn('my-dsh: the card record could not be written: %s', message(error));
    }
    return { sessionId: session.id, turn: this.turns.get(session.id)?.turn ?? -1 };
  }

  // ── changes by hand and on cards ──────────────────────────────────────────────────────────────────────────────────────────────

  /** The matter's own folder in the data directory: its uploads under `files`, and the working directory of a conversation outside every workspace. */
  private matterFolder(matterId: string): string {
    return join(this.directory, 'matters', matterId);
  }

  /** A context from a dialog, checked: the workspace exists, paths exist, links are read again, uploads are copied into the matter's folder. */
  private async matterContext(input: Partial<ContextInput>, matterId: string, signal: AbortSignal): Promise<MatterContext> {
    const workspaceId = input.workspaceId ?? undefined;
    if (workspaceId && !this.ctx.workspaceRegistry.get(workspaceId as WorkspaceId)) throw new RequestError('没有这个工作区');
    const sources = await resolveSources(input.sources ?? [], { read: this.uploads(), files: join(this.matterFolder(matterId), 'files'), signal });
    return { ...(workspaceId ? { workspaceId } : {}), sources, ...(input.instructions ? { instructions: input.instructions } : {}) };
  }

  /** Reads files uploaded through DSH, when this DSH keeps an attachment store. */
  private uploads(): ReadUpload | undefined {
    const attachments = this.ctx.get('attachments');
    if (!attachments) return undefined;
    return (upload, signal) => attachments.readFileStream({ attachmentId: upload.attachmentId, name: upload.name, bytes: upload.bytes } as FileAttachmentRef, signal);
  }

  /** The presets a matter can be hosted under, as DSH's permission preset service offers them now; none without the service. */
  private presetOptions(): { value: string; name: string }[] {
    const service = this.permissionPresets;
    return service ? hostingPresets(service.catalog().options) : [];
  }

  /** Host a matter under a preset the service offers now, or stop hosting it with null, which needs no service. */
  private async changeHosting(matterId: string, preset: string | null): Promise<Matter> {
    if (preset !== null) {
      if (!this.permissionPresets) throw new RequestError('这个 DSH 没有权限预设，托管不了');
      if (!this.presetOptions().some(option => option.value === preset)) throw new RequestError('没有这个权限预设');
    }
    const at = new Date().toISOString();
    return await this.store.update(matters => setHosting(matters, matterId, preset === null ? null : { preset, at }));
  }

  /** The service a hosted matter's new session gets its preset from; a RequestError naming the preset when it cannot be applied. */
  private presetService(matter: Matter, preset: string): PermissionPresetsLike {
    const service = this.permissionPresets;
    if (!service) throw new RequestError(`「${matter.name}」托管在权限预设 ${preset} 下，这个 DSH 没有权限预设，没有开会话。`);
    if (!this.presetOptions().some(option => option.value === preset)) {
      throw new RequestError(`「${matter.name}」托管用的权限预设 ${preset} 在这个 DSH 里没有了，没有开会话。告诉用户在事项页改托管。`);
    }
    return service;
  }

  private async fileByHand(matterId: string, sessionId: string): Promise<Matter> {
    await this.requireSession(sessionId);
    if (sessionId === this.assistant.peek().sessionId) throw new RequestError('my dsh 自己不能放进事项');
    if (conversationOf(this.store.list(), sessionId)) throw new RequestError('事项的对话不能放进事项');
    const at = new Date().toISOString();
    const { matter, before } = await this.store.update((matters) => {
      const before = linkOf(matters, sessionId);
      const changed = addSession(matters, matterId, { sessionId, by: 'manual', at });
      return { matters: changed.matters, matter: { matter: changed.matter, before } };
    });
    // 产物: what the session wrote before it joined.
    void this.backfill(sessionId);
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

  /**
   * Take back a session my dsh started or one filed by hand: it leaves the matter and is kept; a started one stops its turn. The file a
   * note wrote into a matter's memory is deleted while it is still as it was written.
   */
  private async undo(id: string): Promise<ActivityView> {
    const entry = this.assistant.peek().activity.find(candidate => candidate.id === id);
    if (!entry) throw new RequestError('没有这条记录');
    if (entry.kind === 'note') {
      const file = noteFile(entry);
      const { applied } = await this.memory.apply(file.matterId, [{ op: 'delete', path: file.path, expect: file.hash }]);
      if (applied.length === 0) throw new RequestError('这条已经撤不回了');
    } else {
      await this.store.update(matters => undoChange(matters, entry));
    }
    if (entry.kind === 'start' && entry.sessionId) await this.stop(entry.sessionId);
    const at = new Date().toISOString();
    // An accepted suggestion of 自动归类 that is taken back is declined with it, so it is not made again.
    const refused = entryKey(entry);
    if (refused) await this.grouping.refuse([refused], at);
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
    const accepted = await this.assistant.update((state) => {
      const decided = decideProposal(state.proposals, id, { state: 'accepted', at, ...(proposal.change.kind === 'new' ? { matterId: matter.id } : {}) });
      const entry = manageEntry({ id: randomUUID(), at, matterId: matter.id, matterName: matter.name, text, why: proposal.why });
      return { state: { ...state, proposals: decided.proposals, activity: appendActivity(state.activity, entry) }, result: decided.proposal };
    });
    // A new matter goes back to my dsh as the user's answer, so it can pass on what the user asked for there.
    if (proposal.change.kind === 'new') {
      try {
        await this.ctx.sessionController.prompt({
          requestId: randomUUID() as SessionRequestId, sessionId: proposal.sessionId as SessionId, mode: 'queue',
          content: [{ type: 'text', text: `新起了事项「${matter.name}」` }],
        }, this.lifetime.signal);
      } catch (error) {
        this.ctx.logger.warn('my-dsh: the new matter was not told to my dsh: %s', message(error));
      }
    }
    return accepted;
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

  // ── 自动归类 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The board was read: the first read after the Host started checks whether a run is due. */
  private boardOpened(): void {
    if (this.boardRead) return;
    this.boardRead = true;
    this.groupingCheck();
  }

  /** Start a run when one is due ({@link groupingDue}) and none runs; the caller does not wait for it. */
  private groupingCheck(): void {
    if (this.groupingRun || this.lifetime.signal.aborted) return;
    const modelReady = this.llm !== undefined && this.defaultModel !== undefined;
    const matters = this.store.list();
    const [newest] = this.looseNow(matters);
    const changes = [...(newest ? [newest.lastActivity] : []), ...matters.filter(matter => !matter.archivedAt).map(matter => Date.parse(matter.createdAt))]
      .filter(Number.isFinite);
    const changedAt = changes.length > 0 ? Math.max(...changes) : undefined;
    if (!groupingDue({ runs: this.grouping.peek().runs, modelReady, now: Date.now(), changedAt })) return;
    this.groupingRun = this.group()
      .catch((error: unknown) => { this.ctx.logger.warn('my-dsh: a run of automatic grouping was not recorded: %s', message(error)); })
      .finally(() => { this.groupingRun = undefined; });
  }

  /** The loose sessions of the review's window ({@link looseSessions}), newest first. */
  private looseNow(matters: readonly Matter[]): SessionView[] {
    return looseSessions(this.sessions.all().map(sessionView), {
      matters, archived: new Set(this.ctx.workspaceRegistry.archivedSessionIds), hidden: this.conversations(matters), since: Date.now() - REVIEW_DAYS * DAY_MS,
    });
  }

  /**
   * One run over the loose sessions of the review's window: the newest ones' logs read for evidence, the origin rules, then the model for
   * the sessions the rules left, when there is a model. The run's suggestions replace the pending ones. A run that fails is recorded with
   * why and the next check runs again; when the model step failed or had no model, the rules' suggestions go in beside the earlier model
   * ones.
   */
  private async group(): Promise<void> {
    const at = new Date().toISOString();
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(PASS_TIMEOUT_MS)]);
    const counts = { loose: 0, read: 0, asked: 0, origin: 0, model: 0 };
    let made: Made[] | undefined;
    let error: string | undefined;
    let modelUnavailable = false;
    try {
      await this.loadSessions();
      const matters = this.store.list();
      const loose = this.looseNow(matters);
      counts.loose = loose.length;
      counts.read = await this.readEvidence(loose.slice(0, GROUPING_LOGS), signal);
      const input = await this.ruleInput(loose, matters, await this.scheduleEntries());
      const origin = originSuggestions(input);
      counts.origin = origin.suggestions.length;
      made = [...origin.suggestions];
      const rest = input.loose.filter(session => !origin.placed.has(session.id)).slice(0, MODEL_SESSIONS_MAX);
      if (rest.length > 0 && (!this.llm || !this.defaultModel)) {
        modelUnavailable = true;
      } else if (rest.length > 0) {
        try {
          const model = await this.askGrouping(rest, input, signal);
          counts.asked = rest.length;
          counts.model = model.length;
          made.push(...model);
        } catch (failure) {
          if (this.lifetime.signal.aborted) return;
          error = message(failure);
        }
      }
    } catch (failure) {
      if (this.lifetime.signal.aborted) return;
      error = message(failure);
    }
    const run: GroupingRun = {
      at, endedAt: new Date().toISOString(), ...counts, ...(modelUnavailable ? { modelUnavailable: true as const } : {}), ...(error !== undefined ? { error } : {}),
    };
    await this.grouping.recordRun(
      { run, ...(made ? { made, keepModel: error !== undefined || modelUnavailable } : {}) },
      { at: run.endedAt, id: () => `sg-${randomUUID()}`, takenOut: this.corrections.takenOut() },
    );
  }

  /** my dsh's own session and each matter's conversation: conversations, not work. */
  private conversations(matters: readonly Matter[]): Set<string> {
    const own = this.assistant.peek().sessionId;
    return new Set([...(own ? [own] : []), ...matters.flatMap(matter => (matter.conversation ? [matter.conversation] : []))]);
  }

  /**
   * Read each session's log after its cursor for evidence, the newest session first, skipping one with no activity since its last read.
   * One write for all, which also lets go of the evidence of sessions DSH no longer lists.
   * @returns how many logs were read.
   */
  private async readEvidence(sessions: readonly SessionView[], signal: AbortSignal): Promise<number> {
    const stored = this.grouping.peek().evidence;
    const updates: Record<string, SessionEvidence> = {};
    for (const view of sessions) {
      signal.throwIfAborted();
      const known = stored[view.id];
      if (known && known.readAt >= view.lastActivity) continue;
      let events: HistoryEvent[];
      try {
        events = await this.historyAfter(view.id, known?.cursor ?? -1, signal);
      } catch {
        signal.throwIfAborted();
        continue;
      }
      updates[view.id] = foldEvidence(known ?? emptyEvidence(), events, view.id, Date.now());
    }
    await this.grouping.noteEvidence(updates, new Set(this.sessions.all().map(track => track.id)));
    return Object.keys(updates).length;
  }

  /**
   * What the origin rules read of the loose sessions and of the sessions of matters in progress: the branch noted when their turns ended,
   * else their worktree's (one git read per working directory), their PRs, the sessions they referenced, and the scheduled tasks they ran.
   */
  private async ruleInput(loose: readonly SessionView[], matters: readonly Matter[], schedules: readonly ScheduleEntry[]): Promise<RuleInput> {
    const { tasks, runs } = scheduleFacts(schedules);
    const active = matters.filter(matter => !matter.archivedAt);
    const filed = active.flatMap(matter => matter.sessions.flatMap((link) => {
      const view = this.sessions.view(link.sessionId);
      return view ? [{ view, matterId: matter.id }] : [];
    }));
    const dirs = [...new Set([...loose, ...filed.map(item => item.view)].flatMap((view) => { const cwd = this.cwds.get(view.id); return cwd ? [cwd] : []; }))];
    const git = new Map<string, GitFacts | undefined>(await Promise.all(dirs.slice(0, GROUPING_DIRS).map(async dir => [dir, await readGit(dir)] as const)));
    const { evidence, branches, declined } = this.grouping.peek();
    const session = (view: SessionView, matterId?: string): RuleSession => {
      const cwd = this.cwds.get(view.id);
      const facts = cwd ? git.get(cwd) : undefined;
      const known = evidence[view.id];
      const branch = sessionBranch(branches[view.id], facts);
      return {
        id: view.id, title: displayTitle(view), lastActivity: view.lastActivity, ...(matterId ? { matterId } : {}), ...(branch ? { branch } : {}),
        prs: sessionPrs(known, facts?.remote), refs: known?.refs ?? [], runs: [...new Set([...(known?.schedules ?? []), ...(runs.get(view.id) ?? [])])],
      };
    };
    const prsOf = (matter: Matter) => matter.sources.flatMap((source) => { const key = source.kind === 'pr' ? prKey(source.value) : undefined; return key ? [key] : []; });
    return {
      loose: loose.map(view => session(view)), filed: filed.map(item => session(item.view, item.matterId)),
      matters: new Map(active.map(matter => [matter.id, { name: matter.name, prs: prsOf(matter) }])),
      tasks, declined: new Set(declined), takenOut: this.corrections.takenOut(),
    };
  }

  /**
   * The model step: the sessions the rules left, with what DSH's cached turn outline says of their first prompt and last reply, and the
   * matters in progress, the newest first; one call per {@link MODEL_CHUNK} sessions, each answer checked.
   * @throws when the model service is gone, a call fails, or an answer could not be read twice in a row.
   */
  private async askGrouping(sessions: readonly RuleSession[], input: RuleInput, signal: AbortSignal): Promise<Made[]> {
    const cache = this.projectionCache;
    const records = cache ? await this.ctx.sessionQuery.listSessions(signal).catch(() => []) : [];
    const headers = new Map(records.map(record => [record.header.id as string, record.header]));
    const outline = (sessionId: string): unknown => {
      const header = headers.get(sessionId);
      if (!cache || !header) return undefined;
      try {
        return cache.cachedSnapshot(header, ['turnOutline'])?.values.turnOutline;
      } catch {
        return undefined;
      }
    };
    const { evidence } = this.grouping.peek();
    const shown = sessions.map((session): ModelSession => {
      const cwd = this.cwds.get(session.id);
      const trigger = triggerLabel(evidence[session.id]?.trigger);
      const schedules = session.runs.flatMap((id) => { const task = input.tasks.get(id); return task ? [task.title] : []; });
      return {
        id: session.id, title: session.title, ...outlineEnds(outline(session.id)), ...(cwd ? { folder: basename(cwd) } : {}),
        ...(session.branch ? { branch: session.branch.name } : {}), ...(session.prs.length ? { prs: session.prs.map(prName) } : {}),
        ...(trigger ? { trigger } : {}), ...(schedules.length ? { schedules } : {}),
      };
    });
    const matters = this.boardIndex().matters.filter(matter => !matter.archived).slice(0, MODEL_MATTERS_MAX)
      .map(matter => ({ id: matter.id, name: matter.name, goal: matter.goal }));
    const made: Made[] = [];
    for (const chunk of chunked(shown, MODEL_CHUNK)) {
      const call = { matters, sessions: chunk };
      const answer = await this.askModelFor(GROUPING_SYSTEM, groupingPrompt(call), signal, text => readGrouping(text, call), 'my-dsh-grouping');
      if (!answer) throw new RequestError('模型的回答两次都不是能读的 JSON');
      made.push(...answer);
    }
    return made;
  }

  /** The branch a session's turn ended on, kept when it names one piece of work: not a shared branch such as main, not a detached HEAD. */
  private async noteBranch(sessionId: string, cwd: string | undefined): Promise<void> {
    if (!cwd) return;
    await this.ready;
    if (this.callerKind(sessionId)) return;
    const facts = await readGit(cwd);
    const branch = facts ? branchKey(facts) : undefined;
    if (branch) await this.grouping.noteBranch(sessionId, { ...branch, at: Date.now() });
  }

  /**
   * Accept a pending suggestion as the card shows it now: a new matter gets its name, goal, main workspace and sessions; a filing puts
   * the session in its matter. The links carry the suggestion's provenance, rule and reason; 做事记录 gets an entry that can be undone,
   * and 产物 reads what the sessions wrote before they joined.
   */
  private async acceptSuggestion(id: string): Promise<Matter> {
    const stored = this.grouping.peek().suggestions.find(suggestion => suggestion.id === id);
    if (!stored) throw new RequestError('没有这条建议');
    if (stored.state !== 'pending') throw new RequestError('这条建议已经处理过了');
    await this.loadSessions();
    // What the card shows of it: its sessions while they are all loose, its matter while in progress, the main workspace.
    const view = this.boardSnapshot([]).suggestions?.find(suggestion => suggestion.id === id);
    if (!view) throw new RequestError('这条建议已经不适用了：里面的会话归进了事项、归档了或不在了');
    const at = new Date().toISOString();
    const sessions = view.sessions.map(session => session.id);
    const link = (sessionId: string): SessionLink => ({ sessionId, by: stored.by, at, why: stored.why, ...(stored.rule ? { rule: stored.rule } : {}) });
    const matter = await this.store.update((matters) => {
      if (sessions.some(sessionId => linkOf(matters, sessionId))) throw new RequestError('这条建议已经不适用了：里面的会话归进了事项');
      if (view.kind === 'file') return addSession(matters, view.matter!.id, link(sessions[0]!));
      let changed = createMatter(matters, { name: view.name!, goal: view.goal ?? '', ...(view.workspace ? { workspaceId: view.workspace.id } : {}) }, { id: randomUUID(), at });
      const made = changed.matter.id;
      for (const sessionId of sessions) changed = addSession(changed.matters, made, link(sessionId));
      return changed;
    });
    // A run may have replaced it meanwhile; the sessions are filed all the same, and no run suggests them again.
    await this.grouping.decide(id, { state: 'accepted', at, matterId: matter.id }).catch(() => undefined);
    const entry = groupEntry({
      id: randomUUID(), at, matterId: matter.id, matterName: matter.name, sessions: view.sessions.map(session => ({ id: session.id, title: session.title })),
      created: view.kind === 'new', by: stored.by, why: stored.why,
    });
    await this.assistant.update(state => ({ state: { ...state, activity: appendActivity(state.activity, entry) }, result: undefined }));
    for (const sessionId of sessions) void this.backfill(sessionId);
    return matter;
  }

  /** Decline a suggestion for good: its never-again key is kept, and corrections.jsonl gets what it would have done and why. */
  private async declineSuggestion(id: string): Promise<{ id: string }> {
    const at = new Date().toISOString();
    const suggestion = await this.grouping.decide(id, { state: 'declined', at });
    await this.corrections.append(suggestionCorrection(suggestion, at));
    return { id };
  }

  // ── reading the board ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Something the board shows changed. */
  private changed(): void {
    this.feed.touch();
  }

  private async snapshot(): Promise<BoardSnapshot> {
    await this.loadSessions();
    this.boardOpened();
    const [schedules, usage] = await Promise.all([this.scheduleEntries(), this.usageStats()]);
    const snapshot = this.boardSnapshot(schedules);
    const own = new Map(this.store.list().map(matter => [matter.id, matter]));
    return {
      ...snapshot,
      usage,
      activity: this.assistant.peek().activity.length,
      matters: snapshot.matters.map((matter) => {
        const memory = this.memoryView(matter.id);
        const stored = own.get(matter.id);
        const artifacts = stored ? this.artifactView(stored) : [];
        return { ...matter, ...(memory ? { memory } : {}), ...(artifacts.length ? { artifacts } : {}) };
      }),
    };
  }

  // ── 事项记忆 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The matter context a session reads each step: its matter's goal, instructions, sources and memory; for a matter's conversation, the
   * conversation's rules first and the matter's live sessions after; nothing for other sessions. The memory block stays the same for
   * the whole of a session's turn.
   */
  private matterContextFor(sessionId: string | undefined): string {
    const caller = this.callerKind(sessionId);
    if (caller?.kind === 'conversation') {
      return conversationContext(caller.matter, this.listedSessions(caller.matter), caller.matter.hosting?.preset, this.memoryBlock(caller.matter, caller.sessionId, true));
    }
    if (!sessionId || caller) return '';
    const matter = this.store.list().find(candidate => !candidate.archivedAt && candidate.sessions.some(link => link.sessionId === sessionId));
    if (!matter) return '';
    return matterContext(matter, this.memoryBlock(matter, sessionId, false));
  }

  /**
   * The memory block of a session's context, made once for the turn the session is in. None until the matter's folder was first read
   * after a start, so no turn keeps an index that is not there yet.
   */
  private memoryBlock(matter: Matter, sessionId: string, conversation: boolean): string | undefined {
    const scan = this.memory.scanOf(matter.id);
    if (!scan) return undefined;
    return this.freeze.text(sessionId, this.turns.get(sessionId)?.turn ?? -1, () => memoryContext({
      dir: scan.dir, index: scan.index.text, sessionId,
      ...(conversation ? {} : { title: this.titleOf(sessionId) }), conversation,
    }));
  }

  /** A matter's live sessions as its conversation lists them: known here, not archived in DSH, in the order they joined. */
  private listedSessions(matter: Matter): ListedSession[] {
    const archived = new Set<string>(this.ctx.workspaceRegistry.archivedSessionIds);
    return matter.sessions.flatMap((link): ListedSession[] => {
      const view = this.sessions.view(link.sessionId);
      if (!view || archived.has(link.sessionId)) return [];
      return [{ id: view.id, title: displayTitle(view), state: view.state, ...(view.wait ? { wait: view.wait } : {}), ...(view.preview ? { preview: view.preview } : {}), by: link.by }];
    });
  }

  /** The sessions whose turns feed a matter's memory and 产物: its sessions not archived in DSH, and its conversation. */
  private memorySessions(matter: Matter): string[] {
    const archived = new Set<string>(this.ctx.workspaceRegistry.archivedSessionIds);
    return [...matter.sessions.map(link => link.sessionId).filter(id => !archived.has(id)), ...(matter.conversation ? [matter.conversation] : [])];
  }

  /** The matter in progress a session works in, or whose conversation it is. */
  private matterOfSession(sessionId: string): Matter | undefined {
    return this.store.list().find(matter => !matter.archivedAt && (matter.conversation === sessionId || matter.sessions.some(link => link.sessionId === sessionId)));
  }

  /** Set the memory folders up again soon: the matters, their names or their main workspaces changed. */
  private scheduleMemorySync(): void {
    if (this.lifetime.signal.aborted) return;
    clearTimeout(this.memorySyncTimer);
    this.memorySyncTimer = setTimeout(() => { this.memorySyncTimer = undefined; void this.syncMemory(); }, 300);
  }

  /** Each matter in progress keeps its memory in its main workspace, or in the data directory while it has none that exists. */
  private syncMemory(): Promise<void> {
    const run = this.memorySync.then(async () => {
      const paths = new Map<string, string>(this.ctx.workspaceRegistry.list().map(workspace => [workspace.id, workspace.path]));
      const places: MemoryPlace[] = [];
      for (const matter of this.store.list()) {
        if (matter.archivedAt) continue;
        const path = matter.workspaceId ? paths.get(matter.workspaceId) : undefined;
        const folder = path ? await stat(path).then(info => info.isDirectory(), () => false) : false;
        places.push({ matterId: matter.id, name: matter.name, ...(folder && path ? { workspace: path } : {}) });
      }
      await this.memory.sync(places, matterId => this.notes.of(matterId));
    });
    this.memorySync = run.catch((error: unknown) => { this.ctx.logger.warn('my-dsh: the memory folders were not set up: %s', message(error)); });
    return this.memorySync;
  }

  /**
   * On start: the memory folders, then the sessions; the merge check, with 自动归类's, now and every hour; 产物 written while the Host
   * was not running.
   */
  private async startMemory(): Promise<void> {
    try {
      await this.syncMemory();
      await this.diffs.prune(new Set(this.assistant.peek().activity.map(entry => entry.id)));
      await this.loadSessions().catch(() => undefined);
      if (this.lifetime.signal.aborted) return;
      this.mergeCheck();
      this.groupingCheck();
      this.mergeTimer = setInterval(() => { this.mergeCheck(); this.groupingCheck(); }, MERGE_CHECK_MS);
      for (const matter of this.store.list()) {
        if (matter.archivedAt) continue;
        for (const sessionId of this.memorySessions(matter)) await this.backfill(sessionId);
      }
    } catch (error) {
      this.ctx.logger.warn('my-dsh: the memory did not start: %s', message(error));
    }
  }

  /** What the page shows of a matter's memory, once its folder was read. */
  private memoryView(matterId: string): MemoryView | undefined {
    const scan = this.memory.scanOf(matterId);
    if (!scan) return undefined;
    const mergedAt = this.memory.mergedAt(matterId);
    return {
      dir: scan.dir,
      rows: scan.index.order.map(item => ({
        path: item.path, category: item.category, description: clipDescription(item.description),
        ...(!item.userOwned && !item.isVerified ? { unverified: true as const } : {}),
      })),
      flagged: scan.flagged.map(file => ({ ...file })),
      ...(mergedAt !== undefined ? { mergedAt: new Date(mergedAt).toISOString() } : {}),
      ...(this.passing.get(matterId) === 'merge' ? { merging: true as const } : {}),
    };
  }

  /** One file of a matter's memory index, read now; its sources as the page names them. */
  private async memoryFile(matterId: string, path: string): Promise<MemoryFileView> {
    const matter = this.store.list().find(candidate => candidate.id === matterId);
    const scan = this.memory.scanOf(matterId);
    if (!matter || !scan) throw new RequestError('这件事项的记忆还没准备好');
    const known = scan.entries.find(entry => entry.path === path);
    if (!known) throw new RequestError('索引里没有这个文件');
    const text = await this.memory.read(matterId, path);
    if (text === undefined) throw new RequestError('读不到这个文件');
    const checked = checkMemoryFile(path, text, { size: Buffer.byteLength(text, 'utf8'), mtime: known.mtime });
    if (!('entry' in checked)) throw new RequestError(`这个文件没进索引：${checked.flagged.reason}`);
    const { entry } = checked;
    const parsed = parseFrontmatter(text);
    const assistantId = this.assistant.peek().sessionId;
    const sources = entry.sources.flatMap((id): { id: string; title: string }[] => {
      if (id === matter.conversation) return [{ id, title: '对话' }];
      if (id === assistantId) return [{ id, title: 'my dsh' }];
      return this.sessions.has(id) ? [{ id, title: this.titleOf(id) }] : [];
    });
    const updated = parsed?.fields.updated?.trim();
    return {
      path, category: entry.category, name: entry.name, description: entry.description, by: entry.by, userOwned: entry.userOwned, sources,
      verified: entry.verified, ...(updated ? { updated } : {}), body: parsed?.body.trim() ?? '', warnings: entry.warnings,
    };
  }

  /** 产物 of a matter: what its sessions and its conversation wrote, newest first. */
  private artifactView(matter: Matter): ArtifactRowView[] {
    const sessions = this.memorySessions(matter).map((sessionId) => {
      const known = this.artifacts.of(sessionId);
      const cwd = this.cwds.get(sessionId) ?? known.cwd;
      return { sessionId, ...(cwd ? { cwd } : {}), files: known.files };
    });
    return artifactRows(sessions).map(row => ({ ...row, title: row.sessionId === matter.conversation ? '对话' : this.titleOf(row.sessionId) }));
  }

  /** The note ids of `note` entries whose files are still as my dsh wrote them, which can be taken back. */
  private undoableNotes(): Set<string> {
    const ids = new Set<string>();
    const hashes = new Map<string, Map<string, string>>();
    for (const entry of this.assistant.peek().activity) {
      if (entry.kind !== 'note' || entry.undoneAt || !entry.note?.path || !entry.note.hash || !entry.matterId) continue;
      let files = hashes.get(entry.matterId);
      if (!files) {
        files = new Map((this.memory.scanOf(entry.matterId)?.entries ?? []).map(file => [file.path, file.hash]));
        hashes.set(entry.matterId, files);
      }
      if (files.get(entry.note.path) === entry.note.hash) ids.add(entry.note.id);
    }
    return ids;
  }

  /** Append entries to 做事记录 in one write, after the diffs they keep. */
  private async recordActivity(items: readonly { entry: ActivityEntry; diff?: string }[]): Promise<void> {
    if (items.length === 0) return;
    for (const item of items) {
      if (!item.diff) continue;
      await this.diffs.write(item.entry.id, item.diff).catch((error: unknown) => { this.ctx.logger.warn('my-dsh: a memory diff was not kept: %s', message(error)); });
    }
    await this.assistant.update(state => ({ state: { ...state, activity: items.reduce((all, item) => appendActivity(all, item.entry), state.activity) }, result: undefined }));
  }

  /** 做事记录 entries for changes to a matter's memory, each with its diff. */
  private memoryEntries(
    matter: Matter, changes: readonly MemoryChange[], author: (change: MemoryChange) => { by: MemoryAuthor; sessionId?: string },
  ): { entry: ActivityEntry; diff: string }[] {
    const at = new Date().toISOString();
    return changes.map((change) => {
      const who = author(change);
      return {
        entry: memoryEntry({
          id: randomUUID(), at, matterId: matter.id, matterName: matter.name, path: change.path, change: change.change, by: who.by,
          ...(who.sessionId ? { sessionId: who.sessionId, title: who.sessionId === matter.conversation ? '对话' : this.titleOf(who.sessionId) } : {}),
        }),
        // A file that looks like it holds a key keeps it out of the stored diff too.
        diff: looksSecret(change.before ?? '') || looksSecret(change.after ?? '') ? '内容像密钥，改动不显示' : unifiedDiff(change.path, change.before, change.after),
      };
    });
  }

  /** Changes the memory store saw on disk: made by the session whose file call on the file came shortly before, else by the user. */
  private async memoryObserved(matterId: string, changes: readonly MemoryChange[]): Promise<void> {
    const matter = this.store.list().find(candidate => candidate.id === matterId);
    if (!matter) return;
    const scan = this.memory.scanOf(matterId);
    const folders = scan ? [scan.dir, scan.realDir] : [];
    const now = Date.now();
    const writes = this.recentWrites;
    const live = new Set(writes.map(write => `${write.sessionId}\n${write.callId}`));
    for (const key of this.claimedWrites) if (!live.has(key.split('\n').slice(0, 2).join('\n'))) this.claimedWrites.delete(key);
    await this.recordActivity(this.memoryEntries(matter, changes, (change) => {
      const sessionId = claimWriter(change.path, folders, now, writes, this.claimedWrites);
      return sessionId ? { by: 'session', sessionId } : { by: 'user' };
    }));
  }

  /** A path inside some matter's memory folder, which 产物 leave out. */
  private inMemory(path: string): boolean {
    if (path.split(/[\\/]/).includes('.my-dsh')) return true;
    return this.memory.folders().some(folder => within(folder.dir, path) !== undefined || within(folder.realDir, path) !== undefined);
  }

  /**
   * A file tool call in a session's live events: every call is kept a while for telling who changed a memory file; a successful one by
   * a session of a matter in progress (or by its conversation) adds the files it wrote outside the memory folders to 产物.
   */
  private fileEvent(sessionId: string, event: { type: string; time: number; data: unknown }): void {
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string' && FILE_TOOLS.has(data.name)) {
      const cwd = this.cwds.get(sessionId);
      const args = typeof data.arguments === 'string' ? data.arguments : '';
      this.fileCalls.set(`${sessionId}\n${data.callId}`, { sessionId, name: data.name, args, ...(cwd ? { cwd } : {}) });
      this.recentWrites = [
        ...this.recentWrites.filter(write => event.time - write.at <= WRITE_WINDOW_MS),
        { sessionId, callId: data.callId, paths: callTargets(data.name, args, cwd), at: event.time },
      ];
      return;
    }
    if (event.type === 'tool/result' && isRecord(data.message) && typeof data.message.toolCallId === 'string') {
      const callId = data.message.toolCallId;
      const call = this.fileCalls.get(`${sessionId}\n${callId}`);
      if (!call) return;
      this.fileCalls.delete(`${sessionId}\n${callId}`);
      const failed = data.message.isError === true;
      const changes = callChanges(call.name, call.args, { isError: failed, text: resultText(data.message), meta: data.meta }, call.cwd);
      // A failed call (a refused approval fails it too) wrote nothing; a successful one also names the canonical paths it changed.
      this.recentWrites = failed
        ? this.recentWrites.filter(write => !(write.sessionId === sessionId && write.callId === callId))
        : this.recentWrites.map(write => (write.sessionId === sessionId && write.callId === callId
          ? { ...write, paths: [...new Set([...write.paths, ...changes.map(change => change.path)])] }
          : write));
      const kept: TimedChange[] = changes.filter(change => !this.inMemory(change.path)).map(change => ({ ...change, at: event.time }));
      if (kept.length && this.matterOfSession(sessionId)) {
        void this.artifacts.record(sessionId, kept, call.cwd ? { cwd: call.cwd } : {}).catch((error: unknown) => {
          this.ctx.logger.warn('my-dsh: 产物 of %s were not recorded: %s', sessionId, message(error));
        });
      }
      return;
    }
    if (event.type === 'turn/end') {
      for (const [key, call] of this.fileCalls) if (call.sessionId === sessionId) this.fileCalls.delete(key);
    }
  }

  /** An event in one of a matter's sessions: 补记 waits until they have all been quiet for two minutes. */
  private memoryActivity(sessionId: string, time: number): void {
    if (this.lifetime.signal.aborted) return;
    const matter = this.matterOfSession(sessionId);
    if (!matter) return;
    this.lastEvent.set(matter.id, time);
    clearTimeout(this.captureTimers.get(matter.id));
    this.captureTimers.set(matter.id, setTimeout(() => {
      this.captureTimers.delete(matter.id);
      void this.capture(matter.id).catch((error: unknown) => { this.ctx.logger.warn('my-dsh: 补记 of %s did not finish: %s', matter.id, message(error)); });
    }, CAPTURE_QUIET_MS));
  }

  /**
   * A session's own history events after a cursor, or since a moment, oldest first; at most {@link HISTORY_PAGES} pages back, without
   * the parent's history a fork starts with.
   */
  private async historyAfter(sessionId: string, cursor: number, signal: AbortSignal, since?: number): Promise<HistoryEvent[]> {
    const pages: HistoryEvent[][] = [];
    let beforeSeq: number | undefined;
    for (let page = 0; page < HISTORY_PAGES; page += 1) {
      const read = await this.ctx.sessionController.events({
        address: { kind: 'session', sessionId: sessionId as SessionId }, maxMessages: PAGE_MESSAGES, ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      }, signal);
      const events = read.records.flatMap(record => (record.type === 'event' ? [record.event as unknown as HistoryEvent] : []));
      pages.unshift(events);
      const first = events[0];
      if (!read.hasMore || !first || first.seq <= cursor || (since !== undefined && first.time < since)) break;
      beforeSeq = first.seq;
    }
    return ownEvents(pages.flat()).filter(event => event.seq > cursor);
  }

  /** The files of the index as a pass may show them to the model, whole, with their hashes; files left out of the index stay out. */
  private passFiles(scan: MemoryScan): PassFile[] {
    return scan.entries.flatMap((entry): PassFile[] => {
      const text = scan.texts.get(entry.path);
      if (text === undefined) return [];
      const line = indexLine({
        path: entry.path, category: entry.category, name: entry.name, description: entry.description, userOwned: entry.userOwned, isVerified: entry.isVerified, mtime: entry.mtime,
      });
      return [{ path: entry.path, text, hash: entry.hash, line, sources: entry.sources, ...(entry.updated !== undefined ? { updated: entry.updated } : {}) }];
    });
  }

  /** Ask the user's default model for operations; one more try when the answer has none that can be read. */
  private async askModel(system: string, prompt: string, signal: AbortSignal): Promise<RawOp[]> {
    const ops = await this.askModelFor(system, prompt, signal, readOps, 'my-dsh-memory');
    if (ops) return ops;
    throw new RequestError('模型没有给出能用的结果，再整理一次试试');
  }

  /**
   * Ask the user's default model through DSH's model service and read its answer; one more try when `read` finds nothing it can use.
   * @returns what `read` made of the answer, or undefined after two answers it could not use.
   */
  private async askModelFor<T>(system: string, prompt: string, signal: AbortSignal, read: (answer: string) => T | undefined, purpose: string): Promise<T | undefined> {
    const llm = this.llm;
    const model = this.defaultModel;
    if (!llm || !model) throw new RequestError('模型服务还没加载好，稍后再试');
    const selection = model.currentSelection();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let answer = '';
      for await (const chunk of llm.stream({
        ...selection, system, purpose, signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: attempt === 0 ? prompt : `${prompt}\n\n上一次的回答不是能解析的 JSON，只输出那个 JSON 对象。` }] }],
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') answer += chunk.text;
      }
      const value = read(answer);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** Check the model's operations, write the ones that pass, and record the changes in 做事记录 and the pass with what it skipped. */
  private async applyPass(matter: Matter, kind: 'capture' | 'merge', ops: readonly RawOp[], shown: ReadonlyMap<string, string>): Promise<void> {
    const scan = this.memory.scanOf(matter.id);
    if (!scan) return;
    const states = new Map([...scan.texts].map(([path, text]) => [path, { hash: contentHash(text), userOwned: scan.owned.get(path) ?? false }]));
    const checked = checkOps(ops, states, shown, { by: kind === 'capture' ? CAPTURE_BY : MERGE_BY, updated: dayKey(Date.now(), this.timeZone()) });
    const { applied, skipped } = await this.memory.apply(matter.id, checked.planned);
    await this.recordActivity(this.memoryEntries(matter, applied, () => ({ by: kind })));
    await this.memory.recordPass(matter.id, {
      kind, at: new Date().toISOString(), applied: applied.map(change => ({ op: change.change, path: change.path })), skipped: [...checked.skipped, ...skipped],
    });
  }

  /**
   * 补记: once no session of the matter runs and they all stayed quiet for two minutes, each session's turns since its cursor go to the
   * model with the memory, and what later sessions need is written in. A session whose new turns wrote into the memory folder itself
   * is left out; its cursor moves on all the same.
   */
  private async capture(matterId: string): Promise<void> {
    const matter = this.store.list().find(candidate => candidate.id === matterId && !candidate.archivedAt);
    const scan = this.memory.scanOf(matterId);
    if (!matter || !scan || this.passing.has(matterId) || !this.llm || !this.defaultModel) return;
    const ids = this.memorySessions(matter);
    if (!captureReady({ states: ids.map(id => this.sessions.view(id)?.state), lastEvent: this.lastEvent.get(matterId) ?? 0, now: Date.now() })) return;
    this.passing.set(matterId, 'capture');
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(PASS_TIMEOUT_MS)]);
    try {
      const cursors: Record<string, number> = {};
      const turns: SessionTurns[] = [];
      for (const sessionId of ids) {
        const cursor = this.memory.cursor(sessionId) ?? -1;
        let events: HistoryEvent[];
        try { events = await this.historyAfter(sessionId, cursor, signal); } catch { continue; }
        const fresh = newTurns(events, cursor);
        if (!fresh) continue;
        cursors[sessionId] = fresh.cursor;
        const wrote = changedPaths(fresh.events, this.cwds.get(sessionId)).some(path => within(scan.dir, path) !== undefined || within(scan.realDir, path) !== undefined);
        if (wrote) continue;
        const lines = transcriptLines(fresh.events);
        if (lines.length) turns.push({ id: sessionId, title: sessionId === matter.conversation ? '事项的对话' : this.titleOf(sessionId), lines, last: fresh.events.at(-1)!.time });
      }
      if (turns.length) {
        const memory = captureMemory(this.passFiles(scan), scan.index.text);
        const ops = await this.askModel(CAPTURE_SYSTEM, capturePrompt(matter, memory.text, turnsText(turns)), signal);
        await this.applyPass(matter, 'capture', ops, memory.shown);
      }
      await this.memory.setCursors(cursors);
    } finally {
      this.passing.delete(matterId);
    }
  }

  /** Queue the matters whose memory is due its daily merge, and run the queue. */
  private mergeCheck(): void {
    const now = Date.now();
    for (const matter of this.store.list()) {
      if (matter.archivedAt || this.mergeQueue.includes(matter.id) || !this.memory.scanOf(matter.id)) continue;
      const lastActivity = Math.max(0, ...this.memorySessions(matter).map(id => this.sessions.view(id)?.lastActivity ?? 0));
      if (mergeDue({ mergedAt: this.memory.mergedAt(matter.id), base: this.memory.base(matter.id), lastActivity, now })) this.mergeQueue.push(matter.id);
    }
    void this.drainMerges();
  }

  /** The queued merges, one matter at a time. */
  private async drainMerges(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.mergeQueue.shift(); next !== undefined && !this.lifetime.signal.aborted; next = this.mergeQueue.shift()) {
        const matterId = next;
        await this.merge(matterId).catch((error: unknown) => { this.ctx.logger.warn('my-dsh: the merge of %s did not finish: %s', matterId, message(error)); });
      }
    } finally {
      this.draining = false;
    }
  }

  /** 整理 by hand: merge a matter's memory now. */
  private async mergeNow(matterId: string): Promise<{ mergedAt: string }> {
    if (!this.store.list().some(matter => matter.id === matterId)) throw new RequestError('没有这个事项');
    const running = this.passing.get(matterId);
    if (running) throw new RequestError(running === 'merge' ? '这件事项正在整理' : '这件事项正在补记，稍后再整理');
    this.mergeQueue = this.mergeQueue.filter(id => id !== matterId);
    await this.merge(matterId);
    return { mergedAt: new Date(this.memory.mergedAt(matterId) ?? Date.now()).toISOString() };
  }

  /**
   * 合并: the memory files and the turns since the last merge (the last day's before the first) go to the model, which merges
   * duplicates, fixes what the turns contradict, drops what is stale or done, marks what was checked, and keeps the index well under its
   * caps.
   */
  private async merge(matterId: string): Promise<void> {
    const matter = this.store.list().find(candidate => candidate.id === matterId);
    const scan = this.memory.scanOf(matterId);
    if (!matter || !scan) throw new RequestError('这件事项的记忆还没准备好');
    if (this.passing.has(matterId)) return;
    if (!this.llm || !this.defaultModel) throw new RequestError('模型服务还没加载好，稍后再试');
    this.passing.set(matterId, 'merge');
    this.changed();
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(PASS_TIMEOUT_MS)]);
    try {
      const since = this.memory.mergedAt(matterId) ?? Math.min(this.memory.base(matterId), Date.now() - MERGE_EVERY_MS);
      const active = new Set<string>();
      const turns: SessionTurns[] = [];
      for (const sessionId of this.memorySessions(matter)) {
        if ((this.sessions.view(sessionId)?.lastActivity ?? 0) < since) continue;
        let events: HistoryEvent[];
        try { events = await this.historyAfter(sessionId, -1, signal, since); } catch { continue; }
        const recent = turnsSince(events, since);
        const lines = transcriptLines(recent);
        if (!lines.length) continue;
        active.add(sessionId);
        turns.push({ id: sessionId, title: sessionId === matter.conversation ? '事项的对话' : this.titleOf(sessionId), lines, last: recent.at(-1)!.time });
      }
      if (scan.entries.length === 0 && turns.length === 0) {
        await this.memory.recordPass(matterId, { kind: 'merge', at: new Date().toISOString(), applied: [], skipped: [] });
        return;
      }
      const memory = mergeMemory(this.passFiles(scan), active);
      const ops = await this.askModel(MERGE_SYSTEM, mergePrompt(matter, memory.text, turnsText(turns), scan.index), signal);
      await this.applyPass(matter, 'merge', ops, memory.shown);
    } finally {
      this.passing.delete(matterId);
      this.changed();
    }
  }

  /** 产物 a session wrote since its cursor, read from its history: on start, and when it joins a matter. */
  private async backfill(sessionId: string): Promise<void> {
    const known = this.artifacts.of(sessionId);
    let events: HistoryEvent[];
    try {
      events = await this.historyAfter(sessionId, known.cursor, this.lifetime.signal);
    } catch {
      return;
    }
    if (events.length === 0) return;
    const cwd = this.cwds.get(sessionId) ?? known.cwd;
    const { changes, cursor } = eventChanges(events, cwd);
    await this.artifacts.record(sessionId, changes.filter(change => !this.inMemory(change.path)), { cursor, ...(cwd ? { cwd } : {}) }).catch((error: unknown) => {
      this.ctx.logger.warn('my-dsh: 产物 of %s were not read: %s', sessionId, message(error));
    });
  }

  private boardSnapshot(schedules: readonly ScheduleEntry[]): BoardSnapshot {
    const matters = this.store.list();
    const replies = new Map<string, string>();
    for (const matter of matters) {
      const reply = matter.conversation ? this.sessions.fullReply(matter.conversation) : undefined;
      if (reply) replies.set(matter.conversation!, reply);
    }
    return buildSnapshot({
      matters,
      sessions: this.sessions.all().map(sessionView),
      workspaces: this.workspaceFacts(),
      assistant: this.assistantView(),
      presets: this.presetOptions(),
      replies,
      schedules,
      suggestions: this.grouping.peek().suggestions.filter(suggestion => suggestion.state === 'pending'),
      takenOut: this.corrections.takenOut(),
      now: Date.now(),
      timeZone: this.timeZone(),
    });
  }

  /**
   * The head's numbers: the session list's rows for the sessions and their tokens, the session headers for the first session and the
   * forks, the plugin manager for the installed plugins. Each read that fails leaves its numbers out; none fails the snapshot.
   */
  private usageStats(): Promise<UsageStats> {
    const now = Date.now();
    if (this.usageRead && now - this.usageRead.at < USAGE_EVERY_MS) return this.usageRead.value;
    const signal = this.lifetime.signal;
    const read = (async (): Promise<UsageStats> => {
      const manager = this.pluginManager;
      const [listed, headers, bundles] = await Promise.allSettled([
        this.ctx.sessionController.list({}, signal),
        this.ctx.sessionQuery.listSessions(signal),
        manager ? manager.listBundles() : Promise.resolve(undefined),
      ]);
      const failed = (what: string, result: PromiseSettledResult<unknown>) => {
        if (result.status === 'rejected' && !signal.aborted) this.ctx.logger.warn('my-dsh: %s were not read for the head: %s', what, message(result.reason));
      };
      failed('the sessions', listed);
      failed('the session headers', headers);
      failed('the plugins', bundles);
      const records = headers.status === 'fulfilled' ? headers.value.map(record => record.header) : undefined;
      const stats: UsageStats = {};
      const first = records ? firstSessionAt(records) : undefined;
      if (first !== undefined) stats.firstSessionAt = first;
      if (listed.status === 'fulfilled') {
        const rows = listed.value.items.map(item => ({
          sessionId: item.sessionId, blank: item.blank, ...(item.origin ? { origin: item.origin } : {}),
          tokenUsage: (item.projections?.values as { tokenUsage?: unknown } | undefined)?.tokenUsage,
        }));
        Object.assign(stats, sessionUsage(rows, records ? seededSessions(records) : new Set()));
      }
      if (bundles.status === 'fulfilled' && bundles.value) stats.plugins = installedPlugins(bundles.value);
      return stats;
    })();
    this.usageRead = { at: now, value: read };
    return read;
  }

  /** DSH's scheduled tasks, read once after each change of its task list; none without the schedule service, or when the read fails. */
  private scheduleEntries(): Promise<readonly ScheduleEntry[]> {
    const service = this.schedule;
    if (!service) return Promise.resolve([]);
    if (!this.scheduleRead) {
      const read: Promise<readonly ScheduleEntry[]> = service.catalog().catch((error: unknown) => {
        this.ctx.logger.warn('my-dsh: the scheduled tasks were not read: %s', message(error));
        if (this.scheduleRead === read) this.scheduleRead = undefined;
        return [];
      });
      this.scheduleRead = read;
    }
    return this.scheduleRead;
  }

  /** my dsh's session and the newest cards under its turns and under those of the matters' conversations; older sessions' cards stay out. */
  private assistantView(): AssistantView {
    const state = this.assistant.peek();
    const matters = this.store.list();
    const own = new Set([...(state.sessionId ? [state.sessionId] : []), ...matters.flatMap(matter => (matter.conversation ? [matter.conversation] : []))]);
    const cards = [...state.proposals.map(proposalCard), ...state.questions.map(questionCard), ...receiptCards(state.activity, matters, this.undoableNotes())]
      .filter(card => own.has(card.sessionId))
      .sort((a, b) => a.turn - b.turn);
    const view = state.sessionId ? this.sessions.view(state.sessionId) : undefined;
    return {
      sessionId: state.sessionId ?? null, cards: keepNewest(cards, CARDS_MAX),
      ...conversationParts(view, state.sessionId ? this.sessions.fullReply(state.sessionId) : undefined),
    };
  }

  private indexInput(): IndexInput {
    const state = this.assistant.peek();
    const matters = this.store.list();
    const sent = new Map<string, string[]>();
    for (const entry of state.activity) {
      if ((entry.kind === 'start' || entry.kind === 'send') && entry.sessionId && entry.task) sent.set(entry.sessionId, [...(sent.get(entry.sessionId) ?? []), entry.task]);
    }
    return {
      matters,
      sessions: this.sessions.all().map(sessionView),
      workspaces: this.ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds })),
      archived: new Set(this.ctx.workspaceRegistry.archivedSessionIds),
      // Conversations, not work: my dsh's own session and each matter's.
      hidden: new Set([...(state.sessionId ? [state.sessionId] : []), ...matters.flatMap(matter => (matter.conversation ? [matter.conversation] : []))]),
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
    for (const item of items) if (item.cwd) this.cwds.set(item.sessionId, item.cwd);
    await this.fillReplies();
    if (!this.workspacesFilled) {
      this.workspacesFilled = true;
      await this.fillWorkspaces();
    }
  }

  /**
   * How each session's last reply starts, from the turn outline DSH caches per session: one listing of session headers (the read the
   * session list itself makes), then an in-memory cache lookup per session. No session log is read. Sessions the cache has no current
   * record for (older log formats) get no reply; turns this process sees end keep the replies current from then on.
   */
  private async fillReplies(): Promise<void> {
    const cache = this.projectionCache;
    if (!cache) return;
    try {
      const records = await this.ctx.sessionQuery.listSessions(this.lifetime.signal);
      const replies = new Map<string, string>();
      for (const record of records) {
        try {
          const reply = lastReply(cache.cachedSnapshot(record.header, ['turnOutline'])?.values.turnOutline);
          if (reply) replies.set(record.header.id, reply);
        } catch {
          // A record the cache cannot serve gives no reply.
        }
      }
      this.sessions.loadReplies(replies);
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.ctx.logger.warn('my-dsh: the last replies were not read: %s', message(error));
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

/** The parts of DSH's model service, default-model service and system prompt service the plugin uses. */
interface LlmLike {
  stream(options: {
    provider: string; model: string; reasoningEffort?: string; system?: string; purpose?: string; signal?: AbortSignal;
    messages: { role: 'user'; content: { type: 'text'; text: string }[] }[];
  }): AsyncIterable<{ type: string; text?: string }>;
}
interface DefaultModelLike { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
/** The parts of DSH's permission preset service (`dsh-permission-presets`) the plugin uses. `set` throws for a name it does not offer. */
interface PermissionPresetsLike {
  catalog(): { options: { value: string; name: string; description?: string }[] };
  set(session: Session, name: string): void;
}
/** The part of DSH's schedule service (`dsh-schedule`) the plugin uses: every stored task, active first. */
interface ScheduleLike {
  catalog(): Promise<readonly ScheduleEntry[]>;
}
/** The plugin manager's bundle list, the one DSH's plugin page reads. */
interface PluginManagerLike {
  listBundles(): Promise<readonly UsageBundle[]>;
}
interface SystemPromptLike {
  context(entry: { name: string; order: number; interpolate?: boolean; text: (input: { agent?: { session?: { id?: string } } }) => string }): unknown;
}
