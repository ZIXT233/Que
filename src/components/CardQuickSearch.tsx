"use client";

import { useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { nicknameHue } from "@/lib/card-nickname";
import { WorkspaceMachineIcon } from "./WorkspaceMachineIcon";

export type CardQuickSearchItem = {
  id: string;
  title: string;
  nickname?: string;
  host: string;
  folder: string;
  remote: boolean;
  tmux?: boolean;
  location: "working" | "queue" | "detached";
};

function fuzzyTitleScore(title: string, query: string) {
  const value = title.normalize("NFKC").toLocaleLowerCase();
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase();
  if (!needle) return 0;
  const exact = value.indexOf(needle);
  if (exact >= 0) return exact;
  let cursor = -1;
  let gap = 0;
  for (const character of needle) {
    const next = value.indexOf(character, cursor + 1);
    if (next < 0) return null;
    gap += next - cursor - 1;
    cursor = next;
  }
  return 100 + gap;
}

export function CardQuickSearch({ items, onOpen }: {
  items: CardQuickSearchItem[];
  onOpen: (item: CardQuickSearchItem) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const results = useMemo(() => items.map((item, index) => {
    const titleScore = fuzzyTitleScore(item.title, query);
    const nicknameScore = item.nickname ? fuzzyTitleScore(item.nickname, query) : null;
    const score = titleScore === null ? nicknameScore : nicknameScore === null ? titleScore : Math.min(titleScore, nicknameScore);
    return { item, index, score };
  })
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item), [items, query]);

  const openItem = (item: CardQuickSearchItem) => {
    onOpen(item);
    setExpanded(false);
    inputRef.current?.blur();
  };
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) setExpanded(false);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setExpanded(false);
      event.currentTarget.blur();
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + results.length) % results.length);
    } else if (event.key === "Enter" && expanded) {
      event.preventDefault();
      openItem(results[Math.min(activeIndex, results.length - 1)]);
    }
  };

  return <div className={`cq-card-search ${expanded ? "is-expanded" : ""}`} onBlur={handleBlur}>
    <div className="cq-card-search-field">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder={t("queue.搜索卡片…")}
        aria-label={t("queue.搜索卡片")}
        aria-expanded={expanded}
        aria-controls="cq-card-search-results"
        aria-activedescendant={expanded && results.length ? `cq-card-search-result-${results[Math.min(activeIndex, results.length - 1)].id}` : undefined}
        role="combobox"
        autoComplete="off"
        onFocus={() => { setExpanded(true); setActiveIndex(0); }}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setExpanded(true); }}
        onKeyDown={handleKeyDown}
      />
    </div>
    {expanded && <div className="cq-card-search-results" id="cq-card-search-results" role="listbox">
      {results.length ? results.map((item, index) => <button
        type="button"
        id={`cq-card-search-result-${item.id}`}
        role="option"
        aria-selected={index === activeIndex}
        className={index === activeIndex ? "is-active" : ""}
        key={`${item.location}-${item.id}`}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => setActiveIndex(index)}
        onClick={() => openItem(item)}
      >
        <strong className={item.nickname ? "cq-card-search-nickname" : undefined} style={item.nickname ? { "--cq-nickname-hue": nicknameHue(item.id) } as CSSProperties : undefined}>{item.nickname || item.title}</strong>
        {item.nickname && <span className="cq-card-search-session-title">{item.title}</span>}
        <span className="cq-card-search-meta">
          <span><WorkspaceMachineIcon name={item.remote ? "remote" : "local"} size={14} />{item.tmux && <span className="cq-tmux-badge">TMUX</span>}{item.host}</span>
          <span><WorkspaceMachineIcon name="folder" size={14} />{item.folder}</span>
        </span>
      </button>) : <div className="cq-card-search-empty">{t("queue.没有匹配的卡片")}</div>}
    </div>}
  </div>;
}
