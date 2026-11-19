package shop

import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals

class PricingPolicyTest {
    private fun orderOf(vararg unitPrices: String) =
        Order(unitPrices.map { OrderLine(sku = "SKU-1", quantity = 1, unitPrice = BigDecimal(it)) })

    @Test
    fun `total is the subtotal rounded to cents`() {
        assertEquals(BigDecimal("20.00"), PricingPolicy.totalFor(orderOf("19.99", "0.01")))
    }

    @Test
    fun `orders over the threshold receive five percent off`() {
        assertEquals(BigDecimal("142.50"), PricingPolicy.totalFor(orderOf("150.00")))
    }

    @Test
    fun `small orders pay the full subtotal`() {
        assertEquals(BigDecimal("50.00"), PricingPolicy.totalFor(orderOf("50.00")))
    }
}
