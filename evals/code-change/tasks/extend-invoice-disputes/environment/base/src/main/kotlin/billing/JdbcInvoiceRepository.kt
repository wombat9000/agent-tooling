package billing

import java.sql.ResultSet
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository

interface InvoiceRepository {
    fun insert(invoice: Invoice)
    fun findById(id: String): Invoice?
    fun updateStatus(id: String, expectedStatus: InvoiceStatus, newStatus: InvoiceStatus, paidAt: Instant? = null): Boolean
}

@Repository
class JdbcInvoiceRepository(private val jdbc: JdbcTemplate) : InvoiceRepository {
    override fun insert(invoice: Invoice) {
        jdbc.update(
            """
            INSERT INTO invoices (id, customer_id, amount_cents, currency, status, issued_at, paid_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """.trimIndent(),
            invoice.id,
            invoice.customerId,
            invoice.amount.amountCents,
            invoice.amount.currency.name,
            invoice.status.name,
            invoice.issuedAt.atOffset(ZoneOffset.UTC),
            invoice.paidAt?.atOffset(ZoneOffset.UTC),
        )
    }

    override fun findById(id: String): Invoice? =
        jdbc.query(
            """
            SELECT id, customer_id, amount_cents, currency, status, issued_at, paid_at
            FROM invoices
            WHERE id = ?
            """.trimIndent(),
            { row, _ -> mapRow(row) },
            id,
        ).firstOrNull()

    override fun updateStatus(
        id: String,
        expectedStatus: InvoiceStatus,
        newStatus: InvoiceStatus,
        paidAt: Instant?,
    ): Boolean {
        val updated = if (paidAt != null) {
            jdbc.update(
                "UPDATE invoices SET status = ?, paid_at = ? WHERE id = ? AND status = ?",
                newStatus.name,
                paidAt.atOffset(ZoneOffset.UTC),
                id,
                expectedStatus.name,
            )
        } else {
            jdbc.update(
                "UPDATE invoices SET status = ? WHERE id = ? AND status = ?",
                newStatus.name,
                id,
                expectedStatus.name,
            )
        }
        return updated == 1
    }

    private fun mapRow(row: ResultSet): Invoice =
        Invoice(
            id = row.getString("id"),
            customerId = row.getString("customer_id"),
            amount = Money(
                amountCents = row.getLong("amount_cents"),
                currency = Currency.valueOf(row.getString("currency")),
            ),
            status = InvoiceStatus.valueOf(row.getString("status")),
            issuedAt = row.getObject("issued_at", OffsetDateTime::class.java).toInstant(),
            paidAt = row.getObject("paid_at", OffsetDateTime::class.java)?.toInstant(),
        )
}
