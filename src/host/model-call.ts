/**
 * Reading one call to the user's default model through DSH's model service. DSH does not throw when a call fails: the stream ends with a
 * `finish` chunk that says why, `error` or `aborted` for a failed or stopped call and `max-tokens` for an answer cut at the length limit.
 * Pure, so the wording of what a background pass records can be tested.
 */

/** Why a call stopped, as the `finish` chunk of DSH's stream gives it. */
export interface StreamFinish {
  kind: string;
  failure?: { message?: string };
}

/** The failure's own words, whitespace collapsed and cut to 120 characters. */
function detail(finish: StreamFinish): string {
  const text = finish.failure?.message?.replace(/\s+/g, ' ').trim();
  return text ? [...text].slice(0, 120).join('') : '没有说明';
}

/**
 * Why a call gave no answer worth reading: the pass ran out of time, or the call failed or was stopped.
 * @param finish - the stream's `finish` reason, when it sent one.
 * @param timedOut - the pass's time ran out while the call was open.
 * @param minutes - how long a pass may take.
 * @returns the reason a run records, or undefined when the answer is worth reading.
 */
export function callStop(finish: StreamFinish | undefined, timedOut: boolean, minutes: number): string | undefined {
  if (timedOut) return `模型 ${minutes} 分钟内没有答完`;
  if (finish?.kind === 'error') return `模型调用出错：${detail(finish)}`;
  if (finish?.kind === 'aborted') return `模型调用被中止：${detail(finish)}`;
  return undefined;
}

/** Two answers in a row were cut at the length limit: what the run records instead of “not JSON”. */
export const CUT_TWICE = '模型的回答两次都写到长度上限还没写完';
