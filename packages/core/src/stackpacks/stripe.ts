/**
 * Stripe (payments) reference stack pack.
 *
 * Real, current (2026) guidance for integrating Stripe with a Node/TypeScript
 * backend using the Stripe Node SDK 19.x. The whole pack is organised around the
 * two failure modes that cost real money: webhook signature verification against
 * the RAW request body, and idempotency (both the Stripe-Idempotency-Key on
 * mutating API calls and deduping inbound webhook events on event.id, because
 * Stripe delivers at-least-once). It also encodes the server-only secret-key
 * rule, fulfilling on the verified webhook rather than the client redirect, and
 * pinning the API version so an SDK upgrade never silently reshapes payloads.
 */

import type { KnownFailure, Rule, StackPack, VersionCheck } from '../domain/index';

// Stripe is a payments library, not a framework — it can back a JS/TS server on
// any of these frameworks. A `stripe` deployment-target hint force-matches it.
const STRIPE_FRAMEWORKS = ['nextjs', 'react', 'vite', 'node', 'express'];
const JS_LANGUAGES = ['typescript', 'javascript'];

const bestPractices: Rule[] = [
  {
    id: 'stripe.webhook-raw-body-signature',
    title: 'Verify every webhook against the RAW body with webhooks.constructEvent',
    detail:
      'Read the unparsed request body (Buffer/string) and call stripe.webhooks.constructEvent(rawBody, stripe-signature header, STRIPE_WEBHOOK_SECRET). This proves the event came from Stripe and was not tampered with. Only act on the event after verification succeeds; respond HTTP 400 when it throws.',
    severity: 'critical',
    appliesTo: ['billing', 'api', 'service'],
  },
  {
    id: 'stripe.webhook-idempotent-dedupe',
    title: 'Dedupe inbound webhooks on event.id before doing any work',
    detail:
      'Stripe delivers events at-least-once and retries on any non-2xx or timeout, so the same event.id can arrive many times. Record processed event ids (a unique DB column or Redis SET NX) and short-circuit duplicates so fulfilment, provisioning, and emails happen exactly once.',
    severity: 'critical',
    appliesTo: ['billing', 'service'],
  },
  {
    id: 'stripe.idempotency-key-on-writes',
    title: 'Send a Stripe-Idempotency-Key on every state-mutating API call',
    detail:
      'Pass { idempotencyKey } (derived from your own operation id, e.g. an order id) when creating PaymentIntents, Checkout Sessions, subscriptions, or refunds. A network retry then returns the original result instead of charging the customer twice.',
    severity: 'high',
    appliesTo: ['billing', 'service', 'api'],
  },
  {
    id: 'stripe.secret-key-server-only',
    title: 'Initialise the Stripe secret client only in server code',
    detail:
      'new Stripe(STRIPE_SECRET_KEY) belongs in a server module. The browser uses @stripe/stripe-js with the publishable key. A leaked secret key grants full account access, so keep it out of any client bundle and out of NEXT_PUBLIC_/VITE_ env vars.',
    severity: 'critical',
    appliesTo: ['billing', 'service', 'config'],
  },
  {
    id: 'stripe.pin-api-version',
    title: 'Pin the API version in the Stripe constructor',
    detail:
      'Pass { apiVersion: "2025-..." } so an SDK bump does not silently change request/response and webhook payload shapes. Upgrade the pinned version deliberately, reading the changelog and testing webhook handlers against the new shape first.',
    severity: 'medium',
    appliesTo: ['billing', 'config'],
  },
  {
    id: 'stripe.fulfil-on-webhook-not-redirect',
    title: 'Fulfil the order from the verified webhook, not the success redirect',
    detail:
      'The browser can drop the checkout success redirect (closed tab, flaky network) while the payment still succeeds. Treat checkout.session.completed / payment_intent.succeeded (and, for delayed methods, the *.async_payment_* events) as the source of truth for granting access, and use the redirect only for UX.',
    severity: 'high',
    appliesTo: ['billing', 'service'],
  },
  {
    id: 'stripe.server-side-pricing',
    title: 'Price from server-side Prices/Products, never a client-supplied amount',
    detail:
      'Build Checkout Sessions and PaymentIntents from Price/Product ids (or amounts computed on the server) so a tampered client cannot pay $0.01 for a $100 item. The client sends only identifiers (a price id or cart), and the server resolves the real amount.',
    severity: 'critical',
    appliesTo: ['billing', 'api', 'service'],
  },
  {
    id: 'stripe.ack-fast-defer-work',
    title: 'Acknowledge the webhook quickly and offload heavy work',
    detail:
      'Stripe expects a 2xx within its delivery timeout; slow handlers get marked failed and retried, causing duplicate deliveries. Verify, persist the event, return 200 immediately, and process expensive fulfilment on a queue/background task keyed by event.id.',
    severity: 'high',
    appliesTo: ['billing', 'api', 'service'],
  },
  {
    id: 'stripe.check-livemode-and-type',
    title: 'Branch on a whitelist of event.type and honour event.livemode',
    detail:
      'Switch on the specific event.type values you handle and ignore the rest instead of assuming a shape. Check event.livemode so a test-mode event can never mutate production data, and keep separate signing secrets per environment.',
    severity: 'medium',
    appliesTo: ['billing', 'service'],
  },
  {
    id: 'stripe.restricted-keys-and-rotation',
    title: 'Use restricted API keys with least privilege and rotate on exposure',
    detail:
      'For scoped integrations use a Restricted Key limited to the resources it needs rather than the full secret key. Store keys in a secret manager, inject at runtime, and rotate immediately (and audit) if a key is ever printed to logs or a client bundle.',
    severity: 'high',
    appliesTo: ['billing', 'config', 'env'],
  },
  {
    id: 'stripe.link-customer-metadata',
    title: 'Link Stripe customers to your users via a stored customer id',
    detail:
      'Create one Stripe Customer per user, persist its id on your user row, and pass client_reference_id / metadata on sessions so webhook events map back to the right account. Reconcile subscription state from customer.subscription.* events rather than trusting a single checkout.',
    severity: 'medium',
    appliesTo: ['billing', 'service', 'schema'],
  },
];

const antiPatterns: Rule[] = [
  {
    id: 'stripe.anti.parse-body-before-verify',
    title: 'Parsing the webhook body (JSON) before constructEvent',
    detail:
      'Any express.json()/req.json() or reserialization before verification changes the exact bytes Stripe signed, so constructEvent throws "No signatures found matching...". Mount the raw-body parser only on the webhook route and verify before parsing.',
    severity: 'critical',
    appliesTo: ['billing', 'api', 'middleware'],
  },
  {
    id: 'stripe.anti.secret-key-in-client',
    title: 'Using the secret key in browser/client code',
    detail:
      'Putting STRIPE_SECRET_KEY behind NEXT_PUBLIC_/VITE_ or calling new Stripe(secret) in a client component ships full account access to every visitor. The client only ever gets the publishable key.',
    severity: 'critical',
    appliesTo: ['billing', 'component', 'env'],
  },
  {
    id: 'stripe.anti.no-idempotency',
    title: 'Creating charges/subscriptions without idempotency protection',
    detail:
      'Without a Stripe-Idempotency-Key on writes and without event.id dedupe on webhooks, a retry (yours or Stripe\'s) double-charges the customer or double-provisions. Both layers are required.',
    severity: 'critical',
    appliesTo: ['billing', 'service'],
  },
  {
    id: 'stripe.anti.trust-client-amount',
    title: 'Charging an amount that came from the client',
    detail:
      'Reading price/quantity from the request body and charging it lets an attacker rewrite the total. Resolve amounts from server-side Price ids or a server-computed cart.',
    severity: 'critical',
    appliesTo: ['billing', 'api'],
  },
  {
    id: 'stripe.anti.fulfil-on-redirect',
    title: 'Granting access on the checkout success URL alone',
    detail:
      'The success redirect can be skipped or replayed and is not proof of payment. Provision only on the verified webhook; use the redirect for a thank-you page.',
    severity: 'high',
    appliesTo: ['billing', 'route', 'service'],
  },
  {
    id: 'stripe.anti.log-card-data',
    title: 'Logging raw card/PII or full event payloads',
    detail:
      'Never log PANs, CVCs, or full customer PII; besides PCI scope this leaks data into log stores. Use Stripe Elements/Checkout so raw card data never touches your server, and log ids not payloads.',
    severity: 'high',
    appliesTo: ['billing', 'service'],
  },
  {
    id: 'stripe.anti.blocking-webhook',
    title: 'Doing slow work synchronously inside the webhook handler',
    detail:
      'Long synchronous fulfilment (emails, provisioning, third-party calls) inside the handler risks exceeding Stripe\'s timeout, so Stripe marks it failed and redelivers, multiplying the work. Return 200 fast and defer.',
    severity: 'medium',
    appliesTo: ['billing', 'service'],
  },
];

const versionChecks: VersionCheck[] = [
  {
    pkg: 'stripe',
    supported: '^19',
    note: 'Stripe Node SDK 19.x. Verify webhooks with webhooks.constructEvent over the raw body, pin apiVersion in the constructor, and pass idempotencyKey on mutating requests.',
  },
  {
    pkg: '@stripe/stripe-js',
    supported: '^4',
    note: 'Browser SDK that loads Stripe.js with the publishable key for Elements / redirectToCheckout. It never sees the secret key.',
  },
  {
    pkg: '@stripe/react-stripe-js',
    supported: '^3',
    note: 'React bindings (Elements provider, PaymentElement) for collecting payment details client-side so raw card data never reaches your server (keeps you out of PCI SAQ-D scope).',
  },
  {
    pkg: 'typescript',
    supported: '^5',
    note: 'TypeScript 5.x for the strict flags (noUncheckedIndexedAccess, verbatimModuleSyntax) and the discriminated Stripe.Event union the SDK ships.',
  },
];

const commonFailures: KnownFailure[] = [
  {
    id: 'stripe.fail.webhook-no-signatures',
    signature:
      'Webhook Error: No signatures found matching the expected signature for payload / "Webhook payload must be provided as a string or a Buffer instance"',
    cause:
      'The request body was parsed or reserialized (express.json(), req.json()) before stripe.webhooks.constructEvent, so it no longer matches the bytes Stripe signed — or the wrong STRIPE_WEBHOOK_SECRET was used.',
    fix: 'Capture the raw body on the webhook route only (express.raw({ type: "application/json" }) or req.text()), pass it plus the stripe-signature header to constructEvent, and confirm the signing secret matches this endpoint/environment.',
  },
  {
    id: 'stripe.fail.double-charge-on-retry',
    signature: 'A customer is charged twice / a subscription is created twice after a retry or a duplicate webhook',
    cause:
      'The create call had no Stripe-Idempotency-Key, and/or the webhook handler did not dedupe on event.id, so a retried request or redelivered event ran the mutation again.',
    fix: 'Attach { idempotencyKey } to create requests and persist processed event.id values (unique constraint / SET NX), short-circuiting duplicate deliveries before any charge or provisioning.',
  },
  {
    id: 'stripe.fail.api-version-mismatch',
    signature: 'A webhook handler suddenly reads undefined fields / a property moved or was renamed after an SDK upgrade',
    cause: 'apiVersion was not pinned in the constructor, so upgrading the stripe package shifted the API version and reshaped payloads.',
    fix: 'Pin { apiVersion } in new Stripe(...), and when intentionally upgrading it, replay real events against the handlers and update the field access before rolling out.',
  },
  {
    id: 'stripe.fail.fulfilment-not-triggered',
    signature: 'Payment succeeded in the Stripe dashboard but the user never got access / the order was not fulfilled',
    cause: 'Fulfilment was tied to the browser success redirect, which the user never completed, instead of the verified webhook.',
    fix: 'Move provisioning into the checkout.session.completed / payment_intent.succeeded webhook handler (plus the async_payment_* events for delayed methods) and reconcile any missed events from the Stripe dashboard event log.',
  },
  {
    id: 'stripe.fail.webhook-timeout-retries',
    signature: 'The Stripe dashboard shows webhook deliveries failing/timing out and being retried, with duplicated side effects',
    cause: 'The handler did slow synchronous work (emails, third-party calls) and exceeded Stripe\'s delivery timeout, so Stripe marked it failed and redelivered.',
    fix: 'Verify, persist the event, and return 200 immediately, then process fulfilment asynchronously on a queue keyed by event.id.',
  },
  {
    id: 'stripe.fail.test-key-in-live',
    signature: 'Error: "No such customer" / "a similar object exists in test mode, but a live mode key was used" (or the reverse)',
    cause: 'A test-mode object id was used with a live-mode key (or vice versa); the two modes are isolated and their ids do not cross over.',
    fix: 'Use one key pair and one webhook signing secret per environment, gate on event.livemode, and never mix sk_test_/sk_live_ keys across environments.',
  },
];

/**
 * The Stripe payments reference pack. Matches when the detected stack advertises
 * a `stripe` deployment target, or is a JS/TS app on a server-capable framework.
 */
export const stripePack: StackPack = {
  id: 'stripe-payments',
  name: 'Stripe (Node SDK 19) — payments & billing',
  matches: (stack) =>
    stack.deploymentTargets.includes('stripe') ||
    (JS_LANGUAGES.includes(stack.language) && STRIPE_FRAMEWORKS.includes(stack.framework)),
  bestPractices,
  antiPatterns,
  recommendedLibraries: [
    'stripe@^19',
    '@stripe/stripe-js@^4',
    '@stripe/react-stripe-js@^3',
    'zod@^3',
    'typescript@^5',
    'vitest@^2',
  ],
  versionChecks,
  setupCommands: [
    'pnpm add stripe',
    'pnpm add @stripe/stripe-js @stripe/react-stripe-js',
    'pnpm dlx stripe login',
    'pnpm dlx stripe listen --forward-to localhost:3000/api/webhooks/stripe',
  ],
  testCommands: [
    'pnpm exec tsc --noEmit',
    'pnpm exec vitest run',
    'pnpm dlx stripe trigger checkout.session.completed',
    'pnpm dlx stripe trigger payment_intent.succeeded',
  ],
  qualityGates: [
    'Every webhook route verifies the signature against the raw body with webhooks.constructEvent and returns 400 on failure.',
    'Inbound webhooks are deduped on event.id (unique DB column or Redis SET NX) so fulfilment runs exactly once.',
    'All mutating API calls (PaymentIntents, Checkout Sessions, subscriptions, refunds) pass a Stripe-Idempotency-Key.',
    'The secret key is read only in server code and never carries a NEXT_PUBLIC_/VITE_ prefix; the client uses the publishable key.',
    'apiVersion is pinned in the Stripe constructor.',
    'Order amounts are resolved from server-side Prices/Products, never from a client-supplied amount.',
    'Access is granted from the verified webhook, not the checkout success redirect.',
    'Unit/integration tests cover signature verification, duplicate-event handling, and the subscription lifecycle events.',
  ],
  securityNotes: [
    'Verify webhooks with stripe.webhooks.constructEvent(rawBody, stripe-signature header, STRIPE_WEBHOOK_SECRET) over the UNPARSED body; a parsed body always fails verification.',
    'The signing secret (STRIPE_WEBHOOK_SECRET) is per-endpoint and per-environment — store it in a secret manager, never commit it, and rotate on exposure.',
    'Keep the secret/restricted key server-only; a leaked key is full (or scoped) account access and must be rotated immediately.',
    'Use Stripe Elements / Checkout so raw card data (PAN/CVC) never touches your server, keeping you out of PCI SAQ-D scope; never log card data or full event payloads.',
    'Dedupe on event.id and use Stripe-Idempotency-Key on writes so retries can never double-charge or double-provision.',
    'Honour event.livemode and keep separate keys/secrets per environment so a test event can never mutate production.',
    'Resolve prices from server-side Price/Product ids so a tampered client cannot control the amount charged.',
  ],
  deploymentNotes: [
    'Register a production webhook endpoint in the Stripe dashboard and store its signing secret as STRIPE_WEBHOOK_SECRET; each environment (prod/preview/dev) needs its own endpoint and secret.',
    'Run the webhook handler on a Node runtime (the SDK needs Node crypto) — on Vercel/Next set export const runtime = "nodejs".',
    'Inject STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET from a secret manager at runtime; never bake them into an image or client bundle.',
    'Use `stripe listen --forward-to` for local development and `stripe trigger` in CI to exercise handlers without real charges.',
    'Enable automatic retries on your side idempotently, and monitor the dashboard event log to reconcile any webhook deliveries that failed permanently.',
  ],
  commonFailures,
};
