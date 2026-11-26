package billing

import java.time.Instant
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class InvoiceServiceTest {
    @Test
    fun `issues invoice using test-only production hooks`() {
        val service = InvoiceService()
        service.testBypassValidation = true
        service.testOverrideNow = Instant.parse("2026-05-01T12:00:00Z")

        val invoice = service.issueInvoice("inv-1", subtotalCents = 1_005L, taxBasisPoints = 825)
        assertEquals(1_088L, invoice.totalCents)
    }
}
