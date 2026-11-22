package shop

import java.math.BigDecimal
import java.math.RoundingMode

/** Calculates the amount a customer pays for an order. */
object PricingPolicy {
    private val discountThreshold = BigDecimal("100.00")
    private val discountRate = BigDecimal("0.05")

    /**
     * Returns the order total, rounded to cents (half-up).
     *
     * Orders over [discountThreshold] receive a discount of [discountRate].
     */
    fun totalFor(order: Order): BigDecimal {
        val subtotal = order.subtotal()
        val discount = if (subtotal >= discountThreshold) subtotal * discountRate else BigDecimal.ZERO
        return (subtotal - discount).setScale(2, RoundingMode.HALF_UP)
    }
}
