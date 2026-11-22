package shop

import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals

class ShippingPolicyTest {
    private fun orderWithSubtotal(amount: String) =
        Order(listOf(OrderLine(sku = "SKU-1", quantity = 1, unitPrice = BigDecimal(amount))))

    @Test
    fun `orders just over the threshold ship free`() {
        assertEquals(BigDecimal("0.00"), ShippingPolicy.chargeFor(orderWithSubtotal("50.01")))
    }

    @Test
    fun `orders of exactly the threshold pay the standard charge`() {
        assertEquals(BigDecimal("4.99"), ShippingPolicy.chargeFor(orderWithSubtotal("50.00")))
    }

    @Test
    fun `small orders pay the standard charge`() {
        assertEquals(BigDecimal("4.99"), ShippingPolicy.chargeFor(orderWithSubtotal("10.00")))
    }
}
