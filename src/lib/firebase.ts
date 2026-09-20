import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

export const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAbb9aCsOfMkw9G5H0L58LSkbsONhix51k",
  authDomain: "agriculture-intelligente-7873e.firebaseapp.com",
  projectId: "agriculture-intelligente-7873e",
  storageBucket: "agriculture-intelligente-7873e.firebasestorage.app",
  messagingSenderId: "213483282746",
  appId: "1:213483282746:web:badde539687095497a7003",
  measurementId: "G-VKD4SWJLNJ",
};

const apiKey =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim()) ||
  DEFAULT_FIREBASE_CONFIG.apiKey;
const authDomain =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim()) ||
  DEFAULT_FIREBASE_CONFIG.authDomain;
const projectId =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim()) ||
  DEFAULT_FIREBASE_CONFIG.projectId;
const storageBucket =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim()) ||
  DEFAULT_FIREBASE_CONFIG.storageBucket;
const messagingSenderId =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?.trim()) ||
  DEFAULT_FIREBASE_CONFIG.messagingSenderId;
const appId =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_APP_ID?.trim()) ||
  DEFAULT_FIREBASE_CONFIG.appId;
const measurementId =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID?.trim()) ||
  DEFAULT_FIREBASE_CONFIG.measurementId;

const firebaseConfig = {
  apiKey,
  authDomain,
  projectId,
  storageBucket,
  messagingSenderId,
  appId,
  measurementId,
};

/**
 * One Google provider for every sign-in entry point (popup AND redirect).
 *
 * `prompt: select_account` forces Google's account chooser, so clicking
 * "Continue with Google" always shows the account selection screen instead of
 * silently re-using the previously signed-in account.
 */
function createGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let googleProvider: GoogleAuthProvider;

try {
  app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  googleProvider = createGoogleProvider();
} catch {
  // Safe build-time and SSR fallback when invalid or dummy environment variables are provided
  try {
    app = getApps().length > 0 ? getApp() : initializeApp(DEFAULT_FIREBASE_CONFIG);
    auth = getAuth(app);
    db = getFirestore(app);
    googleProvider = createGoogleProvider();
  } catch {
    app = (getApps().length > 0 ? getApp() : {}) as FirebaseApp;
    auth = {} as Auth;
    db = {} as Firestore;
    googleProvider = createGoogleProvider();
  }
}

export {
  app,
  auth,
  db,
  db as firestore,
  googleProvider,
  GoogleAuthProvider,
  initializeApp,
  getAuth,
  getFirestore,
  firebaseConfig,
};

export default app;
