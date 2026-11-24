package billing

import java.time.Instant

enum class InvoiceStatus {
    ISSUED,
    PAID,
    VOID,
}

data class Invoice(
    val id: String,
    val customerId: String,
    val amount: Money,
    val status: InvoiceStatus,
    val issuedAt: Instant,
    val paidAt: Instant? = null,
) {
    init {
        if (!ID_PATTERN.matches(id)) {
            throw InvalidBillingRequest("Invalid invoice ID")
        }
        if (!CUSTOMER_ID_PATTERN.matches(customerId)) {
            throw InvalidBillingRequest("Customer ID must be 1-64 ASCII letters, digits, underscores, or hyphens")
        }
        if (status == InvoiceStatus.PAID && paidAt == null) {
            throw InvalidBillingRequest("Paid invoice must record paidAt")
        }
        if ((status == InvoiceStatus.ISSUED || status == InvoiceStatus.VOID) && paidAt != null) {
            throw InvalidBillingRequest("Unpaid invoice cannot record paidAt")
        }
    }

    fun markPaid(paidAt: Instant): Invoice {
        if (status != InvoiceStatus.ISSUED) {
            throw BillingConflict("Only ISSUED invoices can be paid")
        }
        return copy(status = InvoiceStatus.PAID, paidAt = paidAt)
    }

    fun void(): Invoice {
        if (status != InvoiceStatus.ISSUED) {
            throw BillingConflict("Only ISSUED invoices can be voided")
        }
        return copy(status = InvoiceStatus.VOID)
    }

    companion object {
        private val ID_PATTERN = Regex("[A-Za-z0-9_-]{1,64}")
        private val CUSTOMER_ID_PATTERN = Regex("[A-Za-z0-9_-]{1,64}")

        fun issue(id: String, customerId: String, amount: Money, issuedAt: Instant): Invoice =
            Invoice(
                id = id,
                customerId = customerId,
                amount = amount,
                status = InvoiceStatus.ISSUED,
                issuedAt = issuedAt,
            )
    }
}
