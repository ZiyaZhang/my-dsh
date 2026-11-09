/**
 * The my-dsh Remote: request and response types, the request check, and the descriptor the DSH Remote carrier routes by. The client bundle
 * imports this file, so it keeps to types and the dependency-free check below.
 */
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';

/** A matter: what a group of sessions is for. Big matters have a main conversation; the rest are only a board. */
export interface Matter {
  id: string;
  name: string;
  /** One sentence. */
  goal: string;
  /** Session ids, in the order they joined. */
  sessions: string[];
  /** The session id of its main conversation, once one is opened. */
  main?: string;
  createdAt: string;
  archivedAt?: string;
}

export type MyDshRequest = { action: 'snapshot' };

export interface MyDshResponse {
  /** In-progress matters first, newest activity first; archived ones after them. */
  matters: Matter[];
}

export class RequestError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Takes the listed actions only, with no extra keys; returns a fresh copy or throws a RequestError whose message the page shows. */
export function parseRequest(value: unknown): MyDshRequest {
  if (!isRecord(value)) throw new RequestError('my-dsh 请求必须是一个 JSON 对象');
  if (value.action !== 'snapshot') throw new RequestError(`没有这个操作：${JSON.stringify(value.action)}`);
  const extra = Object.keys(value).filter(key => key !== 'action');
  if (extra.length) throw new RequestError(`snapshot 不接受这些字段：${extra.join('、')}`);
  return { action: 'snapshot' };
}

const json = (value: unknown) => value;
const requestObject = (value: unknown) => {
  if (!isRecord(value)) throw new Error('request must be a JSON object');
  return value as unknown as MyDshRequest;
};

export const MY_DSH_DESCRIPTOR: InvocationDescriptor = {
  id: 'dsh-my-dsh#mydsh/call', service: 'mydsh', namespace: 'mydsh', method: 'call',
  invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'MyDshRequest', create: () => ({ parse: requestObject }) } }],
  result: { mode: 'strict', typeSymbol: 'MyDshResponse', create: () => ({ parse: json }), encode: value => json(value) },
};
export const MY_DSH_REMOTE: TypertRemoteContribution = { package: 'dsh-my-dsh', descriptors: [MY_DSH_DESCRIPTOR] };

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { mydsh: { call: (request: MyDshRequest, signal?: AbortSignal) => Promise<RemoteResult<MyDshResponse>> } }
  interface TypertRemoteMap { 'mydsh/call': (request: MyDshRequest, signal?: AbortSignal) => Promise<RemoteResult<MyDshResponse>> }
}
