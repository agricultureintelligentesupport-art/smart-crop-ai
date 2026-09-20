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
import { clearProfile, writeProfile, type StoredProfile } from "@/lib/auth/profile";
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
        setUser(currentUser);

        if (profileUnsub) {
          profileUnsub();
          profileUnsub = null;
        }

        if (currentUser && db && (db as { app?: unknown }).app) {
          try {
            const userDocRef = doc(db, "users", currentUser.uid);
            profileUnsub = onSnapshot(
              userDocRef,
              (snapshot) => {
                if (snapshot.exists()) {
                  const data = snapshot.data() as UserProfile;
                  setProfile(data);

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
      clearProfile();
      setUser(null);
      setProfile(null);
    } catch (error) {
      console.error("Error signing out:", error);
      throw error;
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
