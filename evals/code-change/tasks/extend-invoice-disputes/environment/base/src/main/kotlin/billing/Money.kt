package billing

enum class Currency {
    USD,
    EUR,
    GBP;

    companion object {
        fun parse(raw: String): Currency =
            entries.find { it.name == raw }
                ?: throw InvalidBillingRequest("Unsupported currency: $raw")
    }
}

data class Money(val amountCents: Long, val currency: Currency) {
    init {
        if (amountCents <= 0) {
            throw InvalidBillingRequest("Amount must be positive")
        }
    }
}
