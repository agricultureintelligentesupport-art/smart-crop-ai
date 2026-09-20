"use client";

import type { ReactNode } from "react";

/**
 * Tiny dependency-free Markdown renderer tuned for the assistant's replies:
 * `##`/`###` headings, `-`/`*`/numbered lists, `**bold**`, `` `code` ``,
 * `> quotes` and paragraphs. Everything is rendered as React elements (no
 * `dangerouslySetInnerHTML`), so model output can never inject markup.
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // Split on **bold** and `code` spans while keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={`${keyPrefix}-b${i}`} className="font-black text-emerald-950">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={`${keyPrefix}-c${i}`}
          dir="ltr"
          className="rounded-md bg-emerald-900/8 px-1.5 py-0.5 text-[0.85em] font-bold text-emerald-800"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyPrefix}-t${i}`}>{part}</span>;
  });
}

type Block =
  | { kind: "h2" | "h3" | "p" | "quote"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;

  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const h3 = line.match(/^###\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    const h1 = line.match(/^#\s+(.*)$/);
    const ul = line.match(/^[-*•]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);

    if (h3) {
      flushList();
      blocks.push({ kind: "h3", text: h3[1] });
    } else if (h2 || h1) {
      flushList();
      blocks.push({ kind: "h2", text: (h2 ?? h1)![1] });
    } else if (ul) {
      if (!list || list.kind !== "ul") {
        flushList();
        list = { kind: "ul", items: [] };
      }
      list.items.push(ul[1]);
    } else if (ol) {
      if (!list || list.kind !== "ol") {
        flushList();
        list = { kind: "ol", items: [] };
      }
      list.items.push(ol[1]);
    } else if (quote) {
      flushList();
      blocks.push({ kind: "quote", text: quote[1] });
    } else {
      flushList();
      blocks.push({ kind: "p", text: line });
    }
  }
  flushList();
  return blocks;
}

export default function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2.5">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "h2":
            return (
              <h3
                key={i}
                className="mt-1 flex items-center gap-1.5 text-[14px] font-black leading-6 text-emerald-900"
              >
                {renderInline(block.text, `h2-${i}`)}
              </h3>
            );
          case "h3":
            return (
              <h4 key={i} className="text-[13px] font-black leading-5 text-emerald-900">
                {renderInline(block.text, `h3-${i}`)}
              </h4>
            );
          case "ul":
            return (
              <ul key={i} className="space-y-1.5">
                {block.items.map((item, j) => (
                  <li key={j} className="flex gap-2 text-[13px] font-semibold leading-6">
                    <span aria-hidden className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                    <span className="min-w-0">{renderInline(item, `ul-${i}-${j}`)}</span>
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="space-y-1.5">
                {block.items.map((item, j) => (
                  <li key={j} className="flex gap-2 text-[13px] font-semibold leading-6">
                    <span
                      aria-hidden
                      className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-100 text-[10.5px] font-black text-emerald-800"
                    >
                      {j + 1}
                    </span>
                    <span className="min-w-0">{renderInline(item, `ol-${i}-${j}`)}</span>
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <p
                key={i}
                className="rounded-xl border-s-4 border-amber-400 bg-amber-50/80 px-3 py-2 text-[12.5px] font-semibold leading-6 text-amber-900"
              >
                {renderInline(block.text, `q-${i}`)}
              </p>
            );
          default:
            return (
              <p key={i} className="text-[13px] font-semibold leading-6">
                {renderInline(block.text, `p-${i}`)}
              </p>
            );
        }
      })}
    </div>
  );
}
