# PetroKenya — Station Dashboard

> **This is a copy of [dariusttt/petro-kenya](https://github.com/dariusttt/petro-kenya)** at commit `f8af815`.
> The live site, https://petrokenya.onrender.com, deploys from petro-kenya — make changes there.

Daily fuel station management for PetroKenya branches: pump meters, payments
(M-Pesa / cash / credit / card), gases & lubricants, tank dips, expenses, credit
invoices, KRA tax figures, analytics and records.

It is an **installable phone app (PWA)** backed by a small **Python server** that
keeps every branch's records in one shared SQLite database, with sign-in and
per-branch permissions.

## Project layout

```
frontend/                 the app people open on their phone or computer
  index.html              page structure
  css/styles.css          look & phone layout
  js/app.js               calculations, forms, sign-in, talking to the server
  js/i18n.js              Kiswahili translation
  manifest.webmanifest    makes it installable ("Add to Home Screen")
  sw.js                   service worker — opens offline, caches app files
  icons/                  app icons
backend/
  server.py               web server + JSON API + SQLite + accounts (Python stdlib only)
  business.py             credit accounts, alerts and email, monthly reports, photo uploads
  tests/test_server.py    API tests
render.yaml, Procfile     hosting config (Render / Railway / Heroku-style hosts)
```

## Run it on your computer

Needs Python 3.9+. Nothing to install.

```bash
python3 backend/server.py
```

Open **http://localhost:8000**. On the very first start the server creates an
`admin` account and prints its password in the terminal — sign in with it, then
change the password under **👤 → Change Password**.

To try it on your phone over Wi-Fi, run `HOST=0.0.0.0 python3 backend/server.py`
and open `http://<your-computer's-IP>:8000` on the phone. (Installing as an app
and offline mode need HTTPS, so for those, host it online — see below.)

## Put it online (so every branch can use it)

**Render** (simplest). `render.yaml` already describes everything; Render only needs an account.

1. Sign up at [render.com](https://render.com) with your GitHub account, and allow Render to see
   this repository.
2. **New → Blueprint**, pick this repository and the branch to run (the one with this code).
3. Render shows the settings from `render.yaml` and asks for the secret ones:
   - `PK_ADMIN_PASSWORD` — the owner's first password: 8+ characters, not a common password,
     and not containing the word "admin". If it's refused, the deploy log says why.
   - `PK_SMTP_HOST`, `PK_SMTP_USER`, `PK_SMTP_PASSWORD` — for alert and backup emails
     (Gmail: `smtp.gmail.com`, your address, and an app password — see *Alert emails* below).
     They can be left empty now and added later under the service's *Environment*.
4. **Apply.** The first deploy takes a few minutes. Your address is
   `https://petrokenya.onrender.com` (or similar), shown at the top of the service page.
5. Open it, sign in as `admin` with the password from step 3, then under **👤**:
   change the password, add each branch's users, and add a **backup email** address.

Cost: the *Starter* instance plus the 1 GB disk (about US$7–8 a month). The disk is what
keeps the database between deploys; Render's free instance has no disk, so its data would
be wiped on every restart. Each push to the chosen branch redeploys automatically.

**Railway** also works: create a service from the repo (it uses the `Procfile`),
add a volume mounted at `/data`, and set `PK_DB=/data/petrokenya.sqlite3`,
`PK_ADMIN_USER`, `PK_ADMIN_PASSWORD`, `PK_SECURE_COOKIE=1` and `PK_TRUST_PROXY=1`.

## Backups

- **Every night** the server writes a backup zip (the database and receipt photos) into a
  `backups` folder next to the database — on Render, on the same disk. The latest 14 are kept.
- **Off the server:** add addresses under **👤 → 💾 Backups**, and each night's database is
  also emailed there (photos are left out to keep the email small). This copy survives even
  if the server or its disk is lost. Needs the `PK_SMTP_*` mail settings.
- **On demand:** **⬇️ Back Up Now** makes a backup and downloads it; earlier ones can be
  downloaded from the list. **✉️ Email a Backup Now** sends one straight away.
- From a terminal: `python3 backend/server.py backup`.

**Restoring** (stop the app first):

```bash
python3 backend/server.py restore petrokenya-backup-2026-11-14_2300.zip
```

It checks the zip holds a sound PetroKenya database, keeps the database it replaces as
`backups/before-restore-….sqlite3` (so a restore can be undone), then puts the backup and its
photos in place. On Render: open the service's **Shell** tab, put the zip in `/var/data`
(for example with `curl -o /var/data/restore.zip <link to the file>`), run
`python3 backend/server.py restore /var/data/restore.zip`, then use **Manual Deploy → Restart
service** so the app reopens the restored database. Ask for help the first time — a restore
replaces what's there now.

## Install on a phone

1. Open your app's `https://` address in the phone's browser and sign in.
2. **Android (Chrome):** tap **📲 Install** in the header, or ⋮ → *Install app*.
   **iPhone (Safari):** Share → *Add to Home Screen*.
3. It opens full-screen from its own icon. Without internet it still opens, shows the
   records from the last sync, and keeps new saves on the phone until it reconnects.

## Accounts & permissions

| Role | Can do |
|------|--------|
| **admin** | Everything: all branches, any date, the bin, add/remove users, reset passwords, sign users out |
| **manager** (always tied to a branch) | That branch: any earlier day, approve days, bin records |
| **staff** with a branch | Only that branch — see its records; save or bin today's and yesterday's |
| **staff** without a branch | All branches, same date limit, no bulk moves and no user management |

**Keeping records honest**

- Every save keeps a full copy of the record. A record's details show its change
  history: who changed what, from what to what, and when.
- Deleting moves a record to the **🗑️ Bin** (Records page). Only admins can restore it
  or delete it for good; its history is kept even then.
- Staff can only change today's and yesterday's records; older days are locked.
- Staff never see cost prices, margins or profit — not on screen, in reports or downloads, nor in what the
  server sends them. When they save a day the cost prices come from the owner's prices (or the day before).
  Nobody can save a future date.

**Daily workflow**

- **Branch managers** (role *manager*, tied to one branch) can change any earlier
  day of their branch and **approve** a day from the KRA Filing page or the
  record's details. An approved day is locked for everyone until an admin reopens it.
- **💲 Fuel Prices** (menu): admins set selling and cost prices per branch from a
  date. Those prices fill in automatically and can't be typed over; the server
  applies them on every save. Fuels without a set price can still be typed.
- **Pumps:** three petrol (P1–P3), three diesel (D1–D3) and one kerosene (K1). Each pump has
  its own litres and sales (KES) meters; a fuel's litres and sales are the sum over its pumps.
  The list is `PUMPS` in `backend/server.py` and `frontend/js/app.js` (and `preview/mock-api.js`).
- **Opening readings** (each pump's meters and the dips) are filled from the previous saved day's
  closing readings. If someone changes them, the page warns before saving and the
  record is flagged ⚠️ in Records and in its details.
- **🚚 Fuel Deliveries** (Dips page): log supplier, delivery note, truck, litres
  ordered and received, and tank dips before and after. Received litres fill the
  deliveries boxes; short deliveries and dip differences are shown.

**Money and stock checks**

- **👷 Cash per Attendant** (Payments page): for each attendant, the sales on their
  pumps against the cash and M-Pesa they handed in; shortages are shown per person.
- **🧾 Credit Accounts** (menu): customer accounts with credit limits (set by managers
  or admins), balances, payments and printable statements. Pick the account on the
  invoice form (Expenses page); the app warns before an invoice goes over the limit.
  Admins can void a wrongly entered payment; the voided payment is kept on record.
- **🔔 Alerts** (managers and admins): raised automatically when a saved day shows a
  tank shortage, low tank stock, a cash shortage, an attendant shortage, changed
  opening readings or a short delivery. They clear themselves when the day is
  corrected. Admins set the limits and the alert email addresses under
  **👤 → Alert Settings**.
- **📈 Monthly Report** (menu): one month's totals for each branch side by side, a
  day-by-day list, **Print / PDF** and **Download for Excel**.

- **📷 Receipt Photos** (Expenses page): take or choose a photo of a receipt or delivery
  note; it is shrunk on the phone and kept with the day. Tap a photo to open it full size.
  Photos are stored in an `uploads` folder next to the database (on Render, on the
  same disk) and only people who can see that branch can open them.

**Saving without internet**

Saving with no connection keeps the day on the phone ("⏳ Waiting to send" in Records,
and the status pill shows how many are waiting). They are sent automatically when the
connection returns or the app is opened again. If the server refuses one — for example
the day was approved meanwhile — it stays listed with the reason and can be discarded.
Photos, prices, alerts and credit accounts need a connection.

**Kiswahili**

Choose **English** or **Kiswahili** on the sign-in screen or under **👤 → Lugha / Language**;
the choice is remembered on that phone. Menus, labels, buttons, messages and dates
switch language; names and anything people type are never changed, and official KRA
tax terms stay in English. The translations live in `frontend/js/i18n.js` — have a
fluent speaker on your team read through them and adjust any wording to how your
staff talk.

**Alert emails** need a mail account on the server. With Gmail, turn on 2-step
verification, create an *app password*, and set on the server:
`PK_SMTP_HOST=smtp.gmail.com`, `PK_SMTP_PORT=587`, `PK_SMTP_USER=you@gmail.com`,
`PK_SMTP_PASSWORD=<the app password>` (keep it secret: set it as a secret on Render,
never in the code). Then use **Send Test Email** in Alert Settings.

**Forgotten passwords:** **Forgot password?** on the sign-in screen sends a 6-digit code that works
once, for 15 minutes (5 wrong tries and it stops working). It goes to the account's own email; if it
has none, by SMS to its phone; if it has neither, to the admins' emails, so an admin can pass it on in
person. Everyone sets their email and phone under **👤 → Your Email & Phone**; admins can set them for
any user (📇). The reply never says whether a username exists, and requests are limited (3 per
account and 5 per device every 15 minutes). Every password box has a 👁 button to show what's typed.

**SMS** uses [Africa's Talking](https://africastalking.com): create an account, buy SMS credit, and
set `PK_SMS_USERNAME` and `PK_SMS_API_KEY` on the server (and `PK_SMS_SENDER` if you have an approved
sender name). Without them, codes go by email only.

**Sign-in safety**

- A sign-in lasts 7 days and ends after 8 hours without use.
- After 5 wrong passwords from one device, or 10 for one account from any devices,
  sign-in pauses for 15 minutes.
- Passwords need 8+ characters and can't be a common password or contain the username.
- **👤 → Sign out other devices** ends your other sign-ins; admins can sign any user
  out everywhere (⎋ next to the user).

**Branches** are added by the admin under **👤 → 🏪 Branches**; a new install starts with none,
and nothing can be recorded until the first branch exists. Every branch picker (Fuel Entry,
users, prices, records filter) uses that list. A branch can only be removed while no saved days
or users belong to it. **✏️ Rename** changes a branch's name everywhere at once: its saved days
(and their history), users, prices, alerts, credit payments and photos. (A database from before branches were managed keeps the branches its
users and records already use.)

Admins manage users in the app under **👤**. From a terminal you can also run:

```bash
python3 backend/server.py add-branch "Moiben Branch"
python3 backend/server.py create-user mary --role staff --station "Moiben Branch"
python3 backend/server.py reset-password mary
```

## Settings

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `8000` | Port to listen on |
| `HOST` | `127.0.0.1` | `0.0.0.0` to accept connections from other devices / when hosted |
| `PK_DB` | `backend/petrokenya.sqlite3` | Database file |
| `PK_UPLOADS` | `uploads` next to the database | Folder for receipt photos |
| `PK_BACKUPS` | `backups` next to the database | Folder for the nightly backups |
| `PK_ADMIN_USER`, `PK_ADMIN_PASSWORD` | — | Admin created on first start (otherwise `admin` + random password) |
| `PK_SECURE_COOKIE` | auto | `1` forces the Secure cookie flag (auto when behind an HTTPS proxy) |
| `PK_SMTP_HOST`, `PK_SMTP_PORT`, `PK_SMTP_USER`, `PK_SMTP_PASSWORD`, `PK_SMTP_FROM` | — | Mail account for alert and backup emails (port 587 uses STARTTLS, 465 uses SSL) |
| `PK_SMS_USERNAME`, `PK_SMS_API_KEY`, `PK_SMS_SENDER` | — | Africa's Talking account for password reset codes by SMS (`sandbox` as the username uses their test system) |
| `PK_TRUST_PROXY` | off | `1` reads the visitor's address from `X-Forwarded-For`. Set it **only** behind a proxy you control (Render, Railway); never when the server faces the internet directly |

## API

JSON in and out. Everything except `/api/health` and `/api/login` needs a
signed-in session (cookie). The server recomputes all figures — litres, revenue,
profit, VAT, excise, road levy, dip and pump variances — whenever a record is saved.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/login`, `/api/logout` | Sign in / out |
| GET | `/api/me` · POST `/api/me/password` | Current user · change own password |
| GET | `/api/stations` | Branches this user may use |
| POST | `/api/compute` | Compute figures without saving |
| GET | `/api/records?station=&date=&from=&to=&limit=` | List records |
| POST | `/api/records` | Save (updates the existing date + branch record) |
| GET · PUT · DELETE | `/api/records/{id}` | One record |
| DELETE | `/api/records?station=` | Erase records (admin) |
| GET | `/api/analytics?station=` | Last 7 days + all-time totals |
| GET | `/api/export.csv?station=` | CSV download |
| GET · POST | `/api/users` | List / add users (admin) |
| DELETE | `/api/users/{id}` · POST `/api/users/{id}/password` | Remove user · reset password (admin) |

## Website preview

`python3 preview/build_preview.py` builds one self-contained page of the app that runs
with no server: `preview/mock-api.js` stands in for the backend inside the browser, with
the same rules and marked example data, and one-tap sign-ins for owner, branch manager
and pump staff. It's for showing the app; everything entered stays in that browser.
Printing, CSV downloads and email don't work there.

## Tests

```bash
python3 -m unittest discover -s backend/tests
```
