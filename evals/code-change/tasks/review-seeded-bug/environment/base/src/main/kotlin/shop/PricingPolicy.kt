package shop

import java.math.BigDecimal
import java.math.RoundingMode

/** Calculates the amount a customer pays for an order. */
object PricingPolicy {
    /** Returns the order total, rounded to cents (half-up). */
    fun totalFor(order: Order): BigDecimal = order.subtotal().setScale(2, RoundingMode.HALF_UP)
}
