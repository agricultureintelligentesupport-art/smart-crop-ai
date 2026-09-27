"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Dependency-free Markdown renderer with a polished, professional
 * typewriter-style progressive text reveal for assistant replies.
 *
 * Pre-parses markdown blocks and inline formatting (headings, lists, quotes,
 * bold, code) so that syntax delimiters (`**`, `##`, etc.) never glitch on
 * screen. Characters stream in small, smooth, pacing-calibrated chunks paired
 * with an emerald pulsing cursor that disappears upon completion.
 *
 * Full support for `prefers-reduced-motion` (instant display with subtle fade)
 * and automatic scroll tracking to eliminate layout jank.
 */

interface InlineToken {
  kind: "bold" | "code" | "plain";
  text: string;
}

function parseTokens(raw: string): InlineToken[] {
  const parts = raw.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return { kind: "bold", text: part.slice(2, -2) };
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return { kind: "code", text: part.slice(1, -1) };
    }
    return { kind: "plain", text: part };
  });
}

function renderTokens(
  tokens: InlineToken[],
  charBudget: number,
  showCursor: boolean,
  keyPrefix: string
): ReactNode[] {
  let remaining = charBudget;
  const nodes: ReactNode[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (remaining <= 0) break;
    const token = tokens[i];
    const len = token.text.length;
    const isLastToken = remaining <= len || i === tokens.length - 1;
    const visibleText = token.text.slice(0, remaining);
    remaining -= len;

    const cursor =
      showCursor && isLastToken ? <span className="chat-cursor" aria-hidden /> : null;

    if (token.kind === "bold") {
      nodes.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-black text-emerald-950">
          {visibleText}
          {cursor}
        </strong>
      );
    } else if (token.kind === "code") {
      nodes.push(
        <code
          key={`${keyPrefix}-c${i}`}
          dir="ltr"
          className="rounded-md bg-emerald-900/8 px-1.5 py-0.5 text-[0.85em] font-bold text-emerald-800"
        >
          {visibleText}
          {cursor}
        </code>
      );
    } else {
      nodes.push(
        <span key={`${keyPrefix}-t${i}`}>
          {visibleText}
          {cursor}
        </span>
      );
    }
  }

  return nodes;
}

interface ParsedItem {
  tokens: InlineToken[];
  length: number;
  start: number;
  end: number;
}

interface ParsedBlock {
  kind: "h2" | "h3" | "p" | "quote" | "ul" | "ol";
  tokens?: InlineToken[];
  items?: ParsedItem[];
  length: number;
  start: number;
  end: number;
}

function parseMarkdownWithOffsets(markdown: string): {
  blocks: ParsedBlock[];
  totalChars: number;
} {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const rawBlocks: Array<
    | { kind: "h2" | "h3" | "p" | "quote"; text: string }
    | { kind: "ul" | "ol"; items: string[] }
  > = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;

  const flushList = () => {
    if (list) {
      rawBlocks.push(list);
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
      rawBlocks.push({ kind: "h3", text: h3[1] });
    } else if (h2 || h1) {
      flushList();
      rawBlocks.push({ kind: "h2", text: (h2 ?? h1)![1] });
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
      rawBlocks.push({ kind: "quote", text: quote[1] });
    } else {
      flushList();
      rawBlocks.push({ kind: "p", text: line });
    }
  }
  flushList();

  let offset = 0;
  const blocks: ParsedBlock[] = rawBlocks.map((b) => {
    const blockStart = offset;
    if ("items" in b) {
      let itemOffset = blockStart;
      const items: ParsedItem[] = b.items.map((itemText) => {
        const tokens = parseTokens(itemText);
        const length = tokens.reduce((sum, t) => sum + t.text.length, 0);
        const itemStart = itemOffset;
        const itemEnd = itemStart + length;
        itemOffset = itemEnd;
        return { tokens, length, start: itemStart, end: itemEnd };
      });
      const blockLength = items.reduce((sum, it) => sum + it.length, 0);
      const blockEnd = blockStart + blockLength;
      offset = blockEnd;
      return {
        kind: b.kind,
        items,
        length: blockLength,
        start: blockStart,
        end: blockEnd,
      };
    } else {
      const tokens = parseTokens(b.text);
      const blockLength = tokens.reduce((sum, t) => sum + t.text.length, 0);
      const blockEnd = blockStart + blockLength;
      offset = blockEnd;
      return {
        kind: b.kind,
        tokens,
        length: blockLength,
        start: blockStart,
        end: blockEnd,
      };
    }
  });

  return { blocks, totalChars: offset };
}

export default function Markdown({
  text,
  animate = true,
}: {
  text: string;
  animate?: boolean;
}) {
  const { blocks, totalChars } = useMemo(() => parseMarkdownWithOffsets(text), [text]);
  const reduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);

  const [revealedCount, setRevealedCount] = useState<number>(() =>
    animate ? 0 : totalChars
  );

  const effectiveCount = reduceMotion || !animate ? totalChars : revealedCount;
  const isComplete = effectiveCount >= totalChars;

  // Progressive reveal timer
  useEffect(() => {
    if (reduceMotion || !animate || totalChars === 0) return;

    // Pacing formula: smoothly finishes in ~1.2s to 2.2s
    const step = Math.max(2, Math.ceil(totalChars / 80));
    const timer = window.setInterval(() => {
      setRevealedCount((prev) => {
        const next = prev + step;
        if (next >= totalChars) {
          window.clearInterval(timer);
          return totalChars;
        }
        return next;
      });
    }, 20);

    return () => window.clearInterval(timer);
  }, [animate, reduceMotion, totalChars]);

  // Keep scroll pinned to bottom while typing (prevents layout jumping)
  useEffect(() => {
    if (isComplete) return;
    const container = rootRef.current?.closest(".overflow-y-auto");
    if (container) {
      const isNearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < 120;
      if (isNearBottom) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [effectiveCount, isComplete]);

  return (
    <motion.div
      ref={rootRef}
      initial={reduceMotion ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="space-y-3 break-words text-emerald-950"
    >
      {blocks.map((block, i) => {
        // Block has not started typing yet
        if (effectiveCount < block.start) {
          return null;
        }

        const blockBudget = Math.max(0, effectiveCount - block.start);
        const blockIsActive = effectiveCount < block.end;

        if (block.kind === "ul" || block.kind === "ol") {
          const renderedItems: ReactNode[] = [];

          if (block.items) {
            for (let j = 0; j < block.items.length; j++) {
              const item = block.items[j];
              if (effectiveCount < item.start) break;

              const itemBudget = Math.max(0, effectiveCount - item.start);
              const itemIsActive = effectiveCount < item.end;
              const showItemCursor = itemIsActive && !isComplete;

              const content = renderTokens(
                item.tokens,
                itemBudget,
                showItemCursor,
                `${block.kind}-${i}-${j}`
              );

              if (block.kind === "ul") {
                renderedItems.push(
                  <li key={j} className="flex gap-2 text-[13px] font-semibold leading-6">
                    <span
                      aria-hidden
                      className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_0_6px_rgba(16,185,129,0.6)]"
                    />
                    <span className="min-w-0">{content}</span>
                  </li>
                );
              } else {
                renderedItems.push(
                  <li key={j} className="flex gap-2 text-[13px] font-semibold leading-6">
                    <span
                      aria-hidden
                      className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-100 to-emerald-200/80 text-[10.5px] font-black text-emerald-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]"
                    >
                      {j + 1}
                    </span>
                    <span className="min-w-0">{content}</span>
                  </li>
                );
              }
            }
          }

          if (renderedItems.length === 0) return null;

          return block.kind === "ul" ? (
            <ul key={i} className="space-y-1.5">
              {renderedItems}
            </ul>
          ) : (
            <ol key={i} className="space-y-1.5">
              {renderedItems}
            </ol>
          );
        }

        const showCursor = blockIsActive && !isComplete;
        const content = renderTokens(
          block.tokens ?? [],
          blockBudget,
          showCursor,
          `b-${i}`
        );

        switch (block.kind) {
          case "h2":
            return (
              <h3
                key={i}
                className="mt-1.5 flex items-center gap-2 text-[14.5px] font-black leading-6 tracking-tight text-emerald-900 first:mt-0"
              >
                <span
                  aria-hidden
                  className="h-4 w-1 shrink-0 rounded-full bg-gradient-to-b from-emerald-400 to-emerald-600"
                />
                {content}
              </h3>
            );
          case "h3":
            return (
              <h4 key={i} className="text-[13px] font-black leading-5 text-emerald-900">
                {content}
              </h4>
            );
          case "quote":
            return (
              <p
                key={i}
                className="rounded-xl border-s-4 border-amber-400 bg-gradient-to-br from-amber-50 to-orange-50/60 px-3 py-2 text-[12.5px] font-semibold leading-6 text-amber-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
              >
                {content}
              </p>
            );
          default:
            return (
              <p key={i} className="text-[13px] font-semibold leading-6">
                {content}
              </p>
            );
        }
      })}
    </motion.div>
  );
}
