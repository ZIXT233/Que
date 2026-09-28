"use client";

import React, { useMemo, useState, type ReactNode } from "react";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";

interface CodeBlockNode {
  type: "code";
  lang: string;
  code: string;
}

interface HeadingNode {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

interface BlockquoteNode {
  type: "blockquote";
  lines: string[];
}

interface ListItem {
  text: string;
  checked?: boolean;
}

interface ListNode {
  type: "list";
  ordered: boolean;
  start?: number;
  items: ListItem[];
}

interface TableNode {
  type: "table";
  headers: string[];
  alignments: ("left" | "center" | "right" | "default")[];
  rows: string[][];
}

interface HrNode {
  type: "hr";
}

interface ParagraphNode {
  type: "paragraph";
  text: string;
}

type BlockNode =
  | CodeBlockNode
  | HeadingNode
  | BlockquoteNode
  | ListNode
  | TableNode
  | HrNode
  | ParagraphNode;

const UNORDERED_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  const parts = trimmed.replace(/^\||\|$/g, "").split("|");
  if (parts.length === 0) return false;
  return parts.every((p) => /^\s*:?-+:?\s*$/.test(p));
}

function parseAlignments(sepLine: string): ("left" | "center" | "right" | "default")[] {
  const parts = sepLine.trim().replace(/^\||\|$/g, "").split("|");
  return parts.map((part) => {
    const s = part.trim();
    const start = s.startsWith(":");
    const end = s.endsWith(":");
    if (start && end) return "center";
    if (end) return "right";
    if (start) return "left";
    return "default";
  });
}

function splitTableRow(rowLine: string): string[] {
  return rowLine.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

export function parseBlocks(markdown: string): BlockNode[] {
  if (!markdown) return [];
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Blank lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 2. Code blocks (``` or ~~~)
    const codeMatch = line.match(/^(\s*)(```|~~~)([\w#+-]*)/);
    if (codeMatch) {
      const marker = codeMatch[2];
      const lang = codeMatch[3].trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        if (lines[i].trim().startsWith(marker)) {
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        type: "code",
        lang,
        code: codeLines.join("\n"),
      });
      continue;
    }

    // 3. Tables
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(line);
      const alignments = parseAlignments(lines[i + 1]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({
        type: "table",
        headers,
        alignments,
        rows,
      });
      continue;
    }

    // 4. Headings (# to ######)
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      blocks.push({
        type: "heading",
        level: hMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: hMatch[2].trim(),
      });
      i++;
      continue;
    }

    // 5. Horizontal rule (---, ***, ___)
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // 6. Blockquote (> ...)
    if (line.startsWith(">")) {
      const bqLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith(">") || (bqLines.length > 0 && lines[i].trim() !== "" && !lines[i].startsWith("#") && !lines[i].startsWith("```")))) {
        bqLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", lines: bqLines });
      continue;
    }

    // 7. Lists (Ordered or Unordered)
    const uMatch = line.match(UNORDERED_RE);
    const oMatch = line.match(ORDERED_RE);
    if (uMatch || oMatch) {
      const isOrdered = Boolean(oMatch);
      const items: ListItem[] = [];
      let startNum: number | undefined = undefined;

      while (i < lines.length) {
        const cur = lines[i];
        const curUMatch = cur.match(UNORDERED_RE);
        const curOMatch = cur.match(ORDERED_RE);

        if (isOrdered ? curOMatch : curUMatch) {
          const rawText = (isOrdered ? curOMatch![3] : curUMatch![3]).trim();
          if (isOrdered && startNum === undefined) {
            startNum = parseInt(curOMatch![2], 10) || 1;
          }
          const taskMatch = rawText.match(TASK_RE);
          if (taskMatch) {
            items.push({
              text: taskMatch[2],
              checked: taskMatch[1].toLowerCase() === "x",
            });
          } else {
            items.push({ text: rawText });
          }
          i++;
        } else if (cur.trim() === "") {
          if (i + 1 < lines.length && (UNORDERED_RE.test(lines[i + 1]) || ORDERED_RE.test(lines[i + 1]))) {
            i++;
          } else {
            break;
          }
        } else if (/^\s{2,}\S/.test(cur) && items.length > 0) {
          items[items.length - 1].text += "\n" + cur.trim();
          i++;
        } else {
          break;
        }
      }

      blocks.push({
        type: "list",
        ordered: isOrdered,
        start: startNum,
        items,
      });
      continue;
    }

    // 8. Paragraphs
    const pLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^(\s*)(```|~~~)/) &&
      !lines[i].match(/^(#{1,6})\s+/) &&
      !lines[i].match(/^(\*{3,}|-{3,}|_{3,})\s*$/) &&
      !lines[i].startsWith(">") &&
      !UNORDERED_RE.test(lines[i]) &&
      !ORDERED_RE.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      pLines.push(lines[i]);
      i++;
    }

    if (pLines.length > 0) {
      blocks.push({
        type: "paragraph",
        text: pLines.join("\n"),
      });
    }
  }

  return blocks;
}

export function MarkdownLink({ href, children }: { href: string; children: ReactNode }) {
  const handleClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(href);
    } catch {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      title={href}
      className="cq-markdown-link"
    >
      {children}
    </a>
  );
}

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await copyText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  const copyLabel = copied ? (t("i18n.copied") || "已复制") : (t("i18n.copy") || "复制");

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang || "text"}</span>
        <div className="markdown-code-actions">
          <button
            type="button"
            className={`markdown-code-action ${copied ? "is-active" : ""}`}
            onClick={handleCopy}
            title={copyLabel}
            aria-label={copyLabel}
          >
            {copied ? (
              <>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>{copyLabel}</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>{copyLabel}</span>
              </>
            )}
          </button>
        </div>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function renderInline(text: string, keyPrefix = "inline"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = text;
  let keyIndex = 0;

  while (remaining.length > 0) {
    // 1. Inline code: `code`
    const codeMatch = remaining.match(/^`([^`\n]+)`/);
    if (codeMatch) {
      nodes.push(
        <code className="markdown-inline-code" key={`${keyPrefix}-${keyIndex++}`}>
          {codeMatch[1]}
        </code>
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // 2. Markdown link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]\n]+)\]\(((?:https?:\/\/|\/|#)[^)\s]+)\)/);
    if (linkMatch) {
      nodes.push(
        <MarkdownLink href={linkMatch[2]} key={`${keyPrefix}-${keyIndex++}`}>
          {linkMatch[1]}
        </MarkdownLink>
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // 3. Autolink: http(s)://...
    const autoLinkMatch = remaining.match(/^https?:\/\/[^\s<)"]+/);
    if (autoLinkMatch) {
      const url = autoLinkMatch[0];
      nodes.push(
        <MarkdownLink href={url} key={`${keyPrefix}-${keyIndex++}`}>
          {url}
        </MarkdownLink>
      );
      remaining = remaining.slice(url.length);
      continue;
    }

    // 4. Bold + Italic: ***text*** or ___text___
    const boldItalicMatch = remaining.match(/^(?:\*\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*\*|___([^\s_](?:[^_\n]*[^\s_])?)___)/);
    if (boldItalicMatch) {
      const content = boldItalicMatch[1] || boldItalicMatch[2];
      nodes.push(
        <strong key={`${keyPrefix}-${keyIndex++}`}>
          <em>{renderInline(content, `${keyPrefix}-${keyIndex}-bi`)}</em>
        </strong>
      );
      remaining = remaining.slice(boldItalicMatch[0].length);
      continue;
    }

    // 5. Bold: **text** or __text__
    const boldMatch = remaining.match(/^(?:\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*|__([^\s_](?:[^_\n]*[^\s_])?)__)/);
    if (boldMatch) {
      const content = boldMatch[1] || boldMatch[2];
      nodes.push(
        <strong key={`${keyPrefix}-${keyIndex++}`}>
          {renderInline(content, `${keyPrefix}-${keyIndex}-b`)}
        </strong>
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // 6. Italic: *text* or _text_
    const italicMatch = remaining.match(/^(?:\*([^\s*](?:[^*\n]*[^\s*])?)\*|_(?!\s)([^\n_]+?)(?<!\s)_)/);
    if (italicMatch) {
      const content = italicMatch[1] || italicMatch[2];
      nodes.push(
        <em key={`${keyPrefix}-${keyIndex++}`}>
          {renderInline(content, `${keyPrefix}-${keyIndex}-i`)}
        </em>
      );
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // 7. Strikethrough: ~~text~~
    const strikeMatch = remaining.match(/^~~([^~\n]+)~~/);
    if (strikeMatch) {
      nodes.push(
        <del key={`${keyPrefix}-${keyIndex++}`}>
          {renderInline(strikeMatch[1], `${keyPrefix}-${keyIndex}-s`)}
        </del>
      );
      remaining = remaining.slice(strikeMatch[0].length);
      continue;
    }

    // 8. Newline
    if (remaining.startsWith("\n")) {
      nodes.push(<br key={`${keyPrefix}-${keyIndex++}`} />);
      remaining = remaining.slice(1);
      continue;
    }

    // 9. Plain text up to the next potential token
    const nextSpecial = remaining.search(/[`[h*_~\n]|https?:\/\//);
    if (nextSpecial === -1) {
      nodes.push(remaining);
      break;
    } else if (nextSpecial === 0) {
      nodes.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      nodes.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return nodes;
}

export function MarkdownMessage({
  content,
  role,
}: {
  content: string;
  role?: "user" | "assistant";
}) {
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <div className={`markdown-body markdown-content-root ${role ? `markdown-${role}-message` : ""}`}>
      {blocks.map((block, idx) => {
        switch (block.type) {
          case "code":
            return <CodeBlock key={idx} lang={block.lang} code={block.code} />;
          case "heading": {
            const Tag = `h${block.level}` as keyof React.JSX.IntrinsicElements;
            return <Tag key={idx}>{renderInline(block.text, `h-${idx}`)}</Tag>;
          }
          case "blockquote":
            return (
              <blockquote key={idx}>
                {block.lines.map((l, li) => (
                  <p key={li}>{renderInline(l, `bq-${idx}-${li}`)}</p>
                ))}
              </blockquote>
            );
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            const hasTaskList = block.items.some((it) => it.checked !== undefined);
            return (
              <ListTag
                className={hasTaskList ? "contains-task-list" : undefined}
                start={block.start}
                key={idx}
              >
                {block.items.map((item, itemIdx) => {
                  if (item.checked !== undefined) {
                    return (
                      <li className="task-list-item" key={itemIdx}>
                        <input
                          type="checkbox"
                          checked={item.checked}
                          readOnly
                          disabled
                          aria-hidden="true"
                        />
                        <span>{renderInline(item.text, `li-${idx}-${itemIdx}`)}</span>
                      </li>
                    );
                  }
                  return (
                    <li key={itemIdx}>
                      {renderInline(item.text, `li-${idx}-${itemIdx}`)}
                    </li>
                  );
                })}
              </ListTag>
            );
          }
          case "table":
            return (
              <div className="markdown-table-wrap" key={idx}>
                <table>
                  <thead>
                    <tr>
                      {block.headers.map((h, i) => (
                        <th
                          key={i}
                          style={
                            block.alignments[i] && block.alignments[i] !== "default"
                              ? { textAlign: block.alignments[i] }
                              : undefined
                          }
                        >
                          {renderInline(h, `th-${idx}-${i}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {row.map((cell, cIdx) => (
                          <td
                            key={cIdx}
                            style={
                              block.alignments[cIdx] && block.alignments[cIdx] !== "default"
                                ? { textAlign: block.alignments[cIdx] }
                                : undefined
                            }
                          >
                            {renderInline(cell, `td-${idx}-${rIdx}-${cIdx}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={idx} />;
          case "paragraph":
            return <p key={idx}>{renderInline(block.text, `p-${idx}`)}</p>;
          default:
            return null;
        }
      })}
    </div>
  );
}
