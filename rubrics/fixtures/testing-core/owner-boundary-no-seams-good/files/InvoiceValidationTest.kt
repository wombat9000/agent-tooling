package billing

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class InvoiceValidationTest {
    private val service = InvoiceService(Clock.fixed(Instant.parse("2026-05-01T12:00:00Z"), ZoneOffset.UTC))

    @Test
    fun `rejects negative invoice subtotals through public boundary`() {
        assertThrows(IllegalArgumentException::class.java) {
            service.issueInvoice("inv-neg", subtotalCents = -100L, taxBasisPoints = 825)
        }
    }
}
