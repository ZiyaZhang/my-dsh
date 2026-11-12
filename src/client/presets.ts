/**
 * 托管 as a matter's head offers it: 不托管, then DSH's permission presets under DSH's own names for its three, each with one line on
 * what the sessions my dsh opens in the matter may then do. Any other preset shows the name the snapshot gives it, without a line. Pure,
 * so it can be tested.
 */

/** The preset that lifts the sandbox and never asks; picking it asks for confirmation first. */
export const FULL_ACCESS = 'danger-full-access';

export interface PresetView {
  name: string;
  /** What the sessions my dsh opens in the matter may do under it; absent for a preset the table does not know. */
  description?: string;
}

const KNOWN: Readonly<Record<string, Required<PresetView>>> = {
  'read-only': { name: '仅可查看', description: '派出去的会话只读，改文件前都会问你' },
  'workspace-write': { name: '工作区内修改', description: '在工作区里改文件、跑命令不问你，工作区外的先问' },
  [FULL_ACCESS]: { name: '完全权限', description: '做什么都不问你，选它会再确认一次' },
};

/** The matter is not hosted. */
export const NOT_HOSTED: Required<PresetView> = { name: '不托管', description: '你说话它才动手；派出去的会话按 DSH 默认权限跑' };

/** How to show a preset: from the table, else by the name in `presets`, else by its key. */
export function presetView(value: string, presets: readonly { value: string; name: string }[]): PresetView {
  if (Object.hasOwn(KNOWN, value)) return KNOWN[value];
  return { name: presets.find(option => option.value === value)?.name ?? value };
}

/** One choice of 托管: `value` is the preset, null for 不托管. */
export interface HostingOption extends PresetView {
  value: string | null;
}

/**
 * The choices of 托管: 不托管, then the presets in DSH's order, then the matter's current preset when DSH no longer offers it, so the
 * head can still name it.
 */
export function hostingOptions(presets: readonly { value: string; name: string }[], current: string | undefined): HostingOption[] {
  const values = presets.map(option => option.value);
  if (current !== undefined && !values.includes(current)) values.push(current);
  return [{ value: null, ...NOT_HOSTED }, ...values.map(value => ({ value, ...presetView(value, presets) }))];
}
