# Firebase Auth diagnostics

The app exposes the Firebase runtime configuration through
`firebaseRuntimeConfig` in `src/lib/firebase.ts`. It deliberately reports only
safe metadata: whether the environment values were loaded, the project ID,
the auth domain, the source (`environment`, `development-fallback`, or
`incomplete`), and the initialization error. The API key itself is never
rendered.

## What was found

With no `.env.local` in this checkout, the required
`NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
`NEXT_PUBLIC_FIREBASE_PROJECT_ID`, and `NEXT_PUBLIC_FIREBASE_APP_ID` values are
not present. In development the app therefore uses the explicitly labelled
`development-fallback`, whose project is
`agriculture-intelligente-7873e`. Before this diagnostic was added, the same
fallback happened silently and even an invalid/partially configured runtime
could fall back to a different project. In production, missing or partial
configuration now fails closed with `auth/configuration-missing` instead of
silently selecting another project.

The `.env.example` values target the same `agriculture-intelligente-7873e`
project. The deployment must still provide them as build-time environment
variables; a Firebase web config is public, but it is project-specific.
`NEXT_PUBLIC_AUTH_BACKEND=firebase` is also required for real phone/e-mail
Firebase auth. The Google button always uses real Firebase Auth regardless of
that gateway switch.

## Raw Google error reporting

Each of these calls has an explicit error boundary:

- `signInWithPopup`
- `signInWithRedirect`
- `getRedirectResult`

The exact SDK `error.code` and `error.message` are preserved and shown in an
assertive red alert below the Google button. Common findings are:

- `auth/operation-not-allowed`: enable Google under Firebase Console →
  Authentication → Sign-in providers.
- `auth/unauthorized-domain`: add the exact application hostname under
  Firebase Console → Authentication → Settings → Authorized domains.
- `auth/invalid-api-key`: the API key does not belong to the configured
  Firebase project or is restricted incorrectly.
- `auth/internal-error`: inspect the original message in the alert and the
  browser console; no fake session is created.

The alert also prints the config source and project ID, which makes a project
mismatch visible immediately.

## Redirect handshake

Before popup/redirect auth the app explicitly requests
`browserLocalPersistence` and records a short-lived session-storage marker.
On every fresh page load it calls `getRedirectResult(auth)` exactly once and
logs whether the result was a Firebase user or `null`, whether a redirect was
pending, and whether `auth.currentUser` was already restored. A `null` result
is normal on a direct visit; if it occurs after a redirect, the concurrent
`onAuthStateChanged` listener adopts the restored Firebase user when one is
available. If neither a result nor a restored user exists, the flow stays on
the
method step and never creates a fake account.

The two most common reasons for a post-redirect `null` are blocked/partitioned
browser persistence and a redirect returning to an origin that Firebase does
not authorize. The raw `getRedirectResult` error is surfaced in the alert when
Firebase provides one. The persistence call is also guarded and surfaced so it
cannot fail silently.
