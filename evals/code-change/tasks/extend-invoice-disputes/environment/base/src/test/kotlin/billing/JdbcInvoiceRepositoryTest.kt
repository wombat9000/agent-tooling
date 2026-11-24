package billing

import billing.testsupport.FIXED_INSTANT
import billing.testsupport.anInvoice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest
import org.springframework.context.annotation.Import

@JdbcTest
@Import(JdbcInvoiceRepository::class)
class JdbcInvoiceRepositoryTest {
    @Autowired
    private lateinit var repository: JdbcInvoiceRepository

    @Test
    fun `inserts and loads an invoice with exact fields`() {
        val invoice = anInvoice(id = "inv-db-1", customerId = "cust-42", amountCents = 12_500L, currency = Currency.GBP)

        repository.insert(invoice)

        assertEquals(invoice, repository.findById("inv-db-1"))
    }

    @Test
    fun `conditional status update succeeds when expected status matches and rejects stale status`() {
        val invoice = anInvoice(id = "inv-db-2", status = InvoiceStatus.ISSUED)
        val paidAt = FIXED_INSTANT.plusSeconds(90)
        repository.insert(invoice)

        val updated = repository.updateStatus("inv-db-2", InvoiceStatus.ISSUED, InvoiceStatus.PAID, paidAt)
        val staleUpdate = repository.updateStatus("inv-db-2", InvoiceStatus.ISSUED, InvoiceStatus.VOID)

        assertTrue(updated)
        assertFalse(staleUpdate)
        assertEquals(invoice.copy(status = InvoiceStatus.PAID, paidAt = paidAt), repository.findById("inv-db-2"))
    }
}
