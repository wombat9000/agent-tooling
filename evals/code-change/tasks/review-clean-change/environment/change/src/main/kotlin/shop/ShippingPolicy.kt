package shop

import java.math.BigDecimal

/**
 * Decides the shipping charge for an order.
 *
 * Orders whose subtotal is over [freeShippingThreshold] ship free; all other orders pay
 * [standardCharge].
 */
object ShippingPolicy {
    val freeShippingThreshold = BigDecimal("50.00")
    val standardCharge = BigDecimal("4.99")

    private val noCharge = BigDecimal("0.00")

    /** Returns the shipping charge for [order], with two decimal places. */
    fun chargeFor(order: Order): BigDecimal =
        if (order.subtotal() > freeShippingThreshold) noCharge else standardCharge
}
