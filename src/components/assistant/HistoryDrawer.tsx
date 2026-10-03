"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { MessageSquarePlus, MoreVertical, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { FOCUS_RING, GPU } from "@/components/auth/ui";
import type { HistoryCopy } from "@/lib/assistant/historyCopy";
import type { ConversationGroup, ConversationMeta, RecencyGroupKey } from "@/lib/assistant/conversations";
import type { Lang } from "@/lib/wilayas";

/** Short, presentation-only relative time (e.g. "قبل 5 دقائق") — no business logic. */
function formatRelativeTime(iso: string, lang: Lang, now: Date = new Date()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diffSeconds = Math.round((now.getTime() - ts) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang === "ar" ? "ar" : "fr", { numeric: "auto" });
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.345, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = diffSeconds;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  for (const [limit, nextUnit] of steps) {
    if (Math.abs(value) < limit) {
      unit = nextUnit;
      break;
    }
    value = Math.round(value / limit);
    unit = nextUnit;
  }
  try {
    return rtf.format(-Math.max(0, value), unit);
  } catch {
    return "";
  }
}

interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  lang: Lang;
  copy: HistoryCopy;
  groups: ConversationGroup[];
  activeId: string | null;
  /** Caption: signed-in members keep history in their account, guests on-device. */
  savedOnAccount: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onDeleteOne: (id: string) => void;
  onDeleteAll: () => void;
}

const GROUP_LABEL_KEY: Record<RecencyGroupKey, keyof HistoryCopy["groups"]> = {
  today: "today",
  yesterday: "yesterday",
  week: "week",
  older: "older",
};

/**
 * Right-side (RTL) conversation drawer: overlay + sliding panel, swipe-to-close,
 * focus trap, ESC/back support. Purely presentational + local interaction state
 * (which menu is open, which item is being renamed) — every actual data change
 * goes back to the view through the callback props.
 */
export default function HistoryDrawer({
  open,
  onClose,
  lang,
  copy,
  groups,
  activeId,
  savedOnAccount,
  onSelect,
  onNewChat,
  onRename,
  onDeleteOne,
  onDeleteAll,
}: HistoryDrawerProps) {
  const reduce = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  /** Closes the drawer and resets its local interaction state (open menu / in-progress rename). */
  const handleClose = useCallback(() => {
    setMenuFor(null);
    setRenamingId(null);
    onClose();
  }, [onClose]);

  // ESC + focus trap + focus-on-open.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const focusables = () =>
      panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusables();
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, handleClose]);

  // Back-button support: a drawer open consumes one "back" instead of leaving the screen.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    window.history.pushState({ phytoscanDrawer: true }, "");
    const onPopState = () => handleClose();
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (window.history.state?.phytoscanDrawer) window.history.back();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per open/close transition
  }, [open]);

  const startRename = useCallback((item: ConversationMeta) => {
    setMenuFor(null);
    setRenamingId(item.id);
    setRenameDraft(item.title);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingId) onRename(renamingId, renameDraft);
    setRenamingId(null);
  }, [renamingId, renameDraft, onRename]);

  const onRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        setRenamingId(null);
      }
    },
    [commitRename],
  );

  const dragX = lang === "ar" ? 1 : -1; // panel sits on the "start" edge; dragging it off-screen closes it

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            aria-label={copy.close}
            key="overlay"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.22 }}
            onClick={handleClose}
            className="chat-drawer-overlay z-[60]"
          />
          <motion.div
            key="panel"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={copy.drawerTitle}
            drag="x"
            dragDirectionLock
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: dragX > 0 ? 0 : 0.5, right: dragX > 0 ? 0.5 : 0 }}
            onDragEnd={(_event, info) => {
              const offset = info.offset.x * dragX;
              if (offset < -70) handleClose();
            }}
            initial={reduce ? false : { x: `${-100 * dragX}%` }}
            animate={{ x: 0 }}
            exit={{ x: `${-100 * dragX}%` }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 42 }}
            className={`chat-drawer-panel ${GPU} z-[61] flex flex-col`}
            dir={lang === "ar" ? "rtl" : "ltr"}
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--chat-hairline)] px-4 py-3.5">
              <h2 className="text-[15px] font-black text-emerald-950">{copy.drawerTitle}</h2>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={handleClose}
                aria-label={copy.close}
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-emerald-800 hover:bg-emerald-50 ${FOCUS_RING}`}
              >
                <X size={18} strokeWidth={2.4} aria-hidden />
              </button>
            </div>

            {/* Primary action */}
            <div className="shrink-0 px-4 pt-3.5">
              <button
                type="button"
                onClick={() => {
                  onNewChat();
                  handleClose();
                }}
                className={`flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-[13.5px] font-black text-white shadow-[0_10px_22px_-12px_rgba(5,150,105,0.9)] ${FOCUS_RING}`}
              >
                <MessageSquarePlus size={16} strokeWidth={2.6} aria-hidden />
                {copy.newChat}
              </button>
            </div>

            {/* List */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 py-3">
              {groups.length === 0 ? (
                <p className="px-2.5 py-6 text-center text-[12.5px] font-bold text-emerald-900/45">{copy.emptyList}</p>
              ) : (
                groups.map((group) => (
                  <div key={group.key} className="mb-3">
                    <p className="px-2.5 pb-1.5 pt-2 text-[11px] font-black uppercase tracking-wide text-emerald-900/40">
                      {copy.groups[GROUP_LABEL_KEY[group.key]]}
                    </p>
                    <ul className="flex flex-col gap-1">
                      {group.items.map((item) => (
                        <li key={item.id} className="relative">
                          {renamingId === item.id ? (
                            <div className="flex items-center gap-1.5 rounded-xl px-2.5 py-2">
                              <input
                                autoFocus
                                value={renameDraft}
                                onChange={(event) => setRenameDraft(event.target.value)}
                                onKeyDown={onRenameKeyDown}
                                onBlur={commitRename}
                                maxLength={40}
                                className="h-11 min-w-0 flex-1 rounded-xl border border-emerald-300/60 bg-white px-3 text-[13px] font-bold text-emerald-950 outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/35"
                              />
                            </div>
                          ) : (
                            <div
                              className={`chat-drawer-item flex items-center gap-1 rounded-xl ${
                                item.id === activeId ? "chat-drawer-item-active" : ""
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  onSelect(item.id);
                                  handleClose();
                                }}
                                className={`min-w-0 flex-1 rounded-xl px-2.5 py-2.5 text-start ${FOCUS_RING}`}
                              >
                                <span className="block truncate text-[13px] font-bold text-emerald-950">{item.title}</span>
                                <span className="block truncate text-[10.5px] font-semibold text-emerald-900/45">
                                  {formatRelativeTime(item.updatedAt, lang)}
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setMenuFor((current) => (current === item.id ? null : item.id))}
                                aria-label={copy.itemMenu}
                                aria-haspopup="menu"
                                aria-expanded={menuFor === item.id}
                                className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-emerald-700/70 hover:bg-emerald-50 ${FOCUS_RING}`}
                              >
                                <MoreVertical size={16} strokeWidth={2.4} aria-hidden />
                              </button>

                              {menuFor === item.id && (
                                <div
                                  role="menu"
                                  className="chat-drawer-menu absolute end-10 top-11 z-10 w-40 overflow-hidden py-1"
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => startRename(item)}
                                    className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-[12.5px] font-bold text-emerald-900 hover:bg-emerald-50"
                                  >
                                    <Pencil size={14} strokeWidth={2.4} aria-hidden />
                                    {copy.rename}
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setMenuFor(null);
                                      if (typeof window === "undefined" || window.confirm(copy.deleteOneConfirm)) {
                                        onDeleteOne(item.id);
                                      }
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-[12.5px] font-bold text-rose-600 hover:bg-rose-50"
                                  >
                                    <Trash2 size={14} strokeWidth={2.4} aria-hidden />
                                    {copy.deleteOne}
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="shrink-0 border-t border-[var(--chat-hairline)] px-4 py-3.5">
              {groups.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (typeof window === "undefined" || window.confirm(copy.deleteAllConfirm)) onDeleteAll();
                  }}
                  className={`flex h-11 w-full items-center justify-center gap-2 rounded-2xl text-[12.5px] font-black text-rose-600 hover:bg-rose-50 ${FOCUS_RING}`}
                >
                  <Trash2 size={15} strokeWidth={2.4} aria-hidden />
                  {copy.deleteAll}
                </button>
              )}
              <p className="mt-1 text-center text-[10.5px] font-semibold text-emerald-900/40">
                {savedOnAccount ? copy.savedToAccount : copy.savedOnDevice}
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/** Small "+" shortcut for the header trailing slot (optional, alongside the menu button). */
export function NewChatShortcut({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-[rgba(6,78,59,0.09)] bg-white/85 text-emerald-800 shadow-[0_1px_2px_rgba(6,78,59,0.06)] transition-colors hover:bg-white active:scale-[0.96] ${FOCUS_RING}`}
    >
      <Plus size={18} strokeWidth={2.4} aria-hidden />
    </button>
  );
}
