# AdoptShop QA checklist

## Environment safety

- Production storefront visibility is currently **Public** (verified from `shop_settings`).
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
- [ ] The Custom Adopt form enforces 8 JPG, PNG, WebP, GIF or AVIF images maximum and 5 MB per image.
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

### Inventory artwork storage
- [ ] New adopt artwork uploads use the private bucket and exactly one main image is selected.
- [ ] Failed signed uploads clean up their unlinked storage object.
- [ ] Failed gallery saves clean up unlinked uploads while preserving any object already referenced by a saved image row.
- [ ] Retry after a failed gallery save can re-upload the original selected files.
- [ ] Removed or replaced gallery images no longer leave unused private objects.

### Premade purchase
- [ ] Valid request reserves an Available adopt exactly once.
- [ ] A second simultaneous request cannot reserve the same adopt.
- [ ] Approval, invoice-sent and payment-pending actions persist after reload.
- [ ] Rejected/cancelled requests cannot be reopened through ordinary status edits.
- [ ] Invoice-sent and payment-pending confirmations cannot be reversed; paid request history is locked.
- [ ] Payment can be confirmed directly for an active Reserved request without approval or invoice-sent prerequisites.
- [ ] Confirming payment immediately marks the Adopt Sold and sets it visible in Sold Archive; it does not mark delivery completed.
- [ ] Confirmed amount equals the request total.
- [ ] Duplicate payment confirmation does not create another payment.
- [ ] Unpaid request can be returned to shop and retains history.
- [ ] Generic inventory edits cannot mark an adopt Sold; only confirmed manual sale or paid delivery can do so.
- [ ] A Reserved adopt with an active request cannot be made Available without Return to Shop cancelling that request.
- [ ] A Sold adopt cannot be reopened through ordinary inventory status edits.
- [ ] Paid request cannot be cancelled or returned to shop.
- [ ] Manual sale records buyer, license, actual amount, method and ToS acceptance.
- [ ] Manual sale appears in Sold Archive and can proceed to delivery.
- [ ] A separate actual-delivery action creates ownership and a pending-review certificate exactly once.

### Custom Adopt
- [ ] Public request stores the server-set US$37 base and server-calculated license fee.
- [ ] Submitting with no reference images uses the JSON request path; submissions with references retain the secure multipart upload path.
- [ ] The customer sees a request-received confirmation with the Custom order number, and the existing Telegram bot receives the Custom request alert.
- [ ] 8 images at or below 5 MB each are accepted.
- [ ] 9 images, non-image files and files over 5 MB are rejected.
- [ ] Failed uploads clean up previously uploaded references.
- [ ] Quote and payment plan persist after reload.
- [ ] Payment plan cannot be changed after any payment is confirmed.
- [ ] A paid-order price adjustment requires a matching administrative history entry and preserves previous payment records.
- [ ] Agreed total always equals design quote plus the fixed license fee.
- [ ] Unpaid quote changes reset quote-sent and client-approval flags.
- [ ] Full-payment plan accepts only one 100% payment.
- [ ] Split plan accepts 60% initial payment and 40% final payment only after final approval.
- [ ] Final 40% confirmation also records delivery, creates ownership/certificate records once, and moves the order into Customs Archive; final artwork and character name are required.
- [ ] Full Payment 100% confirmation does not imply delivery; completion remains separate until the work is finished.
- [ ] Duplicate payment confirmation is blocked.
- [ ] Preview cannot be recorded before payment.
- [ ] Final approval cannot be recorded before preview presentation.
- [ ] Final artwork accepts JPG, PNG, WebP, GIF or AVIF only, up to 20 MB, and is stored in the private delivery bucket.
- [ ] Failed final-artwork uploads or failed saves clean up unlinked objects.
- [ ] Replacing or clearing final artwork removes the previous private object only after the new database reference is saved.
- [ ] Full Payment completion is blocked without 100% payment, final approval, character name and final artwork.
- [ ] Public Customs Archive shows only completed final artwork, Custom ID, character name and category; buyer contact, client references and payment history remain private.
- [ ] Active Custom requests never appear in the public Adopt catalog or Home inventory.
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
