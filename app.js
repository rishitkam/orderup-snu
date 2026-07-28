import { db, auth, googleProvider, ALLOWED_DOMAIN, persistenceError } from "./firebase-config.js";
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

/* ---------------- identity: comes from a verified @{ALLOWED_DOMAIN} Google login ---------------- */
let myId = null;
let myEmail = null;
let myName = null;

/* ---------------- DOM refs: login gate ---------------- */
const loginGate = document.getElementById("loginGate");
const appRoot = document.getElementById("appRoot");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const loginSub = document.getElementById("loginSub");
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
    "persistence: " + (persistenceError ? persistenceError.code || String(persistenceError) : "ok"),
    "ua:          " + navigator.userAgent
  ];
  loginDiagBody.textContent = lines.join("\n");
  loginDiag.hidden = false;
}

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
    const result = await signInWithPopup(auth, googleProvider);
    await handleSignedInUser(result.user);
  } catch (err) {
    console.error(err);

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

onAuthStateChanged(auth, (user) => {
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
    refreshQuickPostBar();
    startOrdersListener(); // only start reading once we actually have a valid, verified auth token
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
});

function getMyName() { return myName || ""; }

/* ---------------- remembered defaults (contact, location, last app/expiry) ---------------- */
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

function hasQuickPostDefaults() {
  // A contact saved before numbers were required could be an Instagram handle
  // or a room number. Treat those as "no default" so the user is sent through
  // the full form once to supply a real number, rather than quick-posting
  // something nobody can call.
  return !!(normalizePhone(getSavedContact()) && getSavedLocation());
}

/* ---------------- quick post bar ---------------- */
const quickPost = document.getElementById("quickPost");
const qpApp = document.getElementById("qpApp");
const qpTarget = document.getElementById("qpTarget");
const qpExpiry = document.getElementById("qpExpiry");
const qpSubmit = document.getElementById("qpSubmit");
const quickPostNote = document.getElementById("quickPostNote");

// mirror the same app options as the full form, so they stay in sync
qpApp.innerHTML = document.getElementById("fApp").innerHTML;

function refreshQuickPostBar() {
  if (!hasQuickPostDefaults()) {
    quickPost.hidden = true;
    return;
  }
  quickPost.hidden = false;
  const savedApp = getSavedApp();
  if (savedApp) qpApp.value = savedApp;
  const savedExpiry = getSavedExpiry();
  if (savedExpiry) qpExpiry.value = savedExpiry;
  quickPostNote.textContent = `Posts to ${getSavedLocation()} · reachable at ${normalizePhone(getSavedContact())}. Tap "Post an order" to change these.`;
}

qpSubmit.addEventListener("click", async () => {
  const target = Number(qpTarget.value);
  if (!target || target <= 0) {
    toast("Enter how much ₹ is needed first");
    qpTarget.focus();
    return;
  }
  const savedContact = normalizePhone(getSavedContact());
  if (!savedContact) {
    toast("Add your mobile number first — tap \"Post an order\"");
    return;
  }

  const minutes = Number(qpExpiry.value);
  const expiresAt = Date.now() + minutes * 60 * 1000;
  const appVal = qpApp.value;

  const payload = {
    app: appVal,
    current: 0,
    target,
    items: "",
    location: getSavedLocation(),
    contact: savedContact,
    posterId: myId,
    posterName: getMyName(),
    posterEmail: myEmail,
    createdAt: serverTimestamp(),
    expiresAt
  };

  qpSubmit.disabled = true;
  try {
    await addDoc(collection(db, ORDERS_COL), payload);
    saveApp(appVal);
    saveExpiry(qpExpiry.value);
    qpTarget.value = "";
    toast("Posted to the board 🎉");
  } catch (err) {
    console.error(err);
    toast("Couldn't post — check your Firebase setup");
  } finally {
    qpSubmit.disabled = false;
  }
});

qpTarget.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); qpSubmit.click(); }
});

/* ---------------- DOM refs: app ---------------- */
const board = document.getElementById("board");
const emptyState = document.getElementById("emptyState");
const toastEl = document.getElementById("toast");

const postModalBackdrop = document.getElementById("postModalBackdrop");
const openPostModalBtn = document.getElementById("openPostModal");
const closePostModalBtn = document.getElementById("closePostModal");
const postForm = document.getElementById("postForm");

const filterTabs = document.getElementById("filterTabs");
let currentFilter = "all";
let latestOrders = [];

/* ---------------- smart search ---------------- */
const searchToggle = document.getElementById("searchToggle");
const searchPanel = document.getElementById("searchPanel");
const sMyValue = document.getElementById("sMyValue");
const sMaxTime = document.getElementById("sMaxTime");
const sApp = document.getElementById("sApp");
const sSort = document.getElementById("sSort");
const clearSearchBtn = document.getElementById("clearSearch");

searchToggle.addEventListener("click", () => {
  const isHidden = searchPanel.hidden;
  searchPanel.hidden = !isHidden;
  searchToggle.classList.toggle("open", isHidden);
});
[sMyValue, sMaxTime, sApp, sSort].forEach(el => {
  el.addEventListener("input", render);
  el.addEventListener("change", render);
});
clearSearchBtn.addEventListener("click", () => {
  sMyValue.value = "";
  sMaxTime.value = "0";
  sApp.value = "";
  sSort.value = "match";
  render();
});

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

openPostModalBtn.addEventListener("click", () => {
  const fContact = document.getElementById("fContact");
  const fLocation = document.getElementById("fLocation");
  const fApp = document.getElementById("fApp");
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
  const savedApp = getSavedApp();
  if (savedApp) fApp.value = savedApp;
  const savedExpiry = getSavedExpiry();
  if (savedExpiry) fExpiry.value = savedExpiry;

  openModal(postModalBackdrop);
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

/* ---------------- filter tabs ---------------- */
filterTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-tab");
  if (!btn) return;
  [...filterTabs.children].forEach(c => c.classList.remove("active"));
  btn.classList.add("active");
  currentFilter = btn.dataset.filter;
  render();
});

/* ---------------- post order ---------------- */
postForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const currentRaw = document.getElementById("fCurrent").value;
  const current = currentRaw === "" ? 0 : Number(currentRaw);
  const target = Number(document.getElementById("fTarget").value);
  const minutes = Number(document.getElementById("fExpiry").value);
  const expiresAt = Date.now() + minutes * 60 * 1000;

  const contactInput = document.getElementById("fContact");
  const contact = normalizePhone(contactInput.value);
  if (!contact) {
    toast("Enter a valid 10-digit mobile number");
    contactInput.focus();
    return;
  }

  const location = document.getElementById("fLocation").value.trim();
  const appVal = document.getElementById("fApp").value;
  const expiryVal = document.getElementById("fExpiry").value;

  const payload = {
    app: appVal,
    current,
    target,
    items: document.getElementById("fItems").value.trim(),
    location,
    contact,
    posterId: myId,
    posterName: getMyName(),
    posterEmail: myEmail,
    createdAt: serverTimestamp(),
    expiresAt
  };

  try {
    await addDoc(collection(db, ORDERS_COL), payload);
    saveContact(contact);
    saveLocation(location);
    saveApp(appVal);
    saveExpiry(expiryVal);
    postForm.reset();
    document.getElementById("contactHint").hidden = true;
    document.getElementById("locationHint").hidden = true;
    closeModal(postModalBackdrop);
    toast("Posted to the board 🎉");
    refreshQuickPostBar();
  } catch (err) {
    console.error(err);
    toast("Couldn't post — check your Firebase setup");
  }
});

/* ---------------- realtime listener ---------------- */
let unsubscribeOrders = null;

function startOrdersListener() {
  if (unsubscribeOrders) return; // already listening
  const q = query(collection(db, ORDERS_COL), orderBy("createdAt", "desc"));
  unsubscribeOrders = onSnapshot(q, (snap) => {
    latestOrders = [];
    snap.forEach(d => latestOrders.push({ id: d.id, ...d.data() }));
    render();
  }, (err) => {
    console.error(err);
    board.innerHTML = `<p class="empty-state">Couldn't connect to the board. Check that firebase-config.js has been filled in with a real project.</p>`;
  });
}

function stopOrdersListener() {
  if (unsubscribeOrders) {
    unsubscribeOrders();
    unsubscribeOrders = null;
  }
  latestOrders = [];
}

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

function cardInnerHTML(o, now, myValue) {
  const current = o.current || 0;
  const needed = o.target;
  const { label, urgent } = timeLeftLabel(o.expiresAt);
  const isMine = o.posterId === myId;
  const isGoodMatch = myValue !== null && needed <= myValue;

  return `
      ${amountBlock(needed)}
      <div class="card-body">
        <div class="card-top">
          <span class="card-app">${escapeHtml(o.app)}${isGoodMatch ? '<span class="match-badge">fits your cart</span>' : ""}</span>
          <span class="card-timer ${urgent ? "urgent" : ""}">${label}</span>
        </div>
        <div class="card-amounts">
          ${current > 0 ? `cart's at <b>₹${current}</b> · ` : ""}needs <b>₹${needed}</b> more to unlock free delivery
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
      </div>
  `;
}

function wireCardEvents(el, o) {
  const joinBtn = el.querySelector("[data-join]");
  if (joinBtn) {
    joinBtn.addEventListener("click", async () => {
      joinBtn.disabled = true;
      joinBtn.textContent = "…";

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

      const slot = el.querySelector(".contact-slot");
      const waDigits = extractWhatsAppDigits(o.contact);
      let html = `<div class="contact-reveal">Reach out: ${escapeHtml(o.contact)}</div>`;
      if (waDigits) {
        html += `<a class="btn btn-primary btn-block wa-link" href="${buildWhatsAppLink(waDigits, o)}" target="_blank" rel="noopener">Message on WhatsApp</a>`;
      }
      slot.innerHTML = html;
      joinBtn.textContent = "Contact revealed ✓";
    });
  }
  const removeBtn = el.querySelector("[data-remove]");
  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      deleteDoc(doc(db, ORDERS_COL, o.id)).catch(() => toast("Couldn't remove — try again"));
    });
  }
}

function render() {
  const now = Date.now();
  const active = latestOrders.filter(o => (o.expiresAt || 0) > now);

  // lazy-clean expired ones (best effort, ignore failures)
  latestOrders.filter(o => (o.expiresAt || 0) <= now).forEach(o => {
    deleteDoc(doc(db, ORDERS_COL, o.id)).catch(() => { });
  });

  let visible = currentFilter === "mine"
    ? active.filter(o => o.posterId === myId)
    : active;

  // ---- smart search: filters ----
  const myValueRaw = sMyValue.value;
  const myValue = myValueRaw === "" ? null : Number(myValueRaw);
  const maxTimeMin = Number(sMaxTime.value);
  const appFilter = sApp.value;

  if (maxTimeMin > 0) {
    visible = visible.filter(o => (o.expiresAt - now) <= maxTimeMin * 60000);
  }
  if (appFilter) {
    visible = visible.filter(o => o.app === appFilter);
  }

  // ---- smart search: sort ----
  const sortMode = sSort.value;
  if (myValue !== null && sortMode === "match") {
    visible = [...visible].sort((a, b) => Math.abs(a.target - myValue) - Math.abs(b.target - myValue));
  } else if (sortMode === "soonest") {
    visible = [...visible].sort((a, b) => a.expiresAt - b.expiresAt);
  } else if (sortMode === "lowest") {
    visible = [...visible].sort((a, b) => a.target - b.target);
  }

  emptyState.hidden = visible.length !== 0;

  // ---- keyed reconciliation: update/move existing cards in place,
  // only create+animate cards that are genuinely new. This is what
  // stops the whole board flashing on every snapshot / 30s tick. ----
  const stillPresent = new Set();
  let prevEl = null;

  visible.forEach(o => {
    const html = cardInnerHTML(o, now, myValue);
    const needed = o.target;
    const isGoodMatch = myValue !== null && needed <= myValue;
    const wantedClass = "card" + (isGoodMatch ? " matched" : "");

    let el = board.querySelector(`[data-order-id="${o.id}"]`);

    if (el) {
      if (el.dataset.snapshot !== html) {
        el.innerHTML = html;
        el.dataset.snapshot = html;
        wireCardEvents(el, o);
      }
      if (el.className !== wantedClass) el.className = wantedClass;
    } else {
      el = document.createElement("div");
      el.dataset.orderId = o.id;
      el.className = wantedClass + " card-enter";
      el.innerHTML = html;
      el.dataset.snapshot = html;
      wireCardEvents(el, o);
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
  const msg = `Hey! Saw your OrderUp post for ${o.app} (₹${o.target} more needed) — I'm in, let's split delivery!`;
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
/* init handled by onAuthStateChanged above */

/* ---------------- PWA service worker ---------------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { });
  });
}
