import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { THUMB, stepAt } from "./model";

/** Pointer mapping, fill, ticks and thumb all use the same inset lane. */
export function DiscreteSlider({
  labels,
  value,
  disabled,
  onCommit,
  title,
  action,
}: {
  labels: string[];
  value: number;
  disabled: boolean;
  onCommit: (index: number) => void;
  title: string;
  action?: ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(value);
  const pointer = useRef<number | null>(null);
  const sent = useRef<number | null>(null);
  const set = (next: number) => {
    latest.current = next;
    setDraft(next);
  };
  useEffect(() => {
    if (pointer.current === null && !disabled) {
      set(value);
      sent.current = null;
    }
  }, [value, disabled]);
  const commit = () => {
    if (
      !disabled &&
      latest.current !== value &&
      latest.current !== sent.current
    ) {
      sent.current = latest.current;
      onCommit(latest.current);
    }
  };
  const count = labels.length;
  const available = count > 1 && !disabled;
  return (
    <div className="fc-effort">
      <div className="fc-effort-label">
        <span className="fc-effort-heading"><span>{title}</span><strong>{labels[draft] || "—"}</strong></span>
        <span className="fc-effort-action">{action}</span>
      </div>
      <div className="fc-effort-track-row">
      <div
        className="fc-slider"
        role="slider"
        tabIndex={available ? 0 : -1}
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, count - 1)}
        aria-valuenow={Math.max(0, draft)}
        aria-valuetext={labels[draft]}
        aria-disabled={!available}
        style={
          {
            "--fc-thumb": `${THUMB}px`,
            "--fc-position": `${count > 1 ? (Math.max(0, draft) / (count - 1)) * 100 : 0}%`,
          } as CSSProperties
        }
        onPointerDown={(event) => {
          if (!available || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus();
          pointer.current = event.pointerId;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const rect = event.currentTarget.getBoundingClientRect();
          set(stepAt(event.clientX, rect.left, rect.width, count));
        }}
        onPointerMove={(event) => {
          if (pointer.current !== event.pointerId || !available) return;
          const rect = event.currentTarget.getBoundingClientRect();
          set(stepAt(event.clientX, rect.left, rect.width, count));
        }}
        onPointerUp={(event) => {
          if (pointer.current !== event.pointerId) return;
          pointer.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          commit();
        }}
        onClick={(event) => {
          if (!available || event.detail === 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          set(stepAt(event.clientX, rect.left, rect.width, count));
          commit();
        }}
        onPointerCancel={() => {
          pointer.current = null;
          set(value);
        }}
        onLostPointerCapture={() => {
          if (pointer.current !== null) {
            pointer.current = null;
            set(value);
          }
        }}
        onKeyDown={(event) => {
          if (!available) return;
          const offsets: Record<string, number> = {
            ArrowLeft: -1,
            ArrowDown: -1,
            ArrowRight: 1,
            ArrowUp: 1,
            PageDown: -1,
            PageUp: 1,
          };
          if (
            event.key in offsets ||
            event.key === "Home" ||
            event.key === "End"
          ) {
            event.preventDefault();
            event.stopPropagation();
            set(
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? count - 1
                  : Math.max(
                      0,
                      Math.min(count - 1, latest.current + offsets[event.key]),
                    ),
            );
          }
          if (event.key === "Escape") set(value);
        }}
        onKeyUp={(event) => {
          if (
            [
              "ArrowLeft",
              "ArrowDown",
              "ArrowRight",
              "ArrowUp",
              "Home",
              "End",
              "PageDown",
              "PageUp",
            ].includes(event.key)
          ) {
            event.stopPropagation();
            commit();
          }
        }}
        onBlur={() => {
          if (pointer.current === null) commit();
        }}
      >
        <div className="fc-slider-lane" aria-hidden="true">
          <span className="fc-slider-fill" />
          {labels.map((label, index) => (
            <i
              key={index}
              title={label}
              style={{
                left: `${count > 1 ? (index / (count - 1)) * 100 : 0}%`,
              }}
            />
          ))}
          <span className="fc-slider-thumb" />
        </div>
      </div>
      </div>
    </div>
  );
}
