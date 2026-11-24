#!/usr/bin/env bash
set -euo pipefail

cd /workspace
main=src/main/kotlin/billing
test=src/test/kotlin/billing

cat > src/main/resources/schema.sql <<'EOF'
CREATE TABLE IF NOT EXISTS invoices (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL,
    amount_cents BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(32) NOT NULL,
    issued_at TIMESTAMP WITH TIME ZONE NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS disputes (
    id VARCHAR(64) PRIMARY KEY,
    invoice_id VARCHAR(64) NOT NULL,
    reason_category VARCHAR(64) NOT NULL,
    description VARCHAR(500) NOT NULL,
    requested_amount_cents BIGINT NOT NULL,
    status VARCHAR(32) NOT NULL,
    refund_amount_cents BIGINT,
    resolution_note VARCHAR(500),
    opened_at TIMESTAMP WITH TIME ZONE NOT NULL,
    resolved_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_disputes_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id)
);
EOF

cat > "$main/Invoice.kt" <<'EOF'
package billing

import java.time.Duration
import java.time.Instant

enum class InvoiceStatus(val requiresPaidTimestamp: Boolean) {
    ISSUED(requiresPaidTimestamp = false),
    PAID(requiresPaidTimestamp = true),
    VOID(requiresPaidTimestamp = false),
    DISPUTED(requiresPaidTimestamp = true),
    REFUNDED(requiresPaidTimestamp = true),
}

data class Invoice(
    val id: String,
    val customerId: String,
    val amount: Money,
    val status: InvoiceStatus,
    val issuedAt: Instant,
    val paidAt: Instant? = null,
) {
    init {
        if (!ID_PATTERN.matches(id)) {
            throw InvalidBillingRequest("Invalid invoice ID")
        }
        if (!CUSTOMER_ID_PATTERN.matches(customerId)) {
            throw InvalidBillingRequest("Customer ID must be 1-64 ASCII letters, digits, underscores, or hyphens")
        }
        if (status.requiresPaidTimestamp && paidAt == null) {
            throw InvalidBillingRequest("Status $status requires paidAt")
        }
        if (!status.requiresPaidTimestamp && paidAt != null) {
            throw InvalidBillingRequest("Status $status cannot record paidAt")
        }
    }

    fun markPaid(paidAt: Instant): Invoice {
        if (status != InvoiceStatus.ISSUED) {
            throw BillingConflict("Only ISSUED invoices can be paid")
        }
        return copy(status = InvoiceStatus.PAID, paidAt = paidAt)
    }

    fun void(): Invoice {
        if (status != InvoiceStatus.ISSUED) {
            throw BillingConflict("Only ISSUED invoices can be voided")
        }
        return copy(status = InvoiceStatus.VOID)
    }

    fun openDispute(now: Instant, existingDisputeCount: Int): Invoice {
        if (status != InvoiceStatus.PAID) {
            throw BillingConflict("Only PAID invoices can be disputed")
        }
        val paymentTime = paidAt ?: throw BillingConflict("Paid timestamp is required to open a dispute")
        if (now.isAfter(paymentTime.plus(DISPUTE_WINDOW))) {
            throw BillingConflict("Dispute window of 30 days has expired")
        }
        if (existingDisputeCount >= MAX_DISPUTES_PER_INVOICE) {
            throw BillingConflict("Invoice has reached the maximum of $MAX_DISPUTES_PER_INVOICE disputes")
        }
        return copy(status = InvoiceStatus.DISPUTED)
    }

    fun applyDisputeResolution(decision: DisputeDecision): Invoice {
        if (status != InvoiceStatus.DISPUTED) {
            throw BillingConflict("Only DISPUTED invoices can resolve disputes")
        }
        return copy(status = decision.resultingInvoiceStatus)
    }

    companion object {
        const val MAX_DISPUTES_PER_INVOICE: Int = 2
        val DISPUTE_WINDOW: Duration = Duration.ofDays(30)

        private val ID_PATTERN = Regex("[A-Za-z0-9_-]{1,64}")
        private val CUSTOMER_ID_PATTERN = Regex("[A-Za-z0-9_-]{1,64}")

        fun issue(id: String, customerId: String, amount: Money, issuedAt: Instant): Invoice =
            Invoice(
                id = id,
                customerId = customerId,
                amount = amount,
                status = InvoiceStatus.ISSUED,
                issuedAt = issuedAt,
            )
    }
}
EOF

cat > "$main/Dispute.kt" <<'EOF'
package billing

import java.time.Instant

enum class DisputeReasonCategory {
    DUPLICATE_CHARGE,
    UNAUTHORIZED,
    SERVICE_NOT_DELIVERED,
    BILLING_ERROR;

    companion object {
        fun parse(raw: String): DisputeReasonCategory =
            entries.find { it.name == raw }
                ?: throw InvalidBillingRequest("Unsupported dispute reason category: $raw")
    }
}

enum class DisputeStatus {
    OPEN,
    RESOLVED_REFUNDED,
    RESOLVED_PARTIAL_REFUND,
    RESOLVED_REJECTED,
}

enum class DisputeDecision(
    val resultingDisputeStatus: DisputeStatus,
    val resultingInvoiceStatus: InvoiceStatus,
) {
    FULL_REFUND(
        resultingDisputeStatus = DisputeStatus.RESOLVED_REFUNDED,
        resultingInvoiceStatus = InvoiceStatus.REFUNDED,
    ) {
        override fun resolveRefundAmount(
            requestedRefundCents: Long?,
            disputeRequestedCents: Long,
            invoiceAmountCents: Long,
        ): Long {
            val effective = requestedRefundCents ?: invoiceAmountCents
            if (effective != invoiceAmountCents) {
                throw InvalidBillingRequest("FULL_REFUND amount must match full invoice amount")
            }
            return effective
        }
    },
    PARTIAL_REFUND(
        resultingDisputeStatus = DisputeStatus.RESOLVED_PARTIAL_REFUND,
        resultingInvoiceStatus = InvoiceStatus.REFUNDED,
    ) {
        override fun resolveRefundAmount(
            requestedRefundCents: Long?,
            disputeRequestedCents: Long,
            invoiceAmountCents: Long,
        ): Long {
            val amount = requestedRefundCents
                ?: throw InvalidBillingRequest("PARTIAL_REFUND requires refundAmountCents")
            val withinRequested = amount in 1L..disputeRequestedCents
            val strictlyLessThanInvoice = amount < invoiceAmountCents
            if (!withinRequested || !strictlyLessThanInvoice) {
                throw InvalidBillingRequest(
                    "PARTIAL_REFUND amount must be between 1 and requestedAmountCents and less than invoice amount",
                )
            }
            return amount
        }
    },
    REJECT(
        resultingDisputeStatus = DisputeStatus.RESOLVED_REJECTED,
        resultingInvoiceStatus = InvoiceStatus.PAID,
    ) {
        override fun resolveRefundAmount(
            requestedRefundCents: Long?,
            disputeRequestedCents: Long,
            invoiceAmountCents: Long,
        ): Long? {
            if (requestedRefundCents != null) {
                throw InvalidBillingRequest("REJECT must not specify refundAmountCents")
            }
            return null
        }
    };

    abstract fun resolveRefundAmount(
        requestedRefundCents: Long?,
        disputeRequestedCents: Long,
        invoiceAmountCents: Long,
    ): Long?

    companion object {
        fun parse(raw: String): DisputeDecision =
            entries.find { it.name == raw }
                ?: throw InvalidBillingRequest("Unsupported dispute decision: $raw")
    }
}

data class Dispute(
    val id: String,
    val invoiceId: String,
    val reasonCategory: DisputeReasonCategory,
    val description: String,
    val requestedAmountCents: Long,
    val status: DisputeStatus,
    val refundAmountCents: Long? = null,
    val resolutionNote: String? = null,
    val openedAt: Instant,
    val resolvedAt: Instant? = null,
) {
    init {
        if (!ID_PATTERN.matches(id)) {
            throw InvalidBillingRequest("Invalid dispute ID")
        }
        if (description != description.trim() || description.length !in MIN_DESCRIPTION_LENGTH..MAX_TEXT_LENGTH) {
            throw InvalidBillingRequest("Description must be $MIN_DESCRIPTION_LENGTH-$MAX_TEXT_LENGTH trimmed characters")
        }
        if (requestedAmountCents < 1L) {
            throw InvalidBillingRequest("Requested amount must be positive")
        }
        if (status == DisputeStatus.OPEN) {
            if (refundAmountCents != null || resolutionNote != null || resolvedAt != null) {
                throw InvalidBillingRequest("Open dispute cannot have resolution fields")
            }
        } else {
            if (resolvedAt == null) {
                throw InvalidBillingRequest("Resolved dispute must record resolvedAt")
            }
            if (resolutionNote == null || resolutionNote != resolutionNote.trim() || resolutionNote.length !in MIN_RESOLUTION_NOTE_LENGTH..MAX_TEXT_LENGTH) {
                throw InvalidBillingRequest("Resolution note must be $MIN_RESOLUTION_NOTE_LENGTH-$MAX_TEXT_LENGTH trimmed characters")
            }
            if (status == DisputeStatus.RESOLVED_REJECTED && refundAmountCents != null) {
                throw InvalidBillingRequest("Rejected dispute cannot have refundAmountCents")
            }
            if (status != DisputeStatus.RESOLVED_REJECTED && (refundAmountCents == null || refundAmountCents < 1L)) {
                throw InvalidBillingRequest("Refunded dispute must record positive refundAmountCents")
            }
        }
    }

    fun resolve(
        decision: DisputeDecision,
        refundAmountCents: Long?,
        resolutionNote: String,
        invoiceAmountCents: Long,
        resolvedAt: Instant,
    ): Dispute {
        if (status != DisputeStatus.OPEN) {
            throw BillingConflict("Dispute $id is already resolved")
        }
        val normalizedNote = normalizeText(resolutionNote, MIN_RESOLUTION_NOTE_LENGTH, "resolutionNote")
        val resolvedRefund = decision.resolveRefundAmount(
            requestedRefundCents = refundAmountCents,
            disputeRequestedCents = requestedAmountCents,
            invoiceAmountCents = invoiceAmountCents,
        )
        return copy(
            status = decision.resultingDisputeStatus,
            refundAmountCents = resolvedRefund,
            resolutionNote = normalizedNote,
            resolvedAt = resolvedAt,
        )
    }

    companion object {
        private const val MIN_DESCRIPTION_LENGTH = 10
        private const val MIN_RESOLUTION_NOTE_LENGTH = 5
        private const val MAX_TEXT_LENGTH = 500
        private val ID_PATTERN = Regex("[A-Za-z0-9_-]{1,64}")

        fun open(
            id: String,
            invoice: Invoice,
            reasonCategory: DisputeReasonCategory,
            description: String,
            requestedAmountCents: Long,
            openedAt: Instant,
        ): Dispute {
            val normalizedDescription = normalizeText(description, MIN_DESCRIPTION_LENGTH, "description")
            if (requestedAmountCents < 1L || requestedAmountCents > invoice.amount.amountCents) {
                throw InvalidBillingRequest("requestedAmountCents must be between 1 and invoice amountCents")
            }
            return Dispute(
                id = id,
                invoiceId = invoice.id,
                reasonCategory = reasonCategory,
                description = normalizedDescription,
                requestedAmountCents = requestedAmountCents,
                status = DisputeStatus.OPEN,
                openedAt = openedAt,
            )
        }

        private fun normalizeText(raw: String, minLength: Int, fieldName: String): String {
            val trimmed = raw.trim()
            if (trimmed.length !in minLength..MAX_TEXT_LENGTH) {
                throw InvalidBillingRequest("$fieldName must be $minLength-$MAX_TEXT_LENGTH characters")
            }
            return trimmed
        }
    }
}
EOF

cat > "$main/NotificationGateway.kt" <<'EOF'
package billing

import org.slf4j.LoggerFactory

enum class NotificationEventType {
    INVOICE_PAID,
    INVOICE_VOIDED,
    DISPUTE_OPENED,
    DISPUTE_RESOLVED,
}

data class BillingNotification(
    val eventType: NotificationEventType,
    val invoiceId: String,
    val customerId: String,
    val amount: Money,
    val metadata: Map<String, String> = emptyMap(),
)

interface NotificationGateway {
    fun send(notification: BillingNotification)
}

class LoggingNotificationGateway : NotificationGateway {
    private val logger = LoggerFactory.getLogger(LoggingNotificationGateway::class.java)

    override fun send(notification: BillingNotification) {
        logger.info(
            "Billing notification event={} invoiceId={} customerId={} amount={} {}",
            notification.eventType,
            notification.invoiceId,
            notification.customerId,
            notification.amount.amountCents,
            notification.amount.currency,
        )
    }
}
EOF

cat > "$main/JdbcDisputeRepository.kt" <<'EOF'
package billing

import java.sql.ResultSet
import java.time.OffsetDateTime
import java.time.ZoneOffset
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository

interface DisputeRepository {
    fun insert(dispute: Dispute)
    fun findByIdAndInvoiceId(disputeId: String, invoiceId: String): Dispute?
    fun findByInvoiceId(invoiceId: String): List<Dispute>
    fun countByInvoiceId(invoiceId: String): Int
    fun resolveIfOpen(resolved: Dispute): Boolean
}

@Repository
class JdbcDisputeRepository(private val jdbc: JdbcTemplate) : DisputeRepository {
    override fun insert(dispute: Dispute) {
        jdbc.update(
            """
            INSERT INTO disputes (
                id, invoice_id, reason_category, description, requested_amount_cents,
                status, refund_amount_cents, resolution_note, opened_at, resolved_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """.trimIndent(),
            dispute.id,
            dispute.invoiceId,
            dispute.reasonCategory.name,
            dispute.description,
            dispute.requestedAmountCents,
            dispute.status.name,
            dispute.refundAmountCents,
            dispute.resolutionNote,
            dispute.openedAt.atOffset(ZoneOffset.UTC),
            dispute.resolvedAt?.atOffset(ZoneOffset.UTC),
        )
    }

    override fun findByIdAndInvoiceId(disputeId: String, invoiceId: String): Dispute? =
        jdbc.query(
            """
            SELECT id, invoice_id, reason_category, description, requested_amount_cents,
                   status, refund_amount_cents, resolution_note, opened_at, resolved_at
            FROM disputes
            WHERE id = ? AND invoice_id = ?
            """.trimIndent(),
            { row, _ -> mapRow(row) },
            disputeId,
            invoiceId,
        ).firstOrNull()

    override fun findByInvoiceId(invoiceId: String): List<Dispute> =
        jdbc.query(
            """
            SELECT id, invoice_id, reason_category, description, requested_amount_cents,
                   status, refund_amount_cents, resolution_note, opened_at, resolved_at
            FROM disputes
            WHERE invoice_id = ?
            ORDER BY opened_at ASC, id ASC
            """.trimIndent(),
            { row, _ -> mapRow(row) },
            invoiceId,
        )

    override fun countByInvoiceId(invoiceId: String): Int =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM disputes WHERE invoice_id = ?",
            Int::class.java,
            invoiceId,
        ) ?: 0

    override fun resolveIfOpen(resolved: Dispute): Boolean {
        val updated = jdbc.update(
            """
            UPDATE disputes
            SET status = ?, refund_amount_cents = ?, resolution_note = ?, resolved_at = ?
            WHERE id = ? AND invoice_id = ? AND status = ?
            """.trimIndent(),
            resolved.status.name,
            resolved.refundAmountCents,
            resolved.resolutionNote,
            resolved.resolvedAt?.atOffset(ZoneOffset.UTC),
            resolved.id,
            resolved.invoiceId,
            DisputeStatus.OPEN.name,
        )
        return updated == 1
    }

    private fun mapRow(row: ResultSet): Dispute =
        Dispute(
            id = row.getString("id"),
            invoiceId = row.getString("invoice_id"),
            reasonCategory = DisputeReasonCategory.valueOf(row.getString("reason_category")),
            description = row.getString("description"),
            requestedAmountCents = row.getLong("requested_amount_cents"),
            status = DisputeStatus.valueOf(row.getString("status")),
            refundAmountCents = row.getObject("refund_amount_cents")?.let { (it as Number).toLong() },
            resolutionNote = row.getString("resolution_note"),
            openedAt = row.getObject("opened_at", OffsetDateTime::class.java).toInstant(),
            resolvedAt = row.getObject("resolved_at", OffsetDateTime::class.java)?.toInstant(),
        )
}
EOF

cat > "$main/DisputeService.kt" <<'EOF'
package billing

import java.time.Clock
import java.time.Instant
import java.time.temporal.ChronoUnit.SECONDS
import java.util.UUID
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

data class OpenDisputeCommand(
    val invoiceId: String,
    val reasonCategory: DisputeReasonCategory,
    val description: String,
    val requestedAmountCents: Long,
)

data class ResolveDisputeCommand(
    val invoiceId: String,
    val disputeId: String,
    val decision: DisputeDecision,
    val refundAmountCents: Long?,
    val resolutionNote: String,
)

@Service
class DisputeService(
    private val invoices: InvoiceRepository,
    private val disputes: DisputeRepository,
    private val notifications: NotificationGateway,
    private val clock: Clock,
) {
    fun listDisputes(invoiceId: String): List<Dispute> =
        disputes.findByInvoiceId(invoiceId)

    @Transactional
    fun openDispute(command: OpenDisputeCommand): Dispute {
        val invoice = invoices.findById(command.invoiceId)
            ?: throw ResourceNotFound("Invoice not found: ${command.invoiceId}")
        val now = nowUtc()
        val dispute = Dispute.open(
            id = "disp-${UUID.randomUUID()}",
            invoice = invoice,
            reasonCategory = command.reasonCategory,
            description = command.description,
            requestedAmountCents = command.requestedAmountCents,
            openedAt = now,
        )
        val existingCount = disputes.countByInvoiceId(invoice.id)
        val disputedInvoice = invoice.openDispute(now, existingCount)
        if (!invoices.updateStatus(invoice.id, expectedStatus = InvoiceStatus.PAID, newStatus = disputedInvoice.status)) {
            throw BillingConflict("Invoice ${invoice.id} status changed concurrently")
        }
        disputes.insert(dispute)
        notifications.send(
            BillingNotification(
                eventType = NotificationEventType.DISPUTE_OPENED,
                invoiceId = invoice.id,
                customerId = invoice.customerId,
                amount = Money(dispute.requestedAmountCents, invoice.amount.currency),
                metadata = mapOf(
                    "disputeId" to dispute.id,
                    "reasonCategory" to dispute.reasonCategory.name,
                ),
            ),
        )
        return dispute
    }

    @Transactional
    fun resolveDispute(command: ResolveDisputeCommand): Dispute {
        val invoice = invoices.findById(command.invoiceId)
            ?: throw ResourceNotFound("Invoice not found: ${command.invoiceId}")
        val existing = disputes.findByIdAndInvoiceId(command.disputeId, command.invoiceId)
            ?: throw ResourceNotFound("Dispute not found: ${command.disputeId}")
        val resolved = existing.resolve(
            decision = command.decision,
            refundAmountCents = command.refundAmountCents,
            resolutionNote = command.resolutionNote,
            invoiceAmountCents = invoice.amount.amountCents,
            resolvedAt = nowUtc(),
        )
        val updatedInvoice = invoice.applyDisputeResolution(command.decision)
        if (!disputes.resolveIfOpen(resolved)) {
            throw BillingConflict("Dispute ${existing.id} was resolved concurrently")
        }
        if (!invoices.updateStatus(invoice.id, expectedStatus = InvoiceStatus.DISPUTED, newStatus = updatedInvoice.status)) {
            throw BillingConflict("Invoice ${invoice.id} status changed concurrently")
        }
        val notificationAmount = resolved.refundAmountCents?.let { Money(it, invoice.amount.currency) } ?: invoice.amount
        notifications.send(
            BillingNotification(
                eventType = NotificationEventType.DISPUTE_RESOLVED,
                invoiceId = invoice.id,
                customerId = invoice.customerId,
                amount = notificationAmount,
                metadata = mapOf(
                    "disputeId" to resolved.id,
                    "decision" to command.decision.name,
                    "disputeStatus" to resolved.status.name,
                    "refundAmountCents" to (resolved.refundAmountCents ?: 0L).toString(),
                ),
            ),
        )
        return resolved
    }

    private fun nowUtc(): Instant = clock.instant().truncatedTo(SECONDS)
}
EOF

cat > "$main/InvoiceController.kt" <<'EOF'
package billing

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

data class CreateInvoiceRequest(
    val customerId: String? = null,
    val amountCents: Long? = null,
    val currency: String? = null,
)

data class InvoiceResponse(
    val id: String,
    val customerId: String,
    val amountCents: Long,
    val currency: String,
    val status: String,
    val issuedAt: String,
    val paidAt: String?,
    val disputes: List<DisputeResponse> = emptyList(),
) {
    companion object {
        fun from(invoice: Invoice, disputes: List<Dispute> = emptyList()): InvoiceResponse =
            InvoiceResponse(
                id = invoice.id,
                customerId = invoice.customerId,
                amountCents = invoice.amount.amountCents,
                currency = invoice.amount.currency.name,
                status = invoice.status.name,
                issuedAt = invoice.issuedAt.toString(),
                paidAt = invoice.paidAt?.toString(),
                disputes = disputes.map(DisputeResponse::from),
            )
    }
}

@RestController
@RequestMapping("/invoices")
class InvoiceController(
    private val invoiceService: InvoiceService,
    private val disputeService: DisputeService,
) {
    @PostMapping
    fun issue(@RequestBody request: CreateInvoiceRequest): ResponseEntity<InvoiceResponse> {
        val customerId = request.customerId ?: throw InvalidBillingRequest("customerId is required")
        val amountCents = request.amountCents ?: throw InvalidBillingRequest("amountCents is required")
        val currency = request.currency?.let(Currency::parse) ?: throw InvalidBillingRequest("currency is required")
        val created = invoiceService.issueInvoice(customerId, Money(amountCents, currency))
        return ResponseEntity.status(HttpStatus.CREATED).body(InvoiceResponse.from(created))
    }

    @GetMapping("/{id}")
    fun fetch(@PathVariable id: String): InvoiceResponse {
        val invoice = invoiceService.getInvoice(id)
        val disputes = disputeService.listDisputes(id)
        return InvoiceResponse.from(invoice, disputes)
    }

    @PostMapping("/{id}/pay")
    fun pay(@PathVariable id: String): InvoiceResponse =
        InvoiceResponse.from(invoiceService.payInvoice(id))

    @PostMapping("/{id}/void")
    fun void(@PathVariable id: String): InvoiceResponse =
        InvoiceResponse.from(invoiceService.voidInvoice(id))
}
EOF

cat > "$main/DisputeController.kt" <<'EOF'
package billing

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

data class OpenDisputeRequest(
    val reasonCategory: String? = null,
    val description: String? = null,
    val requestedAmountCents: Long? = null,
)

data class ResolveDisputeRequest(
    val decision: String? = null,
    val refundAmountCents: Long? = null,
    val resolutionNote: String? = null,
)

data class DisputeResponse(
    val id: String,
    val invoiceId: String,
    val reasonCategory: String,
    val description: String,
    val requestedAmountCents: Long,
    val status: String,
    val refundAmountCents: Long?,
    val resolutionNote: String?,
    val openedAt: String,
    val resolvedAt: String?,
) {
    companion object {
        fun from(dispute: Dispute): DisputeResponse =
            DisputeResponse(
                id = dispute.id,
                invoiceId = dispute.invoiceId,
                reasonCategory = dispute.reasonCategory.name,
                description = dispute.description,
                requestedAmountCents = dispute.requestedAmountCents,
                status = dispute.status.name,
                refundAmountCents = dispute.refundAmountCents,
                resolutionNote = dispute.resolutionNote,
                openedAt = dispute.openedAt.toString(),
                resolvedAt = dispute.resolvedAt?.toString(),
            )
    }
}

@RestController
@RequestMapping("/invoices/{invoiceId}/disputes")
class DisputeController(private val disputeService: DisputeService) {
    @PostMapping
    fun open(
        @PathVariable invoiceId: String,
        @RequestBody request: OpenDisputeRequest,
    ): ResponseEntity<DisputeResponse> {
        val reasonCategory = request.reasonCategory?.let(DisputeReasonCategory::parse)
            ?: throw InvalidBillingRequest("reasonCategory is required")
        val description = request.description ?: throw InvalidBillingRequest("description is required")
        val requestedAmountCents = request.requestedAmountCents
            ?: throw InvalidBillingRequest("requestedAmountCents is required")
        val dispute = disputeService.openDispute(
            OpenDisputeCommand(
                invoiceId = invoiceId,
                reasonCategory = reasonCategory,
                description = description,
                requestedAmountCents = requestedAmountCents,
            ),
        )
        return ResponseEntity.status(HttpStatus.CREATED).body(DisputeResponse.from(dispute))
    }

    @PostMapping("/{disputeId}/resolve")
    fun resolve(
        @PathVariable invoiceId: String,
        @PathVariable disputeId: String,
        @RequestBody request: ResolveDisputeRequest,
    ): DisputeResponse {
        val decision = request.decision?.let(DisputeDecision::parse)
            ?: throw InvalidBillingRequest("decision is required")
        val resolutionNote = request.resolutionNote ?: throw InvalidBillingRequest("resolutionNote is required")
        val resolved = disputeService.resolveDispute(
            ResolveDisputeCommand(
                invoiceId = invoiceId,
                disputeId = disputeId,
                decision = decision,
                refundAmountCents = request.refundAmountCents,
                resolutionNote = resolutionNote,
            ),
        )
        return DisputeResponse.from(resolved)
    }
}
EOF

cat > "$test/testsupport/InvoiceFixtures.kt" <<'EOF'
package billing.testsupport

import billing.BillingNotification
import billing.Currency
import billing.Dispute
import billing.DisputeReasonCategory
import billing.DisputeRepository
import billing.DisputeResponse
import billing.DisputeStatus
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
    paidAt: Instant? = if (status.requiresPaidTimestamp) issuedAt.plusSeconds(60) else null,
): Invoice =
    Invoice(
        id = id,
        customerId = customerId,
        amount = Money(amountCents, currency),
        status = status,
        issuedAt = issuedAt,
        paidAt = paidAt,
    )

fun aDispute(
    id: String = "disp-1",
    invoiceId: String = "inv-1",
    reasonCategory: DisputeReasonCategory = DisputeReasonCategory.DUPLICATE_CHARGE,
    description: String = "Charged twice for monthly plan",
    requestedAmountCents: Long = 5_000L,
    status: DisputeStatus = DisputeStatus.OPEN,
    refundAmountCents: Long? = null,
    resolutionNote: String? = null,
    openedAt: Instant = FIXED_INSTANT.plusSeconds(3_600),
    resolvedAt: Instant? = null,
): Dispute =
    Dispute(
        id = id,
        invoiceId = invoiceId,
        reasonCategory = reasonCategory,
        description = description,
        requestedAmountCents = requestedAmountCents,
        status = status,
        refundAmountCents = refundAmountCents,
        resolutionNote = resolutionNote,
        openedAt = openedAt,
        resolvedAt = resolvedAt,
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

class InMemoryDisputeRepository : DisputeRepository {
    private val store = LinkedHashMap<String, Dispute>()

    override fun insert(dispute: Dispute) {
        store[dispute.id] = dispute
    }

    override fun findByIdAndInvoiceId(disputeId: String, invoiceId: String): Dispute? =
        store[disputeId]?.takeIf { it.invoiceId == invoiceId }

    override fun findByInvoiceId(invoiceId: String): List<Dispute> =
        store.values
            .filter { it.invoiceId == invoiceId }
            .sortedWith(compareBy<Dispute> { it.openedAt }.thenBy { it.id })

    override fun countByInvoiceId(invoiceId: String): Int =
        store.values.count { it.invoiceId == invoiceId }

    override fun resolveIfOpen(resolved: Dispute): Boolean {
        val current = store[resolved.id] ?: return false
        if (current.invoiceId != resolved.invoiceId || current.status != DisputeStatus.OPEN) return false
        store[resolved.id] = resolved
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

    fun issuePaidInvoice(customerId: String = "cust-1", amountCents: Long = 10_000L, currency: String = "USD"): InvoiceResponse =
        payInvoice(issueInvoice(customerId, amountCents, currency).id)

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

    fun openDisputeRaw(
        invoiceId: String,
        reasonCategory: String = "DUPLICATE_CHARGE",
        description: String = "Charged twice for monthly plan",
        requestedAmountCents: Long = 5_000L,
    ): MvcResult =
        mvc.perform(
            post("/invoices/{id}/disputes", invoiceId)
                .contentType(APPLICATION_JSON)
                .content(
                    json.writeValueAsString(
                        mapOf(
                            "reasonCategory" to reasonCategory,
                            "description" to description,
                            "requestedAmountCents" to requestedAmountCents,
                        ),
                    ),
                ),
        ).andReturn()

    fun openDispute(
        invoiceId: String,
        reasonCategory: String = "DUPLICATE_CHARGE",
        description: String = "Charged twice for monthly plan",
        requestedAmountCents: Long = 5_000L,
    ): DisputeResponse =
        readDispute(openDisputeRaw(invoiceId, reasonCategory, description, requestedAmountCents), expectedStatus = 201)

    fun resolveDisputeRaw(
        invoiceId: String,
        disputeId: String,
        decision: String,
        refundAmountCents: Long? = null,
        resolutionNote: String = "Reviewed claim evidence",
    ): MvcResult {
        val payload = linkedMapOf<String, Any?>(
            "decision" to decision,
            "resolutionNote" to resolutionNote,
        )
        if (refundAmountCents != null) {
            payload["refundAmountCents"] = refundAmountCents
        }
        return mvc.perform(
            post("/invoices/{id}/disputes/{disputeId}/resolve", invoiceId, disputeId)
                .contentType(APPLICATION_JSON)
                .content(json.writeValueAsString(payload)),
        ).andReturn()
    }

    fun resolveDispute(
        invoiceId: String,
        disputeId: String,
        decision: String,
        refundAmountCents: Long? = null,
        resolutionNote: String = "Reviewed claim evidence",
    ): DisputeResponse =
        readDispute(resolveDisputeRaw(invoiceId, disputeId, decision, refundAmountCents, resolutionNote), expectedStatus = 200)

    fun readInvoice(result: MvcResult, expectedStatus: Int): InvoiceResponse {
        check(result.response.status == expectedStatus) {
            "Expected HTTP $expectedStatus but got ${result.response.status}: ${result.response.contentAsString}"
        }
        return json.readValue(result.response.contentAsString)
    }

    fun readDispute(result: MvcResult, expectedStatus: Int): DisputeResponse {
        check(result.response.status == expectedStatus) {
            "Expected HTTP $expectedStatus but got ${result.response.status}: ${result.response.contentAsString}"
        }
        return json.readValue(result.response.contentAsString)
    }
}
EOF

cat > "$test/DisputeTest.kt" <<'EOF'
package billing

import billing.testsupport.FIXED_INSTANT
import billing.testsupport.aDispute
import billing.testsupport.anInvoice
import java.time.Duration
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.EnumSource
import org.junit.jupiter.params.provider.ValueSource

class DisputeTest {
    @ParameterizedTest
    @ValueSource(strings = ["", "   ", "UNKNOWN", "duplicate_charge"])
    fun `rejects unknown dispute reason categories`(raw: String) {
        assertFailsWith<InvalidBillingRequest> {
            DisputeReasonCategory.parse(raw)
        }
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "   ", "short", "123456789"])
    fun `opening a dispute rejects descriptions shorter than 10 trimmed characters`(description: String) {
        val invoice = anInvoice(status = InvoiceStatus.PAID)

        assertFailsWith<InvalidBillingRequest> {
            Dispute.open("disp-1", invoice, DisputeReasonCategory.BILLING_ERROR, description, 1_000L, FIXED_INSTANT)
        }
    }

    @Test
    fun `opening a dispute rejects descriptions longer than 500 characters`() {
        val invoice = anInvoice(status = InvoiceStatus.PAID)

        assertFailsWith<InvalidBillingRequest> {
            Dispute.open("disp-1", invoice, DisputeReasonCategory.BILLING_ERROR, "a".repeat(501), 1_000L, FIXED_INSTANT)
        }
    }

    @ParameterizedTest
    @ValueSource(longs = [0L, -100L, 10_001L])
    fun `opening a dispute rejects requested amounts outside invoice bounds`(amount: Long) {
        val invoice = anInvoice(amountCents = 10_000L, status = InvoiceStatus.PAID)

        assertFailsWith<InvalidBillingRequest> {
            Dispute.open("disp-1", invoice, DisputeReasonCategory.DUPLICATE_CHARGE, "Valid dispute description", amount, FIXED_INSTANT)
        }
    }

    @Test
    fun `opening a dispute trims description and sets initial open state`() {
        val invoice = anInvoice(id = "inv-9", amountCents = 10_000L, status = InvoiceStatus.PAID)

        val dispute = Dispute.open(
            id = "disp-9",
            invoice = invoice,
            reasonCategory = DisputeReasonCategory.UNAUTHORIZED,
            description = "  1234567890  ",
            requestedAmountCents = 10_000L,
            openedAt = FIXED_INSTANT,
        )

        assertEquals("1234567890", dispute.description)
        assertEquals(DisputeStatus.OPEN, dispute.status)
        assertNull(dispute.refundAmountCents)
        assertNull(dispute.resolutionNote)
        assertNull(dispute.resolvedAt)
    }

    @ParameterizedTest
    @EnumSource(value = InvoiceStatus::class, names = ["ISSUED", "VOID", "DISPUTED", "REFUNDED"])
    fun `invoice rejects opening a dispute when status is not paid`(status: InvoiceStatus) {
        val invoice = anInvoice(status = status)

        assertFailsWith<BillingConflict> {
            invoice.openDispute(FIXED_INSTANT.plusSeconds(3_600), existingDisputeCount = 0)
        }
    }

    @Test
    fun `invoice allows opening a dispute at exact 30-day boundary`() {
        val paidAt = FIXED_INSTANT
        val invoice = anInvoice(status = InvoiceStatus.PAID, issuedAt = paidAt.minusSeconds(60), paidAt = paidAt)

        val disputed = invoice.openDispute(paidAt.plus(Duration.ofDays(30)), existingDisputeCount = 1)

        assertEquals(InvoiceStatus.DISPUTED, disputed.status)
    }

    @Test
    fun `invoice rejects opening a dispute after the 30-day window expires`() {
        val paidAt = FIXED_INSTANT
        val invoice = anInvoice(status = InvoiceStatus.PAID, issuedAt = paidAt.minusSeconds(60), paidAt = paidAt)

        assertFailsWith<BillingConflict> {
            invoice.openDispute(paidAt.plus(Duration.ofDays(30)).plusSeconds(1), existingDisputeCount = 0)
        }
    }

    @Test
    fun `invoice rejects opening a third lifetime dispute`() {
        val invoice = anInvoice(status = InvoiceStatus.PAID)

        assertFailsWith<BillingConflict> {
            invoice.openDispute(FIXED_INSTANT.plusSeconds(3_600), existingDisputeCount = 2)
        }
    }

    @Test
    fun `full refund defaults refund amount to invoice total and trims resolution note`() {
        val dispute = aDispute(requestedAmountCents = 4_000L)
        val resolvedAt = FIXED_INSTANT.plusSeconds(7_200)

        val resolved = dispute.resolve(
            decision = DisputeDecision.FULL_REFUND,
            refundAmountCents = null,
            resolutionNote = "  Approved full refund  ",
            invoiceAmountCents = 10_000L,
            resolvedAt = resolvedAt,
        )

        assertEquals(DisputeStatus.RESOLVED_REFUNDED, resolved.status)
        assertEquals(10_000L, resolved.refundAmountCents)
        assertEquals("Approved full refund", resolved.resolutionNote)
        assertEquals(resolvedAt, resolved.resolvedAt)
    }

    @Test
    fun `full refund rejects mismatched explicit refund amount`() {
        val dispute = aDispute(requestedAmountCents = 4_000L)

        assertFailsWith<InvalidBillingRequest> {
            dispute.resolve(DisputeDecision.FULL_REFUND, 4_000L, "Mismatch amount", 10_000L, FIXED_INSTANT)
        }
    }

    @ParameterizedTest
    @ValueSource(longs = [0L, -10L, 5_001L, 10_000L])
    fun `partial refund rejects out-of-range amounts`(invalidRefund: Long) {
        val dispute = aDispute(requestedAmountCents = 5_000L)

        assertFailsWith<InvalidBillingRequest> {
            dispute.resolve(DisputeDecision.PARTIAL_REFUND, invalidRefund, "Invalid partial", 10_000L, FIXED_INSTANT)
        }
    }

    @Test
    fun `partial refund requires strictly less than full invoice amount even when full invoice was requested`() {
        val dispute = aDispute(requestedAmountCents = 10_000L)

        assertFailsWith<InvalidBillingRequest> {
            dispute.resolve(DisputeDecision.PARTIAL_REFUND, 10_000L, "Cannot equal total", 10_000L, FIXED_INSTANT)
        }
    }

    @Test
    fun `reject decision forbids providing refund amount`() {
        val dispute = aDispute()

        assertFailsWith<InvalidBillingRequest> {
            dispute.resolve(DisputeDecision.REJECT, 0L, "Valid rejection note", 10_000L, FIXED_INSTANT)
        }
    }

    @ParameterizedTest
    @ValueSource(strings = ["", "    ", "1234"])
    fun `resolving a dispute rejects notes shorter than 5 trimmed characters`(note: String) {
        val dispute = aDispute()

        assertFailsWith<InvalidBillingRequest> {
            dispute.resolve(DisputeDecision.REJECT, null, note, 10_000L, FIXED_INSTANT)
        }
    }

    @Test
    fun `resolving an already resolved dispute fails with conflict`() {
        val resolved = aDispute(
            status = DisputeStatus.RESOLVED_REJECTED,
            resolutionNote = "Already closed",
            resolvedAt = FIXED_INSTANT.plusSeconds(7_200),
        )

        assertFailsWith<BillingConflict> {
            resolved.resolve(DisputeDecision.FULL_REFUND, null, "Second attempt", 10_000L, FIXED_INSTANT.plusSeconds(9_000))
        }
    }
}
EOF

cat > "$test/DisputeServiceTest.kt" <<'EOF'
package billing

import billing.testsupport.FIXED_INSTANT
import billing.testsupport.InMemoryDisputeRepository
import billing.testsupport.InMemoryInvoiceRepository
import billing.testsupport.aDispute
import billing.testsupport.anInvoice
import java.time.Clock
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions

class DisputeServiceTest {
    private val invoices = InMemoryInvoiceRepository()
    private val disputes = InMemoryDisputeRepository()
    private val notifications = mock(NotificationGateway::class.java)
    private val clock = Clock.fixed(FIXED_INSTANT.plusSeconds(3_600), ZoneOffset.UTC)
    private val service = DisputeService(invoices, disputes, notifications, clock)

    @Test
    fun `opening a dispute transitions invoice to disputed, persists dispute, and notifies gateway`() {
        val paid = anInvoice(id = "inv-1", customerId = "cust-7", amountCents = 10_000L, currency = Currency.USD, status = InvoiceStatus.PAID)
        invoices.insert(paid)

        val opened = service.openDispute(
            OpenDisputeCommand(
                invoiceId = "inv-1",
                reasonCategory = DisputeReasonCategory.DUPLICATE_CHARGE,
                description = "  Charged twice on card  ",
                requestedAmountCents = 4_500L,
            ),
        )

        assertEquals(InvoiceStatus.DISPUTED, invoices.findById("inv-1")?.status)
        assertEquals(opened, disputes.findByIdAndInvoiceId(opened.id, "inv-1"))
        assertEquals("Charged twice on card", opened.description)
        verify(notifications).send(
            BillingNotification(
                eventType = NotificationEventType.DISPUTE_OPENED,
                invoiceId = "inv-1",
                customerId = "cust-7",
                amount = Money(4_500L, Currency.USD),
                metadata = mapOf(
                    "disputeId" to opened.id,
                    "reasonCategory" to "DUPLICATE_CHARGE",
                ),
            ),
        )
    }

    @Test
    fun `resolving with partial refund marks invoice refunded and notifies with refunded amount`() {
        val disputed = anInvoice(id = "inv-2", customerId = "cust-8", amountCents = 10_000L, currency = Currency.EUR, status = InvoiceStatus.DISPUTED)
        val openDispute = aDispute(id = "disp-2", invoiceId = "inv-2", requestedAmountCents = 6_000L)
        invoices.insert(disputed)
        disputes.insert(openDispute)

        val resolved = service.resolveDispute(
            ResolveDisputeCommand(
                invoiceId = "inv-2",
                disputeId = "disp-2",
                decision = DisputeDecision.PARTIAL_REFUND,
                refundAmountCents = 3_500L,
                resolutionNote = "Partial credit approved",
            ),
        )

        assertEquals(DisputeStatus.RESOLVED_PARTIAL_REFUND, resolved.status)
        assertEquals(3_500L, resolved.refundAmountCents)
        assertEquals(InvoiceStatus.REFUNDED, invoices.findById("inv-2")?.status)
        verify(notifications).send(
            BillingNotification(
                eventType = NotificationEventType.DISPUTE_RESOLVED,
                invoiceId = "inv-2",
                customerId = "cust-8",
                amount = Money(3_500L, Currency.EUR),
                metadata = mapOf(
                    "disputeId" to "disp-2",
                    "decision" to "PARTIAL_REFUND",
                    "disputeStatus" to "RESOLVED_PARTIAL_REFUND",
                    "refundAmountCents" to "3500",
                ),
            ),
        )
    }

    @Test
    fun `resolving with reject restores paid invoice status and notifies with invoice amount and zero refund`() {
        val disputed = anInvoice(id = "inv-3", customerId = "cust-9", amountCents = 8_000L, currency = Currency.GBP, status = InvoiceStatus.DISPUTED)
        val openDispute = aDispute(id = "disp-3", invoiceId = "inv-3", requestedAmountCents = 2_000L)
        invoices.insert(disputed)
        disputes.insert(openDispute)

        val resolved = service.resolveDispute(
            ResolveDisputeCommand(
                invoiceId = "inv-3",
                disputeId = "disp-3",
                decision = DisputeDecision.REJECT,
                refundAmountCents = null,
                resolutionNote = "Proof of delivery verified",
            ),
        )

        assertEquals(DisputeStatus.RESOLVED_REJECTED, resolved.status)
        assertEquals(null, resolved.refundAmountCents)
        assertEquals(InvoiceStatus.PAID, invoices.findById("inv-3")?.status)
        verify(notifications).send(
            BillingNotification(
                eventType = NotificationEventType.DISPUTE_RESOLVED,
                invoiceId = "inv-3",
                customerId = "cust-9",
                amount = Money(8_000L, Currency.GBP),
                metadata = mapOf(
                    "disputeId" to "disp-3",
                    "decision" to "REJECT",
                    "disputeStatus" to "RESOLVED_REJECTED",
                    "refundAmountCents" to "0",
                ),
            ),
        )
    }

    @Test
    fun `rejecting an ineligible dispute leaves storage unchanged and sends no notification`() {
        val unpaid = anInvoice(id = "inv-4", status = InvoiceStatus.ISSUED)
        invoices.insert(unpaid)

        assertFailsWith<BillingConflict> {
            service.openDispute(
                OpenDisputeCommand(
                    invoiceId = "inv-4",
                    reasonCategory = DisputeReasonCategory.BILLING_ERROR,
                    description = "Attempt on unpaid invoice",
                    requestedAmountCents = 1_000L,
                ),
            )
        }

        assertEquals(unpaid, invoices.findById("inv-4"))
        assertEquals(emptyList(), disputes.findByInvoiceId("inv-4"))
        verifyNoInteractions(notifications)
    }
}
EOF

cat > "$test/JdbcDisputeRepositoryTest.kt" <<'EOF'
package billing

import billing.testsupport.FIXED_INSTANT
import billing.testsupport.aDispute
import billing.testsupport.anInvoice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.jdbc.JdbcTest
import org.springframework.context.annotation.Import

@JdbcTest
@Import(JdbcInvoiceRepository::class, JdbcDisputeRepository::class)
class JdbcDisputeRepositoryTest {
    @Autowired
    private lateinit var invoices: JdbcInvoiceRepository

    @Autowired
    private lateinit var disputes: JdbcDisputeRepository

    @Test
    fun `inserts disputes and lists them ordered by openedAt then id`() {
        invoices.insert(anInvoice(id = "inv-d1", status = InvoiceStatus.DISPUTED))
        val second = aDispute(id = "disp-b", invoiceId = "inv-d1", openedAt = FIXED_INSTANT.plusSeconds(120))
        val firstTieB = aDispute(id = "disp-a2", invoiceId = "inv-d1", openedAt = FIXED_INSTANT.plusSeconds(60))
        val firstTieA = aDispute(id = "disp-a1", invoiceId = "inv-d1", openedAt = FIXED_INSTANT.plusSeconds(60))

        disputes.insert(second)
        disputes.insert(firstTieB)
        disputes.insert(firstTieA)

        assertEquals(3, disputes.countByInvoiceId("inv-d1"))
        assertEquals(listOf(firstTieA, firstTieB, second), disputes.findByInvoiceId("inv-d1"))
    }

    @Test
    fun `conditional resolve updates an open dispute once and rejects stale updates`() {
        invoices.insert(anInvoice(id = "inv-d2", status = InvoiceStatus.DISPUTED))
        val open = aDispute(id = "disp-open", invoiceId = "inv-d2")
        disputes.insert(open)

        val resolved = open.resolve(
            decision = DisputeDecision.FULL_REFUND,
            refundAmountCents = null,
            resolutionNote = "Verified duplicate charge",
            invoiceAmountCents = 10_000L,
            resolvedAt = FIXED_INSTANT.plusSeconds(600),
        )

        assertTrue(disputes.resolveIfOpen(resolved))
        assertFalse(disputes.resolveIfOpen(resolved))
        assertEquals(resolved, disputes.findByIdAndInvoiceId("disp-open", "inv-d2"))
    }
}
EOF

cat > "$test/InvoiceApiTest.kt" <<'EOF'
package billing

import billing.testsupport.InvoiceApiClient
import billing.testsupport.RecordingNotificationGateway
import com.fasterxml.jackson.databind.ObjectMapper
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit.SECONDS
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
        jdbc.update("DELETE FROM disputes")
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
        assertEquals(emptyList(), created.disputes)

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
        val paid = api.issuePaidInvoice(customerId = "acme-2", amountCents = 3_000L, currency = "EUR")
        notifications.clear()

        val result = api.voidInvoiceRaw(paid.id)

        assertEquals(409, result.response.status)
        assertEquals(paid, api.getInvoice(paid.id))
        assertEquals(emptyList(), notifications.sent)
    }

    @Test
    fun `opens and resolves a dispute with partial refund through HTTP and updates invoice history`() {
        val paid = api.issuePaidInvoice(customerId = "acme-3", amountCents = 10_000L, currency = "USD")
        notifications.clear()

        val opened = api.openDispute(
            invoiceId = paid.id,
            reasonCategory = "SERVICE_NOT_DELIVERED",
            description = "  Missing second milestone delivery  ",
            requestedAmountCents = 4_000L,
        )

        assertEquals("OPEN", opened.status)
        assertEquals("Missing second milestone delivery", opened.description)
        assertEquals("DISPUTED", api.getInvoice(paid.id).status)

        val resolved = api.resolveDispute(
            invoiceId = paid.id,
            disputeId = opened.id,
            decision = "PARTIAL_REFUND",
            refundAmountCents = 3_000L,
            resolutionNote = "Partial milestone credit issued",
        )

        assertEquals("RESOLVED_PARTIAL_REFUND", resolved.status)
        assertEquals(3_000L, resolved.refundAmountCents)

        val fetched = api.getInvoice(paid.id)
        assertEquals("REFUNDED", fetched.status)
        assertEquals(listOf(resolved), fetched.disputes)
        assertEquals(
            listOf(NotificationEventType.DISPUTE_OPENED, NotificationEventType.DISPUTE_RESOLVED),
            notifications.sent.map { it.eventType },
        )
    }

    @Test
    fun `rejected dispute restores paid status and enforces maximum of two lifetime disputes`() {
        val paid = api.issuePaidInvoice(customerId = "acme-4", amountCents = 7_500L, currency = "GBP")
        val first = api.openDispute(paid.id, description = "First rejected dispute claim", requestedAmountCents = 2_000L)
        val firstResolved = api.resolveDispute(paid.id, first.id, decision = "REJECT", resolutionNote = "Charge verified")
        val second = api.openDispute(paid.id, description = "Second rejected dispute claim", requestedAmountCents = 3_000L)
        val secondResolved = api.resolveDispute(paid.id, second.id, decision = "REJECT", resolutionNote = "Charge verified again")
        notifications.clear()

        val thirdAttempt = api.openDisputeRaw(paid.id, description = "Third dispute exceeds limit", requestedAmountCents = 1_000L)

        assertEquals(409, thirdAttempt.response.status)
        val fetched = api.getInvoice(paid.id)
        assertEquals("PAID", fetched.status)
        val expectedOrder = listOf(firstResolved, secondResolved)
            .sortedWith(compareBy<DisputeResponse> { it.openedAt }.thenBy { it.id })
        assertEquals(expectedOrder, fetched.disputes)
        assertEquals(emptyList(), notifications.sent)
    }

    @Test
    fun `maps missing resources and invalid dispute payloads to 404 and 400 without side effects`() {
        val paid = api.issuePaidInvoice(customerId = "acme-5", amountCents = 5_000L, currency = "USD")
        notifications.clear()

        assertEquals(404, api.getInvoiceRaw("inv-missing").response.status)
        assertEquals(404, api.openDisputeRaw("inv-missing").response.status)
        assertEquals(400, api.openDisputeRaw(paid.id, reasonCategory = "INVALID").response.status)
        assertEquals(paid, api.getInvoice(paid.id))
        assertEquals(emptyList(), notifications.sent)
    }

    @Test
    fun `allows only one concurrent dispute open request to succeed`() {
        val paid = api.issuePaidInvoice(customerId = "acme-race", amountCents = 10_000L, currency = "USD")
        notifications.clear()
        val executor = Executors.newFixedThreadPool(4)
        try {
            val barrier = CyclicBarrier(4)
            val attempts = List(4) { idx ->
                executor.submit<Int> {
                    barrier.await(5, SECONDS)
                    api.openDisputeRaw(paid.id, description = "Concurrent claim attempt #$idx", requestedAmountCents = 2_000L).response.status
                }
            }
            val statuses = attempts.map { it.get(15, SECONDS) }.sorted()

            assertEquals(listOf(201, 409, 409, 409), statuses)
            assertEquals(1, api.getInvoice(paid.id).disputes.size)
            assertEquals(1, notifications.sent.size)
        } finally {
            executor.shutdownNow()
        }
    }
}
EOF
