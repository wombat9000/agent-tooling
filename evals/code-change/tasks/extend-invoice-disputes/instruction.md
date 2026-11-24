# Invoice Disputes

Extend the existing Kotlin Spring Boot invoice billing service under `src/main/kotlin/billing/` to support opening and resolving disputes on paid invoices. Preserve all existing invoice issuance, lookup, payment, and voiding behavior.

## Project and storage

- Keep the existing Spring Boot Web, JDBC, and in-memory H2 setup (`billing.InvoiceBillingApplication`, `application.properties`, and `schema.sql`). Do not add ORM dependencies such as Hibernate or JPA.
- Keep the existing `invoices` table and initialize a `disputes` table at startup in `schema.sql`. H2 is the source of truth for both invoices and disputes.
- The verifier inspects persisted state in both `invoices` and `disputes`. The `disputes` table must include at least these unquoted columns:
  - `id` (`VARCHAR`)
  - `invoice_id` (`VARCHAR`)
  - `reason_category` (`VARCHAR`)
  - `description` (`VARCHAR`)
  - `requested_amount_cents` (`BIGINT`)
  - `status` (`VARCHAR`)
  - `refund_amount_cents` (`BIGINT`, nullable)
  - `resolution_note` (`VARCHAR`, nullable)
  - `opened_at` (`TIMESTAMP WITH TIME ZONE`)
  - `resolved_at` (`TIMESTAMP WITH TIME ZONE`, nullable)

## Dispute rules

### Invoice lifecycle updates

- Extend `InvoiceStatus` with `DISPUTED` and `REFUNDED` alongside `ISSUED`, `PAID`, and `VOID`.
- Opening a dispute on a `PAID` invoice transitions the invoice status to `DISPUTED`.
- Resolving a dispute with `FULL_REFUND` or `PARTIAL_REFUND` transitions the invoice status to `REFUNDED`.
- Resolving a dispute with `REJECT` returns the invoice status to `PAID`.
- Existing payment (`POST /invoices/{id}/pay`) and void (`POST /invoices/{id}/void`) endpoints remain allowed only on `ISSUED` invoices and return `409` for `PAID`, `VOID`, `DISPUTED`, and `REFUNDED` invoices.

### Opening a dispute

- Endpoint: `POST /invoices/{invoiceId}/disputes` (`Content-Type: application/json`).
- Request JSON body:
  - `reasonCategory` (required string): must be one of `DUPLICATE_CHARGE`, `UNAUTHORIZED`, `SERVICE_NOT_DELIVERED`, or `BILLING_ERROR`.
  - `description` (required string): after trimming leading and trailing whitespace, length must be between `10` and `500` characters inclusive. Persist and return the trimmed value.
  - `requestedAmountCents` (required JSON integer): must be at least `1` and at most the invoice's `amountCents`.
- Return `404` if `invoiceId` does not exist.
- Return `400` for malformed JSON, missing or invalid fields, unknown `reasonCategory`, out-of-bounds `description`, or `requestedAmountCents` less than `1` or greater than the invoice's `amountCents`.
- Return `409` if:
  - the invoice is not currently in `PAID` status (`ISSUED`, `VOID`, `DISPUTED`, or `REFUNDED`),
  - the current UTC time is strictly more than 30 days (`720` hours) after the invoice's `paidAt` timestamp (exactly 30 days after `paidAt` is still allowed), or
  - the invoice already has `2` total disputes recorded in its history (whether open or resolved).
- Generate each dispute `id` on the server. It must be unique and match `[A-Za-z0-9_-]+`.
- Persist the dispute with status `OPEN`, `refundAmountCents = null`, `resolutionNote = null`, `openedAt` set to current UTC time (whole-second precision, matching existing invoice timestamps), and `resolvedAt = null`.
- Atomicity: opening a dispute and transitioning the invoice from `PAID` to `DISPUTED` must be atomic. Concurrent requests to open a dispute on the same invoice must allow at most one to succeed (`201`) and reject the rest with `409`. Failed requests must leave `invoices` and `disputes` unchanged.

### Resolving a dispute

- Endpoint: `POST /invoices/{invoiceId}/disputes/{disputeId}/resolve` (`Content-Type: application/json`).
- Request JSON body:
  - `decision` (required string): must be one of `FULL_REFUND`, `PARTIAL_REFUND`, or `REJECT`.
  - `refundAmountCents` (optional JSON integer depending on `decision`):
    - For `FULL_REFUND`: if omitted or `null`, defaults to the invoice's full `amountCents`; if provided, must equal the invoice's `amountCents` (any other value returns `400`).
    - For `PARTIAL_REFUND`: required; must satisfy `1 <= refundAmountCents <= dispute.requestedAmountCents` and `refundAmountCents < invoice.amountCents` (any other value returns `400`).
    - For `REJECT`: must be omitted or `null` (providing any non-null integer, including `0`, returns `400`).
  - `resolutionNote` (required string): after trimming leading and trailing whitespace, length must be between `5` and `500` characters inclusive. Persist and return the trimmed value.
- Return `404` if `invoiceId` does not exist, `disputeId` does not exist, or `disputeId` belongs to a different invoice.
- Return `400` for malformed JSON, missing or invalid fields, unknown `decision`, invalid `refundAmountCents` for the decision, or out-of-bounds `resolutionNote`.
- Return `409` if the dispute is not currently `OPEN`.
- Resulting dispute and invoice states:
  - `FULL_REFUND`: dispute status `RESOLVED_REFUNDED`, `refundAmountCents = invoice.amountCents`, invoice status `REFUNDED`.
  - `PARTIAL_REFUND`: dispute status `RESOLVED_PARTIAL_REFUND`, `refundAmountCents = <provided>`, invoice status `REFUNDED`.
  - `REJECT`: dispute status `RESOLVED_REJECTED`, `refundAmountCents = null`, invoice status `PAID`.
- Set `resolvedAt` to the current UTC time (whole-second precision).
- Atomicity: resolving a dispute and updating the invoice status must be atomic. Concurrent requests to resolve the same `OPEN` dispute must allow at most one to succeed (`200`) and reject the rest with `409`. Failed requests must leave `invoices` and `disputes` unchanged.

## Outbound notifications

- Extend `billing.NotificationEventType` with `DISPUTE_OPENED` and `DISPUTE_RESOLVED`.
- Send a `BillingNotification` through the existing `billing.NotificationGateway` bean only after a state transition succeeds (never on rejected requests):
  - On dispute opened:
    - `eventType = NotificationEventType.DISPUTE_OPENED`
    - `invoiceId = invoice.id`
    - `customerId = invoice.customerId`
    - `amount = Money(dispute.requestedAmountCents, invoice.amount.currency)`
    - `metadata` containing `"disputeId" -> dispute.id` and `"reasonCategory" -> dispute.reasonCategory.name`
  - On dispute resolved:
    - `eventType = NotificationEventType.DISPUTE_RESOLVED`
    - `invoiceId = invoice.id`
    - `customerId = invoice.customerId`
    - `amount = Money(refundAmountCents, invoice.amount.currency)` for `FULL_REFUND` / `PARTIAL_REFUND`, or `invoice.amount` for `REJECT`
    - `metadata` containing `"disputeId" -> dispute.id`, `"decision" -> decision.name`, `"disputeStatus" -> resolvedDispute.status.name`, and `"refundAmountCents" -> (refundAmountCents ?: 0L).toString()`

## HTTP contract

| Method and path | Successful response |
| --- | --- |
| `POST /invoices` | `201` and the created invoice (with `"disputes": []`) |
| `GET /invoices/{id}` | `200` and the invoice including its `"disputes"` array ordered by `openedAt` ascending, then `id` ascending |
| `POST /invoices/{id}/pay` | `200` and the paid invoice |
| `POST /invoices/{id}/void` | `200` and the voided invoice |
| `POST /invoices/{id}/disputes` | `201` and the opened dispute |
| `POST /invoices/{id}/disputes/{disputeId}/resolve` | `200` and the resolved dispute |

Dispute JSON shape:

```json
{
  "id": "disp-1",
  "invoiceId": "inv-1",
  "reasonCategory": "DUPLICATE_CHARGE",
  "description": "Charged twice for May subscription",
  "requestedAmountCents": 5000,
  "status": "OPEN",
  "refundAmountCents": null,
  "resolutionNote": null,
  "openedAt": "2030-06-02T10:00:00Z",
  "resolvedAt": null
}
```

Invoice JSON shape from `GET /invoices/{id}`:

```json
{
  "id": "inv-1",
  "customerId": "cust-1",
  "amountCents": 10000,
  "currency": "USD",
  "status": "DISPUTED",
  "issuedAt": "2030-06-01T12:00:00Z",
  "paidAt": "2030-06-01T12:05:00Z",
  "disputes": [
    {
      "id": "disp-1",
      "invoiceId": "inv-1",
      "reasonCategory": "DUPLICATE_CHARGE",
      "description": "Charged twice for May subscription",
      "requestedAmountCents": 5000,
      "status": "OPEN",
      "refundAmountCents": null,
      "resolutionNote": null,
      "openedAt": "2030-06-02T10:00:00Z",
      "resolvedAt": null
    }
  ]
}
```

- Error response bodies and status precedence when a request has multiple errors are up to you.

## Tests and verification

Update or add tests under `src/test/kotlin/billing/` covering the dispute workflow, validation rules, lifecycle transitions, time window, persistence, outbound notifications, and existing invoice functionality. Verify with `./gradlew test`.
