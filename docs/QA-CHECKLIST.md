# AdoptShop QA checklist

## Environment safety

- Production storefront visibility is currently **Temporarily Closed**.
- The owner requires **US$0 in additional service costs**. Do not create a paid Supabase development branch or enable paid features.
- Do not create test customers, adopts, purchase requests, Custom Adopts, payments, ownership records or certificates in the production database without the owner's explicit approval for a controlled test.
- The Netlify site may be connected to the production Supabase project. Treat any deployed preview as production-connected unless its backend configuration is independently verified.
- Do not merge `supabase-integration` into `main` or publish Netlify until the owner approves.
- Safe checks that do not create business records may be performed against the existing project. Full transaction workflows require either a separately configured free test environment or explicit owner approval for clearly identified production test records and a cleanup plan.

## Non-destructive checks already performed

- Browser JavaScript parses successfully.
- `index.html` and `prototype.html` are synchronized.
- No duplicate HTML IDs were found in the active entry point.
- Admin, auth and public Edge Functions deployed successfully.
- All public-schema tables have RLS enabled.
- No direct anon/authenticated table grants exist on private business tables.
- Security-definer functions are restricted to `service_role` and use a restricted search path.
- Storage buckets are private; no storage objects currently exist.
- No foreign-key indexes are missing.
- Invalid-payload smoke checks reject malformed purchase, custom, manual-sale, transfer and delivery operations without inserting records.
- Public request rate-limit function rejects malformed hashes without inserting a rate-limit row.
- Health advisor has no lints.
- Current security advisor reports 13 informational RLS-enabled/no-policy notices on tables intended to be accessed only through authenticated Edge Functions; no critical/high finding was reported in that advisor run.
- Current performance advisor reports unused indexes. These are informational while the business tables are empty and are not a reason to remove indexes before real usage data exists.

## Safe browser checks (no business records)

### Admin authentication
- [ ] Valid password creates a session and opens the admin panel.
- [ ] Invalid password is rejected.
- [ ] Repeated invalid passwords trigger the 15-minute IP lockout.
- [ ] Refresh preserves a valid session.
- [ ] Logout revokes the session.
- [ ] Expired/revoked tokens cannot call admin actions.
- [ ] Public visitors cannot call admin actions.

### Storefront and visibility
- [ ] Temporarily Closed shows the notice, allows browsing, and blocks purchase/custom submissions.
- [ ] Hidden from Public hides the storefront catalog and blocks submissions.
- [ ] Public displays only visible Available inventory, Reserved listings and visible Sold Archive entries.
- [ ] Public catalog does not expose database UUIDs, private file paths or URL-like included-file values.
- [ ] Private artwork is served only through expiring signed URLs.

### Forms and mobile interface
- [ ] Required-field validation appears clearly for purchase and Custom Adopt forms.
- [ ] Invalid email, missing Discord, missing ToS acceptance and invalid links are rejected.
- [ ] The Custom Adopt form enforces 8 images maximum and 5 MB per image.
- [ ] The interface remains usable at 360 px width.
- [ ] Modals scroll without hiding save/cancel actions.
- [ ] Buttons cannot be double-submitted while saving.
- [ ] Keyboard focus and labels work for forms and dialogs.
- [ ] Images have useful alternative text.

### Settings and notifications
- [ ] Store visibility persists after reload.
- [ ] Each of the eight Telegram notification preferences persists.
- [ ] Disabled categories do not send notifications.
- [ ] Test Notification sends only a private test message and creates no business records.

## Transaction workflows requiring an isolated environment or explicit production-test approval

### Premade purchase
- [ ] Valid request reserves an Available adopt exactly once.
- [ ] A second simultaneous request cannot reserve the same adopt.
- [ ] Approval, invoice-sent and payment-pending actions persist after reload.
- [ ] Payment cannot be confirmed before approval and invoice-sent.
- [ ] Confirmed amount equals the request total.
- [ ] Duplicate payment confirmation does not create another payment.
- [ ] Unpaid request can be returned to shop and retains history.
- [ ] Paid request cannot be cancelled or returned to shop.
- [ ] Manual sale records buyer, license, actual amount, method and ToS acceptance.
- [ ] Manual sale appears in Sold Archive and can proceed to delivery.
- [ ] Delivery creates ownership and a pending-review certificate exactly once.

### Custom Adopt
- [ ] Public request stores the server-set US$37 base and server-calculated license fee.
- [ ] 8 images at or below 5 MB each are accepted.
- [ ] 9 images, non-image files and files over 5 MB are rejected.
- [ ] Failed uploads clean up previously uploaded references.
- [ ] Quote and payment plan persist after reload.
- [ ] Unpaid quote changes reset quote-sent and client-approval flags.
- [ ] Full-payment plan accepts only one 100% payment.
- [ ] Split plan accepts 60% initial payment and 40% final payment only after final approval.
- [ ] Duplicate payment confirmation is blocked.
- [ ] Preview cannot be recorded before payment.
- [ ] Final approval cannot be recorded before preview presentation.
- [ ] Final artwork is stored in the private delivery bucket.
- [ ] Delivery is blocked without final payment, final approval, character name and final artwork.
- [ ] Delivery creates ownership and certificate exactly once.
- [ ] Client feedback, revision notes and progress history persist after reload.
- [ ] Custom ownership transfer remains visibly unavailable until implemented.

### Ownership and certificates
- [ ] Ownership history preserves every prior owner.
- [ ] Only Full Rights Transfer ownership can be transferred.
- [ ] Transfer requires current-owner, new-owner and administrator confirmations.
- [ ] Transfer supersedes the old certificate and creates one pending-review certificate.
- [ ] Certificate approval/rejection persists after reload.
- [ ] Print/Save as PDF and Download HTML produce the correct certificate.
- [ ] No certificate is generated before actual delivery.

### Telegram and release gate
- [ ] Real purchase/custom/payment/delivery events reach Telegram.
- [ ] Telegram test delivery is confirmed from the admin panel.
- [ ] No high/critical security findings remain.
- [ ] All applicable safe browser checks pass.
- [ ] Transaction workflows pass in an isolated free environment, or the owner explicitly approves a controlled production test and its cleanup.
- [ ] The owner explicitly approves Netlify publication and, separately, any merge to `main`.
