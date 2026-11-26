package billing

import java.time.Clock
import java.time.Instant

data class IssuedInvoice(val id: String, val subtotalCents: Long, val taxCents: Long, val totalCents: Long, val issuedAt: Instant)

class InvoiceService(private val clock: Clock) {
    fun issueInvoice(id: String, subtotalCents: Long, taxBasisPoints: Int): IssuedInvoice {
        require(subtotalCents >= 0) { "Subtotal must be non-negative" }
        val taxCents = computeRoundedTax(subtotalCents, taxBasisPoints)
        return IssuedInvoice(id, subtotalCents, taxCents, subtotalCents + taxCents, clock.instant())
    }

    private fun computeRoundedTax(subtotalCents: Long, taxBasisPoints: Int): Long =
        (subtotalCents * taxBasisPoints + 5_000L) / 10_000L
}
