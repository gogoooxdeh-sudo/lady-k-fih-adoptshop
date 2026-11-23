# Lady K ★ Fih AdoptShop — source handoff

This archive preserves the **current editable project files available in the workspace**. It is a static HTML/CSS/JavaScript project; it does not use React, Vite, TypeScript, npm dependencies, a database, or a build step.

> **Important status:** the current interactive shop and administration panel are a frontend-only prototype/local simulation, not a production commerce application. The source files are included; the word “prototype” in the existing filename and code is intentional. The panel is not securely authenticated, and it does not persist records. This handoff does not claim that a separate production/Supabase implementation exists.

## Contents

```text
lady-k-fih-adoptshop/
├── .env.example                 # empty placeholders for future server integrations
├── .gitignore
├── README.md                     # this handoff and run/deploy guide
├── index.html                    # current interactive storefront + admin entry point
├── prototype.html                # compatibility entry point to the same source app
├── prototype.css                 # complete responsive styles for current interactive app
├── adopt-details.html            # earlier Phase 1 static layout/template; not data-backed
├── available-adopts.html         # earlier Phase 1 static catalog template
├── custom-adopts.html            # earlier Phase 1 static request-form template
├── contact.html                  # earlier Phase 1 static contact template
├── information.html              # earlier Phase 1 static information/ToS layout
├── sold-archive.html             # earlier Phase 1 static archive template
├── netlify.toml                  # Netlify publishes the repository root; no build step
└── assets/
    ├── css/
    │   └── styles.css            # Phase 1 static pages' styling
    └── js/
        ├── app.js                # Phase 1 static pages' shell and placeholder interactions
        └── prototype.js          # current interactive app logic, records, and workflows
```

There are no separate image/font files in this source snapshot. The current app's example artwork includes inline SVG/data examples in JavaScript; client-upload previews use browser object URLs and are temporary. The CSS falls back to locally available system fonts. No external asset service is required for the current app.

## Technologies and architecture

- Plain HTML5, CSS, and browser JavaScript (ES features such as template strings, optional chaining, and `structuredClone` where available).
- No framework, package manager, third-party runtime dependency, bundler, transpiler, or generated build output.
- `index.html` and `prototype.html` are HTML entry documents referencing `prototype.css` and `assets/js/prototype.js` as **editable source files**. Both entries are intentionally kept in sync and load the same code.
- The six other `.html` files are retained from the earlier Phase 1 static site. They use `assets/css/styles.css` and `assets/js/app.js`; those pages display sample layout/placeholders and are not connected to the interactive app's record state.
- Current admin access uses the discreet footer star. It is only a visual/demo access flow; it does **not** provide authentication or protect data.

## Install and run locally

There are no dependencies to install. Use Python 3's built-in static server from this directory:

```sh
cd lady-k-fih-adoptshop
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. The main interactive application is `index.html`; `prototype.html` opens the same source-backed application. Stop the server with Ctrl+C.

A current browser is recommended. Opening the pages directly as `file://` may restrict browser APIs used for local file previews; using the local server avoids that issue.

### Build command

There is no production build process for this static project. No `npm install`, `npm run build`, or lockfile is required. The production files are the source files themselves. Do not treat a successful static publish as proof that backend-dependent features exist.

## Netlify deployment

`netlify.toml` sets `publish = "."`; there is no build command. For manual deployment, upload the contents of this folder (not an enclosing parent folder) as the static site publish directory. For Git-based deployment:

1. Create a GitHub repository and upload/commit the contents of this folder at the repository root.
2. In Netlify, import that GitHub repository.
3. Set the build command to blank / no build command and the publish directory to `.` (the checked-in `netlify.toml` already specifies the publish directory).
4. Deploy. Verify `/`, `/prototype.html`, and each retained Phase 1 `.html` path after deployment.

This config only publishes static files. It does not configure authentication, server functions, Supabase, storage, database rules, or notifications.

## GitHub maintenance

From the project directory, initialize and push to a repository you control, for example:

```sh
git init
git add .
git commit -m "Import Lady K Fih AdoptShop source"
git branch -M main
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

Replace `OWNER/REPOSITORY` with your own repository path. Do not commit `.env` or any real secret; `.gitignore` excludes local environment files. Review the changes before committing future edits. Since the project has no automated test/build script, use the manual checks below after changes.

## Important source files

- `index.html`, `prototype.html`: current interactive app shell and document entry points. They load the CSS and JS sources rather than embedding a second copy.
- `prototype.css`: public and administrative visual styles, responsive rules, modals, and certificate display.
- `assets/js/prototype.js`: current app state, fictitious sample data, public catalog/request interactions, admin records/actions, payment calculations/history, ownership/certificate helpers, local settings, and reset behavior.
- `assets/css/styles.css`, `assets/js/app.js`, and the six secondary HTML files: retained earlier Phase 1 static site. These are not the data-backed implementation of the current interactive app.
- `netlify.toml`: static hosting configuration only.
- `.env.example`: future integration variable names only. No current code reads them.

## Current local data and behavior

All current app data is browser-memory state initialized by `assets/js/prototype.js`. The demo starts with 13 premades (7 Available, 4 Reserved, 2 Sold), 5 sample Premade requests, and 9 sample Custom requests. Reset restores the fictional seed records. A page refresh resets all changes; nothing is saved to localStorage, sent to a backend, or synchronized with another browser.

The current source implements client-side flows for Available / Reserved / Sold inventory; Premade requests; manual payment confirmation, separate sale finalization and delivery completion; cancellation/Return to Shop; Custom Full Payment (100%) and Split Payment (60% + 40%); separate payment history entries; the requested Custom order statuses; ownership records; certificate eligibility, preview, edits, approval and local print/download; gallery previews; local settings; and safeguards against repeated actions. These are **simulated administrative records**, not evidence of real orders, payments, ownership, delivery, or legal certificates. No payment gateway is included.

Artwork selected by a user in the browser is preview-only. Object URLs and file selections are not uploaded and will not persist after refresh. Certificate output is a local demonstration document and does not prove real-world ownership. The official Terms of Service remains the legal source of truth: <https://ladykadopts.carrd.co/#.

## What remains local-only / known limitations

- No Supabase project connection, schema, migrations, database adapter, RLS policies, Edge Functions, authentication, or storage exists in this source snapshot.
- No real admin login exists. The footer star opens a demo access mechanism that must not be treated as a security boundary. Do not expose real customer data or use this for live sales until secure backend authorization is implemented.
- Requests, status changes, payments, payment history, delivery, ownership, certificates, and settings exist only in current-page memory and reset on refresh.
- Payment is recorded only by the administrator's local demo action; no funds are processed or verified.
- Telegram is a **future planned administrative notification channel only**. No bot call, bot token, chat ID, or notification is present or used; export sends no notifications. Management actions must remain in the secure admin panel, and a notification must never auto-confirm a payment.
- The earlier Phase 1 pages remain static sample/layout templates and are not a second live, data-connected storefront.
- No browser screenshot/visual QA was performed as part of this packaging handoff; the scripted checks described below are not a substitute for manual browser testing.

## Future Supabase and Telegram work (not implemented)

When development resumes, add a real data/auth boundary rather than putting privileged operations in browser JavaScript. Supabase should own persistent inventory, requests, customers, licenses, payment records/history, ownership, certificates, delivery, and file storage. Configure Row Level Security and secure admin authentication before entering real data. Sensitive actions should be authorized server-side/through trusted functions.

The existing Lady K ★ Fih Telegram bot is intended for administrative alerts only, sent by a Supabase Edge Function or another trusted server-side function. Planned event notifications include new Premade and Custom requests, payments awaiting confirmation, second installment awaiting confirmation, payment confirmed, purchase cancellation/Return to Shop, Custom Ready for Delivery, and order Completed. Do not create a new bot, send notifications from public frontend code, or let notifications perform management actions.

Future configuration names are listed in `.env.example`. `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` must be held only in server-side deployment secrets (such as Supabase Edge Function secrets), never committed or exposed in browser code. A Supabase publishable/anon key may be used in a browser only with correct RLS and restricted policies; it is not a substitute for authorization. At present, the example variables are placeholders and the app does not load them.

## Verification performed for this handoff

The packaged source was checked for: presence of the project files; working relative references from the two interactive entry pages to the editable CSS/JS files; unique HTML IDs in the current entry page; JavaScript syntax parsing; and local QuickJS workflow checks covering the seeded counts, required request fields, reservation/cancellation, payment calculations and duplicates, manual sale/delivery separation, Custom state/payment/certificate rules, and Premade certificate image selection. These scripted checks passed in the workspace. They do not constitute a real-browser visual review, a Netlify deployment test, or backend/security verification.

## Version and handoff statement

This ZIP is generated from the latest project directory available in this workspace, including the latest certificate-fit change: Premade certificate art follows the linked adopt's main image and is not cropped in the responsive review panel. It includes editable source files (`prototype.css`, `assets/js/prototype.js`, the HTML pages, and configuration), not only an exported rendered screenshot or a single HTML attachment.

However, the current workspace does **not** contain a separate production implementation beyond this static frontend project. The current interactive core remains explicitly a local prototype/simulation, as documented above. Therefore this handoff cannot truthfully certify a production-ready, backend-connected “definitive live project.” No source files available in the workspace were intentionally omitted from the ZIP; generated folders (`node_modules`, `dist`, caches) are not applicable/not present.
