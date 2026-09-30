"use client";

/**
 * Saved field boundaries — the polygons the farmer draws on the map.
 *
 * Storage mirrors the rest of the app (`auth/userDoc.ts` writes
 * `users/{uid}`, `dailyTasks/store.ts` caches locally): Firestore is the
 * source of truth for a signed-in member, and `localStorage` is both the
 * offline fallback and the instant first paint. Reads merge the two, newest
 * `updatedAt` wins, so a plot drawn while offline is still there on reload.
 *
 * Key layout:
 *   Firestore   `users/{uid}/plots/{plotId}`
 *   localStorage `smart-crop.plots.v1.{uid}`
 *
 * The boundary is private to its owner: it is written under the signed-in
 * user's own path with the client SDK, exactly like the rest of their profile,
 * and the app's Firestore security rules are what keep it that way. The server
 * only ever receives a geometry it has to measure — see `api/field-data`.
 *
 * SSR-safe and never throws: a blocked IndexedDB, a full localStorage or an
 * offline Firestore degrade to "in-memory for this session", never to a crash.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  setDoc,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
import { db, isFirestoreReady } from "@/lib/firebase";
import { logAuthError, logAuthInfo } from "@/lib/auth/logging";
import { centroidOf, normalizeRing, ringAreaHa, validatePlot, type Ring } from "@/lib/geo/polygon";
import type { Plot } from "./types";

const STORAGE_PREFIX = "smart-crop.plots.v1.";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Plot ids are random, not sequential — they must not be guessable. */
function newPlotId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  }
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function isPlot(value: unknown): value is Plot {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Plot>;
  return (
    typeof v.id === "string" &&
    typeof v.uid === "string" &&
    typeof v.areaHa === "number" &&
    Array.isArray(v.ring) &&
    v.ring.length >= 3
  );
}

/**
 * Parsed copies of the stored JSON, keyed by the exact string they came from.
 *
 * `useSyncExternalStore` compares snapshots by identity, and a freshly parsed
 * array is never identical to the last one — without this the dashboard would
 * re-render forever. Re-parsing only when the bytes actually change keeps the
 * snapshot stable while still reflecting an edit immediately.
 */
const parsedCache = new Map<string, { raw: string | null; plots: Plot[] }>();
const NO_PLOTS: Plot[] = [];

function readLocal(uid: string, storage: StorageLike | null): Plot[] {
  if (!storage) return NO_PLOTS;
  const key = STORAGE_PREFIX + uid;
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return NO_PLOTS;
  }
  const hit = parsedCache.get(uid);
  if (hit && hit.raw === raw) return hit.plots;
  if (!raw) {
    parsedCache.set(uid, { raw, plots: NO_PLOTS });
    return NO_PLOTS;
  }
  let plots: Plot[] = NO_PLOTS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) plots = parsed.filter(isPlot);
  } catch {
    plots = NO_PLOTS;
  }
  parsedCache.set(uid, { raw, plots });
  return plots;
}

function writeLocal(uid: string, plots: Plot[], storage: StorageLike | null): void {
  if (!storage) return;
  // The bytes are about to change, so the cached parse is stale by definition.
  parsedCache.delete(uid);
  try {
    storage.setItem(STORAGE_PREFIX + uid, JSON.stringify(plots));
  } catch {
    /* quota or private mode — Firestore remains the source of truth */
  }
  notify();
}

const listeners = new Set<() => void>();

/** Subscribes to plot changes (used by `useSyncExternalStore`). */
export function subscribeToPlots(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      /* a bad subscriber must not break the store */
    }
  });
}

function plotsCollection(firestore: Firestore, uid: string) {
  return collection(firestore, "users", uid, "plots");
}

/** Newest first, so the dashboard's default plot is the most recent one. */
function byRecency(plots: Plot[]): Plot[] {
  return [...plots].sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
}

/**
 * Firestore document shape for a plot.
 *
 * Firestore rejects nested arrays ("Nested arrays are not supported"), so the
 * ring cannot be stored as `number[][]`. The document therefore carries a flat
 * `[lon, lat, lon, lat, …]` `ringFlat`; the in-memory `Plot` — and everything
 * downstream of it, including the `/api/field-data` contract — keeps
 * `ring: [number, number][]` unchanged. Encoding lives only at this storage
 * boundary.
 */
interface FirestorePlotDoc extends Omit<Plot, "ring"> {
  ringFlat: number[];
}

/**
 * Exported for tests: the encoding must survive a round trip with the
 * in-memory `Plot` shape — including `[lon, lat]` pair order — because that
 * shape is the `/api/field-data` contract.
 */
export function toFirestoreDoc(plot: Plot): FirestorePlotDoc {
  const { ring, ...rest } = plot;
  return { ...rest, ringFlat: ring.flat() };
}

/** Accepts both the flat encoding and (defensively) a `ring` array of pairs. */
export function fromFirestoreDoc(data: unknown): Plot | null {
  if (!data || typeof data !== "object") return null;
  const doc = data as Partial<Plot> & { ringFlat?: unknown };
  if (Array.isArray(doc.ringFlat) && doc.ringFlat.length >= 6 && doc.ringFlat.length % 2 === 0) {
    const flat = doc.ringFlat as number[];
    const ring: Ring = [];
    for (let i = 0; i < flat.length; i += 2) ring.push([flat[i], flat[i + 1]]);
    const rest: Record<string, unknown> = { ...doc };
    delete rest.ringFlat;
    const rebuilt = { ...rest, ring } as Plot;
    return isPlot(rebuilt) ? rebuilt : null;
  }
  return isPlot(data) ? (data as Plot) : null;
}

function mergeById(...groups: Plot[][]): Plot[] {
  const map = new Map<string, Plot>();
  for (const plot of groups.flat()) {
    const existing = map.get(plot.id);
    if (!existing || plot.updatedAt >= existing.updatedAt) map.set(plot.id, plot);
  }
  return byRecency([...map.values()]);
}

/**
 * How long the account read may hold up the map.
 *
 * The device copy is already on screen by the time this runs, so the only
 * thing a slow or unreachable Firestore can cost is freshness. Without a
 * ceiling, a phone on a weak connection sits on "checking your account"
 * indefinitely instead of showing the fields the farmer just drew.
 */
const REMOTE_SYNC_TIMEOUT_MS = 4000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("plots: remote acknowledgement timed out")), ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Every plot for this user: the local copy merged with Firestore's. Firestore
 * failures never hide the local plots, so the map is usable offline.
 */
export async function listPlots(uid: string, firestore: Firestore = db): Promise<Plot[]> {
  if (!uid) return [];
  const local = readLocal(uid, defaultStorage());
  if (!isFirestoreReady(firestore)) {
    logAuthInfo("plots", `Firestore not ready — ${local.length} local plot(s) for ${uid}.`);
    return local;
  }
  try {
    const snap = await withTimeout(getDocs(plotsCollection(firestore, uid)), REMOTE_SYNC_TIMEOUT_MS);
    const remote = snap.docs
      .map((d) => fromFirestoreDoc(d.data()))
      .filter((p): p is Plot => p !== null);
    const merged = mergeById(local, remote);
    // Keep the device copy fresh so a later offline load still has everything.
    writeLocal(uid, merged, defaultStorage());
    return merged;
  } catch (error) {
    logAuthError("plots listPlots", error);
    return local;
  }
}

/** Synchronous local read — the map paints instantly, then Firestore syncs. */
export function readLocalPlots(uid: string): Plot[] {
  if (!uid) return [];
  return readLocal(uid, defaultStorage());
}

export interface SavePlotResult {
  ok: boolean;
  plot: Plot | null;
  /** Set when `ok` is false: why the boundary was refused. */
  error?: string;
}

/**
 * Validates and persists a drawn ring. The area, centroid and validity are all
 * *derived* from the geometry — nothing about the parcel is taken on trust from
 * the client, so a tampered payload cannot inject a fake hectare figure.
 */
export async function savePlot(
  uid: string,
  name: string,
  rawRing: unknown,
  existingId?: string | null,
  firestore: Firestore = db,
): Promise<SavePlotResult> {
  const ring: Ring = normalizeRing(rawRing);
  const validation = validatePlot(ring);
  if (!validation.ok) {
    return { ok: false, plot: null, error: validation.detail ?? validation.reason };
  }
  const now = new Date().toISOString();
  const id = existingId ?? newPlotId();
  const previous = readLocal(uid, defaultStorage()).find((p) => p.id === id);
  const plot: Plot = {
    id,
    uid,
    name: (name || "").trim().slice(0, 60) || "Parcel",
    ring,
    areaHa: Math.round(ringAreaHa(ring) * 100) / 100,
    centroid: centroidOf(ring) ?? [ring[0][0], ring[0][1]],
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  const local = readLocal(uid, defaultStorage()).filter((p) => p.id !== id);
  writeLocal(uid, mergeById(local, [plot]), defaultStorage());

  if (isFirestoreReady(firestore)) {
    try {
      // Local-first save already succeeded. Bound the acknowledgement, not
      // the queued SDK write: it can still sync when connectivity returns.
      await withTimeout(setDoc(doc(firestore, "users", uid, "plots", id), toFirestoreDoc(plot)), REMOTE_SYNC_TIMEOUT_MS);
    } catch (error) {
      // The local copy stands; the next listPlots() retries nothing, so say so.
      logAuthError("plots savePlot", error);
    }
  } else {
    logAuthInfo("plots", "Firestore not ready — plot kept on this device only.");
  }
  return { ok: true, plot };
}

export async function deletePlot(
  uid: string,
  plotId: string,
  firestore: Firestore = db,
): Promise<boolean> {
  writeLocal(uid, readLocal(uid, defaultStorage()).filter((p) => p.id !== plotId), defaultStorage());
  if (!isFirestoreReady(firestore)) return true;
  try {
    await withTimeout(deleteDoc(doc(firestore, "users", uid, "plots", plotId)), REMOTE_SYNC_TIMEOUT_MS);
    return true;
  } catch (error) {
    logAuthError("plots deletePlot", error);
    return false;
  }
}

/** Renames a plot without touching its geometry. */
export async function renamePlot(
  uid: string,
  plotId: string,
  name: string,
  firestore: Firestore = db,
): Promise<Plot | null> {
  // Prefer the current local record; a remote read must not overwrite a
  // boundary just saved offline with an older server copy before renaming.
  const plot = readLocal(uid, defaultStorage()).find((p) => p.id === plotId)
    ?? (await listPlots(uid, firestore)).find((p) => p.id === plotId);
  if (!plot) return null;
  const updated: Plot = { ...plot, name: name.trim().slice(0, 60) || plot.name, updatedAt: new Date().toISOString() };
  writeLocal(uid, mergeById(readLocal(uid, defaultStorage()).filter((p) => p.id !== plotId), [updated]), defaultStorage());
  if (isFirestoreReady(firestore)) {
    try {
      await withTimeout(setDoc(doc(firestore, "users", uid, "plots", plotId),
        { name: updated.name, updatedAt: updated.updatedAt }, { merge: true }), REMOTE_SYNC_TIMEOUT_MS);
    } catch (error) {
      logAuthError("plots renamePlot", error);
    }
  }
  return updated;
}

/** Batch write used by tests and bulk tooling. */
export async function replacePlots(uid: string, plots: Plot[], firestore: Firestore = db): Promise<void> {
  writeLocal(uid, byRecency(plots), defaultStorage());
  if (!isFirestoreReady(firestore)) return;
  const batch = writeBatch(firestore);
  for (const plot of plots) batch.set(doc(firestore, "users", uid, "plots", plot.id), toFirestoreDoc(plot));
  await batch.commit();
}
