# Lady K ★ Fih — AdoptShop

Current source for the Lady K ★ Fih AdoptShop storefront and private administration panel.

## Application

- Main entry point: `index.html`
- Compatibility entry point: `prototype.html` (same storefront and application code)
- Styles: `prototype.css`
- Application logic: `assets/js/prototype.js`
- Supabase browser client: `assets/js/supabase-client.js`
- Backend functions: `supabase/functions/`
- Database SQL: `supabase/sql/`
- Hosting configuration: `netlify.toml`

The older standalone HTML routes are retained as redirects to the corresponding section of `index.html`. They are not separate storefront implementations.

## Architecture and services

The application uses plain HTML, CSS and JavaScript. Supabase provides persistent data, private storage, server-side administrative authorization and the API boundary.

- Public catalog reads available and reserved inventory from the Supabase-backed public API.
- Premade purchase requests are submitted to the public API and stored in the database. Buyers do not need accounts.
- Custom Adopt requests are submitted through the public API. Up to 8 reference images are accepted, with a maximum of 5 MB per image.
- The administration panel uses password-only login and server-validated admin sessions.
- Inventory creation, editing, image uploads, gallery ordering and publication settings are connected to the admin API.
- Purchase and Custom request records, customer details, payment history, ownership records, certificates and activity history are stored in Supabase.
- Payment is manually verified by the artist. The shop does not collect or process money.
- Manual premade sales are recorded through an atomic database transaction. Buyer details, the purchase request, confirmed payment, inventory status and activity history are saved together. Duplicate manual sales are blocked by inventory state and active-request checks.
- Delivery is a separate administrative action. Ownership and the certificate record are created by the existing delivery transaction after delivery is actually completed. Certificates begin in Pending Review and require artist approval.
- Telegram notifications are private administrative alerts sent server-side. They never confirm payments or perform management actions.

## Manual sale workflow

Use the Adoptable record in the admin panel and choose Sold for an Available adoptable. The form requires the buyer's full name, email, Discord username, license, amount received, payment method, confirmation of Terms acceptance and explicit confirmation that payment was received.

Saving the form:
1. Creates or updates the buyer record.
2. Creates a linked purchase request marked Payment Confirmed.
3. Creates one confirmed payment-history entry.
4. Marks the adoptable Sold.
5. Records the action in the activity log.
6. Leaves delivery pending.

After the actual files have been delivered, use the separate delivery action on the purchase request. That transaction creates the ownership record and certificate for review. The manual-sale form does not send files, issue a refund, or process a payment.

## Important limitations

- No payment gateway is connected. Payment confirmation means the artist has independently checked that funds were received.
- Store profile/settings editing and notification preference editing are not currently available in the admin panel; the settings page explains this rather than offering local-only save controls.
- Some Custom Adopt workflow controls still require additional integration and browser verification. Do not treat any action as complete unless the panel confirms it was saved and the corresponding database record is present.
- Certificate review and approval are administrative records; certificate documents do not replace the official Terms of Service.
- No real customer, inventory, purchase, payment or ownership records were created as part of development or testing.
- The frontend has not yet undergone a complete browser end-to-end test. Successful Edge Function deployment and database function verification do not prove every browser interaction works.

## Supabase deployment

Project reference: `nzobepexodnbirivsxtm`

Edge Functions:
- `admin-auth`
- `admin-api`
- `public-api`

The `admin-api` function uses its own password/session authorization, so its Supabase JWT verification setting remains disabled intentionally. Do not remove the function's internal session validation.

Secrets such as the service-role key, admin password/session secret, Telegram bot token and Telegram chat ID must remain in Supabase Edge Function Secrets. Never place them in browser code, commit them to Git, or paste them into public issue trackers.

Database SQL files document the database functions and hardening changes. The manual-sale transaction is in `supabase/sql/manual-sale-transaction.sql`; it has been installed in the connected Supabase project and is executable only by `service_role`.

## Git and publishing

Development branch: `supabase-integration`

Work on this branch only. Do not merge it into `main` or publish it to the production Netlify site without explicit approval. Netlify is already connected to GitHub; changes committed to this development branch are not proof that the production site has been updated.

There is no build step. Netlify publishes the repository root as configured by `netlify.toml`.

## Local review

From the repository root, run:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. Browser-only review of the storefront can use the local server, but Supabase-backed requests require the configured application URL and backend CORS settings. Do not create test sales or alter real customer/inventory data in production merely to test the interface.
