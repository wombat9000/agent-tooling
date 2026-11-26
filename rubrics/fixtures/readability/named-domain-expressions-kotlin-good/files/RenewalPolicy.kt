package com.acme.billing

enum class SubscriptionState { ACTIVE, PAST_DUE, CANCELLED }

data class RenewalCandidate(
    val accountId: String,
    val state: SubscriptionState,
    val daysUntilExpiry: Int,
    val unpaidBalanceCents: Long,
    val hasPaymentMethod: Boolean,
) {
    val isWithinRenewalWindow: Boolean
        get() = daysUntilExpiry in 0..7

    val isInGoodStanding: Boolean
        get() = state == SubscriptionState.ACTIVE && unpaidBalanceCents == 0L
}

fun isEligibleForAutoRenewal(candidate: RenewalCandidate?): Boolean {
    if (candidate == null || candidate.accountId.isBlank()) {
        return false
    }
    return candidate.isInGoodStanding && candidate.isWithinRenewalWindow && candidate.hasPaymentMethod
}
