/**
 * 托管 in a matter's head: a chip like DSH's permission chip in the composer, 托管：<preset> or 托管：不托管, opening a menu of 不托管 and
 * the presets DSH offers, each with what the sessions my dsh opens in the matter may then do. 完全权限 asks first, in DSH's dialog, saying
 * what it means here: the sessions the matter's conversation dispatches run without asking, and it keeps dispatching while hosted.
 */
import { useState, type ReactNode } from 'react';
import {
  IconChevronDownOutlineRegular, IconShieldOutlineRegular, Menu, PermissionIconFullAccessRegular, PermissionIconReadOnlyRegular,
  PermissionIconWorkspaceWriteRegular, RiskConfirmation, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { FULL_ACCESS, hostingOptions } from './presets.js';

/** The menu's id for 不托管, which has no preset; DSH's preset names are kebab-case, so it cannot meet one. */
const NONE = 'mydsh:not-hosted';

/** DSH's glyphs for its presets; 不托管 and other presets get the plain shield. */
const GLYPHS: Readonly<Record<string, () => ReactNode>> = {
  'read-only': () => <PermissionIconReadOnlyRegular />,
  'workspace-write': () => <PermissionIconWorkspaceWriteRegular />,
  [FULL_ACCESS]: () => <PermissionIconFullAccessRegular />,
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function HostingChip({ preset, presets, setHosting }: {
  /** The preset the matter is hosted under; undefined while it is not hosted. */
  preset: string | undefined;
  /** DSH's permission presets, from the snapshot. */
  presets: readonly { value: string; name: string }[];
  /** Hosts the matter under a preset, or stops with null. */
  setHosting: (preset: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const options = hostingOptions(presets, preset);
  // Nothing to choose: DSH offers no preset and the matter is not hosted.
  if (options.length === 1) return null;
  const current = options.find(option => option.value === (preset ?? null)) ?? options[0]!;
  const items: MenuEntry[] = options.map(option => ({
    id: option.value ?? NONE,
    label: (
      <span className="mydsh-hosting-option">
        <span className="mydsh-hosting-name">{option.name}</span>
        {option.description && <span className="mydsh-hosting-line">{option.description}</span>}
      </span>
    ),
  }));
  const apply = (next: string | null) => {
    setBusy(true);
    setFailure(null);
    setHosting(next).catch((error: unknown) => { setFailure(message(error)); }).finally(() => { setBusy(false); });
  };
  const choose = (id: string) => {
    setOpen(false);
    const next = id === NONE ? null : id;
    if (next === (preset ?? null)) return;
    if (next === FULL_ACCESS) {
      setAcknowledged(false);
      setConfirming(true);
      return;
    }
    apply(next);
  };
  return (
    <>
      <Menu
        open={open}
        items={items}
        selectedId={current.value ?? NONE}
        onSelect={choose}
        onClose={() => { setOpen(false); }}
        align="end"
        portal
        listClassName="mydsh-hosting-menu"
        anchor={(
          <button
            type="button" className="mydsh-hosting-chip" aria-haspopup="menu" aria-expanded={open} disabled={busy}
            title={current.description} onClick={() => { setOpen(!open); }}
          >
            <span className="mydsh-hosting-glyph" aria-hidden>{(current.value && GLYPHS[current.value]?.()) ?? <IconShieldOutlineRegular />}</span>
            <span className="mydsh-hosting-label">托管：{current.name}</span>
            <span className={`mydsh-hosting-chevron${open ? ' is-open' : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
          </button>
        )}
      />
      {failure && <span className="mydsh-error mydsh-hosting-error" role="alert">{failure}</span>}
      {confirming && (
        <RiskConfirmation
          open
          title="确认启用完全权限？"
          description="启用完全权限后，这件事项的对话派出去的会话会按完全权限跑：改文件、跑外部命令和其他敏感操作都不再先问你。托管时，派出去的会话做完后它还会接着派下一步。只在你信任这件事接下来的活时启用。"
          acknowledgeLabel="我已了解风险，并愿意继续"
          cancelLabel="取消"
          closeLabel="关闭"
          confirmLabel="启用完全权限"
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
          onCancel={() => { setConfirming(false); }}
          onConfirm={() => { setConfirming(false); apply(FULL_ACCESS); }}
        />
      )}
    </>
  );
}
