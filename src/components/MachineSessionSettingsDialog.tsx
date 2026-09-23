"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { MachineSessionSettings } from "@/lib/card-queue";
import { WorkspaceEnvironmentEditor, formatWorkspaceEnvironment, parseWorkspaceEnvironment } from "./WorkspaceEnvironmentEditor";
import { WorkspaceMachineIcon } from "./WorkspaceMachineIcon";
import { WorkspaceRcEditor } from "./WorkspaceRcEditor";

export function MachineSessionSettingsDialog({ machineKey, label, settings, busy, onSave, onClose }: {
  machineKey: string;
  label: string;
  settings?: MachineSessionSettings;
  busy: boolean;
  onSave: (machineKey: string, value: { terminalRc: string; sessionEnv: Record<string, string> }) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [rc, setRc] = useState(settings?.terminalRc ?? "");
  const [env, setEnv] = useState(formatWorkspaceEnvironment(settings?.sessionEnv));
  const [environmentError, setEnvironmentError] = useState(false);

  return <div className="cq-overlay cq-workspace-remove-backdrop" onClick={() => !busy && onClose()}>
    <form className="cq-dialog cq-workspace-edit-dialog" role="dialog" aria-modal="true" aria-label={t("machines.sessionSettings")}
      onClick={event => event.stopPropagation()} onSubmit={async event => {
        event.preventDefault();
        const sessionEnv = parseWorkspaceEnvironment(env);
        if (!sessionEnv) { setEnvironmentError(true); return; }
        if (await onSave(machineKey, { terminalRc: rc, sessionEnv })) onClose();
      }}>
      <div className="cq-dialog-heading"><WorkspaceMachineIcon name="settings" size={20} /><button type="button" aria-label={t("queue.关闭")} disabled={busy} onClick={onClose}><WorkspaceMachineIcon name="close" size={18} /></button></div>
      <h2>{t("machines.sessionSettings")}</h2>
      <p>{label} · {t("machines.sessionSettingsHint")}</p>
      <WorkspaceRcEditor machineKey={machineKey} value={rc} environment={env} onChange={setRc} />
      <WorkspaceEnvironmentEditor value={env} error={environmentError} onChange={value => { setEnv(value); setEnvironmentError(false); }} />
      <div className="cq-confirm-actions machine-session-settings-actions"><button type="button" disabled={busy} onClick={onClose}>{t("queue.取消")}</button><button className="cq-primary" disabled={busy} type="submit">{t("queue.saveWorkspaceChanges")}</button></div>
    </form>
  </div>;
}
