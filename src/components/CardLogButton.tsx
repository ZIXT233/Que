import { useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { saveAndOpenCardLog } from "@/lib/card-log";
import { ErrorDialog } from "./ErrorDialog";

export function CardLogButton({ cardId }: { cardId: string }) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <>
    <button type="button" className="cq-tools-trigger" disabled={saving}
      title={t("harness.logsHint")} aria-label={t("harness.logsHint")} onClick={() => {
        if (saving) return;
        setSaving(true);
        void saveAndOpenCardLog(cardId)
          .catch(error => setError(error instanceof Error ? error.message : t("harness.logsFailed")))
          .finally(() => setSaving(false));
      }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" /></svg>
      <span>{t(saving ? "harness.logsSaving" : "harness.logs")}</span>
    </button>
    {error && createPortal(<ErrorDialog message={error} onDismiss={() => setError(null)} />, document.body)}
  </>;
}
