import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

// Shows one image over the app: fitted to the window, or at its real size
// when clicked. Esc, the close button or the backdrop closes it.
export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const { t } = useI18n();
  const [actual, setActual] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  return (
    <div className={`cq-overlay cq-image-viewer${actual ? " cq-image-viewer--actual" : ""}`} role="dialog" aria-modal="true" aria-label={alt} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <img src={src} alt={alt} onClick={() => setActual((value) => !value)} />
      <button type="button" className="cq-image-viewer-close" aria-label={t("i18n.close")} onClick={onClose}>×</button>
    </div>
  );
}
