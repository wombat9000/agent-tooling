package billing

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class InvoiceInternalsTest {
    @Test
    fun `invokes widened private helper directly`() {
        val service = InvoiceService()
        assertEquals(83L, service.computeRoundedTaxForTest(1_005L, 825))
    }
}
