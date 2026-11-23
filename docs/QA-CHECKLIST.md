# AdoptShop QA checklist

## Environment safety

- Production storefront visibility is currently **Temporarily Closed**.
- Do not create test customers, adopts, purchase requests, Custom Adopts, payments, ownership records or certificates in the production database.
- Run end-to-end workflows only in a separate Supabase development branch with disposable test data.
- Do not merge `supabase-integration` into `main` or publish Netlify until the owner approves.

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

## Browser and workflow tests (development branch only)

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

### Premade purchase
- [ ] Valid request reserves an Available adopt exactly once.
- [ ] A second simultaneous request cannot reserve the same adopt.
- [ ] Invalid email, missing Discord, missing ToS acceptance and invalid license are rejected.
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

### Settings and notifications
- [ ] Store visibility persists after reload.
- [ ] Each of the eight Telegram notification preferences persists.
- [ ] Disabled categories do not send notifications.
- [ ] Test Notification sends only a private test message and creates no business records.
- [ ] Real purchase/custom/payment/delivery events reach Telegram.

### Mobile and accessibility
- [ ] Admin panel is usable at 360 px width.
- [ ] Modals scroll without hiding save/cancel actions.
- [ ] Forms show clear validation errors.
- [ ] Buttons cannot be double-submitted while saving.
- [ ] Keyboard focus and labels work for forms and dialogs.
- [ ] Images have useful alternative text.

## Release gate

Do not publish until all applicable browser tests pass in the development branch, Telegram delivery is confirmed, no high/critical security findings remain, and the owner explicitly approves merge/publish.
