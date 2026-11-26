package com.acme.orders

data class AddressDto(val countryCode: String, val postalCode: String)
data class BillingDto(val currency: String, val address: AddressDto)
data class AccountDto(val billing: BillingDto)
data class OrderSnapshot(val id: String, val status: String, val totalCents: Long, val account: AccountDto)

data class BackoffConfig(val initialDelayMs: Long, val maxDelayMs: Long)
data class RetryConfig(val backoff: BackoffConfig)
data class DeliveryConfig(val retry: RetryConfig)

data class OrderExportRow(
    val orderId: String,
    val countryCode: String,
    val postalCode: String,
    val currency: String,
    val totalCents: Long,
    val retryCapMs: Long,
)

fun mapConfirmedExports(orders: List<OrderSnapshot>, config: DeliveryConfig): List<OrderExportRow> {
    val retryCapMs = config.retry.backoff.maxDelayMs.coerceAtLeast(config.retry.backoff.initialDelayMs)
    return orders
        .filter { it.status == "CONFIRMED" && it.totalCents > 0 }
        .map { order ->
            OrderExportRow(
                orderId = order.id,
                countryCode = order.account.billing.address.countryCode,
                postalCode = order.account.billing.address.postalCode,
                currency = order.account.billing.currency,
                totalCents = order.totalCents,
                retryCapMs = retryCapMs,
            )
        }
        .sortedBy { it.orderId }
}
