package billing

import billing.testsupport.InvoiceApiClient
import billing.testsupport.RecordingNotificationGateway
import com.fasterxml.jackson.databind.ObjectMapper
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import org.junit.jupiter.api.BeforeEach
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc

@SpringBootTest(classes = [InvoiceBillingApplication::class, InvoiceApiTest.NotificationTestConfig::class])
@AutoConfigureMockMvc
class InvoiceApiTest {
    @TestConfiguration
    class NotificationTestConfig {
        @Bean
        @Primary
        fun recordingNotificationGateway(): RecordingNotificationGateway = RecordingNotificationGateway()
    }

    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var json: ObjectMapper
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var notifications: RecordingNotificationGateway

    private lateinit var api: InvoiceApiClient

    @BeforeEach
    fun resetState() {
        jdbc.update("DELETE FROM invoices")
        notifications.clear()
        api = InvoiceApiClient(mvc, json)
    }

    @Test
    fun `issues pays and fetches an invoice while notifying the external gateway`() {
        val created = api.issueInvoice(customerId = "acme-1", amountCents = 8_500L, currency = "USD")

        assertEquals("ISSUED", created.status)
        assertEquals("acme-1", created.customerId)
        assertEquals(8_500L, created.amountCents)
        assertEquals("USD", created.currency)

        val paid = api.payInvoice(created.id)
        val fetched = api.getInvoice(created.id)

        assertEquals("PAID", paid.status)
        assertNotNull(paid.paidAt)
        assertEquals(paid, fetched)
        assertEquals(
            listOf(
                BillingNotification(
                    eventType = NotificationEventType.INVOICE_PAID,
                    invoiceId = created.id,
                    customerId = "acme-1",
                    amount = Money(8_500L, Currency.USD),
                ),
            ),
            notifications.sent,
        )
    }

    @Test
    fun `rejects voiding a paid invoice with conflict and preserves invoice state`() {
        val created = api.issueInvoice(customerId = "acme-2", amountCents = 3_000L, currency = "EUR")
        val paid = api.payInvoice(created.id)
        notifications.clear()

        val result = api.voidInvoiceRaw(created.id)

        assertEquals(409, result.response.status)
        assertEquals(paid, api.getInvoice(created.id))
        assertEquals(emptyList(), notifications.sent)
    }

    @Test
    fun `returns not found for unknown invoice`() {
        val result = api.getInvoiceRaw("inv-missing")

        assertEquals(404, result.response.status)
    }
}
