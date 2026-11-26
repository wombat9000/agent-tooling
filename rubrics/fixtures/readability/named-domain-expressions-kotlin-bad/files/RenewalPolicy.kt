package com.acme.billing

data class RenewalCandidate(
    val accountCode: String,
    val status: String,
    val daysUntilExpiry: Int,
    val unpaidBalanceCents: Long,
    val priorFailures: Int,
    val planSeats: Int,
)

fun decideRenewalAction(c: RenewalCandidate): String {
    if (
        c.status != "ACTIVE" ||
        (c.daysUntilExpiry < 0 || c.daysUntilExpiry > 7) ||
        (c.unpaidBalanceCents > 0L && (c.priorFailures >= 2 || c.planSeats < 10)) ||
        !Regex("^[A-Z]{3}-[0-9]{5}$").matches(c.accountCode)
    ) {
        return "BLOCK"
    }
    return if (c.planSeats >= 50 && c.priorFailures == 0 && c.unpaidBalanceCents == 0L && c.daysUntilExpiry <= 3) {
        "AUTO_RENEW_PRIORITY"
    } else if (c.priorFailures == 1 && c.daysUntilExpiry <= 2 && c.planSeats >= 10) {
        "RETRY_WITH_NOTICE"
    } else {
        "MANUAL_REVIEW"
    }
}
