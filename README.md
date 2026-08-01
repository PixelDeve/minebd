# MineBD


## Latest: Ads, Creators & Monetization (dev)

- **Ads**: owner can create, delete, and target ads to a specific tab or all tabs. Multiple ads rotate through every list as you scroll (not just one slot). Impressions are recorded for owner analytics.
- **Language**: EN / বাংলা toggle lives on the **Profile** tab (removed from the header).
- **Creators** tab: post YouTube / Facebook / Instagram / Twitch links; cards show thumbnail + title preview. Follow a post to get notified when that creator posts again.
- **Monetization (development mode)**: only the owner can enable monetization on a member. Monetized public profiles show an ad + estimated payout tiers (৳100–500 at 100k views). Owner dashboard lists most-active members, most-followed creators, and daily active users.
- **Verification**: contact can be phone, email, or Discord.
- Owner bootstrap help text was removed from the profile UI.

**Redeploy Firestore rules** after pulling this update:
```bash
firebase deploy --only firestore:rules
```


A community hub for Bangladeshi Minecrafters — server list, events, best
player leaderboard, reports, plugin/mod/texture/world marketplace, and
hire-a-developer — built with React + Vite, Firebase (Auth + Firestore),
and Uploadcare for compressed image hosting.

Live at **https://minebd.pages.dev/** (Cloudflare Pages).

## ⚠️ Read this before anything else: redeploy your Firestore rules

`firestore.rules` in this project **only changes what actually happens
once you run:**
```bash
firebase deploy --only firestore:rules
```
Editing the file, or even downloading a new version of this project, does
**not** update your live database by itself — Firebase keeps enforcing
whatever rules were last deployed. If admin/owner actions don't work, a
brand-new signed-in user never shows up under `users` in the Firestore
console, or renaming your account silently fails, **this is almost always
the cause**: an older or default-deny rules file is still the one actually
running. Deploy the command above (from this project folder, after
`firebase login`) and try again.

## Run it locally

```bash
npm install
npm run dev
```
Opens at `http://localhost:5173`. Sign in with Google to test posting,
voting, and reviewing.

## Build + deploy to Firebase Hosting (free tier)

```bash
npm install -g firebase-tools   # once
firebase login                  # once
npm run build
firebase deploy
```
This deploys both the built site (`dist/`) and the Firestore rules
(`firestore.rules`) to the `m1nebd` project. **If you're hosting elsewhere
(Cloudflare Pages, Vercel, etc.), that command never runs** — in that case
deploy rules on their own with `firebase deploy --only firestore:rules`
any time `firestore.rules` changes, separately from however you deploy the
site itself.

## What's already wired up

- **Auth**: real Google sign-in via Firebase Auth (`src/firebase.js`).
- **Data**: all seven collections (servers, events, players, reports,
  resources, developers, ads) read/write to Firestore in realtime through
  one shared hook, `src/lib/useFirestoreCollection.js`.
- **Images**: every upload is resized + re-encoded as JPEG in the browser
  (`compressImage` in `src/App.jsx`) *before* it's sent to Uploadcare
  (`src/lib/uploadcare.js`), so storage and bandwidth stay small no matter
  what the user picks.
- **Security**: `firestore.rules` lets anyone read, but only the person who
  created a listing (or an admin/owner) can edit or delete it.

## The admin/owner panel is real, not a demo

Every signed-in person gets a `users/{uid}` Firestore document the first
time they log in (`role: "member"`, `verified: false`, `banned: false`).
Firestore rules (`firestore.rules`) check that document directly — no
Cloud Function or custom claim required:

- A member can rename themselves but can never touch their own
  `role`/`banned`/`verified` fields.
- Only someone whose *own* `users/{uid}.role` is already `admin` or
  `owner` can change **someone else's** role, ban flag, or verified flag.
- Only `role: "owner"` can create ads (`ads/{adId}`).
- Admins/owner can edit or delete *any* server, event, report, marketplace
  listing, or developer profile — delete buttons for them now show up
  directly on the cards themselves, next to the same button the original
  poster sees.

**Bootstrapping your first owner (one-time, manual step):**
1. Sign in to the deployed app once with the Google account you want as
   owner — this creates your `users/{uid}` doc.
2. Firebase Console → **Firestore Database** → `users` collection → open
   your document → change `role` from `"member"` to `"owner"` → save.
3. Reload the app. The Profile tab now shows the full owner panel — a live
   list of every member with Make Admin / Remove Admin / Ban / Grant
   Verification buttons — and from here you can promote others without
   touching the console again.

## New in this update

Twelve features landed together, so here's what each one actually does and where to find it. **This changed `firestore.rules` again — redeploy before testing any of it** (see the warning at the top of this file).

- **Confirm before ban/delete** — every admin/owner ban and delete action (servers, events, reports, resources, developers, players, comments) now shows a native confirm dialog first. Deliberately used the browser's built-in `confirm()` rather than a custom modal — one less thing that can break, and it matches the "delete account" confirmation that was already there.
- **Spam cooldown** — a new `firestore.rules` function, `cooldownOk()`, rejects a new post if that account's last one landed less than 10 seconds ago (5s for comments). Bookkeeping lives in `users/{uid}.lastPostAt`, updated via `markPosted()` after every successful post. Every "Save" button also now disables itself while submitting (`SaveButton` component), which stops accidental double-submits from the UI side too.
- **Exact version filter** — added to both Servers and Marketplace. It's built from whatever version strings people actually typed into the `version` field (not a fixed list), so it stays accurate without you maintaining anything.
- **RSVP counter** — "I'm interested" button on events, one per account, toggleable. Count is stored as `rsvpCount` on the event.
- **Follow/bookmark** — on servers (in the detail modal) and developers (on their card). Following a server is also what makes the new event-notification feature work (see below).
- **Public profile pages** — click any name (in a review, a comment, or the admin member list) to open a profile modal: join date, role, verified badge, and everything that account has posted across every section.
- **Comment threads** — added to the server detail modal, below reviews. Unlike reviews these aren't one-per-account; anyone can post multiple comments, and can delete their own (admins/owner can delete anyone's).
- **Admin/owner analytics dashboard** — in the owner/admin panel on the Profile tab: total listings per section, most-active members (by post count), and a 14-day daily-active-users bar chart (click "Load" — it's an on-demand fetch, not a live listener, to keep reads cheap).
- **Notifications** — a bell icon in the header (only visible signed in) with unread count. Right now it fires for one event: someone posts a new event on a server you follow. Everything else on this batch's list intentionally *doesn't* send notifications yet, to keep the fan-out volume sane; more triggers are easy to add via `sendNotification()` / `notifyFollowers()` in `src/lib/notifications.js`.
- **Marketplace reviews** — plugins/mods/textures/worlds now have a real detail view (clicking a card previously did nothing) with star + comment reviews, identical pattern to server reviews.
- **New/Trending badges** — "New" = created in the last 7 days. "Trending" = at least 5 votes/likes and a 4.5+ average (players use a like-count-only threshold instead of a rating). Both are computed client-side from fields already being read, no extra queries.
- **Uptime history** — a 14-day dot row in the server detail modal, green/red/grey per day. Backed by a new `servers/{id}/uptimeLog/{date}` doc written every time that server is pinged (see the Live server status section below) — one doc per calendar day, so multiple pings the same day just overwrite it.

### A real bug this update fixed
Auditing the rules for this batch turned up something that's been broken since live-pinging was added: the Firestore rule for updating a server's `online`/`players`/`lastSeen` fields only ever allowed the server's *owner* to write it. Every ping from anyone else was failing silently (caught by a `.catch(() => {})`, so nothing visibly broke) — which meant `lastSeen` only ever actually got refreshed in Firestore when the owner personally revisited the site, undermining the whole "auto-delete after 7 weeks offline" rule for anyone who listed a server and didn't come back often. Fixed by intentionally opening that specific field set to everyone (signed in or not) in the new rules — see the comment above that rule for the reasoning.

## Reviews, ratings, and votes — one per account, editable

All three now work the same way under the hood: the acting person's uid
*is* the document ID in a subcollection (`servers/{id}/reviews/{uid}`,
`developers/{id}/ratings/{uid}`, `reports/{id}/votes/{uid}`). That's what
makes "one per account" true by construction rather than by convention —
submitting again overwrites their own entry instead of creating a new one,
and Firestore rules only allow a user to write the doc whose ID matches
their own uid.

- **Server reviews** now include an optional comment, not just stars, and
  show a live list of everyone's review underneath. If you've already
  reviewed a server, opening it again shows "Edit your review" pre-filled
  with what you wrote.
- **Developer ratings** are a new feature — click the small star row under
  a developer's card to rate them 1–5. Previously the stars were purely
  decorative with no way to actually rate anyone.
- **Report votes** are now capped at one per account. Clicking the same
  thumbs-up/down again removes your vote; clicking the other one switches
  it. Both `src/lib/social.js` (the write logic) and `firestore.rules`
  (the enforcement) changed to support this — the old version only
  incremented a shared counter with no per-user record at all, which is
  why it was uncapped before.

All three recompute their aggregate `rating`/`votes` (or `up`/`down`) by
reading the relevant subcollection after every change and writing the
result back onto the parent document — that's what the list/sort views
read from, so no separate backend job is needed to keep counts accurate.

## Share links now actually work, everywhere

The share button previously copied a hardcoded `minebd.app` domain that
was never yours — that's why the link 404'd. It now uses
`window.location.origin`, so on your real deployment it produces links
like `https://minebd.pages.dev/servers/abc123` automatically — no domain
to configure.

Every section now has a working Share button, not just servers:
`/servers/:id`, `/events/:id`, `/resources/:id` (marketplace), and
`/developers/:id` and `/players/:id` (see below). Opening a shared link
reads that path on load and jumps straight to it — servers open their
full detail modal (same as clicking the card); events/marketplace/
developers/players don't have a separate detail view, so the app switches
to the right tab and briefly highlights the matching card with a green
ring instead.

This relies on the SPA fallback already configured for you
(`public/_redirects` for Cloudflare Pages, or `firebase.json`'s hosting
rewrite for Firebase Hosting) — without that, the host would try to find
a real `/servers/xyz` page and 404 before your app ever runs.

## Best Player leaderboard (new)

A new "Best Player" tab lets anyone nominate a player (name/IGN, platform,
optional server, optional photo, optional description) and lets everyone
else like them — one like per account, toggleable, using the same
doc-ID-is-uid pattern as reviews/ratings/votes above. The top 3 by like
count get a podium layout (gold/silver/bronze), everyone else is a
simple ranked list underneath. Nominators and admins/owner can delete a
listing; likes recompute the same way ratings do — read the `likes`
subcollection, write the count back onto the parent doc.

## Live server status (real pinging, not manual toggles)

Server cards now query the free [mcstatus.io](https://mcstatus.io/docs)
API (`src/lib/pingServer.js`) for the actual online/offline state and
player count of the IP:port you entered — no backend needed, and it's
CORS-friendly for browser fetches. Java and Bedrock use separate
endpoints; batch pings are rate-limited (mcstatus.io allows 5 req/s).
This runs automatically whenever the server list loads, plus there's a
manual **Refresh status** button. A successful ping also updates
`lastSeen` in Firestore, which is what the "auto-delete after 7 weeks
offline" rule actually keys off of.

If a server's status looks wrong, double check the IP/port are exactly
what a Minecraft client would connect with — a wrong port is the most
common cause of a false "offline" reading.

## Uploadcare file deletion

Deleting a listing (server, event, report, market item, player photo, ad, etc.)
also attempts to remove the attached image(s) from Uploadcare so storage does
not keep orphan files.

This requires your **Uploadcare secret key** in `src/lib/uploadcare.js`
(`UPLOADCARE_SECRET_KEY`). Without it, Firestore docs still delete, but CDN
files stay. Prefer proxying deletes through a small backend in production so
the secret is not shipped to browsers.

When a post is **edited** and the image is replaced, the previous Uploadcare
file is deleted the same way.

## Uploadcare image domain

Uploadcare accounts created after September 4, 2025 (yours included) serve
files from a personal subdomain instead of the old shared `ucarecdn.com`.
This is set in `src/lib/uploadcare.js` as `CDN_BASE`. Yours is
`4298bk59oi.ucarecd.net` — you can always confirm/find it again at
**Uploadcare dashboard → your project → API keys → Delivery**. If you ever
create a second Uploadcare project, update `CDN_BASE` to match.

## Auto-expiry (events after 48h, offline servers after 7 weeks)

The UI already hides expired events and long-offline servers instantly by
filtering on timestamps. For actual cleanup (so the documents don't pile up
in Firestore), add a scheduled Cloud Function — see the snippet in the
project chat history, or ask for it again when you set up Cloud Functions.

## Coming next: Content Creator posts + Monetization

Two more features from your list — creator posts (YouTube/Facebook/Instagram/Twitch link previews) and the ad-revenue/monetization system — are big enough to deserve their own pass rather than being rushed into this one. Ask for them whenever you're ready to continue.
