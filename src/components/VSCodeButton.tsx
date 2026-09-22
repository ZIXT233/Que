import { useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "@/hooks/useI18n";
import { ErrorDialog } from "./ErrorDialog";

export function VSCodeButton({ cardId }: { cardId: string }) {
  const { t } = useI18n();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <>
    <button type="button" className="cq-tools-trigger" title={t("editor.open")} aria-label={t("editor.open")} disabled={opening} onClick={() => {
      setOpening(true);
      setError(null);
      void invoke("open_in_vscode", { cardId })
        .catch(error => setError(String(error)))
        .finally(() => setOpening(false));
    }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a1 1 0 0 0-1.276.057L.327 7.261a1 1 0 0 0-.001 1.478L3.899 12 .326 15.261a1 1 0 0 0 .001 1.478l1.322 1.202a1 1 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.94a1.5 1.5 0 0 0-.85-1.353ZM18 17.455 10.822 12 18 6.545v10.91Z" />
      </svg>
      <span>{t("editor.review")}</span>
    </button>
    {error && createPortal(<ErrorDialog message={error} onDismiss={() => setError(null)} />, document.body)}
  </>;
}
