# Philately Passport — working test site

A customer storefront and staff workspace connected to the same persistent database. This version ends at order and **simulated** payment confirmation. It does not collect money, request shipping addresses, or book shipments.

## Start in GitHub Codespaces

Use **Code → Codespaces → Create codespace on this branch**. The checked-in dev container uses Node.js 24, runs the test suite on creation, and starts the site on port **3000**. Open that forwarded port in your browser. Keep the port **private**; the application includes shared test accounts. Codespaces is a temporary development environment, not permanent production hosting; it can stop on inactivity and uses your account's Codespaces allocation.

If the preview does not automatically open, use the **Ports** panel to open port 3000. If the server is stopped, run `npm start` in the repository terminal. Logs: `data/server.log`. The startup script probes the health endpoint to avoid starting a second copy.

## Run locally

Requires Node.js **24.x**. No third-party runtime packages or installation step are needed.

```sh
npm test
npm start
```

Open `http://localhost:3000` for the customer site and `http://localhost:3000/admin` for the staff workspace.

## Test accounts

Use the **Use demo collector account** or **Use demo staff account** button on the appropriate login screen.

| Role | Email | Password |
|---|---|---|
| Customer | collector@philately.test | PassportDemo!2026 |
| Staff | staff@philately.test | PassportDemo!2026 |

These are intentionally public sample credentials. Only use fictional customer information. Creating a test account signs it in without email verification. Account recovery and verified-email delivery are not implemented. Customer and staff roles are enforced by the server; a customer session cannot call staff APIs. Switching roles signs out the current account.

## Try the complete workflow

1. Open the storefront, select 1–5 passports, and choose **Reserve your passport**.
2. Sign in as the demo collector or create an account using fictional details.
3. Review the sample total and acknowledge test mode.
4. Reserve the order, then choose **Simulate successful payment** or **Simulate failed payment**. Cancellation is also available before confirmation.
5. Open **My orders** to see the result and simulated payment reference.
6. Sign out, open the staff dashboard, and use the demo staff account.
7. Review orders, payments, collectors and activity. Search/filter orders, open an order's detail panel, or export CSV.
8. In **Inventory**, edit sample stock/price or pause reservations. Reload the storefront to see the change. Existing orders preserve their original price.

Both ends share a single server database, including across browser sessions. SQLite records live in `data/preview.sqlite` and survive server restarts and Codespace stop/start. They are ignored by Git and disappear if you delete the Codespace. Download/backup the database if test data must be retained. Never commit it.

## Included controls

- Password hashing with scrypt; opaque HttpOnly sessions; staff role checks; customer order ownership.
- Server-calculated prices and amounts in paise. Maximum five units per order.
- Database transactions protect stock holds/allocations; confirmed and held stock cannot exceed inventory.
- Ten-minute holds; failed/cancelled/expired checkouts release stock. Expired checkouts cannot be paid in this simulator.
- Idempotent checkout and simulated payment actions. Terminal outcomes cannot be changed into a different outcome.
- Customer order history, staff order/payment views, stock editing, reservation pause, CSV formula protection and audit history.
- Same-origin write checks, JSON-only mutation endpoints, basic login throttling, bounded input, response security headers.
- Responsive layout, keyboard focus states, native modal dialogs and labelled inputs.

## Technology decision and live integration boundary

For this self-contained preview: **Node.js 24 + browser ES modules + component-rendering functions + built-in SQLite**. There is no framework build or external database provisioning. This deliberately differs from the earlier proposed React/.NET/PostgreSQL production stack. Do not treat this preview as a completed production migration or production hardening exercise.

The only payment action is the clearly labelled `/api/orders/:id/simulate` endpoint. It never calls a provider, handles card credentials, or generates a real payment receipt. For real sales, replace the simulator with a provider adapter, server-created gateway orders, signature-checked events, exact amount/currency matching, capture verification, late-payment resolution, settlement reconciliation and refunds. Do not expose the simulator as a way to mark real orders paid.

Before production: approve price/product artwork, institutional account eligibility, hosting, data retention and policies; replace shared demo credentials, establish verified customer identity/recovery and administrator MFA; implement the selected gateway; migrate or deliberately validate the database/backend choice; add operational backups, durable jobs, monitoring and demand-based load tests. Shipping remains a separate later phase. No official logo or passport artwork is invented: the book illustration is explicitly a mockup.

## Verification

`npm test` exercises role isolation, registration/session invalidation, checkout idempotency, success/failure/cancellation, expiry, price snapshots, stock commitment protection, competing requests for the last unit, paused sales, input validation and response headers. `npm run check` checks server and browser JavaScript syntax. GitHub Actions repeats these checks for pushes and pull requests. The original repository licence is preserved.

## Files

- `server.mjs`: API, authentication, database, inventory and simulator.
- `public/app.js`: storefront, checkout, customer account and dashboard components.
- `public/style.css`: responsive visual design.
- `tests/api.test.mjs`: API/inventory/authentication integration tests.
- `.devcontainer/`: GitHub Codespaces runtime and automatic startup.
- `.github/workflows/test.yml`: automated validation.
