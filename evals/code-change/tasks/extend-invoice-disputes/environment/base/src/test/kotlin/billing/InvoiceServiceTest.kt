package billing

import billing.testsupport.FIXED_INSTANT
import billing.testsupport.InMemoryInvoiceRepository
import billing.testsupport.anInvoice
import java.time.Clock
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions

class InvoiceServiceTest {
    private val repository = InMemoryInvoiceRepository()
    private val notifications = mock(NotificationGateway::class.java)
    private val clock = Clock.fixed(FIXED_INSTANT, ZoneOffset.UTC)
    private val service = InvoiceService(repository, notifications, clock)

    @Test
    fun `paying an issued invoice updates stored state and emits paid notification`() {
        val issued = anInvoice(id = "inv-10", customerId = "cust-9", amountCents = 4_500L, currency = Currency.EUR)
        repository.insert(issued)

        val paid = service.payInvoice("inv-10")

        assertEquals(InvoiceStatus.PAID, paid.status)
        assertEquals(FIXED_INSTANT, paid.paidAt)
        assertEquals(paid, repository.findById("inv-10"))
        verify(notifications).send(
            BillingNotification(
                eventType = NotificationEventType.INVOICE_PAID,
                invoiceId = "inv-10",
                customerId = "cust-9",
                amount = Money(4_500L, Currency.EUR),
            ),
        )
    }

    @Test
    fun `voiding an issued invoice updates stored state and emits voided notification`() {
        val issued = anInvoice(id = "inv-11", customerId = "cust-9", amountCents = 2_000L, currency = Currency.USD)
        repository.insert(issued)

        val voided = service.voidInvoice("inv-11")

        assertEquals(InvoiceStatus.VOID, voided.status)
        assertEquals(voided, repository.findById("inv-11"))
        verify(notifications).send(
            BillingNotification(
                eventType = NotificationEventType.INVOICE_VOIDED,
                invoiceId = "inv-11",
                customerId = "cust-9",
                amount = Money(2_000L, Currency.USD),
            ),
        )
    }

    @Test
    fun `voiding an already paid invoice rejects without emitting a notification`() {
        val paid = anInvoice(id = "inv-12", status = InvoiceStatus.PAID)
        repository.insert(paid)

        assertFailsWith<BillingConflict> {
            service.voidInvoice("inv-12")
        }

        assertEquals(paid, repository.findById("inv-12"))
        verifyNoInteractions(notifications)
    }
}
