package billing.testsupport

import billing.BillingNotification
import billing.Currency
import billing.Invoice
import billing.InvoiceRepository
import billing.InvoiceResponse
import billing.InvoiceStatus
import billing.Money
import billing.NotificationGateway
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.MvcResult
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post

val FIXED_INSTANT: Instant = Instant.parse("2030-06-01T12:00:00Z")

fun anInvoice(
    id: String = "inv-1",
    customerId: String = "cust-1",
    amountCents: Long = 10_000L,
    currency: Currency = Currency.USD,
    status: InvoiceStatus = InvoiceStatus.ISSUED,
    issuedAt: Instant = FIXED_INSTANT,
    paidAt: Instant? = if (status == InvoiceStatus.PAID) issuedAt.plusSeconds(60) else null,
): Invoice =
    Invoice(
        id = id,
        customerId = customerId,
        amount = Money(amountCents, currency),
        status = status,
        issuedAt = issuedAt,
        paidAt = paidAt,
    )

class InMemoryInvoiceRepository : InvoiceRepository {
    private val store = LinkedHashMap<String, Invoice>()

    override fun insert(invoice: Invoice) {
        store[invoice.id] = invoice
    }

    override fun findById(id: String): Invoice? = store[id]

    override fun updateStatus(
        id: String,
        expectedStatus: InvoiceStatus,
        newStatus: InvoiceStatus,
        paidAt: Instant?,
    ): Boolean {
        val current = store[id] ?: return false
        if (current.status != expectedStatus) return false
        store[id] = current.copy(status = newStatus, paidAt = paidAt ?: current.paidAt)
        return true
    }
}

class RecordingNotificationGateway : NotificationGateway {
    private val events = CopyOnWriteArrayList<BillingNotification>()

    val sent: List<BillingNotification>
        get() = events.toList()

    override fun send(notification: BillingNotification) {
        events.add(notification)
    }

    fun clear() {
        events.clear()
    }
}

class InvoiceApiClient(
    private val mvc: MockMvc,
    private val json: ObjectMapper,
) {
    fun issueInvoiceRaw(customerId: String, amountCents: Long, currency: String = "USD"): MvcResult =
        mvc.perform(
            post("/invoices")
                .contentType(APPLICATION_JSON)
                .content(
                    json.writeValueAsString(
                        mapOf(
                            "customerId" to customerId,
                            "amountCents" to amountCents,
                            "currency" to currency,
                        ),
                    ),
                ),
        ).andReturn()

    fun issueInvoice(customerId: String = "cust-1", amountCents: Long = 10_000L, currency: String = "USD"): InvoiceResponse =
        readInvoice(issueInvoiceRaw(customerId, amountCents, currency), expectedStatus = 201)

    fun getInvoiceRaw(id: String): MvcResult =
        mvc.perform(get("/invoices/{id}", id)).andReturn()

    fun getInvoice(id: String): InvoiceResponse =
        readInvoice(getInvoiceRaw(id), expectedStatus = 200)

    fun payInvoiceRaw(id: String): MvcResult =
        mvc.perform(post("/invoices/{id}/pay", id)).andReturn()

    fun payInvoice(id: String): InvoiceResponse =
        readInvoice(payInvoiceRaw(id), expectedStatus = 200)

    fun voidInvoiceRaw(id: String): MvcResult =
        mvc.perform(post("/invoices/{id}/void", id)).andReturn()

    fun voidInvoice(id: String): InvoiceResponse =
        readInvoice(voidInvoiceRaw(id), expectedStatus = 200)

    fun readInvoice(result: MvcResult, expectedStatus: Int): InvoiceResponse {
        check(result.response.status == expectedStatus) {
            "Expected HTTP $expectedStatus but got ${result.response.status}: ${result.response.contentAsString}"
        }
        return json.readValue(result.response.contentAsString)
    }
}
