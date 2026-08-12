import {
  db, auth, googleProvider, ALLOWED_DOMAIN, persistenceState, persistenceReady
} from "./firebase-config.js";
import {
  collection, addDoc, onSnapshot, deleteDoc, doc, setDoc,
  serverTimestamp, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const ORDERS_COL = "orders";
const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

/* ---------------- apps ----------------
   Three apps, deliberately. Blinkit is a single storefront so there's nothing
   to disambiguate; Zomato and Swiggy are marketplaces, so an order only clubs
   with another order from the *same outlet*. */
const APPS = {
  Blinkit: { label: "Blinkit", initial: "b", needsOutlet: false },
  Zomato: { label: "Zomato", initial: "z", needsOutlet: true },
  Swiggy: { label: "Swiggy", initial: "s", needsOutlet: true }
};
const DEFAULT_APP = "Blinkit";

// Pre-loaded because free text fragments outlet names, and matching depends on
// two people naming the same outlet the same way. "Other" stays available.
const POPULAR_OUTLETS = [
  "Domino's Pizza", "California Burrito", "McDonald's", "Burger King",
  "KFC", "Subway", "Pizza Hut", "Wow! Momo", "Behrouz Biryani",
  "Chaayos", "Theobroma", "Haldiram's", "Rolls Mania", "Biryani Blues"
];
const OUTLET_OTHER = "__other__";

/* Brand marks, drawn as inline SVG so they work offline and inside the service
   worker cache — no external image requests. Each uses currentColor, so the
   colour comes from the .app-dot rule in style.css and stays correct on any
   background. To swap in an official asset, replace one entry here: nothing
   else in the codebase references these shapes. */
const APP_ICONS = {
  // Blinkit — lightning bolt (their "instant delivery" mark)
  Blinkit: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13.4 1.9 5.7 13.2c-.3.4 0 1 .5 1h3.9l-1.4 7.3c-.1.5.6.8.9.4l7.8-11.3c.3-.4 0-1-.5-1h-3.9l1.3-7.3c.1-.5-.6-.8-.9-.4z"/></svg>`,
  // Zomato — the Z letterform
  Zomato: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M5.3 3.6h13.4v3L10 17.4h8.7v3H5.3v-3l8.7-10.8H5.3z"/></svg>`,
  // Swiggy — the S curve
  Swiggy: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2.9" stroke-linecap="round" d="M16.8 6.4C15.5 5.1 13.9 4.5 12 4.5c-2.7 0-4.5 1.4-4.5 3.4 0 4 9.1 2.3 9.1 6.6 0 2.2-2 3.7-4.8 3.7-2.1 0-4-.9-5.3-2.4"/></svg>`
};

const isKnownApp = (app) => Object.prototype.hasOwnProperty.call(APPS, app);
const appNeedsOutlet = (app) => !!(APPS[app] && APPS[app].needsOutlet);
const appInitial = (app) => (APPS[app] ? APPS[app].initial : "?");
// Falls back to the letter mark if an app somehow has no icon.
const appIconHTML = (app) => APP_ICONS[app] || escapeHtml(appInitial(app));

// The filter bubbles ship with letter marks in the HTML as a no-JS fallback;
// this upgrades them to the real logos once the module runs.
function paintAppIcons(root) {
  (root || document).querySelectorAll(".app-dot[data-app]").forEach(el => {
    const icon = APP_ICONS[el.dataset.app];
    if (icon) el.innerHTML = icon;
  });
}

// Compared loosely so "Domino's Pizza" and "dominos pizza" still club together.
function outletKey(outlet) {
  return String(outlet || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* ---------------- identity: comes from a verified @{ALLOWED_DOMAIN} Google login ---------------- */
let myId = null;
let myEmail = null;
let myName = null;

/* ---------------- DOM refs: login gate ---------------- */
const loginGate = document.getElementById("loginGate");
const appRoot = document.getElementById("appRoot");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const loginNote = document.getElementById("loginNote");
const loginDiag = document.getElementById("loginDiag");
const loginDiagBody = document.getElementById("loginDiagBody");
const whoamiEmail = document.getElementById("whoamiEmail");
const signOutBtn = document.getElementById("signOutBtn");

function showLoginNote(msg, isError) {
  loginNote.textContent = msg;
  loginNote.classList.toggle("error", !!isError);
}

/* ---------------- sign-in diagnostics ----------------
   The failure mode we kept chasing is *silent*: getRedirectResult() resolves
   null rather than rejecting, so nothing throws and the login screen simply
   reappears. This records that a redirect was started, and if we come back
   with no user, says so on screen instead of pretending nothing happened. */
const PENDING_REDIRECT_KEY = "orderup_redirect_started";

function markRedirectStarted() {
  try { localStorage.setItem(PENDING_REDIRECT_KEY, String(Date.now())); } catch { /* storage blocked */ }
}
function consumeRedirectStarted() {
  try {
    const started = localStorage.getItem(PENDING_REDIRECT_KEY);
    localStorage.removeItem(PENDING_REDIRECT_KEY);
    return started ? Number(started) : null;
  } catch {
    return null;
  }
}

function storageProbe() {
  try {
    localStorage.setItem("__orderup_probe", "1");
    localStorage.removeItem("__orderup_probe");
    return "ok";
  } catch (err) {
    return "BLOCKED (" + (err && err.name ? err.name : "unknown") + ")";
  }
}

function showDiag(reason) {
  const lines = [
    "reason:      " + reason,
    "authDomain:  " + (auth.config && auth.config.authDomain),
    "page origin: " + location.origin,
    "same-origin: " + (auth.config && auth.config.authDomain === location.host ? "yes" : "NO <-- suspect"),
    "flow:        popup-first" + (IS_MOBILE ? " (mobile UA)" : " (desktop UA)"),
    "standalone:  " + (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true),
    "localStorage:" + storageProbe(),
    "persistence: " + (persistenceState.error ? persistenceState.error.code || String(persistenceState.error) : "ok"),
    "ua:          " + navigator.userAgent
  ];
  loginDiagBody.textContent = lines.join("\n");
  loginDiag.hidden = false;
}

/* Anything that escapes to the top level gets shown on the login screen.
   Without this, a module-evaluation error is invisible unless devtools were
   already open *before* the page loaded — which is how a dead auth observer
   went unnoticed while the console looked perfectly clean. */
window.addEventListener("error", (e) => {
  showLoginNote("Something failed to load — details below.", true);
  showDiag("uncaught: " + ((e.error && e.error.message) || e.message));
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  showLoginNote("Something failed to load — details below.", true);
  showDiag("unhandled rejection: " + ((r && (r.code || r.message)) || String(r)));
});

async function handleSignedInUser(user) {
  const email = (user.email || "").toLowerCase();
  if (!email.endsWith("@" + ALLOWED_DOMAIN)) {
    await signOut(auth);
    showLoginNote(`Only @${ALLOWED_DOMAIN} accounts can use OrderUp. Try a different Google account.`, true);
  }
  // otherwise onAuthStateChanged below flips the UI over automatically
}

googleSignInBtn.addEventListener("click", async () => {
  showLoginNote("Opening Google sign-in…", false);
  try {
    // Popup first, on every device — including mobile.
    //
    // signInWithRedirect hands the credential over through sessionStorage,
    // and iOS clears/partitions that across the round trip to Google. Firebase
    // reports it as "missing initial state ... signInWithRedirect in a
    // storage-partitioned browser environment", and the user lands back on the
    // login screen. A popup returns the credential over postMessage and never
    // depends on that handoff, which is why desktop Safari — the same WebKit
    // engine as the iPhone — has worked all along.
    // Persistence is no longer awaited at module load (see firebase-config.js).
    // Wait for it here instead, so the session still survives a page reload —
    // this handler is already async, so it costs nothing.
    await persistenceReady;
    console.log("[orderup] calling signInWithPopup, authDomain =", auth.config && auth.config.authDomain);
    const result = await signInWithPopup(auth, googleProvider);
    console.log("[orderup] popup RESOLVED for", result && result.user && result.user.email);
    await handleSignedInUser(result.user);
  } catch (err) {
    console.error("[orderup] popup REJECTED:", err && err.code, err);

    // User just closed it / double-tapped — not an error worth shouting about.
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") {
      showLoginNote("", false);
      return;
    }

    // Genuinely couldn't open a window (popup blocker, or an installed PWA
    // that forbids new windows). Redirect is worse, but it's better than
    // no path at all — so keep it strictly as a fallback.
    if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") {
      showLoginNote("Opening Google sign-in…", false);
      try {
        markRedirectStarted();
        await signInWithRedirect(auth, googleProvider);
      } catch (redirectErr) {
        console.error(redirectErr);
        showLoginNote("Couldn't start sign-in on this browser.", true);
        showDiag((redirectErr && redirectErr.code) || String(redirectErr));
      }
      return;
    }

    showLoginNote("Couldn't sign in — please try again.", true);
    showDiag((err && err.code) || String(err));
  }
});

signOutBtn.addEventListener("click", () => signOut(auth));

// completes the sign-in when the browser returns from the Google redirect
getRedirectResult(auth).then((result) => {
  const startedAt = consumeRedirectStarted();
  if (result && result.user) {
    handleSignedInUser(result.user);
    return;
  }
  // We started a redirect and came back with nothing, and no session was
  // restored either. This is the silent bounce — say so rather than quietly
  // re-showing the login screen as if the user never tried.
  if (startedAt && !auth.currentUser) {
    showLoginNote("Sign-in didn't complete. Tap below and send this to whoever runs OrderUp.", true);
    showDiag("returned from Google with no credential (getRedirectResult was empty)");
  }
}).catch((err) => {
  consumeRedirectStarted();
  console.error(err);
  showLoginNote("Couldn't finish signing in — please try again.", true);
  showDiag((err && err.code) || String(err));
});

/* The auth observer is registered at the BOTTOM of this file, not here.
   It reads currentFilter and calls applyFilterUI()/refreshQuickPostBar()/
   startOrdersListener(), which touch `const`s declared much further down.
   Registering it up here meant the observer could run while those bindings
   were still in the temporal dead zone — and Firebase swallows exceptions
   thrown inside the observer, so the failure was completely silent: sign-in
   succeeded, nothing listened, the login screen just stayed put. */

function getMyName() { return myName || ""; }

/* ---------------- remembered defaults ---------------- */
function fieldKey(field) {
  return `orderup_${field}_${(myEmail || "").toLowerCase()}`;
}
function getSavedField(field) {
  if (!myEmail) return "";
  try {
    return localStorage.getItem(fieldKey(field)) || "";
  } catch {
    return "";
  }
}
function saveField(field, value) {
  if (!myEmail) return;
  try {
    localStorage.setItem(fieldKey(field), value);
  } catch { /* ignore (e.g. storage disabled) */ }
}
const getSavedContact = () => getSavedField("contact");
const saveContact = (v) => saveField("contact", v);
const getSavedLocation = () => getSavedField("location");
const saveLocation = (v) => saveField("location", v);
const getSavedApp = () => getSavedField("app");
const saveApp = (v) => saveField("app", v);
const getSavedExpiry = () => getSavedField("expiry");
const saveExpiry = (v) => saveField("expiry", v);
const getSavedOutlet = () => getSavedField("outlet");
const saveOutlet = (v) => saveField("outlet", v);

function hasQuickPostDefaults() {
  // A contact saved before numbers were required could be an Instagram handle
  // or a room number. Treat those as "no default" so the user is sent through
  // the full form once to supply a real number, rather than quick-posting
  // something nobody can call.
  return !!(normalizePhone(getSavedContact()) && getSavedLocation());
}

/* ---------------- matching ----------------
   A match is someone whose remaining need is already covered by my cart: they
   need ₹150 more, my cart is at ₹250, so clubbing pushes them over the line.
   When that holds in *both* directions it's a mutual match — we each cross our
   own threshold — which is the outcome actually worth surfacing first.

   Clubbing only makes sense within one app, and on the marketplaces (Zomato,
   Swiggy) only within one outlet: two Zomato carts from different restaurants
   are two separate orders with two separate delivery fees. */
function canClub(mine, theirs) {
  if (!mine || !theirs) return false;
  if (mine.id && theirs.id && mine.id === theirs.id) return false;
  if (mine.posterId && mine.posterId === theirs.posterId) return false;
  if (mine.app !== theirs.app) return false;
  if (appNeedsOutlet(mine.app) && outletKey(mine.outlet) !== outletKey(theirs.outlet)) return false;
  return (Number(theirs.target) || 0) <= (Number(mine.current) || 0);
}

function isMutualMatch(a, b) {
  return canClub(a, b) && canClub(b, a);
}

function matchesFor(order, pool) {
  return pool
    .filter(o => canClub(order, o))
    .sort((x, y) => {
      // mutual matches first — those are the ones where both people win
      const mx = isMutualMatch(order, x) ? 0 : 1;
      const my = isMutualMatch(order, y) ? 0 : 1;
      if (mx !== my) return mx - my;
      // then whoever's need our cart covers most comfortably
      return (Number(y.target) || 0) - (Number(x.target) || 0);
    });
}

/* ---------------- DOM refs: app ---------------- */
const board = document.getElementById("board");
const emptyState = document.getElementById("emptyState");
const boardHeading = document.getElementById("boardHeading");
const toastEl = document.getElementById("toast");

const postModalBackdrop = document.getElementById("postModalBackdrop");
const openPostModalBtn = document.getElementById("openPostModal");
const closePostModalBtn = document.getElementById("closePostModal");
const postForm = document.getElementById("postForm");

const fApp = document.getElementById("fApp");
const fOutlet = document.getElementById("fOutlet");
const fOutletOther = document.getElementById("fOutletOther");
const outletField = document.getElementById("outletField");
const appField = document.getElementById("appField");
const postingTo = document.getElementById("postingTo");
const postingToDot = document.getElementById("postingToDot");
const postingToName = document.getElementById("postingToName");
const postingToChange = document.getElementById("postingToChange");

const matchModalBackdrop = document.getElementById("matchModalBackdrop");
const closeMatchModalBtn = document.getElementById("closeMatchModal");
const dismissMatchesBtn = document.getElementById("dismissMatches");
const matchIntro = document.getElementById("matchIntro");
const matchList = document.getElementById("matchList");

const filterTabs = document.getElementById("filterTabs");
let currentFilter = DEFAULT_APP;   // "Blinkit" | "Zomato" | "Swiggy" | "mine"
let latestOrders = [];

/* ---------------- search ---------------- */
const searchBar = document.getElementById("searchBar");
const sQuery = document.getElementById("sQuery");
const sMyValue = document.getElementById("sMyValue");
const sMaxTime = document.getElementById("sMaxTime");
const sSort = document.getElementById("sSort");
const clearSearchBtn = document.getElementById("clearSearch");
const searchHint = document.getElementById("searchHint");

[sQuery, sMyValue, sMaxTime, sSort].forEach(el => {
  el.addEventListener("input", render);
  el.addEventListener("change", render);
});
clearSearchBtn.addEventListener("click", () => {
  sQuery.value = "";
  render();
  sQuery.focus();
});

/* ---------------- theme ----------------
   Follows the OS by default. Once the toggle is used, that choice is stored
   and wins until it's changed again. The initial application happens in an
   inline script in index.html, before first paint — this only handles the
   toggle and keeps the browser chrome colour in sync. */
const THEME_KEY = "orderup_theme";
const themeToggle = document.getElementById("themeToggle");
const themeToggleIcon = document.getElementById("themeToggleIcon");
const themeColorMeta = document.getElementById("themeColor");
const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function storedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}
function resolvedTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return darkQuery && darkQuery.matches ? "dark" : "light";
}
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;

  const dark = resolvedTheme() === "dark";
  if (themeColorMeta) themeColorMeta.setAttribute("content", dark ? "#0F1A17" : "#EAF2EC");
  if (themeToggleIcon) themeToggleIcon.textContent = dark ? "☀" : "☾";
  if (themeToggle) {
    themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  }
}

themeToggle.addEventListener("click", () => {
  const next = resolvedTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked */ }
  applyTheme(next);
});

// Track the OS only while the user hasn't expressed a preference of their own.
if (darkQuery && darkQuery.addEventListener) {
  darkQuery.addEventListener("change", () => { if (!storedTheme()) applyTheme(null); });
}

applyTheme(storedTheme());

/* ---------------- toast ---------------- */
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

/* ---------------- modal helpers ---------------- */
function openModal(el) { el.classList.add("open"); }
function closeModal(el) { el.classList.remove("open"); }

/* ---------------- filter tabs ---------------- */
function applyFilterUI() {
  [...filterTabs.children].forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === currentFilter);
  });

  const isMine = currentFilter === "mine";
  boardHeading.textContent = isMine ? "Your orders" : `${currentFilter} orders`;

  // Searching outlets only means anything on the marketplaces.
  if (isMine) {
    sQuery.placeholder = "Search your orders…";
  } else if (appNeedsOutlet(currentFilter)) {
    sQuery.placeholder = `Search ${currentFilter} outlets…`;
  } else {
    sQuery.placeholder = `Search ${currentFilter} items…`;
  }

  refreshQuickPostBar();
}

filterTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-tab");
  if (!btn) return;
  currentFilter = btn.dataset.filter;
  if (isKnownApp(currentFilter)) saveApp(currentFilter);
  applyFilterUI();
  render();
});

/* ---------------- outlet picker ---------------- */
function populateOutletSelect(sel, selectedOutlet) {
  const known = POPULAR_OUTLETS.slice();
  // If they previously typed a custom outlet, keep it selectable rather than
  // making them retype it every time.
  if (selectedOutlet && !known.some(o => outletKey(o) === outletKey(selectedOutlet))) {
    known.push(selectedOutlet);
  }
  sel.innerHTML = known.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")
    + `<option value="${OUTLET_OTHER}">Other — type it in</option>`;
  if (selectedOutlet) sel.value = selectedOutlet;
}

function syncOutletField(app, preferredOutlet) {
  const needs = appNeedsOutlet(app);
  outletField.hidden = !needs;
  if (!needs) {
    fOutletOther.hidden = true;
    return;
  }
  populateOutletSelect(fOutlet, preferredOutlet || getSavedOutlet());
  fOutletOther.hidden = fOutlet.value !== OUTLET_OTHER;
}

fOutlet.addEventListener("change", () => {
  const other = fOutlet.value === OUTLET_OTHER;
  fOutletOther.hidden = !other;
  if (other) fOutletOther.focus();
});

fApp.addEventListener("change", () => syncOutletField(fApp.value));

// Reads whichever of the two controls is actually in play.
function readOutlet() {
  if (!appNeedsOutlet(fApp.value)) return "";
  if (fOutlet.value === OUTLET_OTHER) return fOutletOther.value.trim();
  return fOutlet.value;
}

/* ---------------- post modal ---------------- */
function openPostModal() {
  const fContact = document.getElementById("fContact");
  const fLocation = document.getElementById("fLocation");
  const fExpiry = document.getElementById("fExpiry");
  const contactHint = document.getElementById("contactHint");
  const locationHint = document.getElementById("locationHint");

  if (!fContact.value) {
    const saved = normalizePhone(getSavedContact()); // skip pre-numbers junk
    if (saved) { fContact.value = saved; contactHint.hidden = false; }
  }
  if (!fLocation.value) {
    const saved = getSavedLocation();
    if (saved) { fLocation.value = saved; locationHint.hidden = false; }
  }
  const savedExpiry = getSavedExpiry();
  if (savedExpiry) fExpiry.value = savedExpiry;

  // Inside an app tab the app is already decided — show it as a chip instead
  // of asking a question the user has effectively just answered.
  if (isKnownApp(currentFilter)) {
    fApp.value = currentFilter;
    showPostingToChip(currentFilter);
  } else {
    const savedApp = getSavedApp();
    if (isKnownApp(savedApp)) fApp.value = savedApp;
    hidePostingToChip();
  }

  syncOutletField(fApp.value);
  openModal(postModalBackdrop);
}

function showPostingToChip(app) {
  postingTo.hidden = false;
  appField.hidden = true;
  postingToDot.dataset.app = app;
  postingToDot.innerHTML = appIconHTML(app);
  postingToName.textContent = app;
}
function hidePostingToChip() {
  postingTo.hidden = true;
  appField.hidden = false;
}

openPostModalBtn.addEventListener("click", openPostModal);
postingToChange.addEventListener("click", () => {
  hidePostingToChip();
  fApp.focus();
});

// hide the "remembered" hints as soon as they start editing them
document.getElementById("fContact").addEventListener("input", () => {
  document.getElementById("contactHint").hidden = true;
});
document.getElementById("fLocation").addEventListener("input", () => {
  document.getElementById("locationHint").hidden = true;
});
closePostModalBtn.addEventListener("click", () => closeModal(postModalBackdrop));
postModalBackdrop.addEventListener("click", (e) => {
  if (e.target === postModalBackdrop) closeModal(postModalBackdrop);
});

closeMatchModalBtn.addEventListener("click", () => closeModal(matchModalBackdrop));
dismissMatchesBtn.addEventListener("click", () => closeModal(matchModalBackdrop));
matchModalBackdrop.addEventListener("click", (e) => {
  if (e.target === matchModalBackdrop) closeModal(matchModalBackdrop);
});

/* ---------------- quick post ---------------- */
const quickPost = document.getElementById("quickPost");
const qpOutlet = document.getElementById("qpOutlet");
const qpCurrent = document.getElementById("qpCurrent");
const qpTarget = document.getElementById("qpTarget");
const qpExpiry = document.getElementById("qpExpiry");
const qpSubmit = document.getElementById("qpSubmit");
const quickPostNote = document.getElementById("quickPostNote");

function refreshQuickPostBar() {
  // Quick post is a shortcut for "same as last time, new amount". It only
  // makes sense inside an app tab — under "Mine" there's no app to post to.
  if (!hasQuickPostDefaults() || !isKnownApp(currentFilter)) {
    quickPost.hidden = true;
    return;
  }
  quickPost.hidden = false;

  const needsOutlet = appNeedsOutlet(currentFilter);
  qpOutlet.hidden = !needsOutlet;
  if (needsOutlet) populateOutletSelect(qpOutlet, getSavedOutlet());

  const savedExpiry = getSavedExpiry();
  if (savedExpiry) qpExpiry.value = savedExpiry;

  quickPostNote.textContent =
    `Posts to ${currentFilter} · ${getSavedLocation()} · reachable at ${normalizePhone(getSavedContact())}. ` +
    `Tap "Post an order" to change these.`;
}

qpSubmit.addEventListener("click", async () => {
  const target = Number(qpTarget.value);
  if (!target || target <= 0) {
    toast("Enter how much ₹ is still needed");
    qpTarget.focus();
    return;
  }
  const current = Number(qpCurrent.value);
  if (!current || current <= 0) {
    toast("Enter your cart value so we can find matches");
    qpCurrent.focus();
    return;
  }
  const savedContact = normalizePhone(getSavedContact());
  if (!savedContact) {
    toast("Add your mobile number first — tap \"Post an order\"");
    return;
  }

  const appVal = currentFilter;
  let outlet = "";
  if (appNeedsOutlet(appVal)) {
    outlet = qpOutlet.value === OUTLET_OTHER ? "" : qpOutlet.value;
    if (!outlet) {
      toast("Pick an outlet — tap \"Post an order\" to type a new one");
      return;
    }
  }

  const minutes = Number(qpExpiry.value);
  const payload = {
    app: appVal,
    outlet,
    current,
    target,
    items: "",
    location: getSavedLocation(),
    contact: savedContact,
    posterId: myId,
    posterName: getMyName(),
    posterEmail: myEmail,
    createdAt: serverTimestamp(),
    expiresAt: Date.now() + minutes * 60 * 1000
  };

  qpSubmit.disabled = true;
  try {
    await addDoc(collection(db, ORDERS_COL), payload);
    saveExpiry(qpExpiry.value);
    if (outlet) saveOutlet(outlet);
    qpTarget.value = "";
    qpCurrent.value = "";
    toast("Posted to the board 🎉");
    showMatchesFor(payload);
  } catch (err) {
    console.error(err);
    toast("Couldn't post — check your Firebase setup");
  } finally {
    qpSubmit.disabled = false;
  }
});

[qpTarget, qpCurrent].forEach(el => {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); qpSubmit.click(); }
  });
});

/* ---------------- post order ---------------- */
postForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const appVal = fApp.value;
  if (!isKnownApp(appVal)) { toast("Pick an app"); return; }

  const outlet = readOutlet();
  if (appNeedsOutlet(appVal) && !outlet) {
    toast("Which outlet? Pick one or type it in");
    (fOutletOther.hidden ? fOutlet : fOutletOther).focus();
    return;
  }

  const currentInput = document.getElementById("fCurrent");
  const current = Number(currentInput.value);
  if (!current || current <= 0) {
    toast("Enter your cart value — it's what finds your matches");
    currentInput.focus();
    return;
  }

  const target = Number(document.getElementById("fTarget").value);
  const minutes = Number(document.getElementById("fExpiry").value);

  const contactInput = document.getElementById("fContact");
  const contact = normalizePhone(contactInput.value);
  if (!contact) {
    toast("Enter a valid 10-digit mobile number");
    contactInput.focus();
    return;
  }

  const location = document.getElementById("fLocation").value.trim();
  const expiryVal = document.getElementById("fExpiry").value;

  const payload = {
    app: appVal,
    outlet,
    current,
    target,
    items: document.getElementById("fItems").value.trim(),
    location,
    contact,
    posterId: myId,
    posterName: getMyName(),
    posterEmail: myEmail,
    createdAt: serverTimestamp(),
    expiresAt: Date.now() + minutes * 60 * 1000
  };

  try {
    await addDoc(collection(db, ORDERS_COL), payload);
    saveContact(contact);
    saveLocation(location);
    saveApp(appVal);
    saveExpiry(expiryVal);
    if (outlet) saveOutlet(outlet);
    postForm.reset();
    document.getElementById("contactHint").hidden = true;
    document.getElementById("locationHint").hidden = true;
    closeModal(postModalBackdrop);
    toast("Posted to the board 🎉");
    refreshQuickPostBar();
    showMatchesFor(payload);
  } catch (err) {
    console.error(err);
    toast("Couldn't post — check your Firebase setup");
  }
});

/* ---------------- matches modal ----------------
   Opens by itself right after a successful post: the whole point of posting is
   to find someone, so the answer shouldn't be one more tap away. */
function showMatchesFor(order) {
  const now = Date.now();
  const pool = latestOrders.filter(o => (o.expiresAt || 0) > now);
  const matches = matchesFor(order, pool);

  const where = order.outlet ? `${order.app} · ${order.outlet}` : order.app;

  if (!matches.length) {
    matchIntro.textContent =
      `Posted to ${where}. Nobody matches your ₹${order.current} cart yet — you'll show up on their board, ` +
      `so sit tight or check back in a few minutes.`;
    matchList.innerHTML = `<p class="match-empty">No matches right now.</p>`;
  } else {
    const mutual = matches.filter(m => isMutualMatch(order, m)).length;
    matchIntro.textContent =
      `Posted to ${where}. ${matches.length} ${matches.length === 1 ? "person" : "people"} ` +
      `can club with your ₹${order.current} cart` +
      (mutual ? ` — ${mutual} where you both cross the line.` : ".");
    matchList.innerHTML = matches.map(m => matchRowHTML(m, order)).join("");
    wireMatchRows(matchList, matches);
  }

  openModal(matchModalBackdrop);
}

function matchRowHTML(m, against) {
  const { label } = timeLeftLabel(m.expiresAt);
  const mutual = against ? isMutualMatch(against, m) : false;
  return `
    <div class="match-row" data-match-id="${escapeHtml(m.id)}">
      <div class="match-row-main">
        <div class="match-row-name">
          ${escapeHtml(m.posterName || "someone")}
          ${mutual ? '<span class="mutual-badge">you both benefit</span>' : ""}
        </div>
        <div class="match-row-sub">
          needs ₹${Number(m.target) || 0} · cart ₹${Number(m.current) || 0} · ${label} · ${escapeHtml(m.location || "")}
        </div>
      </div>
      <button type="button" class="btn btn-primary match-cta" data-reveal="${escapeHtml(m.id)}">I'm in</button>
    </div>`;
}

// Contact stays hidden until someone actively opts in — same rule as the board
// cards. Tapping here records the join and then reveals the number.
function wireMatchRows(container, orders) {
  container.querySelectorAll("[data-reveal]").forEach(btn => {
    const id = btn.dataset.reveal;
    const order = orders.find(o => o.id === id);
    if (!order) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      await recordJoin(order);
      const row = btn.closest(".match-row");
      btn.remove();
      const slot = document.createElement("div");
      slot.style.width = "100%";
      revealContactInto(slot, order);
      row.appendChild(slot);
      row.style.flexWrap = "wrap";
    });
  });
}

/* ---------------- realtime listener ---------------- */
let unsubscribeOrders = null;

let listenerRetry = 0;

function startOrdersListener() {
  if (unsubscribeOrders) return; // already listening
  const q = query(collection(db, ORDERS_COL), orderBy("createdAt", "desc"));

  unsubscribeOrders = onSnapshot(q, (snap) => {
    listenerRetry = 0; // a delivered snapshot means the stream is healthy
    latestOrders = [];
    snap.forEach(d => latestOrders.push({ id: d.id, ...d.data() }));
    // A throw in here would propagate out of the snapshot callback and can
    // take the subscription with it — one malformed doc would then freeze
    // the board until a manual refresh. Contain it.
    try {
      render();
    } catch (err) {
      console.error("[orderup] render failed:", err);
    }
  }, (err) => {
    console.error("[orderup] orders listener error:", err);

    // Drop the dead subscription so the next attempt opens a fresh stream.
    detachOrdersListener();

    // Streams drop routinely — phone sleeps, wifi switches, tab is frozen.
    // Reconnect with backoff instead of leaving a permanently stale board.
    listenerRetry = Math.min(listenerRetry + 1, 6);
    const wait = Math.min(1000 * 2 ** (listenerRetry - 1), 30000);
    console.log(`[orderup] reconnecting orders listener in ${wait}ms`);
    setTimeout(() => { if (myId) startOrdersListener(); }, wait);
  });
}

function detachOrdersListener() {
  if (unsubscribeOrders) {
    try { unsubscribeOrders(); } catch { /* already torn down */ }
    unsubscribeOrders = null;
  }
}

function stopOrdersListener() {
  detachOrdersListener();
  listenerRetry = 0;
  latestOrders = [];
}

/* ---------------- keeping the board live ----------------
   Safari (and iOS especially) freezes background tabs and installed PWAs, and
   silently kills the Firestore stream while doing so. Nothing tells the page
   this happened: it resumes looking connected while receiving nothing, which
   is the "I have to refresh to see new orders" complaint. So on the way back
   we rebuild the subscription outright rather than trusting the old one. */
let hiddenSince = 0;
const STALE_AFTER_MS = 20000;

function resumeLiveUpdates(reason) {
  if (!myId) return;
  console.log("[orderup] resuming live updates:", reason);
  detachOrdersListener();
  startOrdersListener();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenSince = Date.now();
    return;
  }
  const away = hiddenSince ? Date.now() - hiddenSince : 0;
  hiddenSince = 0;
  try { render(); } catch { /* countdowns only */ }
  if (away > STALE_AFTER_MS) resumeLiveUpdates(`tab hidden for ${Math.round(away / 1000)}s`);
});

// Safari restores from its back/forward cache with dead network connections.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) resumeLiveUpdates("restored from bfcache");
});

window.addEventListener("online", () => resumeLiveUpdates("network came back"));

/* ---------------- render ---------------- */
function timeLeftLabel(expiresAt) {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return { label: "closed", urgent: true };
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return { label: `${mins}m left`, urgent: mins <= 10 };
  const hrs = Math.floor(mins / 60);
  return { label: `${hrs}h ${mins % 60}m left`, urgent: false };
}

function amountBlock(needed) {
  return `
    <div class="amount-block">
      <span class="amount-value">₹${needed}</span>
      <span class="amount-caption">needed</span>
    </div>`;
}

function cardInnerHTML(o, myValue, pool) {
  const current = Number(o.current) || 0;
  const needed = Number(o.target) || 0;
  const { label, urgent } = timeLeftLabel(o.expiresAt);
  const isMine = o.posterId === myId;
  const isGoodMatch = myValue !== null && needed <= myValue;

  // Matches are only ever shown on your OWN posts. Everyone else's matches
  // are their business — and surfacing them on every card turned the board
  // into a wall of nested lists.
  const matches = isMine ? matchesFor(o, pool) : [];

  return `
      ${amountBlock(needed)}
      <div class="card-body">
        <div class="card-top">
          <span class="card-app">
            <span class="app-dot" data-app="${escapeHtml(o.app)}">${appIconHTML(o.app)}</span>
            <span>${escapeHtml(o.app)}</span>
            ${o.outlet ? `<span class="card-outlet">${escapeHtml(o.outlet)}</span>` : ""}
            ${isGoodMatch ? '<span class="match-badge">fits your cart</span>' : ""}
          </span>
          <span class="card-timer ${urgent ? "urgent" : ""}">${label}</span>
        </div>
        <div class="card-amounts">
          ${current > 0 ? `cart's at <b>₹${current}</b> · ` : ""}needs <b>₹${needed}</b> more
        </div>
        ${o.items ? `<p class="card-items">${escapeHtml(o.items)}</p>` : ""}
        <div class="card-meta">
          <span class="card-loc">📍 ${escapeHtml(o.location)}</span>
          <span class="card-poster">by <b>${escapeHtml(o.posterName || "someone")}</b></span>
        </div>
        <div class="card-actions" style="margin-top:10px;">
          ${isMine
      ? `<button class="btn-ghost btn-danger" data-remove="${o.id}">Remove</button>`
      : `<button class="btn-ghost" data-join="${o.id}">I'm in — show contact</button>`
    }
        </div>
        <div class="contact-slot"></div>
        ${matches.length ? `
        <details class="card-matches">
          <summary>${matches.length} ${matches.length === 1 ? "match" : "matches"} for your order</summary>
          <div class="match-list">${matches.map(m => matchRowHTML(m, o)).join("")}</div>
        </details>` : ""}
      </div>
  `;
}

async function recordJoin(o) {
  // record the join so the poster's device (or their Cloud Function) knows to notify them
  try {
    await setDoc(doc(db, ORDERS_COL, o.id, "joins", myId), {
      joinerId: myId,
      joinerName: getMyName(),
      joinerEmail: myEmail,
      joinedAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error("Couldn't record join (notification to poster may not fire):", err);
  }
}

function revealContactInto(slot, o) {
  const waDigits = extractWhatsAppDigits(o.contact);
  let html = `<div class="contact-reveal">Reach out: ${escapeHtml(o.contact)}</div>`;
  if (waDigits) {
    html += `<a class="btn btn-primary btn-block wa-link" href="${buildWhatsAppLink(waDigits, o)}" target="_blank" rel="noopener">Message on WhatsApp</a>`;
  }
  slot.innerHTML = html;
}

function wireCardEvents(el, o, pool) {
  const joinBtn = el.querySelector("[data-join]");
  if (joinBtn) {
    joinBtn.addEventListener("click", async () => {
      joinBtn.disabled = true;
      joinBtn.textContent = "…";
      await recordJoin(o);
      revealContactInto(el.querySelector(".contact-slot"), o);
      joinBtn.textContent = "Contact revealed ✓";
    });
  }
  const removeBtn = el.querySelector("[data-remove]");
  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      deleteDoc(doc(db, ORDERS_COL, o.id)).catch(() => toast("Couldn't remove — try again"));
    });
  }
  // only present on your own cards — see cardInnerHTML
  const nested = el.querySelector(".card-matches .match-list");
  if (nested) wireMatchRows(nested, matchesFor(o, pool));
}

function render() {
  const now = Date.now();
  const active = latestOrders.filter(o => (o.expiresAt || 0) > now);

  // lazy-clean expired ones (best effort, ignore failures)
  latestOrders.filter(o => (o.expiresAt || 0) <= now).forEach(o => {
    deleteDoc(doc(db, ORDERS_COL, o.id)).catch(() => { });
  });

  // Matching always runs against every live order, not just the visible ones —
  // filtering the board shouldn't change who can actually club together.
  const pool = active;

  let visible = currentFilter === "mine"
    ? active.filter(o => o.posterId === myId)
    : active.filter(o => o.app === currentFilter);

  // ---- search + filters ----
  const myValueRaw = sMyValue.value;
  const myValue = myValueRaw === "" ? null : Number(myValueRaw);
  const maxTimeMin = Number(sMaxTime.value);
  const q = sQuery.value.trim().toLowerCase();

  searchBar.classList.toggle("has-query", q.length > 0);

  if (q) {
    visible = visible.filter(o =>
      String(o.outlet || "").toLowerCase().includes(q) ||
      String(o.items || "").toLowerCase().includes(q) ||
      String(o.location || "").toLowerCase().includes(q) ||
      String(o.app || "").toLowerCase().includes(q)
    );
  }
  if (maxTimeMin > 0) {
    visible = visible.filter(o => (o.expiresAt - now) <= maxTimeMin * 60000);
  }

  // ---- sort ----
  const sortMode = sSort.value;
  if (myValue !== null && sortMode === "match") {
    // closest fit to what my cart can actually cover
    visible = [...visible].sort((a, b) => Math.abs(a.target - myValue) - Math.abs(b.target - myValue));
  } else if (sortMode === "soonest") {
    visible = [...visible].sort((a, b) => a.expiresAt - b.expiresAt);
  } else if (sortMode === "lowest") {
    visible = [...visible].sort((a, b) => a.target - b.target);
  }

  emptyState.hidden = visible.length !== 0;

  if (myValue !== null) {
    const fits = visible.filter(o => (Number(o.target) || 0) <= myValue).length;
    searchHint.textContent = fits
      ? `${fits} of these fit a ₹${myValue} cart.`
      : `Nothing here fits a ₹${myValue} cart yet.`;
  } else {
    searchHint.textContent = "";
  }

  // ---- keyed reconciliation: update/move existing cards in place,
  // only create+animate cards that are genuinely new. This is what
  // stops the whole board flashing on every snapshot / 30s tick. ----
  const stillPresent = new Set();
  let prevEl = null;

  visible.forEach(o => {
    const html = cardInnerHTML(o, myValue, pool);
    const isGoodMatch = myValue !== null && (Number(o.target) || 0) <= myValue;
    const wantedClass = "card" + (isGoodMatch ? " matched" : "");

    let el = board.querySelector(`[data-order-id="${o.id}"]`);

    if (el) {
      if (el.dataset.snapshot !== html) {
        // Preserve an open matches drawer across re-renders — collapsing it
        // under the user every 30s would make it unusable.
        const wasOpen = !!el.querySelector(".card-matches[open]");
        el.innerHTML = html;
        el.dataset.snapshot = html;
        if (wasOpen) {
          const d = el.querySelector(".card-matches");
          if (d) d.open = true;
        }
        wireCardEvents(el, o, pool);
      }
      if (el.className !== wantedClass) el.className = wantedClass;
      if (el.dataset.app !== o.app) el.dataset.app = o.app;
    } else {
      el = document.createElement("div");
      el.dataset.orderId = o.id;
      el.dataset.app = o.app;
      el.className = wantedClass + " card-enter";
      el.innerHTML = html;
      el.dataset.snapshot = html;
      wireCardEvents(el, o, pool);
    }

    // keep DOM order matching sorted/filtered order
    const wantedNextSibling = prevEl ? prevEl.nextSibling : board.firstChild;
    if (wantedNextSibling !== el) {
      board.insertBefore(el, wantedNextSibling);
    }
    prevEl = el;
    stillPresent.add(o.id);
  });

  // remove cards that are no longer visible (expired, deleted, filtered out)
  [...board.children].forEach(el => {
    if (!stillPresent.has(el.dataset.orderId)) el.remove();
  });
}

/* Single source of truth for "is this a usable number?".
   Accepts what people actually type — "+91 98765 43210", "098765 43210",
   "98765-43210" — and reduces it to the bare 10 digits we store. Returns null
   for anything that isn't a valid Indian mobile, which is what the form,
   the quick-post bar, and the WhatsApp link all gate on. */
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  let ten = digits;
  if (digits.length === 12 && digits.startsWith("91")) ten = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith("091")) ten = digits.slice(3);
  else if (digits.length === 11 && digits.startsWith("0")) ten = digits.slice(1);
  // Indian mobile numbers are 10 digits starting 6-9. Landlines and short
  // codes won't work on WhatsApp, so they're rejected too.
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

function extractWhatsAppDigits(contact) {
  const ten = normalizePhone(contact);
  return ten ? "91" + ten : null;
}

function buildWhatsAppLink(digits, o) {
  const where = o.outlet ? `${o.app} (${o.outlet})` : o.app;
  const msg = `Hey! Saw your OrderUp post for ${where} — ₹${o.target} more needed. I'm in, let's club the order!`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

/* tick every 30s so countdown labels + expiry cleanup stay fresh */
setInterval(render, 30000);

/* ---------------- init ---------------- */
paintAppIcons();   // upgrade the filter bubbles' letter fallbacks to real logos

/* ---------------- auth observer ----------------
   Registered LAST, deliberately. Everything below the sign-in handler —
   currentFilter, the DOM refs, applyFilterUI, refreshQuickPostBar,
   startOrdersListener — has to be initialized before this can fire, or the
   callback hits the temporal dead zone. Firebase swallows whatever the
   observer throws, so getting this order wrong fails silently. */
console.log("[orderup] module loaded, registering auth observer");
onAuthStateChanged(auth, (user) => {
  console.log("[orderup] auth state changed:", user ? user.email : "null");
  try {
    if (user && user.email && user.email.toLowerCase().endsWith("@" + ALLOWED_DOMAIN)) {
      myId = user.uid;
      myEmail = user.email;
      myName = user.displayName || user.email.split("@")[0];
      whoamiEmail.textContent = myName;
      consumeRedirectStarted();
      loginDiag.hidden = true;
      showLoginNote("", false);
      loginGate.hidden = true;
      appRoot.hidden = false;
      currentFilter = isKnownApp(getSavedApp()) ? getSavedApp() : DEFAULT_APP;
      applyFilterUI();
      refreshQuickPostBar();
      startOrdersListener(); // only read once we have a valid, verified auth token
    } else {
      if (user) {
        // signed in but wrong domain — kick them out
        signOut(auth);
        showLoginNote(`Only @${ALLOWED_DOMAIN} accounts can use OrderUp.`, true);
      }
      myId = null;
      myEmail = null;
      myName = null;
      loginGate.hidden = false;
      appRoot.hidden = true;
      stopOrdersListener();
    }
  } catch (err) {
    // Firebase would otherwise eat this and leave the user staring at the
    // login screen with an empty console — which is exactly what happened.
    console.error("Auth state handler failed:", err);
    showLoginNote("Signed in, but the board failed to load.", true);
    showDiag("auth handler threw: " + (err && err.message ? err.message : String(err)));
  }
});

/* ---------------- PWA service worker ---------------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { });
  });
}
