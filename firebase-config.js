// ------------------------------------------------------------------
// 1. Go to https://console.firebase.google.com → Add project (free)
// 2. Inside the project: Build → Firestore Database → Create database
//    (start in test mode, then apply firestore.rules from this folder)
// 3. Project settings (gear icon) → General → "Your apps" → Web app (</>)
// 4. Copy the config object it gives you and paste the values below.
// ------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
export const db = getFirestore(app);
export const auth = getAuth(app);
googleProvider.setCustomParameters({
  prompt: "select_account"
});
// Storage can be unavailable outright (Private Browsing, locked-down ITP
// settings, some in-app webviews). This used to be a bare top-level await —
// when it rejected, the whole module failed to evaluate, and app.js imports
// from here, so app.js never ran at all: no listeners, no onAuthStateChanged,
// a sign-in button that silently did nothing. Now it degrades to Firebase's
// in-memory default instead, and reports why.
export const persistenceError = await setPersistence(auth, browserLocalPersistence)
  .then(() => null)
  .catch((err) => {
    console.error("Local persistence unavailable, falling back to in-memory:", err);
    return err;
  });

// only students with this email domain may use the site
export const ALLOWED_DOMAIN = "snu.edu.in";

