"use client";

/**
 * The field map's place search: a pill input floating over the canvas, with a
 * dropdown of results. Replaces `leaflet-control-geocoder`.
 *
 * WHY IT LIVES HERE AND NOT IN LEAFLET
 * ------------------------------------
 * The old control rendered inside Leaflet's LTR control panes, fought the
 * RTL layout, hid its failures behind an unremovable throbber, and called
 * Nominatim straight from the browser — a request a web app cannot identify
 * itself on (no script-settable User-Agent) and cannot cache. As a React
 * component it owns a real UI: loading, empty ("لا توجد نتائج") and retryable
 * error states; ≥ 48 px touch rows; keyboard support; a debounced, aborted,
 * client-cached fetch to `/api/geocode`, which handles the Nominatim policy
 * (identification, caching, 1 req/s) server-side.
 *
 * NOTHING IS DRAWN. Selecting a result only flies the map there (zoom 16 —
 * single-field drawing scale, via `MapHandle.flyTo`).
 *
 * REQUEST DISCIPLINE (client half; the route enforces the hard limits)
 *   • debounce 500 ms after the last keystroke
 *   • minimum 3 characters (trimmed)
 *   • best-effort ≥ 1 s between network sends (cache hits are instant)
 *   • one AbortController per request; a newer query aborts the older one
 *   • an in-memory result cache for the lifetime of the sheet
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import type { Place } from "@/lib/geo/places";

export interface MapSearchCopy {
  placeholder: string;
  label: string;
  noResults: string;
  error: string;
  retry: string;
  /** Clear the input (✕). */
  clear: string;
}

type Status = "idle" | "loading" | "results" | "empty" | "error";

const MIN_CHARS = 3;
const DEBOUNCE_MS = 500;
/** Best-effort spacing between real network sends; the route hard-enforces it. */
const SEND_SPACING_MS = 1000;
const MAX_RESULTS = 5;

export default function MapSearch({ copy, lang, onSelect }: { copy: MapSearchCopy; lang: "ar" | "fr"; onSelect: (place: Place) => void }) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spacingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSendRef = useRef(0);
  const cacheRef = useRef(new Map<string, Place[]>());
  const listboxId = useId();

  const clearTimers = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (spacingRef.current) clearTimeout(spacingRef.current);
    debounceRef.current = null;
    spacingRef.current = null;
  }, []);

  const abortInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const runSearch = useCallback(
    (q: string) => {
      const key = `${lang}:${q}`;
      const cached = cacheRef.current.get(key);
      if (cached) {
        abortInFlight();
        setResults(cached);
        setStatus(cached.length > 0 ? "results" : "empty");
        setOpen(true);
        setActiveIndex(-1);
        return;
      }

      abortInFlight();
      const send = () => {
        lastSendRef.current = Date.now();
        const controller = new AbortController();
        abortRef.current = controller;
        setStatus("loading");
        fetch(`/api/geocode?q=${encodeURIComponent(q)}&lang=${lang}`, { signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) throw new Error(`geocode ${response.status}`);
            const body = (await response.json()) as { results?: Place[] };
            const found = (body.results ?? []).slice(0, MAX_RESULTS);
            cacheRef.current.set(key, found);
            if (controller.signal.aborted) return;
            setResults(found);
            setStatus(found.length > 0 ? "results" : "empty");
            setOpen(true);
            setActiveIndex(-1);
          })
          .catch(() => {
            // A newer query (or the clear button) owns the UI now; otherwise
            // this is a network/server failure — the retryable error state.
            if (controller.signal.aborted) return;
            setStatus("error");
            setOpen(true);
            setActiveIndex(-1);
          })
          .finally(() => {
            if (abortRef.current === controller) abortRef.current = null;
          });
      };

      const wait = SEND_SPACING_MS - (Date.now() - lastSendRef.current);
      if (wait > 0) {
        setStatus("loading");
        spacingRef.current = setTimeout(send, wait);
      } else {
        send();
      }
    },
    [abortInFlight, lang],
  );

  const onChange = useCallback(
    (raw: string) => {
      setValue(raw);
      const q = raw.replace(/\s+/gu, " ").trim();
      clearTimers();
      if (q.length < MIN_CHARS) {
        abortInFlight();
        setStatus("idle");
        setOpen(false);
        setResults([]);
        return;
      }
      debounceRef.current = setTimeout(() => runSearch(q), DEBOUNCE_MS);
    },
    [abortInFlight, clearTimers, runSearch],
  );

  const clearInput = useCallback(() => {
    clearTimers();
    abortInFlight();
    setValue("");
    setResults([]);
    setStatus("idle");
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }, [abortInFlight, clearTimers]);

  const retry = useCallback(() => {
    clearTimers();
    const q = value.replace(/\s+/gu, " ").trim();
    if (q.length < MIN_CHARS) return;
    runSearch(q);
  }, [clearTimers, runSearch, value]);

  const choose = useCallback(
    (place: Place) => {
      // A result picked while another query is still queued/in flight: nothing
      // of it may reopen the dropdown after the flight.
      clearTimers();
      abortInFlight();
      setOpen(false);
      setActiveIndex(-1);
      onSelect(place);
      // Mobile: the keyboard should not stay up over the map being flown.
      inputRef.current?.blur();
    },
    [abortInFlight, clearTimers, onSelect],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        if (open) {
          event.preventDefault();
          setOpen(false);
          setActiveIndex(-1);
          return;
        }
        inputRef.current?.blur();
        return;
      }
      if (!open || results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % results.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
      } else if (event.key === "Enter" && activeIndex >= 0) {
        event.preventDefault();
        choose(results[activeIndex]);
      }
    },
    [activeIndex, choose, open, results],
  );

  // Tap outside collapses the dropdown (and stops suggesting results the
  // farmer has moved past) without stealing focus from the map.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // The sheet unmounts with a search in flight: drop the timers and request.
  useEffect(
    () => () => {
      clearTimers();
      abortRef.current?.abort();
    },
    [clearTimers],
  );

  const loading = status === "loading";
  const showList = open && (status === "results" || status === "empty" || status === "error");
  // The search icon sits first in the DOM, so it renders on the right in RTL
  // (and left in French); the clear/spinner slot mirrors it on the other side.
  const dir = lang === "ar" ? "rtl" : "ltr";

  return (
    <div ref={rootRef} dir={dir} className="pointer-events-none absolute inset-x-3 top-3 z-[1000] flex justify-center">
      <div className="pointer-events-auto relative w-full max-w-[21rem]">
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (!open && results.length > 0) {
              setOpen(true);
              return;
            }
            if (open && activeIndex >= 0 && results[activeIndex]) choose(results[activeIndex]);
          }}
        >
          <div
            className="flex h-12 items-center gap-1 rounded-full border border-emerald-900/15 bg-white/95 ps-2 pe-1.5 shadow-[0_14px_30px_-18px_rgba(6,78,59,0.65)] backdrop-blur-sm transition-shadow focus-within:border-emerald-600/45 focus-within:ring-4 focus-within:ring-emerald-400/40"
          >
            {/* First in the DOM → right edge under RTL (left under French). */}
            <span className="grid h-8 w-8 shrink-0 place-items-center text-emerald-800/70" aria-hidden>
              <Search size={17} strokeWidth={2.4} />
            </span>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={copy.placeholder}
              aria-label={copy.label}
              role="combobox"
              aria-expanded={showList}
              aria-controls={showList ? listboxId : undefined}
              aria-activedescendant={showList && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              // 16 px: iOS Safari zooms into anything smaller on focus.
              className="h-full min-w-0 flex-1 bg-transparent text-[16px] font-semibold text-emerald-950 caret-emerald-700 outline-none placeholder:text-emerald-900/45"
            />
            {loading ? (
              <span className="grid h-11 w-11 shrink-0 place-items-center text-emerald-700" role="status" aria-live="polite">
                <Loader2 size={18} className="animate-spin" aria-hidden />
                <span className="sr-only">{copy.label}</span>
              </span>
            ) : value.length > 0 ? (
              <button
                type="button"
                onClick={clearInput}
                aria-label={copy.clear}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-emerald-900/55 hover:bg-emerald-900/5 hover:text-emerald-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
              >
                <X size={18} strokeWidth={2.5} aria-hidden />
              </button>
            ) : (
              <span className="h-11 w-11 shrink-0" aria-hidden />
            )}
          </div>
        </form>

        {showList && (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={copy.label}
            className="absolute inset-x-0 top-[calc(100%+6px)] max-h-[min(16rem,42dvh)] overflow-y-auto overscroll-contain rounded-2xl border border-emerald-900/15 bg-white/95 py-1 shadow-[0_22px_44px_-22px_rgba(6,78,59,0.7)] backdrop-blur-sm"
          >
            {status === "results" &&
              results.map((place, index) => (
                <li key={place.id} id={`${listboxId}-${index}`} role="option" aria-selected={index === activeIndex}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(place)}
                    onMouseEnter={() => setActiveIndex(index)}
                    dir="auto"
                    className={`flex min-h-12 w-full flex-col justify-center gap-0.5 px-4 py-1.5 text-start focus-visible:outline-none ${
                      index === activeIndex ? "bg-emerald-50" : ""
                    }`}
                  >
                    <span className="truncate text-[14px] font-extrabold leading-5 text-emerald-950">{place.name}</span>
                    {place.secondary && (
                      <span className="truncate text-[11.5px] font-semibold leading-4 text-emerald-900/55">{place.secondary}</span>
                    )}
                  </button>
                </li>
              ))}
            {status === "empty" && (
              <li className="flex min-h-12 items-center px-4 text-[13px] font-bold text-emerald-900/60" aria-live="polite">
                {copy.noResults}
              </li>
            )}
            {status === "error" && (
              <li className="flex min-h-12 flex-col justify-center gap-1 px-4 py-2" aria-live="assertive">
                <span className="text-[13px] font-bold text-emerald-900/70">{copy.error}</span>
                <button
                  type="button"
                  onClick={retry}
                  className="min-h-9 w-max rounded-full bg-emerald-600 px-4 text-[12.5px] font-extrabold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
                >
                  {copy.retry}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
