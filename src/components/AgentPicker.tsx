"use client";
import { useEffect, useState } from "react";
import { harnessName, providerIconId, type HarnessCatalogEntry } from "@/lib/harness/catalog";
import { ProviderIcon } from "./ProviderIcon";
import { SshAuthChallenge, useSshAuthChallenge } from "./SshAuthChallenge";
import { machineRequest } from "./RemoteHostsSettings";
import { needsSshSecret } from "@/lib/workspace-machine-errors";
import { ErrorDialog } from "./ErrorDialog";
import { useI18n } from "@/hooks/useI18n";

/**
 * Choosing the agent for a session: the agents the workspace's machine has, and
 * a nickname. `catalog` names the machine (`?workspace=` or `?card=`).
 */
export function AgentPicker({ catalog: query, initialNickname = "", sshHost, sshHostName, onPick }: {
  catalog: string;
  initialNickname?: string;
  sshHost?: string;
  sshHostName?: string;
  onPick: (kind: string, nickname: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<HarnessCatalogEntry[]>([]);
  const [nickname, setNickname] = useState(initialNickname);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const auth = useSshAuthChallenge();
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/acp-catalog${query}`, { signal: abort.signal }).then(async r => {
      const data = await r.json();
      if (!r.ok) throw Object.assign(new Error(data.error), data);
      setCatalog(data);
    }).catch(e => { if (!abort.signal.aborted) { if (sshHost && needsSshSecret(e)) auth.present(e); else setError(e); } });
    return () => abort.abort();
  }, [query, retry]);
  const pick = async (kind: string) => {
    setBusy(true); setError(null);
    try { await onPick(kind, nickname.trim()); }
    catch (e) { if (sshHost && needsSshSecret(e)) auth.present(e); else setError(e); }
    finally { setBusy(false); }
  };
  return <>
    {error ? <ErrorDialog message={error instanceof Error ? error.message : String(error)} onDismiss={() => setError(null)} /> : null}
    {sshHost && <SshAuthChallenge challenge={auth.challenge} hostName={sshHostName || sshHost} busy={busy} error={null} onCancel={auth.clear} onRetry={async (password, trustedPrompt) => {
      setBusy(true);
      try { await machineRequest({ action: "connect", host: sshHost, password, trustedPrompt }); auth.clear(); setRetry(v => v + 1); }
      catch (e) { if (!auth.present(e)) setError(e); }
      finally { setBusy(false); }
    }} />}
    <div className="cq-harness-empty"><div className="cq-harness-picker">
      <div className="cq-harness-picker-head"><div><h3>选择 Agent</h3><p>选择 Agent，在当前工作区开始会话</p></div></div>
      <label className="cq-harness-nickname"><span>{t("harness.nicknameOptional")}</span><input autoComplete="off" maxLength={48} value={nickname} placeholder={t("harness.nicknamePlaceholder")} onChange={e => setNickname(e.target.value)} /></label>
      {[catalog.filter(item => item.available !== false), catalog.filter(item => item.available === false)].map((items, group) => items.length > 0 && <div key={group}>
        {group === 1 && <p className="cq-harness-missing-head">未检测到（需要先安装并登录对应的命令行工具）</p>}
        <div className="cq-harness-options" data-missing={group === 1 || undefined}>{items.map(item => <button key={item.id} type="button" className="cq-harness-option" disabled={busy} onClick={() => void pick(item.id)}>
          <span className="cq-harness-option-icon"><ProviderIcon id={providerIconId(item.id)} size={28} /></span>
          <span className="cq-harness-option-copy"><span className="cq-harness-option-title"><strong>{harnessName(item.id)}</strong></span><small>{item.available === false && item.missing ? `未找到 ${item.missing}` : item.description}</small></span><span className="cq-harness-option-arrow">↗</span>
        </button>)}</div>
      </div>)}
      {!catalog.length && <p role="status">正在读取这台机器的 Agent 列表… <button type="button" onClick={() => setRetry(v => v + 1)}>重试</button></p>}
    </div></div>
  </>;
}
