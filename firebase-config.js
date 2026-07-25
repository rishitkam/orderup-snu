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
await setPersistence(auth, browserLocalPersistence);

// only students with this email domain may use the site
export const ALLOWED_DOMAIN = "snu.edu.in";

