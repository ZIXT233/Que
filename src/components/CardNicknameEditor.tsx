"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { nicknameHue } from "@/lib/card-nickname";

export function CardNicknameEditor({ cardId, nickname, onSave }: {
  cardId: string;
  nickname?: string;
  onSave: (nickname: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(nickname ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(nickname ?? ""), [nickname]);

  const save = async (rawValue: string) => {
    const next = rawValue.trim();
    if (saving) return;
    if (next === (nickname ?? "")) {
      setValue(next);
      return;
    }
    setSaving(true);
    try {
      if (await onSave(next)) setValue(next);
      else setValue(nickname ?? "");
    } finally {
      setSaving(false);
    }
  };

  const colorStyle = { "--cq-nickname-hue": nicknameHue(cardId) } as CSSProperties;
  return <div className="cq-card-nickname-editor" style={colorStyle}>
    <input
      className={`cq-card-nickname${value ? "" : " is-empty"}`}
      aria-label={t("harness.nickname")}
      title={t("harness.nicknamePlaceholder")}
      autoComplete="off"
      autoCorrect="off"
      maxLength={48}
      value={value}
      placeholder={t("harness.addNickname")}
      disabled={saving}
      onChange={event => setValue(event.target.value)}
      onBlur={event => { void save(event.currentTarget.value); }}
      onKeyDown={event => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          const input = event.currentTarget;
          input.value = nickname ?? "";
          setValue(nickname ?? "");
          input.blur();
        }
      }}
    />
  </div>;
}
