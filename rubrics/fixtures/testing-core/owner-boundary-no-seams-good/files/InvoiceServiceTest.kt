package billing

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class InvoiceServiceTest {
    private val fixedClock = Clock.fixed(Instant.parse("2026-05-01T12:00:00Z"), ZoneOffset.UTC)
    private val service = InvoiceService(fixedClock)

    @Test
    fun `issues invoice with half-up tax rounding and clock timestamp`() {
        val invoice = service.issueInvoice("inv-1", subtotalCents = 1_005L, taxBasisPoints = 825)
        assertEquals(83L, invoice.taxCents)
        assertEquals(1_088L, invoice.totalCents)
        assertEquals(Instant.parse("2026-05-01T12:00:00Z"), invoice.issuedAt)
    }
}
