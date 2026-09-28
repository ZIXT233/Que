import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export function ComposerPanel({
  anchor,
  updating = false,
  align,
  fullWidth = false,
  title,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  updating?: boolean;
  fullWidth?: boolean;
  align: "start" | "center";
  title: string;
  onClose: (focus?: boolean) => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const place = () => {
      if (!anchor.isConnected || anchor.closest("[inert]")) {
        close.current(false);
        return;
      }
      const surface = fullWidth
        ? anchor.closest(".fc-composer") || anchor
        : anchor;
      const rect = surface.getBoundingClientRect(),
        width = Math.min(fullWidth ? rect.width : 304, window.innerWidth - 24);
      const left =
        align === "center" ? rect.left + (rect.width - width) / 2 : rect.left;
      const above = rect.top - 20,
        below = window.innerHeight - rect.bottom - 20,
        useAbove = above >= 240 || above >= below;
      const computed = getComputedStyle(anchor);
      const palette = Object.fromEntries(
        ["paper", "surface", "ink", "muted", "line", "accent"].map((name) => [
          `--cq-${name}`,
          computed.getPropertyValue(`--cq-${name}`),
        ]),
      );
      setStyle({
        ...palette,
        fontFamily: computed.fontFamily,
        left: Math.max(12, Math.min(left, window.innerWidth - width - 12)),
        width,
        ...(useAbove
          ? { bottom: window.innerHeight - rect.top + 8 }
          : { top: rect.bottom + 8 }),
        maxHeight: Math.max(
          64,
          Math.min(
            useAbove ? above : below,
            fullWidth ? window.innerHeight * 0.5 : Infinity,
          ),
        ),
      });
    };
    place();
    const frame = requestAnimationFrame(() => panel.current?.focus());
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !anchor.contains(event.target as Node)
      )
        close.current(false);
    };
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    if (fullWidth && anchor.closest(".fc-composer"))
      observer.observe(anchor.closest(".fc-composer")!);
    const theme = new MutationObserver(place);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    const card = anchor.closest("article");
    if (card)
      theme.observe(card, {
        attributes: true,
        attributeFilter: ["inert", "aria-hidden"],
      });
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      theme.disconnect();
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, align, fullWidth]);
  return createPortal(
    <div
      ref={panel}
      className="fc-panel"
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      data-updating={updating || undefined}
      style={style}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close.current(true);
          return;
        }
        if (event.key !== "Tab") return;
        const nodes = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
          ) || [],
        );
        if (!nodes.length) {
          event.preventDefault();
          close.current(true);
          return;
        }
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        if (
          (event.shiftKey && index <= 0) ||
          (!event.shiftKey && index === nodes.length - 1) ||
          index === -1
        ) {
          event.preventDefault();
          nodes[event.shiftKey ? nodes.length - 1 : 0].focus();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
