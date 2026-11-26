package com.acme.billing

import com.acme.legacy.LegacyAuditBridge

data class InvoiceDraftRequest(
    val accountId: String,
    val customerName: String,
    val currencyCode: String,
    val subtotalCents: Long,
    val taxRateBasisPoints: Int,
    val dueDateIso: String,
    val purchaseOrderRef: String?,
    val autoSendEmail: Boolean,
)

data class InvoiceDraftSummary(val accountId: String, val totalCents: Long, val headline: String)

class InvoiceDraftService(private val auditBridge: LegacyAuditBridge) {
    fun buildDraftSummary(request: InvoiceDraftRequest): InvoiceDraftSummary {
        val (accountId, customerName, currencyCode, subtotalCents, taxRateBasisPoints, dueDateIso, poRef, _) = request
        val taxCents = (subtotalCents * taxRateBasisPoints) / 10_000
        val totalCents = subtotalCents + taxCents
        val refSuffix = poRef?.let { " (PO $it)" } ?: ""
        val headline = "$customerName$refSuffix: $currencyCode $totalCents due $dueDateIso"
        return InvoiceDraftSummary(accountId, totalCents, headline)
    }

    fun recordDraftAudit(accountId: String, actorId: String) {
        auditBridge.writeRawEntry(
            accountId,
            actorId,
            "invoice.draft_created",
            "billing-api",
            true,
            0,
            null,
            "v1",
        )
    }
}
