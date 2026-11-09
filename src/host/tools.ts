/**
 * The `my-dsh` preset's own row (`dsh-my-dsh/tools`): my dsh's tools and the board index each model step reads. A preset row registers
 * in the preset's scope, so only sessions running the `my-dsh` preset get them. Everything goes through the Host service `mydsh`.
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type MyDsh from './index.js';
import type { ToolCaller } from './index.js';

export const name = 'my-dsh-tools';
export const inject = ['tools', 'systemPrompt', 'mydsh'];

/** After the built-in runtime contexts. */
const CONTEXT_ORDER = 900;

const json = (value: unknown) => JSON.stringify(value);
const text = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const;

export function apply(ctx: Context): void {
  const mydsh: MyDsh = ctx.mydsh;
  const caller = (exec: { agent?: ToolCaller['agent']; signal: AbortSignal }): ToolCaller => ({ agent: exec.agent, signal: exec.signal });

  ctx.systemPrompt.context({
    name: 'my-dsh:board-index', order: CONTEXT_ORDER, interpolate: false, required: true,
    text: () => mydsh.contextText(),
  });

  ctx.tools.register(defineTool({
    name: 'board_index',
    description: '读取完整的看板索引：事项（名字、目标、别名、主工作区、来源、指令、PR、文档）、事项里和最近 14 天不在事项里的会话（标题、状态、最近动静、工作区）、用到的工作区，以及事项和会话之间的连接和来历（manual 是用户手动加的，mydsh 是你开的）。每轮附带的索引是摘要，要完整的列表、链接和指令全文时调用。状态是这个 DSH 进程看到的。',
    parameters: {},
    output: text,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: '读取看板索引', kind: 'read' }),
    async execute() {
      return json(mydsh.boardIndex());
    },
  }));

  ctx.tools.register(defineTool({
    name: 'session_recent',
    description: '读一条会话最近的情况：标题、状态、所在事项和工作区，以及它最后几条回复的正文（约 1500 字）。liveHere 为 false 时，这条会话不在这个 DSH 进程里运行，状态可能过时，以回复为准。',
    parameters: { sessionId: { type: 'string', required: true, description: '会话 id，来自看板索引。' } },
    output: text,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: '读取会话', kind: 'read', rawInput: args.sessionId }),
    async execute(args, exec) {
      return json(await mydsh.sessionRecent(args.sessionId, exec.signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'start_session',
    description: '在一件事项里开一条新会话，把任务作为第一条消息发给它，并放进这件事项。会话开在事项的主工作区；没有主工作区时，开在事项里最近一条会话所在的工作区。只在用户要你做事时调用。',
    parameters: {
      matterId: { type: 'string', required: true, description: '事项 id，来自看板索引。' },
      title: { type: 'string', required: true, description: '新会话的标题，短。' },
      task: { type: 'string', required: true, description: '发给新会话的完整任务说明，要让它不看这里的对话也能开始做。' },
      why: { type: 'string', required: true, description: '一句话：为什么派到这件事项。' },
    },
    output: text,
    presentCall: args => ({ card: 'generic', title: `开会话 · ${args.title}`, kind: 'execute' }),
    async execute(args, exec) {
      return json(await mydsh.startSession(args, caller(exec)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'send_to_session',
    description: '给一条已有的会话发一条消息，它会接着做。这条会话正被另一个 DSH 进程打开（比如桌面端）时会失败。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '会话 id，来自看板索引。' },
      text: { type: 'string', required: true, description: '发给这条会话的话。' },
      why: { type: 'string', required: true, description: '一句话：为什么发给这条会话。' },
    },
    output: text,
    presentCall: () => ({ card: 'generic', title: '发消息给会话', kind: 'execute' }),
    async execute(args, exec) {
      return json(await mydsh.sendToSession(args, caller(exec)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'propose_matter_change',
    description: '提议新建、合并或改名事项。调用不会改任何东西：用户确认了才生效。调用前先用一句话说要做什么、为什么；调用后这一轮结束。kind=new 要 name 和 goal；kind=merge 要 fromId（被并进去的事项）和 intoId（留下的事项）；kind=rename 要 matterId 和新的 name。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['new', 'merge', 'rename'] },
      name: { type: 'string', description: 'new 和 rename：事项的名字，最多 40 个字。' },
      goal: { type: 'string', description: 'new：一句话目标，最多 120 个字。' },
      workspaceId: { type: 'string', description: 'new：用户指定了主工作区时填它的 id。' },
      matterId: { type: 'string', description: 'rename：要改名的事项 id。' },
      fromId: { type: 'string', description: 'merge：被并进去、之后不再单独存在的事项 id。' },
      intoId: { type: 'string', description: 'merge：留下的事项 id。' },
      phrase: { type: 'string', description: '用户原话里对这件事项的叫法，有的话填。' },
      why: { type: 'string', required: true, description: '一句话理由。' },
    },
    output: text,
    presentCall: args => ({ card: 'generic', title: args.kind === 'new' ? '提议新起事项' : args.kind === 'merge' ? '提议合并事项' : '提议改名' }),
    async execute(args, exec) {
      const result = await mydsh.proposeChange(args, caller(exec));
      exec.concludeTurn();
      return json(result);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'ask_which',
    description: '用户的说法对不上唯一一个事项或会话时（一个都对不上，或者两个以上都可能），列出候选让用户选，不要猜。调用后这一轮结束；用户选了以后会发来“是事项「X」”“是会话「X」”或“都不是”。',
    parameters: {
      phrase: { type: 'string', required: true, description: '用户原话里的说法。' },
      candidates: {
        type: 'array', required: true, description: '1 到 6 个候选，最可能的放前面。',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: ['matter', 'session'] },
            id: { type: 'string', required: true, description: '事项或会话 id，来自看板索引。' },
          },
        },
      },
      why: { type: 'string', required: true, description: '一句话：为什么拿不准。' },
    },
    output: text,
    presentCall: args => ({ card: 'generic', title: `问是哪个 · ${args.phrase}` }),
    async execute(args, exec) {
      const result = await mydsh.askWhich(args, caller(exec));
      exec.concludeTurn();
      return json(result);
    },
  }));
}
