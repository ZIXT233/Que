"use client";
import { MachineSessionSettingsDialog } from "./MachineSessionSettingsDialog";
import { useI18n } from "@/hooks/useI18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { machineErrorText, WorkspaceMachineError } from "@/lib/workspace-machine-errors";
import { WorkspaceMachineIcon } from "./WorkspaceMachineIcon";
import { machineRequest } from "./RemoteHostsSettings";
import type { RemoteHost } from "@/lib/remote-hosts";
import type { MachineSessionSettings, QueueWorkspace } from "@/lib/card-queue";
import { SshAuthChallenge, SshConnectionWait, useSshAuthChallenge } from "./SshAuthChallenge";

export function WorkspacePicker({ workspaces, machineSettings, remoteHosts, onSelect, onUpdate, onUpdateMachine, onRemove, onAddWorkspace, onManageHosts, onClose, busy }: {
  workspaces: QueueWorkspace[]; machineSettings: Record<string, MachineSessionSettings>; remoteHosts: RemoteHost[]; onSelect: (id: string) => void; onUpdate: (id: string, value: { name: string; defaultConversationWeight: number }) => Promise<boolean>; onUpdateMachine: (key: string, value: { terminalRc: string; sessionEnv: Record<string, string> }) => Promise<boolean>; onRemove: (id: string) => Promise<boolean>; onAddWorkspace: (machine: RemoteHost | "local") => void; onManageHosts: () => void; onClose: () => void; busy: boolean;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(-1);
  const [hovered, setHovered] = useState<number | null>(null);
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(() => new Set());
  const [editingWorkspace, setEditingWorkspace] = useState<{ workspace: QueueWorkspace; name: string; weight: number } | null>(null);
  const [editingMachine, setEditingMachine] = useState<{ key: string; label: string } | null>(null);
  const [removingWorkspace, setRemovingWorkspace] = useState<QueueWorkspace | null>(null);
  const [connectingWorkspace, setConnectingWorkspace] = useState<{ workspace: QueueWorkspace; host: RemoteHost; error?: unknown } | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const connectionController = useRef<AbortController | null>(null);
  const { challenge: connectionChallenge, present: presentConnectionChallenge, clear: clearConnectionChallenge } = useSshAuthChallenge();
  const searching = search.trim().length > 0;
  const query = search.trim().toLowerCase();
  const hostKey = (workspace: QueueWorkspace) => workspace.kind === "local" ? "local" : `ssh:${workspace.sshHost}`;
  type WorkspaceGroup = { key: string; kind: QueueWorkspace["kind"]; host?: string; machine: RemoteHost | "local"; workspaces: QueueWorkspace[] };
  const groups = new Map<string, WorkspaceGroup>();
  groups.set("local", { key: "local", kind: "local", machine: "local", workspaces: [] });
  for (const host of remoteHosts) groups.set(`ssh:${host.id}`, { key: `ssh:${host.id}`, kind: "ssh", host: host.name, machine: host, workspaces: [] });
  for (const workspace of workspaces) {
    const key = hostKey(workspace);
    const knownHost = remoteHosts.find((host) => host.id === workspace.sshHost);
    const group = groups.get(key) ?? { key, kind: workspace.kind, host: knownHost?.name || workspace.sshHost || "SSH", machine: knownHost || { id: workspace.sshHost || "", name: workspace.sshHost || "SSH", hostname: workspace.sshHost || "", source: "config" }, workspaces: [] };
    const hostLabel = group.kind === "ssh" ? `${t("machines.remote")} ${group.host}` : t("machines.local");
    if (!searching || `${workspace.name} ${workspace.cwd} ${hostLabel}`.toLowerCase().includes(query)) group.workspaces.push(workspace);
    groups.set(key, group);
  }
  const grouped = [...groups.values()].filter((group) => !searching || group.workspaces.length > 0 || `${t("machines.remote")} ${group.host || t("machines.local")}`.toLowerCase().includes(query)).sort((a, b) => a.kind === b.kind ? 0 : a.kind === "local" ? -1 : 1);
  const visibleMatches = grouped.flatMap((group) => !searching && collapsedHosts.has(group.key) ? [] : group.workspaces);
  const index = selected < 0 ? -1 : Math.min(selected, Math.max(0, visibleMatches.length - 1));
  const activeIndex = hovered ?? index;
  const toggleGroup = (key: string) => {
    setSelected(-1); setHovered(null);
    setCollapsedHosts((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  };
  useEffect(() => () => connectionController.current?.abort(), []);
  const cancelConnection = useCallback(() => {
    connectionController.current?.abort(); connectionController.current = null;
    setConnectionBusy(false); setConnectingWorkspace(null); clearConnectionChallenge();
  }, [clearConnectionChallenge]);
  const connectAndSelect = useCallback(async (workspace: QueueWorkspace, host: RemoteHost, password?: string, trustedPrompt?: string) => {
    connectionController.current?.abort();
    const controller = new AbortController();
    connectionController.current = controller;
    setConnectingWorkspace({ workspace, host }); setConnectionBusy(true); clearConnectionChallenge();
    try {
      await machineRequest({ action: "test-host", host: host.id, ...(password !== undefined ? { password } : {}), ...(trustedPrompt !== undefined ? { trustedPrompt } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      window.dispatchEvent(new Event("que-remote-hosts-changed"));
      setConnectingWorkspace(null); onSelect(workspace.id);
    } catch (error) {
      if (controller.signal.aborted) return;
      setConnectingWorkspace({ workspace, host, error });
      window.dispatchEvent(new Event("que-remote-hosts-changed"));
      presentConnectionChallenge(error);
    } finally {
      if (connectionController.current === controller) { connectionController.current = null; setConnectionBusy(false); }
    }
  }, [clearConnectionChallenge, onSelect, presentConnectionChallenge]);
  const selectWorkspace = useCallback((workspace: QueueWorkspace) => {
    if (busy || connectingWorkspace || editingWorkspace || editingMachine || removingWorkspace) return;
    if (workspace.kind !== "ssh") { onSelect(workspace.id); return; }
    const host = remoteHosts.find(item => item.id === workspace.sshHost) ?? { id: workspace.sshHost || "", name: workspace.sshHost || "SSH", hostname: workspace.sshHost || "", source: "config" as const };
    void connectAndSelect(workspace, host);
  }, [busy, connectingWorkspace, editingWorkspace, editingMachine, removingWorkspace, connectAndSelect, onSelect, remoteHosts]);
  return <><div className="cq-overlay" onClick={onClose}><section inert={!!removingWorkspace || !!editingWorkspace || !!editingMachine || !!connectingWorkspace} className="cq-workspace-picker" role="dialog" aria-modal="true" aria-label={t("queue.选择工作区，新建会话")} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
    // React portal events can bubble here even though the DOM subtree is
    // inert. Only handle our own keyboard navigation while the picker is free.
    if (event.defaultPrevented || event.nativeEvent.isComposing || busy || connectingWorkspace || editingWorkspace || editingMachine || removingWorkspace || !event.currentTarget.contains(event.target as Node)) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    // A focused button already activates its own workspace/action on Enter.
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setHovered(null); setSelected(visibleMatches.length ? index < 0 ? 0 : (index + 1) % visibleMatches.length : -1); }
    if (event.key === "ArrowUp") { event.preventDefault(); setHovered(null); setSelected(visibleMatches.length ? index < 0 ? visibleMatches.length - 1 : (index + visibleMatches.length - 1) % visibleMatches.length : -1); }
    if (event.key === "Enter" && visibleMatches[index < 0 ? 0 : index] && !busy) { event.preventDefault(); selectWorkspace(visibleMatches[index < 0 ? 0 : index]); }
  }}>
    <div className="cq-picker-search"><span>⌕</span><input autoFocus placeholder={t("queue.搜索工作区…")} aria-label={t("queue.搜索工作区")} value={search} onChange={(event) => { setSearch(event.target.value); setSelected(-1); setHovered(null); }} /><button onClick={onClose} aria-label={t("queue.关闭工作区选择")}>×</button></div>
    <div className="cq-workspaces" role="listbox" aria-label={t("queue.工作区列表")}>
      {grouped.map((group) => {
        const collapsed = !searching && collapsedHosts.has(group.key);
        return <section className="cq-workspace-group" key={group.key}>
          <div className="cq-workspace-group-heading">
            <div className="cq-workspace-group-title"><WorkspaceMachineIcon name={group.kind === "ssh" ? "remote" : "local"} size={16} connectionStatus={group.kind === "ssh" ? group.machine !== "local" && group.machine.connected ? "connected" : "disconnected" : undefined} statusLabel={group.kind === "ssh" ? t(group.machine !== "local" && group.machine.connected ? "machines.connected" : "machines.disconnected") : undefined} /><strong>{group.kind === "ssh" ? <>{t("machines.remote")}<i>·</i>{group.host}</> : t("machines.local")}</strong></div>
            <button className="cq-workspace-group-settings" type="button" disabled={busy} title={t("machines.sessionSettings")} aria-label={`${t("machines.sessionSettings")} · ${group.host || t("machines.local")}`} onClick={() => setEditingMachine({ key: group.key, label: group.host || t("machines.local") })}><WorkspaceMachineIcon name="settings" size={19} /></button>
            <button className="cq-workspace-group-add" type="button" disabled={busy} title={t("machines.newWorkspace")} aria-label={`${t("machines.newWorkspace")} · ${group.host || t("machines.local")}`} onClick={() => onAddWorkspace(group.machine)}><WorkspaceMachineIcon name="folder-plus" size={26} /></button>
            <button className="cq-workspace-group-toggle" type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? t("queue.展开") : t("queue.收起")} · ${group.host || t("machines.local")}`} onClick={() => toggleGroup(group.key)}><WorkspaceMachineIcon name="chevron" size={14} /></button>
          </div>
          {!collapsed && group.workspaces.map((workspace) => { const i = visibleMatches.indexOf(workspace); return <div key={workspace.id} role="option" aria-selected={i === activeIndex} className={`cq-workspace-row${i === activeIndex ? " is-selected" : ""}`} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}><button className="cq-workspace-open" disabled={busy} onClick={() => selectWorkspace(workspace)}><span className="cq-workspace-text"><span className="cq-workspace-title"><strong>{workspace.name}</strong></span><small><span className="cq-workspace-meta-path"><WorkspaceMachineIcon name="folder" size={13} /><span>{workspace.cwd}</span></span></small></span></button><span className="cq-workspace-weight" aria-label={`${t("machines.weight")} ${workspace.defaultConversationWeight ?? 0}`}><span aria-hidden="true">⚖️</span>{workspace.defaultConversationWeight ?? 0}</span><button className="cq-workspace-edit" disabled={busy} aria-label={`${t("queue.editWorkspaceAction")} ${workspace.name}`} title={t("queue.editWorkspaceAction")} onClick={() => setEditingWorkspace({ workspace, name: workspace.name, weight: workspace.defaultConversationWeight ?? 0 })}><WorkspaceMachineIcon name="edit" size={15} /></button><button className="cq-workspace-remove" disabled={busy} aria-label={`${t("i18n.remove")} ${workspace.name}`} title={t("i18n.remove")} onClick={() => setRemovingWorkspace(workspace)}><WorkspaceMachineIcon name="close" size={15} /></button></div>; })}
        </section>;
      })}
      {!grouped.length && <p className="cq-workspace-empty">{t("queue.没有匹配的工作区")}</p>}
    </div>
    <button className="cq-picker-add" onClick={onManageHosts}><WorkspaceMachineIcon name="remote" size={15} />{t("machines.manage")}</button>
    {connectingWorkspace && !connectionChallenge && <SshConnectionWait hostName={connectingWorkspace.host.name} busy={connectionBusy} error={connectingWorkspace.error} onCancel={cancelConnection} onRetry={() => void connectAndSelect(connectingWorkspace.workspace, connectingWorkspace.host)} />}
    {connectingWorkspace && <SshAuthChallenge challenge={connectionChallenge} hostName={connectingWorkspace.host.name} busy={connectionBusy} error={connectingWorkspace.error} onCancel={cancelConnection} onRetry={(password, trustedPrompt) => void connectAndSelect(connectingWorkspace.workspace, connectingWorkspace.host, password, trustedPrompt)} />}
  </section></div>
    {editingMachine && <MachineSessionSettingsDialog key={editingMachine.key} machineKey={editingMachine.key} label={editingMachine.label} settings={machineSettings[editingMachine.key]} busy={busy} onSave={onUpdateMachine} onClose={() => setEditingMachine(null)} />}
    {editingWorkspace && <div className="cq-overlay cq-workspace-remove-backdrop" onClick={() => !busy && setEditingWorkspace(null)}>
      <form className="cq-dialog cq-workspace-edit-dialog" role="dialog" aria-modal="true" aria-label={t("queue.editWorkspaceTitle")} onClick={event => event.stopPropagation()} onSubmit={async event => {
        event.preventDefault();
        const name = editingWorkspace.name.trim();
        if (name && await onUpdate(editingWorkspace.workspace.id, { name, defaultConversationWeight: editingWorkspace.weight })) setEditingWorkspace(null);
      }}>
        <div className="cq-dialog-heading"><WorkspaceMachineIcon name="edit" size={20} /><button type="button" aria-label={t("queue.关闭")} disabled={busy} onClick={() => setEditingWorkspace(null)}><WorkspaceMachineIcon name="close" size={18} /></button></div>
        <h2>{t("queue.editWorkspaceTitle")}</h2><p>{t("queue.editWorkspaceDescription")}</p>
        <label htmlFor="edit-workspace-name">{t("machines.workspaceName")}<input id="edit-workspace-name" autoFocus required value={editingWorkspace.name} onChange={event => setEditingWorkspace({ ...editingWorkspace, name: event.target.value })} /></label>
        <label htmlFor="edit-workspace-weight">{t("machines.weight")}<input id="edit-workspace-weight" type="number" required value={editingWorkspace.weight} onChange={event => setEditingWorkspace({ ...editingWorkspace, weight: event.target.valueAsNumber })} /></label>
        <div className="cq-workspace-edit-path"><WorkspaceMachineIcon name="folder" size={13} /><span>{editingWorkspace.workspace.cwd}</span></div>
        <div className="cq-confirm-actions"><button type="button" disabled={busy} onClick={() => setEditingWorkspace(null)}>{t("queue.取消")}</button><button className="cq-primary" disabled={busy || !editingWorkspace.name.trim()}>{t("queue.saveWorkspaceChanges")}</button></div>
      </form>
    </div>}{removingWorkspace && <div className="cq-overlay cq-workspace-remove-backdrop" onClick={() => !busy && setRemovingWorkspace(null)}><section className="cq-dialog cq-archive-confirm" role="alertdialog" aria-modal="true" aria-label={t("queue.removeWorkspaceTitle")} onClick={(event) => event.stopPropagation()}><div className="cq-dialog-heading"><WorkspaceMachineIcon name="folder" size={20} /><button aria-label={t("queue.关闭")} disabled={busy} onClick={() => setRemovingWorkspace(null)}><WorkspaceMachineIcon name="close" size={18} /></button></div><h2>{t("queue.removeWorkspaceTitle")}</h2><p>{t("queue.removeWorkspaceDescription", { name: removingWorkspace.name })}</p><div className="cq-confirm-actions"><button disabled={busy} onClick={() => setRemovingWorkspace(null)}>{t("queue.取消")}</button><button className="cq-primary cq-danger" disabled={busy} onClick={async () => { if (await onRemove(removingWorkspace.id)) setRemovingWorkspace(null); }}>{t("queue.removeWorkspaceAction")}</button></div></section></div>}</>;
}

export function WorkspaceForm({ defaultCwd, entry, onSave, onClose, onBack, busy, error }: {
  defaultCwd: string; onSave: (value: { name: string; kind: "local" | "ssh"; cwd: string; sshHost?: string; defaultConversationWeight: number }) => void;
  entry: RemoteHost | "local"; onClose: () => void; onBack: () => void; busy: boolean; error: unknown;
}) {
  const { t, locale } = useI18n();
  const remote = entry === "local" ? null : entry;
  const [loading, setLoading] = useState(!!remote), [localError, setLocalError] = useState<unknown>(null);
  const { challenge: authChallenge, present: presentAuth, clear: clearAuth } = useSshAuthChallenge();
  const [cwd, setCwd] = useState(entry === "local" ? defaultCwd : ''), [name, setName] = useState(''), [weight, setWeight] = useState(0);
  const [directories, setDirectories] = useState<{ name: string; path: string }[]>([]);
  const [browsing, setBrowsing] = useState(false), [directoryError, setDirectoryError] = useState<unknown>(null);
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const [truncated, setTruncated] = useState(false), [selected, setSelected] = useState(-1);
  const generation = useRef(0);
  const connectionController = useRef<AbortController | null>(null);
  useEffect(() => {
    const generationRef = generation;
    const controllerRef = connectionController;
    return () => { generationRef.current++; controllerRef.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!remote || loading || !cwd) return;
    const controller = new AbortController();
    setDirectories([]); setSelected(-1); setDirectoryError(null); setTruncated(false); setBrowsing(false);
    if (!cwd.startsWith('/')) { setDirectoryError(new WorkspaceMachineError('PATH_INVALID')); return; }
    setBrowsing(true);
    const timer = setTimeout(() => {
      machineRequest({ action: 'directories', host: remote.id, path: cwd }, controller.signal)
        .then(data => { if (!controller.signal.aborted) { setDirectories(data.directories); setTruncated(!!data.truncated); } })
        .catch(e => { if (!controller.signal.aborted) setDirectoryError(e); })
        .finally(() => { if (!controller.signal.aborted) setBrowsing(false); });
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cwd, loading, remote]);
  const pickLocal = async () => {
    setLoading(true); setLocalError(null);
    const token = ++generation.current;
    try {
      const data = await machineRequest({ action: 'local-folder', locale });
      if (generation.current !== token) return;
      if (data.cwd) { setCwd(data.cwd); setName(data.cwd.split(/[\\/]/).filter(Boolean).pop() || ''); }
    } catch (e) { if (generation.current === token) setLocalError(e); }
    finally { if (generation.current === token) setLoading(false); }
  };
  const connect = useCallback(async (host: RemoteHost, secret?: string, trustedPrompt?: string) => {
    connectionController.current?.abort();
    const controller = new AbortController();
    connectionController.current = controller;
    clearAuth(); setLoading(true); setLocalError(null);
    const token = ++generation.current;
    try {
      const data = await machineRequest({ action: 'connect', host: host.id, trustedPrompt, ...(secret !== undefined ? { password: secret } : {}) }, controller.signal);
      if (generation.current !== token) return;
      setCwd(data.cwd.replace(/\/$/, '') + '/'); setName('');
    } catch (e) {
      if (controller.signal.aborted) return;
      if (generation.current !== token) return;
      setLocalError(e);
      presentAuth(e);
    } finally { if (connectionController.current === controller) connectionController.current = null; if (generation.current === token) setLoading(false); }
  }, [clearAuth, presentAuth]);
  useEffect(() => {
    if (!remote) return;
    void connect(remote);
  }, [remote, connect]);
  const cancelConnection = () => { generation.current++; connectionController.current?.abort(); connectionController.current = null; setLoading(false); };
  const close = () => { cancelConnection(); onClose(); };
  const goBack = () => { cancelConnection(); clearAuth(); setLocalError(null); onBack(); };
  const parentPath = cwd.replace(/\/$/, '').split('/').slice(0, -1).join('/') + '/';
  const directoryOptions = [...(cwd.startsWith('/') && cwd !== '/' ? [{ name: t('machines.parent'), path: parentPath, parent: true }] : []), ...directories.map(dir => ({ ...dir, parent: false }))];
  const formBlocked = busy || loading;
  const cancelAuth = () => { cancelConnection(); clearAuth(); setLocalError(null); };
  const alert = localError ? machineErrorText(localError, t) : error ? machineErrorText(error, t) : '';
  const awaitingRemoteConnection = !!remote && !cwd;
  return <div className="cq-overlay" onClick={() => !busy && close()}>
    <section className="cq-workspace-picker machine-dialog" role="dialog" aria-modal="true" aria-label={t('machines.newWorkspace')} onClick={e => e.stopPropagation()} onKeyDown={e => {
      if (e.key === 'Escape' && !busy) { e.stopPropagation(); if (authChallenge) cancelAuth(); else close(); }
      if (e.key === 'Tab') {
        const scope = e.currentTarget.querySelector('.machine-auth-dialog') || e.currentTarget;
        const focusable = [...scope.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="machine-header"><div><h2>{t('machines.folderTitle')}</h2><p>{t('machines.folderHint')}</p></div><button className="machine-icon-button" disabled={busy} onClick={close} aria-label={t('machines.close')}><WorkspaceMachineIcon name="close" /></button></header>
      <div className="machine-body" inert={!!authChallenge}>
        {awaitingRemoteConnection && remote && <div className="machine-connection-wait" role={localError && !authChallenge ? 'alert' : 'status'}><span className="machine-symbol is-remote"><WorkspaceMachineIcon name="remote" size={24} /></span><strong>{remote.name}</strong><p>{loading ? t('machines.connecting', { name: remote.name }) : alert || t('machines.connect', { name: remote.name })}</p>{!loading && !authChallenge && <button className="machine-button is-primary" type="button" disabled={busy} onClick={() => void connect(remote)}>{t('machines.retry')}</button>}</div>}
        {!awaitingRemoteConnection && <form className="machine-folder-form" onSubmit={e => {
          e.preventDefault(); if (formBlocked) return;
          onSave({ name: name.trim() || cwd.split('/').filter(Boolean).pop() || 'Workspace', kind: remote ? 'ssh' : 'local', cwd, defaultConversationWeight: weight, ...(remote ? { sshHost: remote.id } : {}) });
        }}>
          <div className="machine-context"><span><WorkspaceMachineIcon name={remote ? 'remote' : 'local'} />{remote?.name || t('machines.local')}</span></div>
          <label htmlFor="workspace-cwd">{t('machines.folderLabel')}</label>
          <div className="directory-combobox" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDirectoryOpen(false); }}>
          <input id="workspace-cwd" autoFocus required value={cwd} role={remote ? 'combobox' : undefined} aria-autocomplete={remote ? 'list' : undefined} aria-expanded={remote ? directoryOpen : undefined} aria-controls={remote ? 'remote-directories' : undefined} aria-activedescendant={directoryOpen && selected >= 0 ? `remote-dir-${selected}` : undefined} onFocus={() => setDirectoryOpen(true)} onChange={e => { setCwd(e.target.value); setDirectoryOpen(true); }} onKeyDown={e => {
            if (remote && e.key === 'Escape' && directoryOpen) { e.preventDefault(); e.stopPropagation(); setDirectoryOpen(false); return; }
            if (remote && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) setDirectoryOpen(true);
            if (e.key === 'ArrowDown' && directoryOptions.length) { e.preventDefault(); setSelected(i => (i + 1) % directoryOptions.length); }
            if (e.key === 'ArrowUp' && directoryOptions.length) { e.preventDefault(); setSelected(i => (i + directoryOptions.length - 1) % directoryOptions.length); }
            if ((e.key === 'Enter' || e.key === 'Tab') && directoryOpen && selected >= 0 && directoryOptions[selected]) { e.preventDefault(); e.stopPropagation(); setCwd(directoryOptions[selected].path); }
          }} />
          {remote && directoryOpen && <div className="remote-directory-popup">
            <div id="remote-directories" className="remote-directories" role="listbox" aria-label={t('machines.directoryOptions')}>{directoryOptions.map((dir, i) => <button id={`remote-dir-${i}`} key={dir.path} type="button" role="option" aria-selected={selected === i} tabIndex={-1} onMouseDown={e => e.preventDefault()} onClick={() => { setCwd(dir.path); setDirectoryOpen(true); }}><WorkspaceMachineIcon name={dir.parent ? "parent" : "folder"} size={16} /><span>{dir.parent ? `.. / ${dir.name}` : dir.name}</span><WorkspaceMachineIcon name="chevron" size={12} /></button>)}</div>
            <p className={directoryError ? 'machine-error' : 'machine-help'}>{browsing ? t('machines.reading') : directoryError ? machineErrorText(directoryError, t) : t(truncated ? 'machines.truncated' : directories.length ? 'machines.directoryHelp' : 'machines.emptyDirectories')}</p>
          </div>}
          </div>
          {remote ? <p className="machine-help">{t('machines.directoryHelp')}</p> : <button className="machine-browse-folder" type="button" disabled={formBlocked} onClick={() => void pickLocal()}><WorkspaceMachineIcon name="folder" size={18} /><span><strong>{t(loading ? 'machines.pickerWaiting' : 'machines.browse')}</strong><small>{t('machines.localHint')}</small></span><WorkspaceMachineIcon name="chevron" size={14} /></button>}
          <div className="machine-field-grid"><label htmlFor="workspace-name">{t('machines.workspaceName')}<input id="workspace-name" value={name} onChange={e => setName(e.target.value)} placeholder={t('machines.workspaceNameHint')} /></label><label htmlFor="workspace-weight"><span aria-hidden="true">⚖️</span> {t('machines.weight')}<input id="workspace-weight" type="number" value={weight} required onChange={e => setWeight(e.target.valueAsNumber)} /></label></div>
          <div className="machine-actions"><button className="machine-button" type="button" disabled={busy} onClick={goBack}>← {t('machines.back')}</button><button className="machine-button is-primary" disabled={formBlocked || !cwd} type="submit">{t(busy ? 'machines.validating' : 'machines.saveWorkspace')}</button></div>
        </form>}
        {alert && !awaitingRemoteConnection && <p className="machine-error" role="alert">{alert}</p>}
      </div>
      <footer className="machine-footer"><span><kbd>Esc</kbd> {t('machines.close')}</span></footer>
      {remote && <SshAuthChallenge challenge={authChallenge} hostName={remote.name} busy={loading} error={localError} onCancel={cancelAuth} onRetry={(password, trustedPrompt) => void connect(remote, password, trustedPrompt)} />}
    </section>
  </div>;
}
