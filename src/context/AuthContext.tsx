"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import {
  doc,
  onSnapshot,
  setDoc,
  type Unsubscribe,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { clearProfile, readProfile, writeProfile, type StoredProfile } from "@/lib/auth/profile";
import { clearAllLocalCache } from "@/lib/auth/session";
import type { AuthRole } from "@/lib/auth/types";

export interface UserProfile {
  uid?: string;
  displayName?: string;
  email?: string;
  role?: string | null;
  wilaya?: string | null;
  wilayaCode?: string | null;
  preferredCrop?: string | null;
  [key: string]: unknown;
}

export interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  role: string | null;
  wilaya: string | null;
  preferredCrop: string | null;
  signOut: () => Promise<void>;
  updateProfile: (data: Partial<UserProfile>) => Promise<void>;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  loading: true,
  role: null,
  wilaya: null,
  preferredCrop: null,
  signOut: async () => {},
  updateProfile: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(auth && (auth as { app?: unknown }).app));

  useEffect(() => {
    let profileUnsub: Unsubscribe | null = null;
    let authUnsub: (() => void) | null = null;

    if (!auth || !(auth as { app?: unknown }).app) {
      return;
    }

    try {
      authUnsub = onAuthStateChanged(auth, (currentUser) => {
        // Whatever the previous session was listening to belongs to the
        // previous user: detach first so its snapshots can never land on the
        // new session (or on the signed-out state).
        if (profileUnsub) {
          profileUnsub();
          profileUnsub = null;
        }

        if (!currentUser?.uid) {
          // Signed out: identity state drops to defaults. A stale signed-in
          // profile left in storage (expired session, another tab's
          // sign-out, …) is discarded — guest records carry no identity and
          // are preserved, as are device preferences.
          setUser(null);
          setProfile(null);
          try {
            const cached = readProfile();
            if (cached && !cached.isGuest) clearProfile();
          } catch {
            /* storage unavailable */
          }
          setLoading(false);
          return;
        }

        // New (or restored) session: drop the previous user's in-memory
        // profile IMMEDIATELY so it can never flash on screen while the new
        // document loads, then bind strictly to users/{uid}.
        setUser(currentUser);
        setProfile(null);

        if (currentUser && db && (db as { app?: unknown }).app) {
          try {
            const uid = currentUser.uid;
            const userDocRef = doc(db, "users", uid);
            profileUnsub = onSnapshot(
              userDocRef,
              (snapshot) => {
                // Strict UID binding: a snapshot that arrives after the
                // session already moved on (account switch) is ignored.
                if (auth.currentUser?.uid !== uid) return;
                if (snapshot.exists()) {
                  const data = snapshot.data() as UserProfile;
                  // Complete overwrite: the new user's document replaces any
                  // in-memory remainder of the previous profile.
                  setProfile({ ...data, uid });

                  // Sync with local session storage for offline / quick hydration
                  const role = (data.role as AuthRole | null) ?? null;
                  const wilaya = data.wilaya ?? data.wilayaCode ?? null;
                  const method =
                    currentUser.providerData?.[0]?.providerId === "google.com" ? "google" : "email";

                  const stored: StoredProfile = {
                    uid: currentUser.uid,
                    method,
                    displayName:
                      data.displayName || currentUser.displayName || currentUser.email?.split("@")[0] || "",
                    email: currentUser.email ?? undefined,
                    role,
                    wilayaCode: wilaya,
                    isGuest: false,
                    updatedAt: Date.now(),
                  };
                  writeProfile(stored);
                } else {
                  setProfile(null);
                }
                setLoading(false);
              },
              (error) => {
                console.warn("Firestore user profile subscription error:", error);
                setLoading(false);
              },
            );
          } catch (err) {
            console.warn("Firestore listener initialization skipped:", err);
            setLoading(false);
          }
        } else {
          setProfile(null);
          setLoading(false);
        }
      });
    } catch (err) {
      console.warn("Auth listener initialization skipped:", err);
      queueMicrotask(() => setLoading(false));
    }

    return () => {
      if (authUnsub) authUnsub();
      if (profileUnsub) profileUnsub();
    };
  }, []);

  const signOut = async () => {
    try {
      if (auth && (auth as { app?: unknown }).app) {
        await fbSignOut(auth);
      }
    } finally {
      // Complete session isolation: the SDK sign-out is always accompanied
      // by a full local-cache wipe (localStorage + sessionStorage) and an
      // in-memory reset, so the next account can never inherit this
      // profile — even if signOut() itself throws (offline). Errors still
      // propagate to the caller.
      clearAllLocalCache();
      setUser(null);
      setProfile(null);
    }
  };

  const updateProfile = async (data: Partial<UserProfile>) => {
    if (!user || !db || !(db as { app?: unknown }).app) return;
    try {
      const userDocRef = doc(db, "users", user.uid);
      await setDoc(userDocRef, data, { merge: true });
    } catch (err) {
      console.warn("Update profile error:", err);
    }
  };

  const role = (profile?.role as string | null) ?? null;
  const wilaya = profile?.wilaya ?? profile?.wilayaCode ?? null;
  const preferredCrop =
    profile?.preferredCrop ?? (profile?.crop as string | null) ?? (profile?.preferred_crop as string | null) ?? null;

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        role,
        wilaya,
        preferredCrop,
        signOut,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export default AuthProvider;
