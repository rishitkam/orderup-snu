// ------------------------------------------------------------------
// 1. Go to https://console.firebase.google.com → Add project (free)
// 2. Inside the project: Build → Firestore Database → Create database
//    (start in test mode, then apply firestore.rules from this folder)
// 3. Project settings (gear icon) → General → "Your apps" → Web app (</>)
// 4. Copy the config object it gives you and paste the values below.
// ------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
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
  // Leave this as the firebaseapp.com domain Firebase generated.
  //
  // It's tempting to "fix" this to match the domain the site is served from
  // (orderknot-snu.web.app). Don't, unless you have also added
  // https://orderknot-snu.web.app/__/auth/handler to the Authorized redirect
  // URIs on the OAuth client in Google Cloud Console — otherwise Google
  // rejects every sign-in with "Error 400: redirect_uri_mismatch".
  //
  // Matching domains only mattered for signInWithRedirect, which reads the
  // credential back out of authDomain-owned storage. We use signInWithPopup
  // now (see app.js), and a popup returns the credential over postMessage,
  // which works cross-origin — so this can safely stay as-is.
  authDomain: "orderknot-snu.firebaseapp.com",
  projectId: "orderknot-snu",
  storageBucket: "orderknot-snu.firebasestorage.app",
  messagingSenderId: "72262965540",
  appId: "1:72262965540:web:eb969b5b34b7f3c55a3bb1",
  measurementId: "G-CTB1814S7D"
};

export const app = initializeApp(firebaseConfig);
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

