package billing

import org.slf4j.LoggerFactory

enum class NotificationEventType {
    INVOICE_PAID,
    INVOICE_VOIDED,
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
