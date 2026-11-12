/**
 * The numbers my dsh's head shows about the user's DSH as a whole, from what DSH already keeps: the session list's rows, where each
 * session DSH has a cached projection for carries its log's token total (the `tokenUsage` projection; older-format sessions carry none);
 * the session headers' creation times and fork marks; and the plugin manager's bundles. Subagent sessions stay out, and a fork's tokens
 * too, since a fork starts with a copy of its source's turns and their usage. Pure.
 */
import type { UsageStats } from './remote.js';

/** A session list row as these numbers read it. */
export interface UsageRow {
  sessionId: string;
  blank: boolean;
  origin?: string;
  /** The row's `tokenUsage` projection, as DSH gave it. */
  tokenUsage?: unknown;
}

/** A session header as these numbers read it. */
export interface UsageHeader {
  id: string;
  createdAt?: number;
  origin?: string;
  isSeeded?: boolean;
}

/** A plugin manager bundle as the plugin page sorts it. */
export interface UsageBundle {
  official?: boolean;
  installed?: boolean;
  error?: unknown;
}

const BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

/** A row's token total, the four buckets together as DSH's composer adds them; undefined when the row has no usage. */
export function tokenTotal(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  let total = 0;
  for (const bucket of BUCKETS) {
    const count = (value as Record<string, unknown>)[bucket];
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return undefined;
    total += count;
  }
  return total;
}

/**
 * The sessions and their tokens: sessions counts the top-level sessions that are not blank; tokens adds up those that carry a total and
 * are not forks, and tokenSessions says how many did, so a sum over fewer sessions than counted reads as a lower bound.
 */
export function sessionUsage(rows: readonly UsageRow[], seeded: ReadonlySet<string>): Pick<UsageStats, 'sessions' | 'tokens' | 'tokenSessions'> {
  let sessions = 0;
  let tokens = 0;
  let tokenSessions = 0;
  for (const row of rows) {
    if (row.origin === 'subagent' || row.blank) continue;
    sessions += 1;
    if (seeded.has(row.sessionId)) continue;
    const total = tokenTotal(row.tokenUsage);
    if (total === undefined) continue;
    tokens += total;
    tokenSessions += 1;
  }
  return { sessions, tokens, tokenSessions };
}

/** When the earliest top-level session was made; undefined when no header says. */
export function firstSessionAt(headers: readonly UsageHeader[]): number | undefined {
  let first: number | undefined;
  for (const header of headers) {
    if (header.origin === 'subagent' || typeof header.createdAt !== 'number' || !Number.isFinite(header.createdAt)) continue;
    if (first === undefined || header.createdAt < first) first = header.createdAt;
  }
  return first;
}

/** The forks among the headers: sessions that start with a copy of another session's turns. */
export function seededSessions(headers: readonly UsageHeader[]): Set<string> {
  return new Set(headers.filter(header => header.isSeeded === true).map(header => header.id));
}

/** The plugins the plugin page lists under 已安装插件: bundles that are not official, installed or failing to load. */
export function installedPlugins(bundles: readonly UsageBundle[]): number {
  return bundles.filter(bundle => bundle.official !== true && (bundle.installed === true || (bundle.error !== undefined && bundle.error !== null))).length;
}
