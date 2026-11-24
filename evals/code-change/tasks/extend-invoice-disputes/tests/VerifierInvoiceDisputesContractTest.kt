package billing

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit.SECONDS
import javax.sql.DataSource
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary
import org.springframework.http.MediaType
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.MvcResult
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post

@SpringBootTest(classes = [InvoiceBillingApplication::class, VerifierInvoiceDisputesContractTest.VerifierConfig::class])
@AutoConfigureMockMvc
class VerifierInvoiceDisputesContractTest {
    @TestConfiguration
    class VerifierConfig {
        @Bean
        @Primary
        fun verifierNotificationGateway(): VerifierNotificationGateway = VerifierNotificationGateway()
    }

    class VerifierNotificationGateway : NotificationGateway {
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

    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var json: ObjectMapper
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var dataSource: DataSource
    @Autowired private lateinit var notifications: VerifierNotificationGateway

    @BeforeEach
    fun clearState() {
        jdbc.update("DELETE FROM disputes")
        jdbc.update("DELETE FROM invoices")
        notifications.clear()
    }

    @Test
    fun `existing invoice issue, pay, void, and fetch behavior continues to work`() {
        dataSource.connection.use { connection ->
            assertTrue(connection.metaData.url.startsWith("jdbc:h2:mem:"))
        }

        val issued = read(createInvoice("cust-1", 10_000, "USD"), 201)
        assertEquals("ISSUED", issued.path("status").textValue())
        assertEquals(0, issued.path("disputes").size())

        val paid = read(payInvoice(id(issued)), 200)
        assertEquals("PAID", paid.path("status").textValue())
        assertNotNull(paid.path("paidAt").textValue())
        assertStatus(409, payInvoice(id(issued)), "pay twice")
        assertStatus(409, voidInvoice(id(issued)), "void paid")

        val fetched = read(fetchInvoice(id(issued)), 200)
        assertEquals("PAID", fetched.path("status").textValue())
        assertTrue(fetched.path("disputes").isArray)
        assertEquals(0, fetched.path("disputes").size())

        val second = read(createInvoice("cust-2", 2_500, "EUR"), 201)
        val voided = read(voidInvoice(id(second)), 200)
        assertEquals("VOID", voided.path("status").textValue())
        assertStatus(409, payInvoice(id(second)), "pay voided")
        assertStatus(409, voidInvoice(id(second)), "void twice")

        assertEquals(listOf("INVOICE_PAID", "INVOICE_VOIDED"), notifications.sent.map { it.eventType.name })
    }

    @Test
    fun `opening a dispute trims description, persists to H2, transitions invoice to DISPUTED, and notifies`() {
        val invoice = createPaidInvoice("cust-open", 10_000, "USD")
        notifications.clear()

        val dispute = read(
            openDispute(
                id(invoice),
                """{"reasonCategory":"DUPLICATE_CHARGE","description":"  Charged twice for May invoice  ","requestedAmountCents":6000}""",
            ),
            201,
        )

        assertTrue(id(dispute).matches(Regex("[A-Za-z0-9_-]+")), "Invalid dispute ID: ${id(dispute)}")
        assertEquals(id(invoice), dispute.path("invoiceId").textValue())
        assertEquals("DUPLICATE_CHARGE", dispute.path("reasonCategory").textValue())
        assertEquals("Charged twice for May invoice", dispute.path("description").textValue())
        assertEquals(6_000L, dispute.path("requestedAmountCents").longValue())
        assertEquals("OPEN", dispute.path("status").textValue())
        assertTrue(dispute.path("refundAmountCents").isNull)
        assertTrue(dispute.path("resolutionNote").isNull)
        assertNotNull(dispute.path("openedAt").textValue())
        assertTrue(dispute.path("resolvedAt").isNull)

        assertStoredDispute(dispute)
        assertEquals("DISPUTED", invoiceStatusInDb(id(invoice)))

        val fetched = read(fetchInvoice(id(invoice)), 200)
        assertEquals("DISPUTED", fetched.path("status").textValue())
        assertEquals(listOf(dispute), fetched.path("disputes").toList())

        // Existing pay/void endpoints reject DISPUTED invoices
        assertStatus(409, payInvoice(id(invoice)), "pay disputed")
        assertStatus(409, voidInvoice(id(invoice)), "void disputed")

        assertEquals(1, notifications.sent.size)
        val event = notifications.sent.single()
        assertEquals("DISPUTE_OPENED", event.eventType.name)
        assertEquals(id(invoice), event.invoiceId)
        assertEquals("cust-open", event.customerId)
        assertEquals(Money(6_000L, Currency.USD), event.amount)
        assertEquals(id(dispute), event.metadata["disputeId"])
        assertEquals("DUPLICATE_CHARGE", event.metadata["reasonCategory"])
    }

    @Test
    fun `resolving a dispute with full refund, partial refund, and rejection updates invoice, H2, and notifications`() {
        // 1. FULL_REFUND with omitted refundAmountCents defaults to full invoice amount
        val invFull = createPaidInvoice("cust-full", 9_000, "EUR")
        val dispFull = read(openDispute(id(invFull), disputeBody("UNAUTHORIZED", "Unauthorized card charge on account", 4_000)), 201)
        notifications.clear()

        val resolvedFull = read(
            resolveDispute(id(invFull), id(dispFull), """{"decision":"FULL_REFUND","resolutionNote":"  Confirmed fraud with processor  "}"""),
            200,
        )
        assertEquals("RESOLVED_REFUNDED", resolvedFull.path("status").textValue())
        assertEquals(9_000L, resolvedFull.path("refundAmountCents").longValue())
        assertEquals("Confirmed fraud with processor", resolvedFull.path("resolutionNote").textValue())
        assertNotNull(resolvedFull.path("resolvedAt").textValue())
        assertStoredDispute(resolvedFull)
        assertEquals("REFUNDED", invoiceStatusInDb(id(invFull)))
        assertStatus(409, payInvoice(id(invFull)), "pay refunded")
        assertStatus(409, voidInvoice(id(invFull)), "void refunded")
        assertStatus(409, openDispute(id(invFull), disputeBody("BILLING_ERROR", "Trying to dispute refunded invoice", 1_000)), "dispute refunded")
        assertStatus(409, resolveDispute(id(invFull), id(dispFull), """{"decision":"REJECT","resolutionNote":"Already closed"}"""), "resolve twice")

        assertEquals(1, notifications.sent.size)
        val fullEvent = notifications.sent.single()
        assertEquals("DISPUTE_RESOLVED", fullEvent.eventType.name)
        assertEquals(Money(9_000L, Currency.EUR), fullEvent.amount)
        assertEquals(id(dispFull), fullEvent.metadata["disputeId"])
        assertEquals("FULL_REFUND", fullEvent.metadata["decision"])
        assertEquals("RESOLVED_REFUNDED", fullEvent.metadata["disputeStatus"])
        assertEquals("9000", fullEvent.metadata["refundAmountCents"])

        // 2. PARTIAL_REFUND
        val invPartial = createPaidInvoice("cust-partial", 10_000, "GBP")
        val dispPartial = read(openDispute(id(invPartial), disputeBody("SERVICE_NOT_DELIVERED", "Two items missing from shipment", 5_000)), 201)
        notifications.clear()

        val resolvedPartial = read(
            resolveDispute(id(invPartial), id(dispPartial), """{"decision":"PARTIAL_REFUND","refundAmountCents":3500,"resolutionNote":"Refunded missing items"}"""),
            200,
        )
        assertEquals("RESOLVED_PARTIAL_REFUND", resolvedPartial.path("status").textValue())
        assertEquals(3_500L, resolvedPartial.path("refundAmountCents").longValue())
        assertEquals("REFUNDED", invoiceStatusInDb(id(invPartial)))
        assertStoredDispute(resolvedPartial)

        val partialEvent = notifications.sent.single()
        assertEquals("DISPUTE_RESOLVED", partialEvent.eventType.name)
        assertEquals(Money(3_500L, Currency.GBP), partialEvent.amount)
        assertEquals("PARTIAL_REFUND", partialEvent.metadata["decision"])
        assertEquals("RESOLVED_PARTIAL_REFUND", partialEvent.metadata["disputeStatus"])
        assertEquals("3500", partialEvent.metadata["refundAmountCents"])

        // 3. REJECT returns invoice to PAID, allows 2nd dispute, and blocks 3rd dispute (max 2 lifetime disputes)
        val invReject = createPaidInvoice("cust-reject", 8_000, "USD")
        val disp1 = read(openDispute(id(invReject), disputeBody("BILLING_ERROR", "First dispute claim on invoice", 2_000)), 201)
        notifications.clear()

        val resolved1 = read(
            resolveDispute(id(invReject), id(disp1), """{"decision":"REJECT","resolutionNote":"Delivery confirmed by carrier"}"""),
            200,
        )
        assertEquals("RESOLVED_REJECTED", resolved1.path("status").textValue())
        assertTrue(resolved1.path("refundAmountCents").isNull)
        assertEquals("PAID", invoiceStatusInDb(id(invReject)))
        assertStoredDispute(resolved1)

        val rejectEvent = notifications.sent.single()
        assertEquals("DISPUTE_RESOLVED", rejectEvent.eventType.name)
        assertEquals(Money(8_000L, Currency.USD), rejectEvent.amount)
        assertEquals("REJECT", rejectEvent.metadata["decision"])
        assertEquals("RESOLVED_REJECTED", rejectEvent.metadata["disputeStatus"])
        assertEquals("0", rejectEvent.metadata["refundAmountCents"])

        // 2nd dispute succeeds and can be rejected; 3rd dispute returns 409
        val disp2 = read(openDispute(id(invReject), disputeBody("DUPLICATE_CHARGE", "Second dispute claim on invoice", 3_000)), 201)
        val resolved2 = read(resolveDispute(id(invReject), id(disp2), """{"decision":"REJECT","resolutionNote":"Duplicate claim rejected"}"""), 200)
        notifications.clear()

        assertStatus(409, openDispute(id(invReject), disputeBody("BILLING_ERROR", "Third dispute exceeds lifetime cap", 1_000)), "3rd dispute exceeds max 2")
        assertEquals(emptyList(), notifications.sent)

        val fetchedReject = read(fetchInvoice(id(invReject)), 200)
        assertEquals("PAID", fetchedReject.path("status").textValue())
        val expectedOrderedIds = listOf(resolved1, resolved2)
            .sortedWith(compareBy<JsonNode> { it.path("openedAt").textValue() }.thenBy { id(it) })
            .map { id(it) }
        assertEquals(expectedOrderedIds, fetchedReject.path("disputes").map { id(it) })

        // Verify explicit opened_at ascending ordering and id tie-breaking via H2 timestamps
        val earlier = OffsetDateTime.now(ZoneOffset.UTC).minusHours(2)
        val later = OffsetDateTime.now(ZoneOffset.UTC).minusHours(1)
        jdbc.update("UPDATE disputes SET opened_at = ? WHERE id = ?", later, id(resolved1))
        jdbc.update("UPDATE disputes SET opened_at = ? WHERE id = ?", earlier, id(resolved2))
        assertEquals(listOf(id(resolved2), id(resolved1)), read(fetchInvoice(id(invReject)), 200).path("disputes").map { id(it) })

        jdbc.update("UPDATE disputes SET opened_at = ? WHERE id IN (?, ?)", earlier, id(resolved1), id(resolved2))
        assertEquals(listOf(id(resolved1), id(resolved2)).sorted(), read(fetchInvoice(id(invReject)), 200).path("disputes").map { id(it) })
    }

    @Test
    fun `enforces 30-day dispute window and rejects non-paid invoices and missing resources`() {
        val issued = read(createInvoice("cust-w1", 5_000, "USD"), 201)
        val voided = read(createInvoice("cust-w2", 5_000, "USD"), 201)
        read(voidInvoice(id(voided)), 200)
        notifications.clear()

        assertStatus(409, openDispute(id(issued), disputeBody("BILLING_ERROR", "Disputing unpaid issued invoice", 1_000)), "issued invoice")
        assertStatus(409, openDispute(id(voided), disputeBody("BILLING_ERROR", "Disputing voided invoice", 1_000)), "voided invoice")
        assertStatus(404, openDispute("inv-missing", disputeBody("BILLING_ERROR", "Disputing missing invoice", 1_000)), "missing invoice")
        assertEquals(emptyList(), notifications.sent)

        // Paid 30 days + 1 minute ago -> outside 30-day window -> 409
        val expiredInvoice = createPaidInvoice("cust-exp", 5_000, "USD")
        val expiredPaidAt = OffsetDateTime.now(ZoneOffset.UTC).minusDays(30).minusMinutes(1)
        jdbc.update("UPDATE invoices SET paid_at = ? WHERE id = ?", expiredPaidAt, id(expiredInvoice))
        notifications.clear()

        assertStatus(409, openDispute(id(expiredInvoice), disputeBody("BILLING_ERROR", "Too late to dispute invoice", 1_000)), "outside 30d window")
        assertEquals("PAID", invoiceStatusInDb(id(expiredInvoice)))
        assertEquals(emptyList(), notifications.sent)

        // Paid 29 days + 23 hours ago -> inside 30-day window -> 201
        val eligibleInvoice = createPaidInvoice("cust-ok", 5_000, "USD")
        val withinWindowPaidAt = OffsetDateTime.now(ZoneOffset.UTC).minusDays(30).plusHours(1)
        jdbc.update("UPDATE invoices SET paid_at = ? WHERE id = ?", withinWindowPaidAt, id(eligibleInvoice))
        val opened = read(openDispute(id(eligibleInvoice), disputeBody("BILLING_ERROR", "Just inside thirty day window", 1_000)), 201)

        // Cross-invoice dispute resolve returns 404
        assertStatus(404, resolveDispute(id(expiredInvoice), id(opened), """{"decision":"REJECT","resolutionNote":"Wrong invoice"}"""), "wrong invoice for dispute")
        assertStatus(404, resolveDispute(id(eligibleInvoice), "disp-missing", """{"decision":"REJECT","resolutionNote":"Missing dispute"}"""), "missing dispute")
        assertStatus(404, resolveDispute("inv-missing", id(opened), """{"decision":"REJECT","resolutionNote":"Missing invoice"}"""), "missing invoice on resolve")
    }

    @Test
    fun `rejects invalid open and resolve payloads with 400 without mutating state or notifying`() {
        val invoice = createPaidInvoice("cust-val", 10_000, "USD")
        notifications.clear()

        val tooLong = "a".repeat(501)
        val invalidOpenPayloads = listOf(
            "{",
            """{"reasonCategory":"UNKNOWN","description":"Valid long description","requestedAmountCents":1000}""",
            """{"reasonCategory":"BILLING_ERROR","description":"   short ","requestedAmountCents":1000}""",
            """{"reasonCategory":"BILLING_ERROR","description":"123456789","requestedAmountCents":1000}""",
            """{"reasonCategory":"BILLING_ERROR","description":"$tooLong","requestedAmountCents":1000}""",
            """{"reasonCategory":"BILLING_ERROR","description":"Valid long description","requestedAmountCents":0}""",
            """{"reasonCategory":"BILLING_ERROR","description":"Valid long description","requestedAmountCents":-50}""",
            """{"reasonCategory":"BILLING_ERROR","description":"Valid long description","requestedAmountCents":10001}""",
            """{"reasonCategory":"BILLING_ERROR","description":"Valid long description","requestedAmountCents":100.5}""",
            """{"description":"Valid long description","requestedAmountCents":1000}""",
        )
        for (payload in invalidOpenPayloads) {
            assertStatus(400, openDispute(id(invoice), payload), "open payload=$payload")
        }
        assertEquals("PAID", invoiceStatusInDb(id(invoice)))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM disputes", Int::class.java))
        assertEquals(emptyList(), notifications.sent)

        // Valid open at exact 10-char trimmed boundary and requestedAmountCents = 5000
        val dispute = read(openDispute(id(invoice), disputeBody("BILLING_ERROR", "  1234567890  ", 5_000)), 201)
        assertEquals("1234567890", dispute.path("description").textValue())
        notifications.clear()

        val invalidResolvePayloads = listOf(
            "{",
            """{"decision":"UNKNOWN","resolutionNote":"Valid note"}""",
            """{"decision":"FULL_REFUND","refundAmountCents":5000,"resolutionNote":"Wrong full refund amount"}""",
            """{"decision":"PARTIAL_REFUND","resolutionNote":"Missing partial amount"}""",
            """{"decision":"PARTIAL_REFUND","refundAmountCents":0,"resolutionNote":"Zero partial amount"}""",
            """{"decision":"PARTIAL_REFUND","refundAmountCents":5001,"resolutionNote":"Exceeds requested amount"}""",
            """{"decision":"PARTIAL_REFUND","refundAmountCents":10000,"resolutionNote":"Equals full invoice amount"}""",
            """{"decision":"REJECT","refundAmountCents":0,"resolutionNote":"Reject with refund amount"}""",
            """{"decision":"REJECT","refundAmountCents":100,"resolutionNote":"Reject with positive refund"}""",
            """{"decision":"REJECT","resolutionNote":"1234"}""",
            """{"decision":"REJECT","resolutionNote":"   "}""",
            """{"decision":"REJECT","resolutionNote":"$tooLong"}""",
        )
        for (payload in invalidResolvePayloads) {
            assertStatus(400, resolveDispute(id(invoice), id(dispute), payload), "resolve payload=$payload")
        }
        assertEquals("DISPUTED", invoiceStatusInDb(id(invoice)))
        assertStoredDispute(dispute)
        assertEquals(emptyList(), notifications.sent)

        // Also check PARTIAL_REFUND when requestedAmountCents == invoice.amountCents: must still be < invoice.amountCents
        val fullReqInv = createPaidInvoice("cust-val2", 4_000, "USD")
        val fullReqDisp = read(openDispute(id(fullReqInv), disputeBody("DUPLICATE_CHARGE", "Requesting entire invoice amount", 4_000)), 201)
        assertStatus(
            400,
            resolveDispute(id(fullReqInv), id(fullReqDisp), """{"decision":"PARTIAL_REFUND","refundAmountCents":4000,"resolutionNote":"Cannot equal full invoice"}"""),
            "partial refund equals full invoice",
        )
        assertStatus(
            200,
            resolveDispute(id(fullReqInv), id(fullReqDisp), """{"decision":"PARTIAL_REFUND","refundAmountCents":3999,"resolutionNote":"One cent below full invoice"}"""),
            "partial refund one cent below full invoice",
        )
    }

    @Test
    fun `only one concurrent open or resolve request succeeds and notifies`() {
        val executor = Executors.newFixedThreadPool(4)
        try {
            val invoice = createPaidInvoice("cust-race", 10_000, "USD")
            notifications.clear()

            val openBarrier = CyclicBarrier(4)
            val openFutures = List(4) { idx ->
                executor.submit<Int> {
                    openBarrier.await(5, SECONDS)
                    openDispute(
                        id(invoice),
                        disputeBody("DUPLICATE_CHARGE", "Concurrent dispute attempt number $idx", 2_500),
                    ).response.status
                }
            }
            val openStatuses = openFutures.map { it.get(15, SECONDS) }.sorted()
            assertEquals(listOf(201, 409, 409, 409), openStatuses)
            assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM disputes WHERE invoice_id = ?", Int::class.java, id(invoice)))
            assertEquals(1, notifications.sent.count { it.eventType.name == "DISPUTE_OPENED" })

            val disputeId = read(fetchInvoice(id(invoice)), 200).path("disputes").first().path("id").textValue()
            notifications.clear()

            val resolveBarrier = CyclicBarrier(4)
            val resolveFutures = List(4) { idx ->
                executor.submit<Int> {
                    resolveBarrier.await(5, SECONDS)
                    resolveDispute(
                        id(invoice),
                        disputeId,
                        """{"decision":"FULL_REFUND","resolutionNote":"Concurrent resolve attempt $idx"}""",
                    ).response.status
                }
            }
            val resolveStatuses = resolveFutures.map { it.get(15, SECONDS) }.sorted()
            assertEquals(listOf(200, 409, 409, 409), resolveStatuses)
            assertEquals("REFUNDED", invoiceStatusInDb(id(invoice)))
            assertEquals(1, notifications.sent.count { it.eventType.name == "DISPUTE_RESOLVED" })
        } finally {
            executor.shutdownNow()
        }
    }

    private fun createInvoice(customerId: String, amountCents: Long, currency: String): MvcResult =
        mvc.perform(
            post("/invoices")
                .contentType(APPLICATION_JSON)
                .content("""{"customerId":"$customerId","amountCents":$amountCents,"currency":"$currency"}"""),
        ).andReturn()

    private fun createPaidInvoice(customerId: String, amountCents: Long, currency: String): JsonNode {
        val created = read(createInvoice(customerId, amountCents, currency), 201)
        return read(payInvoice(id(created)), 200)
    }

    private fun fetchInvoice(id: String): MvcResult =
        mvc.perform(get("/invoices/{id}", id)).andReturn()

    private fun payInvoice(id: String): MvcResult =
        mvc.perform(post("/invoices/{id}/pay", id)).andReturn()

    private fun voidInvoice(id: String): MvcResult =
        mvc.perform(post("/invoices/{id}/void", id)).andReturn()

    private fun openDispute(invoiceId: String, body: String): MvcResult =
        mvc.perform(post("/invoices/{id}/disputes", invoiceId).contentType(APPLICATION_JSON).content(body)).andReturn()

    private fun resolveDispute(invoiceId: String, disputeId: String, body: String): MvcResult =
        mvc.perform(
            post("/invoices/{id}/disputes/{disputeId}/resolve", invoiceId, disputeId)
                .contentType(APPLICATION_JSON)
                .content(body),
        ).andReturn()

    private fun disputeBody(category: String, description: String, requestedAmountCents: Long): String =
        json.writeValueAsString(
            mapOf(
                "reasonCategory" to category,
                "description" to description,
                "requestedAmountCents" to requestedAmountCents,
            ),
        )

    private fun read(result: MvcResult, expectedStatus: Int): JsonNode {
        assertStatus(expectedStatus, result)
        val contentType = result.response.contentType?.let(MediaType::parseMediaType)
        assertTrue(contentType != null && APPLICATION_JSON.includes(contentType), "Expected application/json, got $contentType")
        return json.readTree(result.response.contentAsString)
    }

    private fun assertStatus(expected: Int, result: MvcResult, context: String? = null) {
        val message = listOfNotNull(context, result.response.contentAsString.ifEmpty { null }).joinToString(" | ")
        assertEquals(expected, result.response.status, message)
    }

    private fun id(node: JsonNode): String = node.path("id").textValue()

    private fun invoiceStatusInDb(invoiceId: String): String =
        jdbc.queryForObject("SELECT status FROM invoices WHERE id = ?", String::class.java, invoiceId)!!

    private fun assertStoredDispute(dispute: JsonNode) {
        val rows = jdbc.query(
            """
            SELECT invoice_id, reason_category, description, requested_amount_cents, status,
                   refund_amount_cents, resolution_note, opened_at, resolved_at
            FROM disputes
            WHERE id = ?
            """.trimIndent(),
            { row, _ ->
                listOf(
                    row.getString("invoice_id"),
                    row.getString("reason_category"),
                    row.getString("description"),
                    row.getLong("requested_amount_cents").toString(),
                    row.getString("status"),
                    row.getObject("refund_amount_cents")?.let { (it as Number).toLong().toString() },
                    row.getString("resolution_note"),
                    row.getObject("opened_at", OffsetDateTime::class.java).toInstant().toString(),
                    row.getObject("resolved_at", OffsetDateTime::class.java)?.toInstant()?.toString(),
                )
            },
            id(dispute),
        )
        val expected = listOf(
            dispute.path("invoiceId").textValue(),
            dispute.path("reasonCategory").textValue(),
            dispute.path("description").textValue(),
            dispute.path("requestedAmountCents").longValue().toString(),
            dispute.path("status").textValue(),
            if (dispute.path("refundAmountCents").isNull) null else dispute.path("refundAmountCents").longValue().toString(),
            if (dispute.path("resolutionNote").isNull) null else dispute.path("resolutionNote").textValue(),
            dispute.path("openedAt").textValue(),
            if (dispute.path("resolvedAt").isNull) null else dispute.path("resolvedAt").textValue(),
        )
        assertEquals(listOf(expected), rows)
    }
}
