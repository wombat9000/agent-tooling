package billing

import billing.testsupport.FIXED_INSTANT
import billing.testsupport.anInvoice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

class InvoiceTest {
    @ParameterizedTest
    @ValueSource(longs = [0L, -1L, -500L])
    fun `money rejects non-positive amounts`(invalidAmount: Long) {
        assertFailsWith<InvalidBillingRequest> {
            Money(invalidAmount, Currency.USD)
        }
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "   ", "usd", "JPY", "US"])
    fun `currency rejects unsupported codes`(invalidCode: String) {
        assertFailsWith<InvalidBillingRequest> {
            Currency.parse(invalidCode)
        }
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "   ", "bad id", "cust/1"])
    fun `invoice rejects invalid customer identifiers`(invalidCustomerId: String) {
        assertFailsWith<InvalidBillingRequest> {
            Invoice.issue("inv-1", invalidCustomerId, Money(500L, Currency.EUR), FIXED_INSTANT)
        }
    }

    @Test
    fun `marking an issued invoice paid transitions status and records paid timestamp`() {
        val issued = anInvoice(status = InvoiceStatus.ISSUED)
        val paidAt = FIXED_INSTANT.plusSeconds(120)

        val paid = issued.markPaid(paidAt)

        assertEquals(InvoiceStatus.PAID, paid.status)
        assertEquals(paidAt, paid.paidAt)
    }

    @Test
    fun `paying an already paid invoice fails with conflict`() {
        val paid = anInvoice(status = InvoiceStatus.PAID)

        assertFailsWith<BillingConflict> {
            paid.markPaid(FIXED_INSTANT.plusSeconds(300))
        }
    }

    @Test
    fun `voiding an issued invoice transitions status to void`() {
        val issued = anInvoice(status = InvoiceStatus.ISSUED)

        val voided = issued.void()

        assertEquals(InvoiceStatus.VOID, voided.status)
        assertEquals(null, voided.paidAt)
    }

    @Test
    fun `voiding a paid invoice fails with conflict`() {
        val paid = anInvoice(status = InvoiceStatus.PAID)

        assertFailsWith<BillingConflict> {
            paid.void()
        }
    }
}
