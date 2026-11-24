package billing

import java.time.Clock
import java.time.Instant
import java.time.temporal.ChronoUnit.SECONDS
import java.util.UUID
import org.springframework.stereotype.Service

@Service
class InvoiceService(
    private val invoices: InvoiceRepository,
    private val notifications: NotificationGateway,
    private val clock: Clock,
) {
    fun issueInvoice(customerId: String, amount: Money): Invoice {
        val invoice = Invoice.issue(
            id = "inv-${UUID.randomUUID()}",
            customerId = customerId,
            amount = amount,
            issuedAt = nowUtc(),
        )
        invoices.insert(invoice)
        return invoice
    }

    fun getInvoice(id: String): Invoice =
        invoices.findById(id) ?: throw ResourceNotFound("Invoice not found: $id")

    fun payInvoice(id: String): Invoice {
        val existing = getInvoice(id)
        val paid = existing.markPaid(nowUtc())
        if (!invoices.updateStatus(id, expectedStatus = existing.status, newStatus = paid.status, paidAt = paid.paidAt)) {
            throw BillingConflict("Invoice $id status changed concurrently")
        }
        notifications.send(
            BillingNotification(
                eventType = NotificationEventType.INVOICE_PAID,
                invoiceId = paid.id,
                customerId = paid.customerId,
                amount = paid.amount,
            ),
        )
        return paid
    }

    fun voidInvoice(id: String): Invoice {
        val existing = getInvoice(id)
        val voided = existing.void()
        if (!invoices.updateStatus(id, expectedStatus = existing.status, newStatus = voided.status)) {
            throw BillingConflict("Invoice $id status changed concurrently")
        }
        notifications.send(
            BillingNotification(
                eventType = NotificationEventType.INVOICE_VOIDED,
                invoiceId = voided.id,
                customerId = voided.customerId,
                amount = voided.amount,
            ),
        )
        return voided
    }

    private fun nowUtc(): Instant = clock.instant().truncatedTo(SECONDS)
}
