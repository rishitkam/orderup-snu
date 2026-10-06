// ------------------------------------------------------------------
// 1. Go to https://console.firebase.google.com → Add project (free)
// 2. Inside the project: Build → Firestore Database → Create database
//    (start in test mode, then apply firestore.rules from this folder)
// 3. Project settings (gear icon) → General → "Your apps" → Web app (</>)
// 4. Copy the config object it gives you and paste the values below.
// ------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  getAuth,
  GoogleAuthProvider,
  browserLocalPersistence,
  setPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

export const googleProvider = new GoogleAuthProvider();


const firebaseConfig = {
  apiKey: "AIzaSyC9rTl9gCtEmzM4IYJRoxc3wCQU87OrW84",
  // Set to the domain the site is actually served from, NOT the default
  // orderknot-snu.firebaseapp.com Firebase generated. This is deliberate.
  //
  // signInWithRedirect (the fallback when the popup is blocked, which is what
  // happens on iOS Safari) sends the browser to Google via a handler hosted on
  // authDomain, and reads the credential back out of authDomain-owned storage
  // on return. When authDomain differs from the page origin, that handoff is
  // cross-origin — and iOS Safari's tracking prevention partitions/wipes that
  // storage across the round trip, so getRedirectResult() comes back EMPTY and
  // the user silently bounces to the login screen. (Desktop/Android are lenient
  // about cross-origin storage, which is why only iPhones were affected.)
  //
  // Pointing authDomain at the serving origin keeps the whole flow first-party,
  // so nothing is partitioned away and iOS completes sign-in.
  //
  // PREREQUISITE: https://orderknot-snu.web.app/__/auth/handler must be in the
  // OAuth client's Authorized redirect URIs (Google Cloud Console → APIs &
  // Services → Credentials → Web client). Without it Google rejects every
  // sign-in with "Error 400: redirect_uri_mismatch". It was added there before
  // this value was changed. Firebase Hosting serves the /__/auth/* handler on
  // this domain automatically.
  authDomain: "orderknot-snu.web.app",
  projectId: "orderknot-snu",
  storageBucket: "orderknot-snu.firebasestorage.app",
  messagingSenderId: "72262965540",
  appId: "1:72262965540:web:eb969b5b34b7f3c55a3bb1",
  measurementId: "G-CTB1814S7D"
};

export const app = initializeApp(firebaseConfig);

// App Check attaches a reCAPTCHA v3 attestation token to every request this
// app makes to Firestore, proving to the server that the request came from
// this real, registered web app and not a script hitting the API directly.
// Firestore has App Check set to Enforced — without this, the server was
// rejecting almost every request before Security Rules ever ran, which is
// why posting failed with "blocked by a database rule" even though the
// rules themselves were correct.
//
// This is the reCAPTCHA *site key* — public by design, meant to ship in
// client code, the same way the apiKey above does. It is NOT the secret
// key (that one stays server-side only and is never used here).
//
// Initialized here, immediately after `app` and before anything else makes
// a network call, so every subsequent request is covered from the start.
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider("6LcpWYUtAAAAABtVLyj0DfRX7j0sDJBJ5jA41LRR"),
  isTokenAutoRefreshEnabled: true
});

// onSnapshot keeps the board live over a long-running WebChannel stream. Plenty
// of networks (campus wifi, captive portals, corporate proxies) and some Safari
// configurations block that stream while still allowing ordinary requests — the
// symptom is the first snapshot arriving fine and no update ever landing after
// it, i.e. "I have to refresh to see new orders". Auto-detect falls back to long
// polling when that happens, instead of sitting on a dead stream.
export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true
});
export const auth = getAuth(app);

// Declared BEFORE any async work in this module, and deliberately so.
//
// This module used to end with `await setPersistence(...)` and declare
// ALLOWED_DOMAIN *after* it. A top-level await suspends module evaluation,
// and any export declared after it is still in its temporal dead zone while
// suspended — so callbacks that fire during that window (Firebase's auth
// observer is one) see an uninitialized binding. Safari reported it as
// "ReferenceError: Cannot access 'ALLOWED_DOMAIN' before initialization",
// thrown on the observer's first line. Firebase swallows whatever the
// observer throws, so sign-in succeeded, nothing listened, and the login
// screen sat there — with an empty-looking console.
//
// Rule for this file: no top-level await, and exports first.
export const ALLOWED_DOMAIN = "snu.edu.in";

googleProvider.setCustomParameters({
  prompt: "select_account"
});
// Storage can be unavailable outright (Private Browsing, locked-down ITP
// settings, some in-app webviews). This used to be a bare top-level await —
// when it rejected, the whole module failed to evaluate, and app.js imports
// from here, so app.js never ran at all: no listeners, no onAuthStateChanged,
// a sign-in button that silently did nothing. But awaiting it at the top
// level is what caused the TDZ bug described above. So: start it, expose the
// promise so callers can sequence against it, and record any failure in a
// mutable holder that's safe to read at any time.
export const persistenceState = { error: null };

export const persistenceReady = setPersistence(auth, browserLocalPersistence)
  .catch((err) => {
    console.error("Local persistence unavailable, falling back to in-memory:", err);
    persistenceState.error = err;
  });

