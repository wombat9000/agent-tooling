package com.acme.ledger

data class AccountRow(val id: String, val country: String, val tier: String, var balanceCents: Long, var frozen: Boolean)

class TransferCoordinator(private val accounts: MutableMap<String, AccountRow>, private val auditLog: MutableList<String>) {
    fun executeRawTransfer(rawLines: List<String>, fxRates: Map<String, Double>, notifications: MutableList<String>): Map<String, Any> {
        val fields = mutableMapOf<String, String>()
        for (line in rawLines) {
            val idx = line.indexOf('=')
            if (idx <= 0) throw IllegalArgumentException("Malformed line: $line")
            fields[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
        }
        val transferId = fields["id"]?.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("Missing id")
        val sourceId = fields["source"] ?: throw IllegalArgumentException("Missing source")
        val destId = fields["destination"] ?: throw IllegalArgumentException("Missing destination")
        val amountCents = fields["amount_cents"]?.toLongOrNull() ?: throw IllegalArgumentException("Invalid amount")
        val currency = fields["currency"]?.uppercase() ?: "USD"
        if (amountCents <= 0L || sourceId == destId) {
            throw IllegalArgumentException("Invalid transfer parameters")
        }

        val source = accounts[sourceId] ?: throw IllegalStateException("Unknown source $sourceId")
        val dest = accounts[destId] ?: throw IllegalStateException("Unknown destination $destId")
        if (source.frozen || dest.frozen) {
            throw IllegalStateException("Account is frozen")
        }
        val sanctionedCountries = setOf("KP", "IR", "SY")
        if (source.country in sanctionedCountries || dest.country in sanctionedCountries) {
            auditLog.add("BLOCKED|$transferId|$sourceId|$destId|sanctioned")
            throw IllegalStateException("Sanctioned jurisdiction")
        }
        if (source.country != dest.country && amountCents > 2_500_000L && source.tier != "ENTERPRISE") {
            auditLog.add("BLOCKED|$transferId|$sourceId|$destId|cross_border_limit")
            throw IllegalStateException("Cross-border limit exceeded")
        }

        val fxRate = if (currency == "USD") 1.0 else fxRates[currency] ?: throw IllegalStateException("Missing FX rate")
        val usdEquivalentCents = Math.round(amountCents * fxRate)
        var feeCents = when {
            source.tier == "ENTERPRISE" -> 0L
            usdEquivalentCents >= 1_000_000L -> Math.round(usdEquivalentCents * 0.005)
            usdEquivalentCents >= 100_000L -> Math.round(usdEquivalentCents * 0.01)
            else -> 250L
        }
        if (source.country != dest.country) {
            feeCents += 450L
        }
        val totalDebit = usdEquivalentCents + feeCents
        if (source.balanceCents < totalDebit) {
            throw IllegalStateException("Insufficient funds")
        }

        source.balanceCents -= totalDebit
        dest.balanceCents += usdEquivalentCents
        val timestamp = System.currentTimeMillis()
        auditLog.add("SETTLED|$transferId|$sourceId|$destId|$usdEquivalentCents|$feeCents|$timestamp")

        val summary = buildString {
            append("Transfer $transferId completed: ")
            append("$sourceId -> $destId ")
            append("amount=$usdEquivalentCents fee=$feeCents ")
            append("remaining=${source.balanceCents}")
        }
        notifications.add("TO:$sourceId|$summary")
        notifications.add("TO:$destId|Incoming transfer $transferId amount=$usdEquivalentCents")

        return mapOf(
            "transferId" to transferId,
            "usdAmountCents" to usdEquivalentCents,
            "feeCents" to feeCents,
            "sourceBalanceCents" to source.balanceCents,
            "destBalanceCents" to dest.balanceCents,
            "summary" to summary,
        )
    }
}
