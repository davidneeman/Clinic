# The website on Cloudflare

The site runs on Cloudflare's free plan:

| What | Where | Free plan |
|---|---|---|
| Pages, photos, the video | Cloudflare's static files: `dist/`, built from `public/` by `scripts/build-cloudflare.mjs` | Unlimited, and they don't count toward the Worker's daily limit |
| `/api/*`: free times, bookings, messages, the admin panel | The Worker: `worker/index.js` | 100,000 requests a day |
| The home and booking pages, with David's texts, photos and notices in them; the photos he uploads (`/media/*`) | The Worker (`worker/content.js`) | Counted in the 100,000 a day: a visit is a few requests |
| The photos David uploads in the admin panel | Workers KV, a store named `clinic-media` (the `MEDIA` binding) | 1 GB; 100,000 reads and 1,000 writes a day |
| The data: bookings, closed days, opening hours, messages, David's clients | Cloudflare D1, a database named `clinic` (tables in `migrations/`) | 5 GB; 5 million rows read and 100,000 written a day |
| Signing in to the admin panel | Face ID, Touch ID or a fingerprint (passkeys, `worker/passkeys.js`), no password. A person is added with a one-time link | Free |
| Payment at booking | Grow's own secure page (`worker/grow.js`): card details never reach the site | Grow's fees only |
| The iPhone calendar | iCloud, over CalDAV (`worker/calendar.js`) | Free |

`BOOKING_MODE` in `wrangler.jsonc` decides how bookings work:

- `"transfer"` (now): bookings are made on the site, and the client pays by Bit or PayBox to David's phone (058-434-4047): one session (350 ₪), the 4-session card (1,200 ₪, this session included), or a session from a card they already have (nothing to pay). The confirmation shows the number, the amount and the booking number to write in the transfer's note. The time is held until David approves it under **פגישות** (or the appointment time passes); approving adds the client to **לקוחות**, adds the card's other 3 sessions or takes one, and puts the booking in his calendar. The site can't see Bit or PayBox payments itself, so approving is by hand. Messages still go to WhatsApp.
- `"whatsapp"`: exactly like the GitHub Pages site today. A booking request or a message opens WhatsApp, and nothing is stored. The free times come from the opening hours, minus the days closed in the admin panel (and, once connected, minus his calendar).
- `"pay"`: what David chose. The client books and pays in full on the site, and messages still go to WhatsApp. See "Payment at booking" below.
- `"online"`: bookings and messages are taken and stored on the site without payment.

## What's ready, and what's still missing

Ready now:
- Everything the site does today, on Cloudflare.
- The admin panel, with Face ID sign-in and David's client list (below).
- Security headers on every page and file, and limits per visitor.
- The database.
- Payment at booking through Grow, tested against a stand-in for Grow's API.
- The iCloud calendar, tested against a real CalDAV server (Radicale).

Still missing:
- **David's Grow account**, and Grow's approval for real payments (below).
- **An app-specific password** for his iCloud calendar (below).
- **The domain** (the one his father has).
- **The terms and privacy policy**: Grow requires them before approving the site.
- **Emails** to him and to clients: they need the domain.

## Setting it up

You'll need David's Cloudflare account. Cloudflare's dashboard is renamed now and then, so a menu may have a slightly different name.

1. **The account.** Open a Cloudflare account, with an email that can stay with the clinic, and turn on two-step login. Later you can invite David under **Manage account → Members**.
2. **On your computer**, in this folder:
   ```sh
   npm install
   npx wrangler login        # sign in as yourself, then choose David's account
   ```
3. **The database.** Done: `clinic`, made with `npx wrangler d1 create clinic --jurisdiction eu`, so the data stays inside the EU (Israel's rules on sending personal data abroad allow EU countries). Its `database_id` is in `wrangler.jsonc`, and its tables were made with `npx wrangler d1 migrations apply clinic --remote`. Run that again whenever a new file appears in `migrations/`.
4. **The photo store.** Done: `clinic-media`, made with `npx wrangler kv namespace create clinic-media`. Its id is in `wrangler.jsonc` (`MEDIA`). It holds only the photos David uploads for the site (no personal data).
5. **Deploys: Cloudflare builds the site from GitHub** (Workers Builds), so every push to the branch goes live by itself, with no token needed anywhere else:
   - Go to **Workers & Pages → Create → Import a repository** and connect GitHub.
   - Pick this repository, name the Worker `clinic` (it must match `name` in `wrangler.jsonc`), and keep the deploy command `npx wrangler deploy`.
   - Set the production branch to the branch the site is on.

   The site is then at `https://clinic.davidneeman.workers.dev`. Deploying from a computer with `npm run cf:deploy` works too. It doesn't work from a cloud session whose network proxy adds the Cloudflare token to every request: uploading the site's files needs a short-lived upload pass instead, which the proxy replaces.
6. **The admin panel's sign-in: Face ID.** Nothing to set up. Each person signs in with a passkey: Face ID or Touch ID on an iPhone, iPad or Mac, a fingerprint on Android. The passkey stays on the phone (on Apple devices it also syncs through iCloud Keychain); the site keeps only its public half, so there's no password to steal or forget.
   - **The first person** gets a one-time link from the database:
     ```sh
     npm run admin:invite -- https://clinic.davidneeman.workers.dev "דוד" 24
     ```
     It prints the link. Open it on the phone, write a name, confirm with Face ID, and the panel opens.
   - **Everyone after that:** in the panel, **מנהלים → יצירת קישור**, then send the link (WhatsApp or copy). Each link works once, within 48 hours. The same tab shows who can sign in, and removing someone stops their sign-in at once.
   - **On a computer:** click the sign-in button, choose the phone, and scan the code with it (Bluetooth on in both). Right after, the panel offers to save the sign-in on that computer (Windows Hello or Touch ID). It's added to the same person, as a second device; **מנהלים** shows how many devices each person has. Saving is allowed only in the 15 minutes after signing in, so a session alone can't add a device later.
   - A signed-in session lasts 12 hours, in a cookie scripts can't read. Signing in is limited to a few tries a minute per visitor.
   - A passkey works only on the address it was made on. After the site moves to its domain (step 6), make a new first link for the new address with the command above.

   **The client list** (**לקוחות**) fills itself: each confirmed booking adds its client, found by phone number, or joins an existing one. David can add clients by hand, keep private notes, count the sessions left on a 4-session card, and see each client's bookings. **מחיקת הלקוח** removes a client and erases their name and details from past bookings too.

   **Optional: Cloudflare Access** as a second way in, with a one-time code sent by email. In **Zero Trust**, add the One-time PIN login method and a self-hosted application for the paths `admin` and `api/admin`, allowing David's email. Then set `ACCESS_TEAM_DOMAIN` (`https://<team name>.cloudflareaccess.com`), `ACCESS_AUD` (the application's AUD tag) and `ADMIN_EMAILS` with `npx wrangler secret put`. The Worker checks Access's token on every admin request: its signature, that it's for this application, that it hasn't expired, and that the email is in `ADMIN_EMAILS`.
7. **The domain** (question 18).
   1. Cloudflare doesn't sell `.co.il` addresses: buy it from an Israeli registrar, in David's name. A `.com` can be bought on Cloudflare itself.
   2. In Cloudflare, add the domain to David's account (**Add a site**, Free plan). At the registrar, switch its nameservers to the two that Cloudflare shows.
   3. Under **Workers & Pages → clinic → Settings → Domains & Routes → Add → Custom domain**, add the address, and `www.` too.
   4. Set `siteUrl` in `config/site.json` to `https://<domain>/`. Link previews, the canonical address and search results all use it.
   5. Make a new first sign-in link for the new address (step 5). If Cloudflare Access is used, move its application there too.
   6. Send the old GitHub Pages address to the new one.
8. **Extra protection, also free:**
   - Under **Security → WAF → Rate limiting rules**, add one rule: when the URI path starts with `/api/`, at most 60 requests in 10 seconds per IP, otherwise block. Floods are stopped before they reach the Worker or its daily limit.
   - **Backups:** D1 keeps a restorable history of the database (Time Travel), with nothing to set up. `npx wrangler d1 export clinic --remote --output <file>` writes a full copy, which contains clients' personal details. Keep such a copy encrypted, and never in this repository.

## Payment at booking (Grow)

How it works:
1. The client chooses a time and fills in their details (Grow asks for a full name and an Israeli mobile number).
2. The time is held for 20 minutes, and the client goes to Grow's secure page to pay. Card details never reach this site.
3. Grow's server tells the Worker (`/api/payments/grow/notify`). That notice isn't signed, so the Worker asks Grow itself (`getPaymentProcessInfo`, with its own identifiers) whether this payment is paid, and for the full price. Only then is the booking confirmed. The Worker then tells Grow the notice arrived (`approveTransaction`).
4. Back on the site, the client sees "confirming your payment", then the booking.

If the client cancels on Grow's page, the time is freed at once. Every 10 minutes (`triggers` in `wrangler.jsonc`), the Worker also:
- asks Grow about payments it didn't report;
- releases holds that ran out;
- retries bookings that didn't reach the calendar.

A payment that arrives after its hold ran out still counts if the time is free. If someone else took the time meanwhile, the log says to refund it in Grow.

To turn it on:
1. David opens a Grow account in his name (grow.business): ID, bank account confirmation and business certificate go only to Grow. Grow gives identifiers for its test environment.
2. ```sh
   npx wrangler secret put GROW_USER_ID
   npx wrangler secret put GROW_PAGE_CODE
   npx wrangler secret put GROW_API_KEY   # only if Grow gives one
   ```
   Then set `BOOKING_MODE` to `"pay"` in `wrangler.jsonc` and deploy. `GROW_ENV` stays `"sandbox"`.
3. Test with Grow's test card `4580458045804580`. Bit, Apple Pay and Google Pay have no test environment: with them, test payments are real.
4. Ask Grow (support@grow.business) for the production review. Grow checks the site has:
   - a real domain;
   - a details page before payment (it does);
   - the phone and address (they're there);
   - a checkbox agreeing to the terms with a link to them (it shows in pay mode);
   - the terms linked from the home page. They must cover how the service is given, liability, age 18 or over, cancellation and privacy.

   The terms page is the part still to add, after David approves the draft.
5. With the production identifiers: update the two secrets, and set `GROW_ENV` to `"production"`.

Before real payments go live, add Cloudflare Turnstile (a free check that a person, not a bot, is booking) to the booking form. It needs keys from the Cloudflare account. Without it, someone could start many bookings without paying, to hold times. Each hold already ends after 20 minutes, and each visitor can send only 5 bookings a minute.

Refunds are done in Grow's dashboard (cancelling up to 24 hours before is free). Cancelling in the admin panel frees the time but doesn't refund.

## The site editor (the admin panel's "האתר" tab)

David changes the site himself, from his phone:
- **Notices** at the top of every page: an update, something new, or something important (for example "the clinic is closed until …"). Each shows from a time until a time (or until he turns it off), and can also close the booking calendar on chosen days: those days show in **זמינות** as closed by the notice, and open again when the notice is paused or deleted. Visitors can close an update or a piece of news; an important notice stays. At most three show at once, the important ones first.
- **The texts**: the headline, each section's title (also its name in the menu), the paragraphs, the quote, the notes before a session. A paragraph he empties disappears from the site.
- **The treatments**: each one's name, description and photo, and **the prices** (a session, the card and how many sessions it has). The prices are the ones the booking page shows and asks to transfer by Bit or PayBox.
- **The photos**: the one in the arch (the site's own, or his), the "about" photo and its description, and the gallery – its order, descriptions, and photos to replace, remove or add (up to 24).

A photo he picks is framed on the phone in the shape it has on the site (the arch shows its window lines), then uploaded in the three sizes the site uses, as a new JPEG: the location and camera details in the phone's file don't go with it, and the server strips any that would. Uploads nothing uses any more are deleted after three days.

His changes are kept in D1 (`settings` → `content`, and the `notices` table) and are on the site at once: the Worker puts them into the home and booking pages as they're served (with the same security headers), and `/api/config` gives the booking page his names and prices. The GitHub Pages copy reads the same from `/api/site` (allowed for that address only) and keeps it in the browser, so it looks the same.

## The iPhone calendar (iCloud)

- Anything in his calendars blocks that time on the booking page, with the usual break around it. An all-day event shown as busy (a vacation) closes the day; events shown as free, or cancelled, block nothing. Only the times are used; titles and details are never kept.
- Each confirmed booking is added to a calendar named "קליניקה" (`CALENDAR_NAME`), made the first time. If his account won't make it, create it once on the iPhone (Calendar → Calendars → Add Calendar).
- If iCloud doesn't answer, the booking page shows the times from the opening hours, as before.

To connect it, David makes an app-specific password: account.apple.com → Sign-In and Security → App-Specific Passwords → "+" → name it "Website". It opens the calendar only, and he can revoke it at any time. Enter it together with him, never over WhatsApp:
```sh
npx wrangler secret put ICLOUD_USER           # his Apple ID email
npx wrangler secret put ICLOUD_APP_PASSWORD   # the password Apple shows, once
```

## Settings

| Name | Kind | What |
|---|---|---|
| `BOOKING_MODE` | `vars` in `wrangler.jsonc` | `transfer`, `whatsapp`, `pay` or `online` (see above) |
| `GROW_ENV` | `vars` | `sandbox` (Grow's test environment) or `production` |
| `CALENDAR_NAME` | `vars` | The calendar bookings go into (default "קליניקה") |
| `ACCESS_TEAM_DOMAIN` | secret, optional | `https://<team name>.cloudflareaccess.com` (only with Cloudflare Access) |
| `ACCESS_AUD` | secret, optional | The Access application's AUD tag |
| `ADMIN_EMAILS` | secret, optional | Who may sign in through Access, with a comma between addresses |
| `GROW_USER_ID`, `GROW_PAGE_CODE` | secrets | Grow's identifiers for the account (and `GROW_API_KEY` if Grow gives one) |
| `ICLOUD_USER`, `ICLOUD_APP_PASSWORD` | secrets | His Apple ID email and the app-specific password |

Secrets are set only with `npx wrangler secret put` (or in the dashboard). Never put them in this repository, in WhatsApp or in an email. Deploys never change them.

## Working on it locally

```sh
cp .dev.vars.example .dev.vars   # local settings; git ignores .dev.vars
npm run cf:dev                   # http://localhost:8787, with a local database
npm test                         # includes test/worker.test.js
```

The local database lives in `.wrangler/`, which git ignores. To sign in to the local admin panel, run `npm run admin:invite -- http://localhost:8787` and open the link (use `localhost`, not `127.0.0.1`: passkeys need a name). `test/admin.test.js` shows how passkeys are checked.
