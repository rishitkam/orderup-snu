import {
  db, auth, googleProvider, ALLOWED_DOMAIN, persistenceState, persistenceReady
} from "./firebase-config.js";
import {
  collection, onSnapshot, deleteDoc, doc, setDoc, getDoc, updateDoc,
  serverTimestamp, query, orderBy, limit, writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, signInWithCredential, GoogleAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const ORDERS_COL = "orders";
const EXTEND_BY_MS = 15 * 60 * 1000;
// Ceiling on "+15 min" so a forgotten order can't be kept alive indefinitely.
// A day is the natural bound now that orders can run until midnight.
const MAX_REMAINING_MS = 24 * 60 * 60 * 1000;

/* ---------------- expiry ----------------
   Every other option is a duration in minutes; this one is an absolute time,
   so it travels as a sentinel string rather than a number. */
const EXPIRY_ALL_DAY = "day";
const MIN_ALL_DAY_MS = 30 * 60 * 1000;

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function expiryToTimestamp(value) {
  if (value !== EXPIRY_ALL_DAY) {
    return Date.now() + (Number(value) || 0) * 60 * 1000;
  }
  // Posting "all day" at 23:50 would otherwise expire in ten minutes, which is
  // useless. Guarantee a floor, even if that spills past midnight.
  return Math.max(endOfToday(), Date.now() + MIN_ALL_DAY_MS);
}

// True for orders set to run until tonight's midnight, so they can be labelled
// as such instead of counting down "13h 42m left".
function isAllDay(expiresAt) {
  const d = new Date(Number(expiresAt) || 0);
  return d.getHours() === 23 && d.getMinutes() === 59;
}
const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

// In-app browsers (the webview inside Instagram, Facebook, WhatsApp, Gmail,
// Snapchat, LinkedIn, etc.) cannot complete a Google sign-in, and there is no
// code fix for it: iOS webviews don't allow window.open (so the popup never
// opens — "nothing happens"), and Google itself refuses OAuth inside embedded
// webviews (disallowed_useragent) so the redirect fallback is dead too. The
// only working path is the real browser, so we detect these UAs and route the
// user out instead of letting them tap a button that can't succeed.
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
function isInAppBrowser() {
  const ua = navigator.userAgent || "";
  // Facebook, Instagram, Line, Snapchat, LinkedIn, TikTok set explicit tokens.
  if (/(FBAN|FBAV|Instagram|Line\/|Snapchat|LinkedInApp|Twitter|MicroMessenger|TikTok|GSA\/)/i.test(ua)) return true;
  // Generic iOS webview: WebKit but neither "Safari" nor a known real browser
  // (Chrome=CriOS, Firefox=FxiOS, Edge=EdgiOS). Real Safari always says "Safari".
  if (IS_IOS && /AppleWebKit/i.test(ua) && !/Safari/i.test(ua) && !/(CriOS|FxiOS|EdgiOS)/i.test(ua)) return true;
  return false;
}

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
const FILTER_ALL = "all";
const FILTER_MINE = "mine";

// "all" and "mine" are filters but not apps, so they can't go through
// isKnownApp() — which also guards the post form's app default.
const isValidFilter = (f) => f === FILTER_ALL || f === FILTER_MINE || isKnownApp(f);

// Pre-loaded because free text fragments outlet names, and matching depends on
// two people naming the same outlet the same way. "Other" stays available.
const POPULAR_OUTLETS = [
  "Domino's Pizza", "California Burrito", "McDonald's", "Burger King",
  "KFC", "Subway", "Pizza Hut", "Wow! Momo", "Behrouz Biryani",
  "Chaayos", "Theobroma", "Haldiram's", "Rolls Mania", "Biryani Blues"
];
const OUTLET_OTHER = "__other__";

/* ---------------- pickup points ----------------
   Riders don't come to your room, they stop at a gate or a landmark and you
   walk down. So the meaningful location is the handover spot, not the
   building: two people in Cluster 1 and Cluster 2 are both walking to
   Parking 1 anyway, which makes them far better matched than their block
   numbers suggest.

   `value` is what gets stored and shown on cards, kept short so it fits.
   `label` carries the buildings each spot covers, which only matters while
   you're choosing. A closed list (no free text) keeps these comparable, so
   they can drive filtering or proximity ranking later without everyone having
   spelled the same place five different ways. */
const PICKUP_POINTS = [
  { value: "Parking 1", label: "Parking 1 (Cluster 1, Cluster 2, UAC)" },
  { value: "Inner gate", label: "Inner gate (Cluster 3)" },
  { value: "Cluster 4 & 5", label: "Cluster 4 & 5 (DH3)" },
  { value: "Cluster 6", label: "Cluster 6" },
  { value: "DH2", label: "DH2" },
  { value: "Acad blocks", label: "Acad blocks (A, B, C, D & library)" },
  { value: "G block", label: "G block" },
  { value: "Towers", label: "Towers (6 & 9)" }
];

const isKnownPickup = (v) => PICKUP_POINTS.some(p => p.value === v);

function populatePickupSelect(sel, placeholder) {
  if (!sel) return;
  sel.innerHTML = `<option value="">${escapeHtml(placeholder || "Choose a drop location…")}</option>`
    + PICKUP_POINTS.map(p => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`).join("");
}

// A plain line-icon pin, replacing the pin emoji that used to sit in front of
// the drop location on every card — same reasoning as the theme toggle icons.
const ICON_PIN = `<svg viewBox="0 0 24 24" width="14" height="14" focusable="false" aria-hidden="true">
  <path fill="currentColor" d="M12 2c-4 0-7 3-7 7 0 5.2 6 12.3 6.3 12.6a1 1 0 0 0 1.4 0C13 21.3 19 14.2 19 9c0-4-3-7-7-7zm0 9.6A2.6 2.6 0 1 1 12 6.4a2.6 2.6 0 0 1 0 5.2z"/>
</svg>`;

/* Brand marks, drawn as inline SVG so they work offline and inside the service
   worker cache — no external image requests. Each uses currentColor, so the
   colour comes from the .app-dot rule in style.css and stays correct on any
   background. To swap in an official asset, replace one entry here: nothing
   else in the codebase references these shapes. */
const APP_ICONS = {
  // Blinkit and Zomato are each brand's own artwork from things/, used whole:
  // Blinkit's app icon, and Zomato's wordmark on its red. They carry their own
  // colours. Swiggy ships a symbol, drawn in currentColor on the .app-dot fill.
  Blinkit: `<svg viewBox="0 0 3500 3500" aria-hidden="true" focusable="false"><rect width="3500" height="3500" fill="#FFE141"/><path d="M630.461 1544.23C681.09 1544.23 726.294 1556.88 766.074 1582.19C806.215 1607.13 837.678 1642.55 860.461 1688.46C882.52 1732.56 893.55 1784.43 893.55 1844.07C893.55 1901.91 882.52 1953.6 860.461 1999.15C838.401 2044.69 807.3 2080.3 767.159 2105.96C726.656 2131.99 681.09 2145 630.461 2145C593.575 2145 558.858 2137.41 526.311 2122.23C493.763 2107.05 465.918 2085.72 442.773 2058.25V2131.44H254V1355H442.773V1630.44C465.918 1602.97 493.763 1581.82 526.311 1567C558.858 1551.82 593.575 1544.23 630.461 1544.23ZM574.046 1988.3C600.807 1988.3 624.675 1982.16 645.65 1969.87C666.625 1957.58 683.079 1940.41 695.013 1918.36C706.947 1896.67 712.914 1871.91 712.914 1844.07C712.914 1816.96 706.947 1792.38 695.013 1770.33C683.079 1748.28 666.625 1731.11 645.65 1718.82C624.675 1706.53 600.807 1700.39 574.046 1700.39C548.732 1700.39 526.13 1706.53 506.24 1718.82C486.35 1730.75 470.8 1747.56 459.589 1769.25C448.378 1791.3 442.773 1816.24 442.773 1844.07C442.773 1871.91 448.378 1896.85 459.589 1918.9C470.8 1940.59 486.35 1957.58 506.24 1969.87C526.13 1982.16 548.732 1988.3 574.046 1988.3Z" fill="black"/><path d="M919.393 2131.44V1355H1108.17V2131.44H919.393Z" fill="black"/><path d="M1161.67 2131.44V1557.24H1349.36V2131.44H1161.67Z" fill="black"/><path d="M1757.09 1544.23C1797.23 1544.23 1833.39 1553.63 1865.58 1572.43C1897.76 1590.86 1923.08 1616.89 1941.52 1650.5C1959.24 1684.48 1968.1 1722.98 1968.1 1766V2131.44H1788.01V1808.29C1788.01 1787.32 1783.85 1768.71 1775.53 1752.44C1767.58 1735.81 1756.19 1722.98 1741.36 1713.94C1726.89 1704.91 1709.9 1700.39 1690.37 1700.39C1671.92 1700.39 1654.93 1704.91 1639.38 1713.94C1623.83 1722.62 1611.71 1734.55 1603.03 1749.73C1593.99 1764.19 1589.47 1781.18 1589.47 1800.7L1588.39 2131.44H1400.7V1557.24H1588.39V1622.85C1606.11 1598.27 1629.79 1579.11 1659.45 1565.38C1689.1 1551.28 1721.65 1544.23 1757.09 1544.23Z" fill="black"/><path d="M2382.88 1808.29L2596.07 2131.44H2382.88L2258.12 1928.12L2200.62 1994.81V2131.44H2011.85V1355H2200.62V1783.89L2381.8 1557.24H2594.98L2382.88 1808.29Z" fill="black"/><path d="M1161.57 1355.06H1349.87V1502.26H1161.57V1355.06Z" fill="black"/><path d="M2626.03 2129.72V1555.52H2813.71V2129.72H2626.03Z" fill="#0C831F"/><path d="M3210.57 1967.6L3248 2088.52C3231 2104.78 3209.49 2117.98 3183.45 2128.1C3157.77 2138.22 3132.64 2143.28 3108.05 2143.28C3072.61 2143.28 3040.96 2135.51 3013.12 2119.96C2985.27 2104.06 2963.57 2082.01 2948.02 2053.81C2932.47 2026.34 2924.7 1994.71 2924.7 1958.93V1705.72H2849.3V1555.52H2924.7V1355.06H3104.79V1555.52H3223.59V1705.72H3104.79V1924.23C3104.79 1942.66 3109.67 1957.66 3119.44 1969.23C3129.2 1980.8 3141.68 1986.58 3156.87 1986.58C3167.72 1986.58 3177.84 1984.95 3187.25 1981.7C3196.65 1978.45 3204.42 1973.75 3210.57 1967.6Z" fill="#0C831F"/><path d="M2624.54 1355.06H2812.84V1502.26H2624.54V1355.06Z" fill="#0C831F"/></svg>`,
  Zomato: `<svg viewBox="0 0 1000 1000" aria-hidden="true" focusable="false"><rect width="1000" height="1000" fill="#E23744"/><path fill="#fff" transform="translate(112 417) scale(0.3104)" d="m381.02 135.1-2.25 72.32-188.62 205.03c78.79 0 128.75-.77 157.56-2.37-8.35 38.91-15.14 70.72-21.98 118.41-37.89-3.2-96.96-4-156.06-4-65.88 0-123.46.79-169.67 4l1.54-73.14 188.61-204.21c-82.57 0-112.88.78-146.95 1.58 7.55-36.56 12.86-77.07 18.16-117.62 59.84 2.38 83.32 3.16 161.35 3.16 71.97.01 112.85-.78 158.31-3.16zm214.39-21.48c-122.75 0-216.64 109.67-216.64 240.84 0 98.53 56.8 174.03 167.39 174.03 123.48 0 216.65-109.69 216.65-241.63.01-97.7-55.31-173.24-167.4-173.24zm-37.13 309.46c-27.28 0-43.17-24.67-43.17-73.14 0-72.32 29.54-130.32 65.92-130.32 26.49 0 42.4 23.86 42.4 73.1-.01 71.52-28.77 130.36-65.15 130.36zm1772.1-314.9c-124.32 0-219.47 111.12-219.47 243.94 0 99.87 57.55 176.37 169.59 176.37 125.09 0 219.49-111.13 219.49-244.78.01-99.02-55.99-175.53-169.61-175.53zm-39.95 314.48c-27.29 0-43.17-24.67-43.17-73.14 0-72.32 29.55-130.31 65.92-130.31 26.48 0 42.42 23.84 42.42 73.09-.02 71.55-28.81 130.36-65.17 130.36zm-890.58-165.97c9.86-67.53 4.56-128.74-70.42-128.74-54.55 0-113.63 46.1-155.29 123.19 9.1-63.6 3.78-123.19-70.45-123.19-56.05 0-116.65 48.47-158.33 128.74 10.61-52.45 8.35-112.07 5.31-124.78-43.17 7.16-81.03 11.12-134.07 12.71 1.52 36.57-.76 84.22-7.58 129.56l-17.42 119.19c-6.82 46.91-14.4 100.95-21.98 135.13h140.9c.77-20.69 6.08-53.26 9.86-81.87l12.12-81.84c9.84-53.28 52.25-116.03 84.82-116.03 18.94 0 18.2 18.27 12.89 52.44l-13.64 92.16c-6.84 46.91-14.39 100.95-21.98 135.13h142.41c.77-20.69 5.31-53.26 9.09-81.87l12.11-81.84c9.86-53.28 52.3-116.03 84.85-116.03 18.96 0 18.21 17.46 15.15 41.32l-34.02 238.41h129.97zm680.51 147.03-15.15 93.79c-23.49 12.71-67.43 31-118.18 31-86.36 0-103.76-46.1-90.15-143.85l21.98-157.36h-42.5l12-101.86 46.4-2.24 17.43-73.91 131.03-49.29-16.65 123.19h90.15c-3.02 12.71-13.66 82.67-16.64 104.1h-87.92l-19.7 145.44c-5.3 37.35-2.25 50.87 23.47 50.87 18.98-.02 46.98-11.15 64.43-19.88zm-497.04 50.66c47.69-5.91 80.51-51.88 88.4-97.75l1.33-12.29c-20.49-4.58-50.11-8.07-78.83-4.56-27.35 3.33-50.11 14.7-62.35 31.16-9.23 11.82-13.87 25.96-11.81 42.82 3.11 25.25 31.04 44.55 63.26 40.62zm-40.59 72.64c-67.31 8.27-111.64-18.45-124.95-79.22-8.35-38.24 3.24-81.8 23.51-107.79 27.15-33.99 71.39-55.81 125.38-62.4 43.45-5.39 80.06-2.73 114.3 3.75l1.42-5.87c.98-9.39 1.97-18.76.6-29.98-3.55-28.81-26.27-45.97-82.37-39.07-37.85 4.65-73.86 18.32-101.82 33.88l-27.2-82.19c37.9-21.76 85.67-38.32 140.34-45.03 104.43-12.81 177.81 20.49 187.21 97.05 2.49 20.36 2.79 41.94.22 61.52-13.41 94.66-22 165.89-25.77 213.63-.61 7.39-.56 20.09.1 38.09l-129.59-.12c2.76-7.46 5.23-17.58 7.43-30.27 1.46-8.35 2.5-18.88 3.15-31.64-27.39 37.58-65.04 59.9-111.96 65.66z"/></svg>`,
  Swiggy: `<svg viewBox="-971.6 -366.7 4443.4 4443.4" aria-hidden="true" focusable="false"><path fill="currentColor" d="m1255.2 3706.3c-2.4-1.7-5-4-7.8-6.3-44.6-55.3-320.5-400.9-601.6-844.2-84.4-141.2-139.1-251.4-128.5-279.9 27.5-74.1 517.6-114.7 668.5-47.5 45.9 20.4 44.7 47.3 44.7 63.1 0 67.8-3.3 249.8-3.3 249.8 0 37.6 30.5 68.1 68.2 68 37.7 0 68.1-30.7 68-68.4l-.7-453.3h-.1c0-39.4-43-49.2-51-50.8-78.8-.5-238.7-.9-410.5-.9-379 0-463.8 15.6-528-26.6-139.5-91.2-367.6-706-372.9-1052-7.5-488 281.5-910.5 688.7-1119.8 170-85.6 362-133.9 565-133.9 644.4 0 1175.2 486.4 1245.8 1112.3 0 .5 0 1.2.1 1.7 13 151.3-820.9 183.4-985.8 139.4-25.3-6.7-31.7-32.7-31.7-43.8-.1-115-.9-438.8-.9-438.8-.1-37.7-30.7-68.1-68.4-68.1-37.6 0-68.1 30.7-68.1 68.4l1.5 596.4c1.2 37.6 32.7 47.7 41.4 49.5 93.8 0 313.1-.1 517.4-.1 276.1 0 392.1 32 469.3 90.7 51.3 39.1 71.1 114 53.8 211.4-154.9 866-1135.9 1939.1-1172.8 1983.8z"/></svg>`
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

// Plain Levenshtein edit distance — the number of single-character inserts,
// deletes or swaps to turn one string into the other.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[n];
}

// 1 = identical, 0 = nothing in common. "behrouz" vs "behrooz" lands around
// 0.86 — a typo, not a different place — while "kfc" vs "bfc" (short strings,
// one swap) lands at 0.67, which is exactly the case the length guard in
// outletsSimilar() below exists to keep out: short names are one edit away
// from a *different real brand* far more easily than long ones are.
function outletSimilarity(a, b) {
  const longer = Math.max(a.length, b.length);
  if (!longer) return 1;
  return 1 - editDistance(a, b) / longer;
}

// Same outlet if the normalized keys match exactly, one is a shortened form
// of the other ("Behrouz" said instead of "Behrouz Biryani" — a name someone
// typed short, not a typo), or they're close enough on a normalized
// edit-distance ratio to absorb an actual typo like "Behrouz"/"Behrooz".
// Short keys are excluded from the edit-distance leg: "KFC" vs "BFC" is one
// swap apart but a completely different restaurant, and there isn't enough
// string length left for a coincidence like that to show up as anything
// other than "similar". The containment leg still applies at short lengths —
// "KFC" said instead of "KFC Biryani" is a real shortening, not a coincidence.
const OUTLET_FUZZY_THRESHOLD = 0.8;
const OUTLET_FUZZY_MIN_LEN = 5;
const OUTLET_PREFIX_MIN_LEN = 4;
function outletsSimilar(a, b) {
  const ka = outletKey(a), kb = outletKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const shorter = ka.length <= kb.length ? ka : kb;
  const longerStr = ka.length <= kb.length ? kb : ka;
  if (shorter.length >= OUTLET_PREFIX_MIN_LEN && longerStr.startsWith(shorter)) return true;
  // Covers "Behrooz" (typo) said short for "Behrouz Biryani" (typo AND
  // truncation at once) — compare the short form against a same-length
  // window off the front of the long one, not the whole thing, so the extra
  // trailing words don't drown out a close match at the start.
  if (shorter.length >= OUTLET_FUZZY_MIN_LEN &&
      outletSimilarity(shorter, longerStr.slice(0, shorter.length)) >= OUTLET_FUZZY_THRESHOLD) return true;
  if (ka.length < OUTLET_FUZZY_MIN_LEN || kb.length < OUTLET_FUZZY_MIN_LEN) return false;
  return outletSimilarity(ka, kb) >= OUTLET_FUZZY_THRESHOLD;
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
const loginInApp = document.getElementById("loginInApp");
const loginInAppMsg = document.getElementById("loginInAppMsg");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const whoamiEmail = document.getElementById("whoamiEmail");
const signOutBtn = document.getElementById("signOutBtn");

function showLoginNote(msg, isError) {
  loginNote.textContent = msg;
  loginNote.classList.toggle("error", !!isError);
}

// If we're stuck inside an in-app browser, sign-in can't succeed here (see
// isInAppBrowser). Disable the dead button and show how to escape to the real
// browser instead of letting the user tap into a silent failure.
if (isInAppBrowser()) {
  googleSignInBtn.disabled = true;
  loginInAppMsg.textContent = IS_IOS
    ? "Open this page in Safari to sign in. Tap the ••• (or share) button at the bottom, then “Open in Safari”."
    : "Open this page in Chrome to sign in. Tap the ⋮ menu, then “Open in browser”.";
  loginInApp.hidden = false;
  copyLinkBtn.addEventListener("click", async () => {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      copyLinkBtn.textContent = "Link copied ✓";
    } catch {
      // Clipboard API is often blocked in webviews too — fall back to a prompt
      // the user can copy from manually.
      window.prompt("Copy this link and open it in your browser:", url);
    }
  });
}

/* ---------------- sign-in diagnostics ----------------
   The failure mode we kept chasing is *silent*: getRedirectResult() resolves
   null rather than rejecting, so nothing throws and the login screen simply
   reappears. This records that a redirect was started, and if we come back
   with no user, says so on screen instead of pretending nothing happened. */
const PENDING_REDIRECT_KEY = "orderknot_redirect_started";

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
    localStorage.setItem("__orderknot_probe", "1");
    localStorage.removeItem("__orderknot_probe");
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
    "flow:        " + (USE_GIS ? "google-identity (iOS)" : "popup-first") + (IS_MOBILE ? " (mobile UA)" : " (desktop UA)"),
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
  showLoginNote("Something failed to load. Details below.", true);
  showDiag("uncaught: " + ((e.error && e.error.message) || e.message));
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  showLoginNote("Something failed to load. Details below.", true);
  showDiag("unhandled rejection: " + ((r && (r.code || r.message)) || String(r)));
});

async function handleSignedInUser(user) {
  const email = (user.email || "").toLowerCase();
  if (!email.endsWith("@" + ALLOWED_DOMAIN)) {
    await signOut(auth);
    showLoginNote(`Only @${ALLOWED_DOMAIN} accounts can use OrderKnot. Try a different Google account.`, true);
  }
  // otherwise onAuthStateChanged below flips the UI over automatically
}

/* ---------------- iPhone sign-in ----------------
   Both Firebase flows fail on iOS Safari: the popup loses track of its tab
   (auth/popup-closed-by-user, auth/internal-error) and the redirect comes back
   with an empty result, because Safari partitions the storage the handoff
   needs. Google Identity Services runs its own popup and hands back a signed
   ID token directly, which Firebase accepts via signInWithCredential — no
   cross-site storage involved. Needs the page origin in the OAuth client's
   "Authorized JavaScript origins". `?gis` forces this path for testing. */
const GOOGLE_CLIENT_ID = "72262965540-ci08dc6mi6ul5k97utd04knqia215em5.apps.googleusercontent.com";
const USE_GIS = (IS_IOS || new URLSearchParams(location.search).has("gis")) && !isInAppBrowser();

function initGoogleIdentity(tries = 0) {
  const gsi = window.google && window.google.accounts && window.google.accounts.id;
  if (!gsi) {
    // The GIS script loads async; give it ~10s before telling the user.
    if (tries < 50) setTimeout(() => initGoogleIdentity(tries + 1), 200);
    else { showLoginNote("Couldn't load Google sign-in. Check your connection and reload.", true); showDiag("GIS script never loaded"); }
    return;
  }
  gsi.initialize({
    client_id: GOOGLE_CLIENT_ID,
    hd: ALLOWED_DOMAIN,              // nudges the account picker toward @snu.edu.in
    ux_mode: "popup",
    callback: async (resp) => {
      showLoginNote("Signing you in…", false);
      try {
        const result = await signInWithCredential(auth, GoogleAuthProvider.credential(resp.credential));
        await handleSignedInUser(result.user); // onAuthStateChanged flips the UI
      } catch (err) {
        console.error("[orderknot] GIS credential sign-in failed:", err);
        showLoginNote("Couldn't sign in. Please try again.", true);
        showDiag((err && err.code) || String(err));
      }
    }
  });
  const slot = document.getElementById("gisSlot");
  const width = Math.min(400, Math.max(200, Math.round(googleSignInBtn.getBoundingClientRect().width) || 300));
  gsi.renderButton(slot, { theme: "filled_black", size: "large", shape: "pill", text: "continue_with", width });
  slot.hidden = false;
  googleSignInBtn.hidden = true;
}
if (USE_GIS) initGoogleIdentity();

googleSignInBtn.addEventListener("click", async () => {
  showLoginNote("Opening Google sign-in…", false);

  // iPhone/iPad: go straight to redirect, never popup. iOS Safari opens the
  // popup as a separate tab and Firebase frequently loses track of it, so the
  // popup rejects with auth/popup-closed-by-user even though the user finished
  // signing in — and that code is treated as "user cancelled" below, so the
  // login screen just sat there with no error. Redirect is safe here only
  // because authDomain is the serving origin (see firebase-config.js), so the
  // credential handoff stays first-party and iOS doesn't partition it away.
  if (IS_IOS) {
    markRedirectStarted();
    signInWithRedirect(auth, googleProvider).catch((err) => {
      console.error(err);
      showLoginNote("Couldn't start sign-in on this browser.", true);
      showDiag((err && err.code) || String(err));
    });
    return;
  }

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
    //
    // CRITICAL: nothing may be `await`ed before signInWithPopup. That call
    // opens a window, and mobile browsers (iOS Safari AND Android Chrome) only
    // permit window.open inside the SYNCHRONOUS run of the tap handler. Any
    // await first — even on an already-resolved promise like persistenceReady —
    // defers to a microtask, the tap's transient activation is gone, the popup
    // is blocked, and Firebase throws auth/popup-blocked. On mobile that reads
    // as "the Google window never opens." Desktop is lenient about this; mobile
    // is not. So persistence is NOT awaited here — it was already kicked off at
    // module load (firebase-config.js) and is applied to the session
    // regardless, so a reload still restores the login.
    console.log("[orderknot] calling signInWithPopup, authDomain =", auth.config && auth.config.authDomain);
    const result = await signInWithPopup(auth, googleProvider);
    console.log("[orderknot] popup RESOLVED for", result && result.user && result.user.email);
    await handleSignedInUser(result.user);
  } catch (err) {
    console.error("[orderknot] popup REJECTED:", err && err.code, err);

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

    showLoginNote("Couldn't sign in. Please try again.", true);
    showDiag((err && err.code) || String(err));
  }
});

signOutBtn.addEventListener("click", () => signOut(auth));

// completes the sign-in when the browser returns from the Google redirect
// Wait for setPersistence (started in firebase-config.js) to settle first.
// Running both at once races: switching persistence while Firebase is still
// restoring the redirect sign-in can drop the user, so iOS came back from
// Google with an empty result. Persistence resolves in milliseconds, and
// nothing here is inside a tap handler, so the wait costs nothing.
persistenceReady.then(() => getRedirectResult(auth)).then((result) => {
  const startedAt = consumeRedirectStarted();
  if (result && result.user) {
    handleSignedInUser(result.user);
    return;
  }
  // We started a redirect and came back with nothing, and no session was
  // restored either. This is the silent bounce — say so rather than quietly
  // re-showing the login screen as if the user never tried.
  if (startedAt && !auth.currentUser) {
    showLoginNote("Sign-in didn't complete. Tap below and send this to whoever runs OrderKnot.", true);
    showDiag("returned from Google with no credential (getRedirectResult was empty)");
  }
}).catch((err) => {
  consumeRedirectStarted();
  console.error(err);
  showLoginNote("Couldn't finish signing in. Please try again.", true);
  showDiag((err && err.code) || String(err));
});

/* The auth observer is registered at the BOTTOM of this file, not here.
   It reads currentFilter and calls applyFilterUI()/startOrdersListener(),
   which touch `const`s declared much further down.
   Registering it up here meant the observer could run while those bindings
   were still in the temporal dead zone — and Firebase swallows exceptions
   thrown inside the observer, so the failure was completely silent: sign-in
   succeeded, nothing listened, the login screen just stayed put. */

function getMyName() { return myName || ""; }

/* ---------------- remembered defaults ---------------- */
function fieldKey(field) {
  return `orderknot_${field}_${(myEmail || "").toLowerCase()}`;
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
// Kept separate from "app": the filter can be "all"/"mine", which must never
// leak into the post form's default app.
const getSavedFilter = () => getSavedField("filter");
const saveFilter = (v) => saveField("filter", v);

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
  if (appNeedsOutlet(mine.app) && !outletsSimilar(mine.outlet, theirs.outlet)) return false;
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
const filterStrip = document.querySelector(".filter-strip");
let currentFilter = DEFAULT_APP;   // "Blinkit" | "Zomato" | "Swiggy" | "mine"
let latestOrders = [];

/* ---------------- search ---------------- */
const searchBar = document.getElementById("searchBar");
const filterPanel = document.getElementById("filterPanel");
const filterToggle = document.getElementById("filterToggle");
const filterDot = document.getElementById("filterDot");
const clearFiltersBtn = document.getElementById("clearFilters");
const sQuery = document.getElementById("sQuery");
const sLocation = document.getElementById("sLocation");
const sMyValue = document.getElementById("sMyValue");
const sMaxTime = document.getElementById("sMaxTime");
const sSort = document.getElementById("sSort");
const clearSearchBtn = document.getElementById("clearSearch");
const searchHint = document.getElementById("searchHint");

[sQuery, sLocation, sMyValue, sMaxTime, sSort].forEach(el => {
  el.addEventListener("input", render);
  el.addEventListener("change", render);
});
clearSearchBtn.addEventListener("click", () => {
  sQuery.value = "";
  render();
  sQuery.focus();
});

/* ---------------- filter panel ----------------
   Search is always on screen; the filters stay collapsed by default, because
   shown permanently they pushed the board below the fold. */
const ICON_FILTER = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 7h16M7 12h10M10 17h4"/></svg>`;
const ICON_SHARE = `<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
  <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 15V3.5M7.5 7.5 12 3l4.500 4.500M6 11.500H5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7.500a1 1 0 0 0-1-1h-1"/></svg>`;

filterToggle.insertAdjacentHTML("afterbegin", ICON_FILTER);

function togglePanel(panel, btn, open) {
  const show = open === undefined ? !panel.classList.contains("open") : open;
  panel.classList.toggle("open", show);
  // inert (not `hidden`) is what actually keeps a collapsed panel's inputs
  // out of tab order — `hidden` would mean display:none, which can't
  // transition, which is the whole reason this panel isn't using it.
  if (show) panel.removeAttribute("inert");
  else panel.setAttribute("inert", "");
  btn.setAttribute("aria-expanded", show ? "true" : "false");
  btn.classList.toggle("on", show);
}

filterToggle.addEventListener("click", () => togglePanel(filterPanel, filterToggle));

clearFiltersBtn.addEventListener("click", () => {
  sLocation.value = "";
  sMyValue.value = "";
  sMaxTime.value = "0";
  render();
});

// Dot on the filter icon whenever a filter is actually narrowing the board, so
// a filtered view is never mistaken for the full one.
function syncFilterDot() {
  // Sort is deliberately excluded: it lives outside the panel now, and it
  // reorders the board rather than hiding anything from it.
  const active = sLocation.value !== "" || sMyValue.value.trim() !== ""
    || sMaxTime.value !== "0";
  filterDot.hidden = !active;
}

/* ---------------- theme ----------------
   Follows the OS by default. Once the toggle is used, that choice is stored
   and wins until it's changed again. The initial application happens in an
   inline script in index.html, before first paint — this only handles the
   toggle and keeps the browser chrome colour in sync. */
const THEME_KEY = "orderknot_theme";
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
// Line-icon sun/moon rather than the emoji glyphs this used to hold — those
// render as full-colour pictures on Android and inconsistently everywhere
// else, which reads as decoration rather than as a control.
const ICON_SUN = `<svg viewBox="0 0 24 24" width="20" height="20" focusable="false">
  <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
  <path stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
    d="M12 2.5v2.4M12 19.1v2.4M21.5 12h-2.4M4.9 12H2.5M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3 5.6 5.6"/>
</svg>`;
const ICON_MOON = `<svg viewBox="0 0 24 24" width="19" height="19" focusable="false">
  <path fill="currentColor" d="M20.3 14.6A8.6 8.6 0 1 1 9.4 3.7a7 7 0 0 0 10.9 10.9z"/>
</svg>`;

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;

  const dark = resolvedTheme() === "dark";
  if (themeColorMeta) themeColorMeta.setAttribute("content", dark ? "#000000" : "#f2f2f7");
  if (themeToggleIcon) themeToggleIcon.innerHTML = dark ? ICON_SUN : ICON_MOON;
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

/* ---------------- sharing ----------------
   The share sheet is how orders actually travel: students already coordinate
   in WhatsApp hostel groups, so the cheapest way onto the board is a link
   pasted into a group someone is already in.

   Note what's NOT in the text: the contact number. Sharing an order must not
   leak the poster's phone into a group chat — the link lands on the card, and
   whoever's interested taps "I'm in" like everyone else. */
function orderShareText(o) {
  const where = o.outlet ? `${o.app} · ${o.outlet}` : o.app;
  const at = o.location ? ` Meet at ${o.location}.` : "";
  // "Closes in till midnight" is not a sentence — all-day orders get their own.
  const closes = isAllDay(o.expiresAt)
    ? "Open till midnight."
    : `Closes in ${timeLeftLabel(o.expiresAt).label.replace(" left", "")}.`;
  return `${where}: ₹${o.target} more needed to hit free delivery.${at} ${closes}`;
}

function orderShareUrl(o) {
  return `${location.origin}${location.pathname}?order=${encodeURIComponent(o.id)}`;
}

async function shareOrder(o) {
  const url = orderShareUrl(o);
  const text = orderShareText(o);

  if (navigator.share) {
    try {
      await navigator.share({ title: "OrderKnot", text, url });
      return;
    } catch (err) {
      // The user backing out of the sheet is not a failure worth reporting.
      if (err && err.name === "AbortError") return;
      console.error("[orderknot] share failed, falling back to clipboard:", err);
    }
  }

  // Desktop Firefox and anything else without the share sheet.
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast("Link copied. Paste it in your group");
  } catch {
    toast("Couldn't share on this browser");
  }
}

/* ---------------- deep links (?order=…) ----------------
   Captured once at load and stashed, because the journey from a shared link
   to the board can pass through the login gate. Kept in sessionStorage so it
   also survives the redirect sign-in fallback, which reloads the page. */
const DEEP_LINK_KEY = "orderknot_deeplink";

function readDeepLink() {
  let fromUrl = null;
  try { fromUrl = new URLSearchParams(location.search).get("order"); } catch { /* ignore */ }
  if (fromUrl) {
    try { sessionStorage.setItem(DEEP_LINK_KEY, fromUrl); } catch { /* storage blocked */ }
    // Strip it so a later refresh doesn't keep re-opening the same card.
    try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ }
    return fromUrl;
  }
  try { return sessionStorage.getItem(DEEP_LINK_KEY); } catch { return null; }
}

let pendingDeepLink = readDeepLink();
let highlightAfterRender = null;

function clearDeepLink() {
  pendingDeepLink = null;
  try { sessionStorage.removeItem(DEEP_LINK_KEY); } catch { /* ignore */ }
}

// Runs once the first real snapshot has landed, so we can tell "not loaded
// yet" apart from "that order is gone".
function maybeConsumeDeepLink() {
  if (!pendingDeepLink) return;

  const wanted = pendingDeepLink;
  const target = latestOrders.find(o => o.id === wanted);
  clearDeepLink();

  if (!target || (target.expiresAt || 0) <= Date.now()) {
    toast("That order has already closed");
    return;
  }

  // Send them to the tab the order actually lives in, and clear any filter
  // that would hide the very card they followed a link to.
  if (isKnownApp(target.app)) {
    currentFilter = target.app;
    applyFilterUI();
  }
  sQuery.value = "";
  sMaxTime.value = "0";

  highlightAfterRender = wanted;
}

/* ---------------- on-screen keyboard ----------------
   iOS keeps `position: fixed` elements pinned to the layout viewport, which
   does not shrink when the keyboard opens — so the toast was rendering behind
   the keyboard, hiding validation messages at the exact moment they're needed.
   visualViewport reports the area actually visible; the difference is what the
   keyboard is covering, and CSS lifts the toast by that much. */
const visualVP = window.visualViewport;

function syncKeyboardInset() {
  if (!visualVP) return;
  const covered = Math.max(0, window.innerHeight - visualVP.height - visualVP.offsetTop);
  document.documentElement.style.setProperty("--kb-inset", covered + "px");
}

if (visualVP) {
  visualVP.addEventListener("resize", syncKeyboardInset);
  visualVP.addEventListener("scroll", syncKeyboardInset);
  syncKeyboardInset();
}

/* ---------------- toast ---------------- */
function toast(msg, ms) {
  syncKeyboardInset(); // the keyboard may already be up when this fires
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), ms || 2200);
}

/* Turns a raw Firestore error into something a student can actually act on —
   and, just as importantly, into something THEY can read back to whoever
   maintains the app. "Check your connection" was the only message every
   write failure ever showed, which meant a permission rule rejecting the
   write looked identical to being offline. There was no way to tell the two
   apart without opening devtools, which is exactly the trap the sign-in
   diagnostic further up this file already exists to avoid. */
function describeWriteError(err) {
  const code = (err && err.code) || "";
  const known = {
    "permission-denied": "blocked by a database rule",
    "unavailable": "no connection to the server",
    "resource-exhausted": "the app has hit its daily limit",
    "unauthenticated": "you're signed out — try signing in again",
    "deadline-exceeded": "the request timed out",
    "not-found": "that order no longer exists",
    "cancelled": "the request was cancelled"
  };
  console.error("[orderknot] write failed:", code || err);
  return known[code] || (code ? `error: ${code}` : "unknown error");
}

/* ---------------- inline field validation ---------------- */
function clearFieldErrors() {
  postForm.querySelectorAll(".field-error").forEach(el => el.remove());
  postForm.querySelectorAll(".has-error").forEach(el => el.classList.remove("has-error"));
}

// Puts the message directly under the offending field, scrolls it into view
// inside the modal, and still toasts so the feedback is impossible to miss.
function showFieldError(input, msg) {
  clearFieldErrors();
  const field = input.closest(".field") || input.parentElement;
  const err = document.createElement("span");
  err.className = "field-error";
  err.textContent = msg;
  field.appendChild(err);
  input.classList.add("has-error");

  // Scroll first, then focus without scrolling again — focus() alone doesn't
  // reliably bring a field into view inside a scrollable modal on iOS.
  try { input.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* older browsers */ }
  try { input.focus({ preventScroll: true }); } catch { input.focus(); }

  toast(msg);
}

postForm.addEventListener("input", clearFieldErrors);
postForm.addEventListener("change", clearFieldErrors);

/* ---------------- modal helpers ---------------- */
function syncSheetOpen() {
  document.documentElement.classList.toggle("sheet-open", !!document.querySelector(".modal-backdrop.open"));
}
function openModal(el) {
  el.classList.add("open");
  const sheet = el.querySelector(".modal");
  if (sheet) sheet.scrollTop = 0;
  syncSheetOpen();
}
function closeModal(el) { el.classList.remove("open"); syncSheetOpen(); }

/* Drag a sheet down by its header to dismiss it.

   The sheet tracks the finger 1:1 while it's held, resists (rather than
   stops dead) if pulled upward, and on release decides from where the
   gesture was GOING, not just where it stopped: a short fast flick dismisses,
   a long slow drag that's let go near the top settles back. Clearing the
   inline transform hands the rest to the CSS transition, which starts from
   wherever the sheet currently is — so there's no jump at the handoff.
   Phones only: on a wide screen the same markup is a centred dialog. */
function enableSheetDrag(backdrop, close) {
  const sheet = backdrop.querySelector(".modal");
  const handle = sheet.querySelector(".modal-head");
  const wide = window.matchMedia("(min-width: 560px)");
  let dragging = false, startY = 0, lastY = 0, lastT = 0, velocity = 0;

  const rubberband = (over, dim) => (over * dim * 0.55) / (dim + 0.55 * over);

  handle.addEventListener("pointerdown", (e) => {
    if (wide.matches || e.target.closest("button")) return;
    dragging = true;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    velocity = 0;
    try { handle.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    sheet.style.transition = "none";
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dt = e.timeStamp - lastT;
    // Sample over at least a frame: two events a fraction of a millisecond
    // apart would otherwise read as an enormous flick.
    if (dt >= 8) {
      velocity = (e.clientY - lastY) / dt * 1000; // px/s
      lastY = e.clientY;
      lastT = e.timeStamp;
    }
    const dy = e.clientY - startY;
    const y = dy >= 0 ? dy : -rubberband(-dy, sheet.offsetHeight);
    sheet.style.transform = `translateY(${y}px)`;
  });
  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    const dy = e.clientY - startY;
    if (e.timeStamp - lastT > 100) velocity = 0; // finger came to rest before lifting
    // Same exponential-decay projection scroll views use to pick a landing point.
    const projected = dy + (velocity / 1000) * 0.99 / (1 - 0.99);
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (e.type === "pointerup" && projected > sheet.offsetHeight * 0.4) close();
  };
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);
}

/* ---------------- filter tabs ---------------- */
function applyFilterUI() {
  let activeBtn = null;
  [...filterTabs.children].forEach(btn => {
    const on = btn.dataset.filter === currentFilter;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    if (on) activeBtn = btn;
  });

  if (currentFilter === FILTER_MINE) {
    boardHeading.textContent = "Your orders";
    sQuery.placeholder = "Search your orders…";
  } else if (currentFilter === FILTER_ALL) {
    boardHeading.textContent = "All orders";
    sQuery.placeholder = "Search every app…";
  } else {
    boardHeading.textContent = `${currentFilter} orders`;
    // Searching outlets only means anything on the marketplaces.
    sQuery.placeholder = appNeedsOutlet(currentFilter)
      ? `Search ${currentFilter} outlets…`
      : `Search ${currentFilter} items…`;
  }

  // Five bubbles no longer fit on the narrowest phones, so the strip scrolls.
  // Keep whichever is selected visible, or the tab you just picked can end up
  // off-screen after a deep link switches it for you.
  ensureTabVisible(activeBtn);
  syncFilterStripFade();
}

// scrollIntoView({ inline: "nearest" }) is unreliable inside a padded
// horizontal scroller — it under-scrolls, and can move the page instead of the
// strip. Computing the offset ourselves is deterministic and never touches
// vertical scroll position.
function ensureTabVisible(btn) {
  if (!filterStrip || !btn) return;
  const strip = filterStrip.getBoundingClientRect();
  const tab = btn.getBoundingClientRect();
  const margin = 12; // leave a sliver of the neighbouring bubble showing

  if (tab.right > strip.right - margin) {
    filterStrip.scrollLeft += tab.right - strip.right + margin;
  } else if (tab.left < strip.left + margin) {
    filterStrip.scrollLeft -= (strip.left + margin) - tab.left;
  }
}

// Fades the right edge of the filter row while there's more to scroll to.
function syncFilterStripFade() {
  if (!filterStrip) return;
  const overflow = filterStrip.scrollWidth - filterStrip.clientWidth;
  filterStrip.classList.toggle("is-scrollable", overflow > 4);
  filterStrip.classList.toggle("at-end", filterStrip.scrollLeft >= overflow - 4);
}

filterTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-tab");
  if (!btn) return;
  const clicked = btn.dataset.filter;

  // The three app tabs toggle: tapping the one that's already active clears
  // it and drops you back to All, so narrowing and un-narrowing are the same
  // gesture. "All" and "Mine" aren't narrowing filters, so they just select.
  currentFilter = (isKnownApp(clicked) && clicked === currentFilter)
    ? FILTER_ALL
    : clicked;

  saveFilter(currentFilter);
  // Only an actual app becomes the post form's default — clearing back to All
  // deliberately leaves the last app you used in place.
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
    + `<option value="${OUTLET_OTHER}">Other (type it in)</option>`;
  if (selectedOutlet) sel.value = selectedOutlet;
}

function syncOutletField(app, preferredOutlet) {
  const needs = appNeedsOutlet(app);
  outletField.hidden = !needs;
  hideOutletSuggest();
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
  hideOutletSuggest();
  if (other) fOutletOther.focus();
});

/* Someone typing "Behrooz" into the free-text outlet field, while a
   "Behrouz Biryani" order is already live, would otherwise never club with
   it — canClub() compares outlet spellings, and outletsSimilar() is fuzzy
   there too, but two near-miss spellings drift further apart every time
   someone retypes instead of reusing the existing one. Nudging them toward
   the name that's already on the board keeps everyone converging on one
   spelling instead of accumulating near-duplicates. */
const outletSuggest = document.getElementById("outletSuggest");
const outletSuggestText = document.getElementById("outletSuggestText");
const outletSuggestUse = document.getElementById("outletSuggestUse");
let outletSuggestValue = "";

function hideOutletSuggest() {
  outletSuggest.hidden = true;
  outletSuggestValue = "";
}

// The curated list, plus whatever outlets are actually live on the board
// right now for the selected app — that's who a match would actually club
// with, so it's more useful to suggest than the static list alone.
function knownOutletNames() {
  const fromOrders = latestOrders
    .filter(o => o.app === fApp.value && o.outlet)
    .map(o => o.outlet);
  const seen = new Map();
  [...POPULAR_OUTLETS, ...fromOrders].forEach((name) => {
    const k = outletKey(name);
    if (k && !seen.has(k)) seen.set(k, name);
  });
  return [...seen.values()];
}

function checkOutletSuggest() {
  const typed = fOutletOther.value.trim();
  if (typed.length < OUTLET_FUZZY_MIN_LEN) { hideOutletSuggest(); return; }
  const typedKey = outletKey(typed);
  const match = knownOutletNames().find((name) => outletKey(name) !== typedKey && outletsSimilar(typed, name));
  if (!match) { hideOutletSuggest(); return; }
  outletSuggestValue = match;
  outletSuggestText.textContent = `Another order already names a similar outlet: "${match}". Did you mean that one?`;
  outletSuggest.hidden = false;
}

fOutletOther.addEventListener("input", () => {
  clearTimeout(fOutletOther._suggestTimer);
  fOutletOther._suggestTimer = setTimeout(checkOutletSuggest, 350);
});

outletSuggestUse.addEventListener("click", () => {
  fOutletOther.value = outletSuggestValue;
  hideOutletSuggest();
  fOutletOther.focus();
});

fApp.addEventListener("change", () => syncOutletField(fApp.value));

// Reads whichever of the two controls is actually in play.
function readOutlet() {
  if (!appNeedsOutlet(fApp.value)) return "";
  if (fOutlet.value === OUTLET_OTHER) return fOutletOther.value.trim();
  return fOutlet.value;
}

/* ---------------- post modal ----------------
   Doubles as the edit form. `editingOrderId` is the only thing that
   distinguishes the two modes; it must be cleared on every close, or the next
   "Post an order" would silently overwrite the last order that was edited. */
let editingOrderId = null;
const postModalTitle = document.getElementById("postModalTitle");
const postSubmitBtn = postForm.querySelector('button[type="submit"]');

// "Closes in" is always relative to now. When editing, preselect whichever
// option is closest to the time the order has left, so saving without touching
// it roughly preserves the existing deadline instead of silently resetting it.
function closestExpiryOption(order) {
  if (order && isAllDay(order.expiresAt)) return EXPIRY_ALL_DAY;
  const msLeft = ((order && order.expiresAt) || 0) - Date.now();
  const mins = Math.max(1, Math.round(msLeft / 60000));
  const opts = [...document.getElementById("fExpiry").options]
    .map(o => o.value).filter(v => v !== EXPIRY_ALL_DAY).map(Number);
  return String(opts.reduce((best, v) => Math.abs(v - mins) < Math.abs(best - mins) ? v : best, opts[0]));
}

function openPostModal(order) {
  editingOrderId = order ? order.id : null;

  const fContact = document.getElementById("fContact");
  const fLocation = document.getElementById("fLocation");
  const fCurrent = document.getElementById("fCurrent");
  const fTarget = document.getElementById("fTarget");
  const fExpiry = document.getElementById("fExpiry");
  const contactHint = document.getElementById("contactHint");
  const locationHint = document.getElementById("locationHint");

  postModalTitle.textContent = order ? "Edit your order" : "Post an order";
  if (postSubmitBtn) postSubmitBtn.textContent = order ? "Save changes" : "Post to the board";

  if (order) {
    // Editing: every field comes from the order itself, not from saved defaults.
    // The number lives in a private doc now. Fill from what this device
    // already knows, then correct it from the server if that differs.
    fContact.value = order.contact || knownContacts.get(order.id) || normalizePhone(getSavedContact()) || "";
    getDoc(contactRef(order.id)).then(snap => {
      if (snap.exists() && editingOrderId === order.id) fContact.value = snap.data().contact || fContact.value;
    }).catch(() => { /* offline: the saved number stands */ });
    // Orders posted before pickup points existed carry free text that isn't in
    // the list; leave the placeholder showing rather than silently reassigning
    // them to whichever option happens to be first.
    fLocation.value = isKnownPickup(order.location) ? order.location : "";
    fCurrent.value = order.current || "";
    fTarget.value = order.target || "";
    fExpiry.value = closestExpiryOption(order);
    contactHint.hidden = true;
    locationHint.hidden = true;

    fApp.value = isKnownApp(order.app) ? order.app : DEFAULT_APP;
    hidePostingToChip();               // let them move it between apps
    syncOutletField(fApp.value, order.outlet);
    openModal(postModalBackdrop);
    return;
  }

  if (!fContact.value) {
    const saved = normalizePhone(getSavedContact()); // skip pre-numbers junk
    if (saved) { fContact.value = saved; contactHint.hidden = false; }
  }
  if (!fLocation.value) {
    const saved = getSavedLocation();
    if (isKnownPickup(saved)) { fLocation.value = saved; locationHint.hidden = false; }
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

function closePostModal() {
  closeModal(postModalBackdrop);
  editingOrderId = null;
  hideOutletSuggest();
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

openPostModalBtn.addEventListener("click", () => openPostModal(null));
postingToChange.addEventListener("click", () => {
  hidePostingToChip();
  fApp.focus();
});

// hide the "remembered" hints as soon as they start editing them
document.getElementById("fContact").addEventListener("input", () => {
  document.getElementById("contactHint").hidden = true;
});
document.getElementById("fLocation").addEventListener("change", () => {
  document.getElementById("locationHint").hidden = true;
});
closePostModalBtn.addEventListener("click", closePostModal);
postModalBackdrop.addEventListener("click", (e) => {
  if (e.target === postModalBackdrop) closePostModal();
});

closeMatchModalBtn.addEventListener("click", () => closeModal(matchModalBackdrop));
dismissMatchesBtn.addEventListener("click", () => closeModal(matchModalBackdrop));
matchModalBackdrop.addEventListener("click", (e) => {
  if (e.target === matchModalBackdrop) closeModal(matchModalBackdrop);
});

enableSheetDrag(postModalBackdrop, closePostModal);
enableSheetDrag(matchModalBackdrop, () => closeModal(matchModalBackdrop));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (matchModalBackdrop.classList.contains("open")) closeModal(matchModalBackdrop);
  else if (postModalBackdrop.classList.contains("open")) closePostModal();
});

/* ---------------- post order ---------------- */
postForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const appVal = fApp.value;
  if (!isKnownApp(appVal)) { toast("Pick an app"); return; }

  const outlet = readOutlet();
  if (appNeedsOutlet(appVal) && !outlet) {
    showFieldError(fOutletOther.hidden ? fOutlet : fOutletOther, "Pick an outlet or type it in");
    return;
  }

  const currentInput = document.getElementById("fCurrent");
  const current = Number(currentInput.value);
  if (!current || current <= 0) {
    showFieldError(currentInput, "Enter your cart value. It's what finds your matches");
    return;
  }

  // Every field is checked here rather than by the browser — the form is
  // novalidate, because a `required` control inside a hidden container blocks
  // native submission silently. See the comment on the form in index.html.
  const targetInput = document.getElementById("fTarget");
  const target = Number(targetInput.value);
  if (!target || target <= 0) {
    showFieldError(targetInput, "How much ₹ more do you need?");
    return;
  }

  const locationInput = document.getElementById("fLocation");
  if (!locationInput.value.trim()) {
    showFieldError(locationInput, "Pick a drop location");
    return;
  }

  const expiresAt = expiryToTimestamp(document.getElementById("fExpiry").value);

  const contactInput = document.getElementById("fContact");
  const contact = normalizePhone(contactInput.value);
  if (!contact) {
    // Covers both wrong-format and right-shape-but-fake (e.g. 9999999999):
    // "real" reads correctly for the junk case, where "10-digit" wouldn't.
    showFieldError(contactInput, "Enter a real 10-digit mobile number");
    return;
  }

  const location = document.getElementById("fLocation").value.trim();
  const expiryVal = document.getElementById("fExpiry").value;

  // No contact in here: every student can read every order, so the number
  // goes in its own doc that only people who tap "I'm in" can read.
  const payload = {
    app: appVal,
    outlet,
    current,
    target,
    location,
    posterId: myId,
    posterName: getMyName(),
    posterEmail: myEmail,
    expiresAt
  };

  const isEdit = !!editingOrderId;

  try {
    // Deliberately NOT awaited.
    //
    // Firestore applies the write to its local cache immediately and only
    // settles this promise once the server acknowledges it. Awaiting that ack
    // before closing the modal is what made "Post" look broken on a phone: the
    // order was saved and already on the board, but the UI sat there waiting
    // for a round trip that can take a very long time on a weak connection.
    // One batch, so an order can never land without its number or vice versa.
    const orderRef = isEdit ? doc(db, ORDERS_COL, editingOrderId) : doc(collection(db, ORDERS_COL));
    const batch = writeBatch(db);
    if (isEdit) {
      // createdAt is left alone — editing shouldn't jump the order back to
      // the top of the board. deleteField strips the number off orders that
      // were posted before it moved out of the order document.
      batch.update(orderRef, { ...payload, contact: deleteField() });
    } else {
      batch.set(orderRef, { ...payload, createdAt: serverTimestamp() });
    }
    batch.set(contactRef(orderRef.id), { contact });
    knownContacts.set(orderRef.id, contact);

    batch.commit().catch((err) => {
      toast(`Couldn't save: ${describeWriteError(err)}`, 4000);
    });

    saveContact(contact);
    saveLocation(location);
    saveApp(appVal);
    saveExpiry(expiryVal);
    if (outlet) saveOutlet(outlet);
    postForm.reset();
    document.getElementById("contactHint").hidden = true;
    document.getElementById("locationHint").hidden = true;
    closePostModal();
    toast(isEdit ? "Order updated" : "Posted to the board");
    // Editing can change your cart value, which changes who matches you.
    showMatchesFor(payload);
  } catch (err) {
    console.error(err);
    toast("Couldn't post. Check your Firebase setup");
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
      `Posted to ${where}. Nobody matches your ₹${order.current} cart yet, but you'll show up on their board, ` +
      `so sit tight or check back in a few minutes.`;
    matchList.innerHTML = `<p class="match-empty">No matches right now.</p>`;
  } else {
    const mutual = matches.filter(m => isMutualMatch(order, m)).length;
    matchIntro.textContent =
      `Posted to ${where}. ${matches.length} ${matches.length === 1 ? "person" : "people"} ` +
      `can club with your ₹${order.current} cart` +
      (mutual ? `, ${mutual} where you both cross the line.` : ".");
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
          Needs ₹${Number(m.target) || 0} · cart ₹${Number(m.current) || 0} · ${label} · ${escapeHtml(m.location || "")}
        </div>
      </div>
      <button type="button" class="btn btn-tinted match-cta" data-reveal="${escapeHtml(m.id)}">I’m in</button>
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
      const contact = await joinAndGetContact(order);
      if (!btn.isConnected) return; // the list was rebuilt while we waited
      if (!contact) {
        btn.disabled = false;
        btn.textContent = "I’m in";
        return;
      }
      const row = btn.closest(".match-row");
      btn.remove();
      const slot = document.createElement("div");
      slot.className = "contact-slot";
      slot.style.width = "100%";
      revealContactInto(slot, order, contact);
      row.appendChild(slot);
    });
  });
}

/* ---------------- realtime listener ---------------- */
let unsubscribeOrders = null;

let listenerRetry = 0;

function startOrdersListener() {
  if (unsubscribeOrders) return; // already listening
  // limit() is a safety valve, not a feature: without it a flood of junk
  // orders makes every client download the entire collection on every
  // reconnect, which can exhaust the free daily read quota and take the
  // board down for everyone.
  const q = query(collection(db, ORDERS_COL), orderBy("createdAt", "desc"), limit(200));

  unsubscribeOrders = onSnapshot(q, (snap) => {
    listenerRetry = 0; // a delivered snapshot means the stream is healthy
    latestOrders = [];
    snap.forEach(d => latestOrders.push({ id: d.id, ...d.data() }));
    // A throw in here would propagate out of the snapshot callback and can
    // take the subscription with it — one malformed doc would then freeze
    // the board until a manual refresh. Contain it.
    try {
      // Resolve any followed link now that we actually have the board — this
      // can switch tabs and clear filters, so it must run before render().
      maybeConsumeDeepLink();
      render();
    } catch (err) {
      console.error("[orderknot] render failed:", err);
    }
  }, (err) => {
    console.error("[orderknot] orders listener error:", err);

    // Drop the dead subscription so the next attempt opens a fresh stream.
    detachOrdersListener();

    // Streams drop routinely — phone sleeps, wifi switches, tab is frozen.
    // Reconnect with backoff instead of leaving a permanently stale board.
    listenerRetry = Math.min(listenerRetry + 1, 6);
    const wait = Math.min(1000 * 2 ** (listenerRetry - 1), 30000);
    console.log(`[orderknot] reconnecting orders listener in ${wait}ms`);
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
  stopJoinListeners();
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
  console.log("[orderknot] resuming live updates:", reason);
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
  // "till midnight" reads better than a 13-hour countdown.
  if (isAllDay(expiresAt)) return { label: "till midnight", urgent: false };
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return { label: `${mins}m left`, urgent: mins <= 10 };
  const hrs = Math.floor(mins / 60);
  return { label: `${hrs}h ${mins % 60}m left`, urgent: false };
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
  const joined = isMine ? (joinsByOrder.get(o.id) || []) : [];

  // The outlet is the headline when there is one (the mark already says which
  // app); otherwise the app name is.
  const title = o.outlet || o.app;
  const sub = [
    o.outlet ? o.app : "",
    isMine ? "You" : (o.posterName || "someone")
  ].filter(Boolean).map(escapeHtml).join(" · ");
  const where = [o.location, current > 0 ? `cart ₹${current}` : ""].filter(Boolean).map(escapeHtml).join(" · ");

  return `
      <div class="card-main">
        <span class="app-dot app-dot-lg" data-app="${escapeHtml(o.app)}" aria-hidden="true">${appIconHTML(o.app)}</span>
        <div class="card-text">
          <div class="card-title">${escapeHtml(title)}</div>
          <div class="card-sub">${sub}</div>
        </div>
        <div class="card-amount">
          <span class="amount-value">₹${needed}</span>
          <span class="amount-caption">${isGoodMatch ? "fits your cart" : "needed"}</span>
        </div>
      </div>
      ${o.items ? `<p class="card-items">${escapeHtml(o.items)}</p>` : ""}
      <div class="card-meta">
        <span class="card-loc">${ICON_PIN}<span>${where}</span></span>
        <span class="card-timer ${urgent ? "urgent" : ""}">${label}</span>
      </div>
      ${joined.length ? `
      <p class="card-joins"><b>${joined.length} ${joined.length === 1 ? "person is" : "people are"} in</b> · ${joined.map(escapeHtml).join(", ")}</p>` : ""}
      <div class="card-actions">
        ${isMine
      ? `<button class="btn btn-tinted" data-filled="${escapeHtml(o.id)}">Found someone</button>
           <button class="btn-ghost btn-icon" data-share="${escapeHtml(o.id)}" aria-label="Share">${ICON_SHARE}</button>
         </div>
         <div class="card-actions card-actions-minor">
           <button class="btn-ghost" data-edit="${escapeHtml(o.id)}">Edit</button>
           <button class="btn-ghost" data-extend="${escapeHtml(o.id)}">+15 min</button>
           <button class="btn-ghost btn-danger" data-remove="${escapeHtml(o.id)}">Remove</button>`
      : `<button class="btn btn-tinted" data-join="${escapeHtml(o.id)}">I’m in</button>
           <button class="btn-ghost btn-icon" data-share="${escapeHtml(o.id)}" aria-label="Share">${ICON_SHARE}</button>`
    }
      </div>
      <div class="contact-slot"></div>
      ${matches.length ? `
      <details class="card-matches">
        <summary>${matches.length} ${matches.length === 1 ? "match" : "matches"} for your order</summary>
        <div class="match-list">${matches.map(m => matchRowHTML(m, o)).join("")}</div>
      </details>` : ""}
  `;
}

const contactRef = (orderId) => doc(db, ORDERS_COL, orderId, "private", "contact");

// Numbers this device has legitimately seen: your own orders' and the ones
// you've tapped "I'm in" on. A card's HTML is rebuilt whenever its countdown
// label changes, and this is what puts a revealed number back afterwards.
const knownContacts = new Map();

async function recordJoin(o) {
  // The join doc does two jobs: it's what lets this person read the number
  // (see firestore.rules), and it's what the poster's card counts.
  try {
    await setDoc(doc(db, ORDERS_COL, o.id, "joins", myId), {
      joinerId: myId,
      joinerName: getMyName(),
      joinerEmail: myEmail,
      joinedAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error("[orderknot] couldn't record join:", (err && err.code) || err);
  }
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
]);

// Opts in, then fetches the poster's number. Unlike everything else on the
// board this genuinely needs the server: the number isn't in the order any
// more, and the rules only release it once the join has landed.
async function joinAndGetContact(o) {
  if (knownContacts.has(o.id)) return knownContacts.get(o.id);
  let contact = null;
  if (o.contact) {
    // Posted before numbers moved out of the order document.
    contact = o.contact;
    recordJoin(o);
  } else {
    try {
      await withTimeout(recordJoin(o), 10000);
      const snap = await withTimeout(getDoc(contactRef(o.id)), 10000);
      contact = snap.exists() ? snap.data().contact : null;
    } catch (err) {
      console.error("[orderknot] couldn't fetch contact:", (err && err.code) || err);
    }
  }
  if (!contact) {
    toast("Couldn't get the number. Check your connection and try again", 4000);
    return null;
  }
  knownContacts.set(o.id, contact);
  return contact;
}

function revealContactInto(slot, o, contact) {
  const waDigits = extractWhatsAppDigits(contact);
  let html = `<div class="contact-reveal"><span>Reach out</span><b>${escapeHtml(contact)}</b></div>`;
  if (waDigits) {
    html += `<a class="btn btn-primary btn-block wa-link" href="${buildWhatsAppLink(waDigits, o)}" target="_blank" rel="noopener">Message on WhatsApp</a>`;
  }
  slot.innerHTML = html;
}

// Removes an order together with its private number.
function deleteOrder(o) {
  const batch = writeBatch(db);
  batch.delete(contactRef(o.id));
  batch.delete(doc(db, ORDERS_COL, o.id));
  return batch.commit();
}

function wireCardEvents(el, o, pool) {
  const joinBtn = el.querySelector("[data-join]");
  if (joinBtn && knownContacts.has(o.id)) {
    const slot = el.querySelector(".contact-slot");
    slot.classList.add("no-anim"); // restoring, not revealing — don't replay the entrance
    revealContactInto(slot, o, knownContacts.get(o.id));
    joinBtn.disabled = true;
    joinBtn.textContent = "Contact revealed";
  } else if (joinBtn) {
    joinBtn.addEventListener("click", async () => {
      joinBtn.disabled = true;
      joinBtn.textContent = "Getting number…";
      const contact = await joinAndGetContact(o);
      // The card may have been rebuilt while that was in flight (its
      // countdown ticked over), so act on whatever is on the board NOW.
      const card = board.querySelector(`[data-order-id="${CSS.escape(o.id)}"]`);
      const btn = card && card.querySelector("[data-join]");
      if (!btn) return;
      if (!contact) {
        btn.disabled = false;
        btn.textContent = "I’m in";
        return;
      }
      revealContactInto(card.querySelector(".contact-slot"), o, contact);
      btn.disabled = true;
      btn.textContent = "Contact revealed";
    });
  }
  const closeOrder = (failMsg) => deleteOrder(o).catch((err) => toast(`${failMsg}: ${describeWriteError(err)}`, 4000));
  const removeBtn = el.querySelector("[data-remove]");
  if (removeBtn) removeBtn.addEventListener("click", () => closeOrder("Couldn't remove"));

  // Same effect as Remove, different meaning: this is the happy ending, and
  // it's the button people should reach for so a clubbed order stops
  // collecting messages.
  const filledBtn = el.querySelector("[data-filled]");
  if (filledBtn) {
    filledBtn.addEventListener("click", () => {
      closeOrder("Couldn't close it");
      toast("Closed. Enjoy the order");
    });
  }

  const shareBtn = el.querySelector("[data-share]");
  if (shareBtn) {
    shareBtn.addEventListener("click", () => shareOrder(o));
  }

  const editBtn = el.querySelector("[data-edit]");
  if (editBtn) {
    editBtn.addEventListener("click", () => openPostModal(o));
  }

  const extendBtn = el.querySelector("[data-extend]");
  if (extendBtn) {
    extendBtn.addEventListener("click", async () => {
      // Extend from whichever is later: the current deadline, or now. An order
      // that already lapsed should get a real 15 minutes, not 15 minutes from
      // a timestamp in the past.
      const base = Math.max(Number(o.expiresAt) || 0, Date.now());
      const next = base + EXTEND_BY_MS;
      if (next - Date.now() > MAX_REMAINING_MS) {
        toast("Can't extend beyond 24 hours out");
        return;
      }
      // Not awaited — the local cache updates immediately and the board
      // re-renders from it; waiting on the server ack would leave the button
      // disabled for however long the phone's connection takes.
      updateDoc(doc(db, ORDERS_COL, o.id), { expiresAt: next }).catch((err) => {
        toast(`Couldn't extend: ${describeWriteError(err)}`, 4000);
      });
      toast("Extended by 15 min");
    });
  }
  // only present on your own cards — see cardInnerHTML
  const nested = el.querySelector(".card-matches .match-list");
  if (nested) wireMatchRows(nested, matchesFor(o, pool));
}

/* ---------------- who's in on my orders ----------------
   The poster used to learn nothing until a WhatsApp message arrived. Each of
   your own live orders gets a listener on its joins, which drives the count
   on the card and a toast when someone new opts in. */
const joinsByOrder = new Map();   // orderId -> [names]
const joinListeners = new Map();  // orderId -> unsubscribe

function syncJoinListeners(active) {
  const mine = new Set(active.filter(o => o.posterId === myId).map(o => o.id));
  for (const [id, unsub] of joinListeners) {
    if (mine.has(id)) continue;
    try { unsub(); } catch { /* already torn down */ }
    joinListeners.delete(id);
    joinsByOrder.delete(id);
  }
  mine.forEach(id => {
    if (joinListeners.has(id)) return;
    let first = true;
    const unsub = onSnapshot(collection(db, ORDERS_COL, id, "joins"), (snap) => {
      const names = [];
      snap.forEach(d => {
        const j = d.data();
        if (j.joinerId !== myId) names.push(j.joinerName || "Someone");
      });
      const before = joinsByOrder.get(id) || [];
      joinsByOrder.set(id, names);
      // Not on the first snapshot: that's history, not news.
      if (!first && names.length > before.length) {
        const fresh = names.find(n => !before.includes(n)) || names[names.length - 1];
        toast(`${fresh} is in on your order`, 3500);
      }
      first = false;
      try { render(); } catch (err) { console.error("[orderknot] render failed:", err); }
    }, (err) => {
      console.error("[orderknot] joins listener error:", (err && err.code) || err);
      joinListeners.delete(id); // let the next render try again
    });
    joinListeners.set(id, unsub);
  });
}

function stopJoinListeners() {
  for (const unsub of joinListeners.values()) { try { unsub(); } catch { /* ignore */ } }
  joinListeners.clear();
  joinsByOrder.clear();
}

function render() {
  const now = Date.now();
  const active = latestOrders.filter(o => (o.expiresAt || 0) > now);

  // lazy-clean expired ones (best effort, ignore failures)
  latestOrders.filter(o => (o.expiresAt || 0) <= now).forEach(o => {
    (o.posterId === myId ? deleteOrder(o) : deleteDoc(doc(db, ORDERS_COL, o.id))).catch(() => { });
  });

  syncJoinListeners(active);

  // Matching always runs against every live order, not just the visible ones —
  // filtering the board shouldn't change who can actually club together.
  const pool = active;

  let visible =
    currentFilter === FILTER_MINE ? active.filter(o => o.posterId === myId) :
    currentFilter === FILTER_ALL ? active :
    active.filter(o => o.app === currentFilter);

  // ---- search + filters ----
  const myValueRaw = sMyValue.value;
  const myValue = myValueRaw === "" ? null : Number(myValueRaw);
  const maxTimeMin = Number(sMaxTime.value);
  const q = sQuery.value.trim().toLowerCase();

  searchBar.classList.toggle("has-query", q.length > 0);
  syncFilterDot();

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
  // Exact match on the canonical drop point. Orders posted before pickup
  // points existed carry free text and simply won't match, which is correct:
  // we can't know where "Block C, Room 214" hands over.
  if (sLocation.value) {
    visible = visible.filter(o => o.location === sLocation.value);
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

  // ---- FLIP: capture where every current card sits BEFORE touching the DOM.
  // Sorting or switching filters used to just teleport cards to their new
  // slot — correct, but visually dead. Recording each one's rect here means
  // that once the reorder below has happened, we can measure how far it
  // actually moved and animate that distance instead. ----
  const firstRects = new Map();
  [...board.children].forEach(el => {
    if (el.dataset.orderId) firstRects.set(el.dataset.orderId, el.getBoundingClientRect());
  });

  // ---- keyed reconciliation: update/move existing cards in place,
  // only create+animate cards that are genuinely new. This is what
  // stops the whole board flashing on every snapshot / 30s tick. ----
  const stillPresent = new Set();
  let prevEl = null;

  visible.forEach(o => {
    const html = cardInnerHTML(o, myValue, pool);
    const isGoodMatch = myValue !== null && (Number(o.target) || 0) <= myValue;
    const wantedClass = "card" + (isGoodMatch ? " matched" : "");

    let el = board.querySelector(`[data-order-id="${CSS.escape(o.id)}"]`);

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

  // ---- FLIP, continued: invert + play. For every card that already existed
  // and actually changed position, jump it back to where it used to be with
  // no transition, then release it on the next frame — the browser animates
  // the difference, so it reads as the card sliding to its new spot rather
  // than reappearing there. Only `transform` is touched, so this is
  // compositor work, not layout thrash; freshly-created cards are skipped,
  // since .card-enter already gives them their own entrance. ----
  board.querySelectorAll(".card:not(.card-enter)").forEach(el => {
    const id = el.dataset.orderId;
    const first = firstRects.get(id);
    if (!first) return; // wasn't on the board a moment ago — nothing to animate from
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return; // didn't move

    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.getBoundingClientRect(); // force layout so the browser commits the starting position
    requestAnimationFrame(() => {
      el.style.transition = "transform 0.42s cubic-bezier(0.32, 0.72, 0, 1)";
      el.style.transform = "";
      el.addEventListener("transitionend", () => { el.style.transition = ""; }, { once: true });
    });
  });

  // Someone followed a shared link — take them to the card and mark it, so it
  // is obvious which of several orders they were sent to.
  if (highlightAfterRender) {
    const el = board.querySelector(`[data-order-id="${CSS.escape(highlightAfterRender)}"]`);
    highlightAfterRender = null;
    if (el) {
      el.classList.add("card-highlight");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => el.classList.remove("card-highlight"), 2600);
    }
  }
}

/* Single source of truth for "is this a usable number?".
   Accepts what people actually type — "+91 98765 43210", "098765 43210",
   "98765-43210" — and reduces it to the bare 10 digits we store. Returns null
   for anything that isn't a valid Indian mobile, which is what the form and
   the WhatsApp link both gate on. */
// Rejects numbers that are the right SHAPE but obviously not real — the lazy
// fakes someone types to get past a required field (9999999999, 6767676767,
// 9876543210). There's no math that proves an Indian mobile is real (they
// carry no check digit, unlike cards/GST), and libphonenumber wouldn't catch
// these either — they're valid, allocated-range numbers, just patterned. So
// this is an explicit heuristic blocklist, not validation. It can in theory
// reject a genuine number that happens to look this regular; that's a rare,
// accepted trade for stopping the common junk.
function isJunkNumber(ten) {
  if (/^(\d)\1{9}$/.test(ten)) return true;      // all identical: 9999999999
  if (/^(\d\d)\1{4}$/.test(ten)) return true;    // repeated 2-digit block: 6767676767
  if (/^(\d{5})\1$/.test(ten)) return true;      // repeated 5-digit block: 9876598765
  // strictly sequential run, each digit ±1 from the previous: 9876543210
  let asc = true, desc = true;
  for (let i = 1; i < ten.length; i++) {
    const step = ten.charCodeAt(i) - ten.charCodeAt(i - 1);
    if (step !== 1) asc = false;
    if (step !== -1) desc = false;
  }
  return asc || desc;
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  let ten = digits;
  if (digits.length === 12 && digits.startsWith("91")) ten = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith("091")) ten = digits.slice(3);
  else if (digits.length === 11 && digits.startsWith("0")) ten = digits.slice(1);
  // Indian mobile numbers are 10 digits starting 6-9. Landlines and short
  // codes won't work on WhatsApp, so they're rejected too.
  if (!/^[6-9]\d{9}$/.test(ten)) return null;
  // Right shape, but a transparent fake — treat it as no number at all.
  if (isJunkNumber(ten)) return null;
  return ten;
}

function extractWhatsAppDigits(contact) {
  const ten = normalizePhone(contact);
  return ten ? "91" + ten : null;
}

function buildWhatsAppLink(digits, o) {
  const where = o.outlet ? `${o.app} (${o.outlet})` : o.app;
  const msg = `Hey! Saw your OrderKnot post for ${where}. ₹${o.target} more needed. I'm in, let's club the order!`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

/* ---------------- add to home screen ----------------
   Offered from the second visit: the first is for finding out what this is.
   Android/Chrome hands us an install prompt to trigger; iOS Safari has no
   API for it at all, so the hint explains the two taps instead. */
const VISITS_KEY = "orderknot_visits";
const INSTALL_DISMISSED_KEY = "orderknot_install_dismissed";
const installHint = document.getElementById("installHint");
const installBtn = document.getElementById("installBtn");
const installHintSub = document.getElementById("installHintSub");
let deferredInstall = null;

function countVisit() {
  try {
    if (sessionStorage.getItem(VISITS_KEY)) return; // once per session, not per reload
    sessionStorage.setItem(VISITS_KEY, "1");
    localStorage.setItem(VISITS_KEY, String((Number(localStorage.getItem(VISITS_KEY)) || 0) + 1));
  } catch { /* storage blocked */ }
}

function syncInstallHint() {
  let visits = 0, dismissed = false;
  try {
    visits = Number(localStorage.getItem(VISITS_KEY)) || 0;
    dismissed = !!localStorage.getItem(INSTALL_DISMISSED_KEY);
  } catch { /* storage blocked */ }
  const installed = navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

  let show = !installed && !dismissed && visits >= 2;
  if (show && deferredInstall) {
    installBtn.hidden = false;
    installHintSub.textContent = "Opens like an app, one tap from anywhere.";
  } else if (show && IS_IOS && !isInAppBrowser()) {
    installBtn.hidden = true;
    installHintSub.textContent = "Tap the Share button, then “Add to Home Screen”.";
  } else {
    show = false; // no way to install from this browser — don't advertise one
  }
  installHint.hidden = !show;
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // hold it for our own button instead of the browser's mini-bar
  deferredInstall = e;
  syncInstallHint();
});
window.addEventListener("appinstalled", () => { deferredInstall = null; syncInstallHint(); });
installBtn.addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch { /* ignore */ }
  deferredInstall = null; // a prompt can only be used once
  syncInstallHint();
});
document.getElementById("installDismiss").addEventListener("click", () => {
  try { localStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch { /* storage blocked */ }
  installHint.hidden = true;
});
countVisit();

/* The top bar's hairline only shows once the board is scrolled under it. */
const topbar = document.getElementById("topbar");
const syncTopbar = () => topbar.classList.toggle("scrolled", window.scrollY > 4);
window.addEventListener("scroll", syncTopbar, { passive: true });
syncTopbar();

/* tick every 30s so countdown labels + expiry cleanup stay fresh */
setInterval(render, 30000);

/* ---------------- init ---------------- */
paintAppIcons();   // upgrade the filter bubbles' letter fallbacks to real logos
populatePickupSelect(document.getElementById("fLocation"));
populatePickupSelect(sLocation, "any location");

if (filterStrip) {
  filterStrip.addEventListener("scroll", syncFilterStripFade, { passive: true });
  window.addEventListener("resize", syncFilterStripFade);
  // Bubble widths change once the web font swaps in.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncFilterStripFade);
  syncFilterStripFade();
}

/* ---------------- auth observer ----------------
   Registered LAST, deliberately. Everything below the sign-in handler —
   currentFilter, the DOM refs, applyFilterUI, startOrdersListener — has to be
   initialized before this can fire, or the callback hits the temporal dead
   zone. Firebase swallows whatever the observer throws, so getting this
   order wrong fails silently. */
console.log("[orderknot] module loaded, registering auth observer");
onAuthStateChanged(auth, (user) => {
  console.log("[orderknot] auth state changed:", user ? user.email : "null");
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
      // Land on whatever tab they left on. New users start on "All" — a board
      // that shows everything is a better first impression than one filtered
      // to a single app that may well be empty.
      currentFilter = isValidFilter(getSavedFilter()) ? getSavedFilter() : FILTER_ALL;
      applyFilterUI();
      syncInstallHint();
      startOrdersListener(); // only read once we have a valid, verified auth token
    } else {
      if (user) {
        // signed in but wrong domain — kick them out
        signOut(auth);
        showLoginNote(`Only @${ALLOWED_DOMAIN} accounts can use OrderKnot.`, true);
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
