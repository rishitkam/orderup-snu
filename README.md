# OrderUp — order-splitting board for your college

A tiny site where students post "I need ₹X more for free delivery" and others
jump in. Live, shared, free to host, and installable as an app on phones.

## What's in this folder

```
index.html          the whole page
style.css            all styling
app.js                board logic (posting, live updates, join, expiry)
firebase-config.js    ← you edit this with your own free Firebase keys
manifest.json + sw.js + icon-*.png   makes it installable as an "app" (PWA)
firestore.rules       security rules for the database
```

## Step 1 — Create a free Firebase project (5 min)

1. Go to https://console.firebase.google.com and sign in with any Google account.
2. Click **Add project**, name it something like `orderup-college`, and finish the wizard (you can skip Google Analytics).
3. In the left sidebar: **Build → Firestore Database → Create database**.
   Pick a region close to India, start in **test mode** for now.
4. In the left sidebar: **Build → Firestore Database → Rules** tab. Paste in the contents of `firestore.rules` from this folder, then **Publish**.
5. Click the gear icon (top-left) → **Project settings**. Scroll to "Your apps" → click the **</> (web)** icon → register an app (any nickname). It'll show you a `firebaseConfig` object.
6. Copy those values into `firebase-config.js` in this folder, replacing the placeholder text.

That's it for the backend — no server to run, no credit card needed.

## Step 2 — Turn on college-only login (5 min)

This site uses **Google Sign-In**, restricted to `@snu.edu.in` accounts.

1. In the Firebase console: **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Google**. Pick a support email when prompted (any email on the project works).
3. Still on that Authentication page, go to **Settings → Authorized domains** and add the domain you'll actually host this on (e.g. `orderup-college.web.app`, or your Netlify/Vercel URL). `localhost` is already allowed by default for testing.
4. That's it — `firebase-config.js` already has `ALLOWED_DOMAIN = "snu.edu.in"` set. Change that one line if your college's domain is different.

How it works for students: they tap "Continue with Google" → pick their `@snu.edu.in` account → they're in, and stay signed in on that device/browser until they hit "sign out." The `firestore.rules` file also blocks access at the database level for anyone without a verified `@snu.edu.in` login, so this isn't just a UI checkbox.

**Sign-in uses a popup on every device**, with a full-page redirect kept only as a fallback for when a popup genuinely can't open (popup blocker, or an installed PWA that forbids new windows).

This is deliberate, and it's the opposite of what this file used to say. `signInWithRedirect` passes the credential back through `sessionStorage`, and iOS clears or partitions that across the round trip to Google — Firebase surfaces it as *"missing initial state ... signInWithRedirect in a storage-partitioned browser environment"*. The visible symptom was iPhone users being bounced straight back to the login screen with no error at all, since `getRedirectResult()` resolves `null` in that case instead of throwing. A popup returns the credential over `postMessage` and never touches that storage, which is why desktop Safari — the same WebKit engine as an iPhone — worked the whole time.

Leave `authDomain` in `firebase-config.js` on the `firebaseapp.com` value Firebase generated. Pointing it at the domain you actually serve from only helps `signInWithRedirect`, and it makes Google reject every sign-in with `Error 400: redirect_uri_mismatch` unless you *also* add `https://<that-domain>/__/auth/handler` to the Authorized redirect URIs on the OAuth client in Google Cloud Console. Popups don't need it. Both sign-in paths land on the same `onAuthStateChanged` logic, so the board appears the moment sign-in completes — no manual refresh.

If sign-in ever fails, the login screen now shows a "Sign-in details" block with the origin, same-origin check, storage probe, and error code — screenshot-able by whoever hit the problem.

**Important caveat**: Google Sign-In needs the student's `@snu.edu.in` address to actually *be* a Google account (a Google Workspace domain, or at minimum a personal Gmail-style account registered under that address). If SNU's student email runs on Microsoft 365 instead, students won't be able to sign in with it via Google — let me know if that's the case and I'll swap this back to Microsoft or to passwordless email-link sign-in, both of which work regardless of what email provider the college uses.

## Step 3 — Test it locally

Any static file server works. Easiest, from this folder:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000 — post an order, then open the same URL in another tab to confirm it shows up live.

## Step 4 — Host it for free, forever

Firebase Hosting itself works great and is already tied to your project:

```bash
npm install -g firebase-tools
firebase login
firebase init hosting     # pick your project, public dir = current folder, single-page app = No
firebase deploy
```

You'll get a URL like `https://orderup-college.web.app` — share that with your college.

(Netlify or Vercel free tiers work identically well if you'd rather use those — just drag-and-drop this folder in their dashboard.)

**On "hosted forever":** no free platform legally promises literal eternity, but Firebase's free Spark plan has no expiry date — it just has generous usage caps (50K reads + 20K writes/day) you won't come close to at college scale. If it ever gets big enough to hit those caps, that's a nice problem — the paid tier is pennies per month at that point.

## Step 5 — "The app"

You don't need the Play Store or App Store for this. Because `manifest.json` + `sw.js` are already wired in:

- On Android (Chrome): visiting the site shows an **"Install app"** prompt, or students can tap ⋮ → **Add to Home screen**.
- On iPhone (Safari): Share button → **Add to Home Screen**.

Once installed it opens full-screen with its own icon, no browser bar — feels like a real app, and it's the exact same code, so there's nothing extra to maintain.

## Notes on the design choices

- **Google Sign-In, no password** — one tap, and Firebase gives us the student's real name for free (`displayName`). `firestore.rules` enforces the `@snu.edu.in` domain check server-side too, not just in the UI.
- **The board updates in place, not by rebuilding itself** — every live update only touches the cards that actually changed, so posting or the board refreshing doesn't cause the whole page to flash.
- **Contact info is only revealed when someone taps "I'm in"** — keeps casual browsers from seeing everyone's WhatsApp number.
- **Orders auto-expire** — set by the poster (15 min to 2 hrs), so the board never fills with stale posts.
- **Anyone can delete their own post; anyone can delete an expired post** — simplest possible moderation model for a first version. If abuse becomes a problem, add real auth and restrict deletes to `posterId == auth.uid`.

## Reasonable next steps (not built yet, easy to add later)

- Push notifications when someone joins your order
- Per-hostel filtering if your college has multiple

Feel free to ask me to add any of these once the base version is live.
