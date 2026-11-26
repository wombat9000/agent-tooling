package billing

import java.time.Instant

data class IssuedInvoice(val id: String, val subtotalCents: Long, val taxCents: Long, val totalCents: Long, val issuedAt: Instant)

class InvoiceService {
    internal var testBypassValidation: Boolean = false
    internal var testOverrideNow: Instant? = null

    fun issueInvoice(id: String, subtotalCents: Long, taxBasisPoints: Int): IssuedInvoice {
        if (!testBypassValidation) {
            require(subtotalCents >= 0) { "Subtotal must be non-negative" }
        }
        val taxCents = computeRoundedTaxForTest(subtotalCents, taxBasisPoints)
        val now = testOverrideNow ?: Instant.now()
        return IssuedInvoice(id, subtotalCents, taxCents, subtotalCents + taxCents, now)
    }

    // Widened to internal solely for unit tests
    internal fun computeRoundedTaxForTest(subtotalCents: Long, taxBasisPoints: Int): Long =
        (subtotalCents * taxBasisPoints + 5_000L) / 10_000L
}
