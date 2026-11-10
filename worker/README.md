# The website on Cloudflare

The site runs on Cloudflare's free plan:

| What | Where | Free plan |
|---|---|---|
| Pages, photos, the video | Cloudflare's static files: `dist/`, built from `public/` by `scripts/build-cloudflare.mjs` | Unlimited, and they don't count toward the Worker's daily limit |
| `/api/*`: free times, bookings, messages, the admin panel | The Worker: `worker/index.js` | 100,000 requests a day |
| The home and booking pages, with David's texts, photos and notices in them; the photos he uploads (`/media/*`) | The Worker (`worker/content.js`) | Counted in the 100,000 a day: a visit is a few requests |
| The photos David uploads in the admin panel | Workers KV, a store named `clinic-media` (the `MEDIA` binding) | 1 GB; 100,000 reads and 1,000 writes a day |
| The data: bookings, closed days, opening hours, messages, David's clients | Cloudflare D1, a database named `clinic` (tables in `migrations/`) | 5 GB; 5 million rows read and 100,000 written a day |
| Signing in to the admin panel | Face ID, Touch ID or a fingerprint (passkeys, `worker/passkeys.js`), no password. A person is added with a one-time link. Or Google, once a manager connects their account | Free |
| Signing in on the booking page (clients: their card and bookings) | Google (`worker/google.js`) or a code sent by SMS through Twilio Verify (`worker/sms.js`) | Google: free. SMS: about 1 ₪ a sign-in (below) |
| Payment at booking | Grow's own secure page (`worker/grow.js`): card details never reach the site | Grow's fees only |
| The iPhone calendar | iCloud, over CalDAV (`worker/calendar.js`) | Free |

`BOOKING_MODE` in `wrangler.jsonc` decides how bookings work:

- `"transfer"` (now): bookings are made on the site, and the client pays by Bit or PayBox to David's phone (058-434-4047): one session (350 ₪), the 4-session card (1,200 ₪, this session included), or a session from a card they already have (nothing to pay). The confirmation shows the number, the amount and the booking number to write in the transfer's note. The time is held until David approves it under **פגישות** (or the appointment time passes); approving adds the client to **לקוחות**, adds the card's other 3 sessions or takes one, and puts the booking in his calendar. The site can't see Bit or PayBox payments itself, so approving is by hand. A client who signed in and has sessions left on their card books from it at once, without waiting for him (see "Signing in on the site" below). Cancelling a confirmed session that came off a card (or a new card's first one) puts it back on the card. Messages still go to WhatsApp.
- `"whatsapp"`: like the first version of the site. A booking request or a message opens WhatsApp, and nothing is stored. The free times come from the opening hours, minus the days closed in the admin panel (and, once connected, minus his calendar).
- `"pay"`: what David chose. The client books and pays in full on the site, and messages still go to WhatsApp. See "Payment at booking" below.
- `"online"`: bookings and messages are taken and stored on the site without payment.

## What's ready, and what's still missing

Ready now:
- Everything the site does today, on Cloudflare.
- The admin panel, with Face ID sign-in and David's client list (below).
- Security headers on every page and file, and limits per visitor.
- Encrypted only: a page asked for over plain `http://` moves to `https://`, and the API refuses plain http (allowed on `localhost`, for development).
- The database.
- Payment at booking through Grow, tested against a stand-in for Grow's API.
- The iCloud calendar, tested against a real CalDAV server (Radicale).

Still missing:
- **Signing in on the site**: the database's new tables (`migrations/0006`) and Google's two settings, and Twilio's for SMS codes (below). Until then the booking page works as before, without signing in.
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
   4. Set `siteUrl` in `config/site.json` to `https://<domain>/` (today it's `https://clinic.davidneeman.workers.dev/`, the main site). Link previews, the canonical address, search results and the old GitHub Pages address (below) all use it.
   5. Make a new first sign-in link for the new address (step 5). If Cloudflare Access is used, move its application there too.
   6. Run `npm run build:pages` and push: the old GitHub Pages address then sends visitors to the new one.
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

A photo he picks is framed on the phone in the shape it has on the site (the arch shows its window lines), then uploaded in the three sizes the site uses, as a new JPEG: the location and camera details in the phone's file don't go with it, and the server strips any that would. Uploads nothing uses are deleted after two weeks (time enough to save a draft that has one).

His changes are kept in D1 (`settings` → `content`, and the `notices` table) and are on the site at once: the Worker puts them into the home and booking pages as they're served (with the same security headers), and `/api/config` gives the booking page his names and prices. The old GitHub Pages address (`docs/`, from `npm run build:pages`) no longer has a copy of the site: it sends visitors to the same place on the main site (an old link to the booking page opens the booking page).

## Signing in on the site (clients), and Google for managers

On the booking page, above the steps, a client can sign in:
- **With the phone**: a code by SMS to their mobile number (Israeli 05… numbers only). They see the card on that number: the client in **לקוחות** with that phone.
- **With Google**. Google tells the site only the name and the email address; no password ever reaches the site. A Google account sees a card once (a) the client confirms their mobile number with an SMS code, or (b) David writes their Gmail address in the client's card (**לקוחות** → the client → **Gmail לכניסה לאתר**). Only he connects an address: one typed into a booking proves nothing, so it never connects a card by itself.

Signed in, the client sees how many sessions are left on their card and their bookings (coming up and past; no notes, no one else's), and the form fills in their name and number. With sessions left, **a session from the card is booked at once**: confirmed, taken off the card, and put in his calendar; under **פגישות** it says **נקבע מהכרטיסייה באתר** and needs nothing from him. With no sessions left, or another phone number on the booking, it waits for his approval as before. Two bookings at the same moment can't both take a card's last session.

**Managers** can sign in with Google too: under **מנהלים**, right after signing in with Face ID, **חיבור חשבון Google**. The sign-in screen then has **כניסה עם Google**. Only a Google account a manager connected opens the panel, and **ניתוק Google** (or removing the person) ends it.

What's kept, in D1: Google's id for the person, their email and name; the phone number they confirmed; and only hashes of the sign-in cookies. A client stays signed in for 90 days (or until **יציאה**), a manager for 12 hours. The cookies are sent only over HTTPS, never to scripts, never from another site. Each Google sign-in is tied to the browser that started it and checked with Google itself (its signature, this site, the time, a value unique to this sign-in, and an email address Google confirmed); the code Google sends back only works with a secret kept on the server (PKCE). A visitor can ask for a few codes, tries or Google sign-ins a minute. **מחיקת הלקוח** also deletes the client's sign-ins.

To turn it on:
1. **The tables**, once: `npx wrangler d1 migrations apply clinic --remote` (it adds `migrations/0006`: new tables only, nothing existing changes). Deploys from GitHub don't run this.
2. **Google** (free), with the clinic's Google account, at [console.cloud.google.com](https://console.cloud.google.com):
   1. Make a project (for example "Clinic").
   2. **Google Auth Platform → Branding**: the app's name as clients should see it ("דוד נאמן"), and a support email. Don't add a logo: that asks for Google's review, and the name and email alone need none.
   3. **Audience**: External, then **Publish app** (until then, only listed test users can sign in).
   4. **Clients → Create client → Web application**. Under **Authorized redirect URIs** add `https://clinic.davidneeman.workers.dev/api/auth/google/callback` (and, once the domain is set, the same with the domain).
   5. Copy the client ID and secret into the Worker, without sending them to anyone:
      ```sh
      npx wrangler secret put GOOGLE_CLIENT_ID
      npx wrangler secret put GOOGLE_CLIENT_SECRET
      ```
3. **SMS codes** (optional; Twilio Verify, about $0.05 a sign-in plus the SMS to Israel, roughly 1 ₪ in all), at [twilio.com](https://www.twilio.com):
   1. Open an account and upgrade it (a trial account sends only to numbers it verified).
   2. **Verify → Services → Create**: the name is what the SMS says ("Your … verification code is"). Keep SMS on.
   3. **Verify → Geo permissions**: allow Israel only. Under **Billing**, a usage alert is a good idea too.
   4. Put the account's SID and auth token (on the console's home page) and the Verify service's SID into the Worker:
      ```sh
      npx wrangler secret put TWILIO_ACCOUNT_SID     # AC…
      npx wrangler secret put TWILIO_AUTH_TOKEN
      npx wrangler secret put TWILIO_VERIFY_SERVICE  # VA…
      ```

Each way to sign in shows once its secrets are there; without Twilio, signing in is with Google only.

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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secrets | Signing in with Google (clients and managers) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE` | secrets, optional | Signing in with a code by SMS |

Secrets are set only with `npx wrangler secret put` (or in the dashboard). Never put them in this repository, in WhatsApp or in an email. Deploys never change them.

## Working on it locally

```sh
cp .dev.vars.example .dev.vars   # local settings; git ignores .dev.vars
npm run cf:dev                   # http://localhost:8787, with a local database
npm test                         # includes test/worker.test.js
```

The local database lives in `.wrangler/`, which git ignores. To sign in to the local admin panel, run `npm run admin:invite -- http://localhost:8787` and open the link (use `localhost`, not `127.0.0.1`: passkeys need a name). `test/admin.test.js` shows how passkeys are checked.

Signing in on the site is tested in `test/sign-in.test.js` against stand-ins for Google and Twilio. To try it in a browser on this computer, `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_CERTS_URL` and `TWILIO_API_URL` can point to a stand-in on `http://127.0.0.1:…` or `http://localhost:…`; the Worker uses them only for requests to `localhost`, never on the real site.
