package shop

import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals

class PricingPolicyTest {
    @Test
    fun `total is the subtotal rounded to cents`() {
        val order = Order(
            listOf(
                OrderLine(sku = "SKU-1", quantity = 1, unitPrice = BigDecimal("19.99")),
                OrderLine(sku = "SKU-2", quantity = 1, unitPrice = BigDecimal("0.01")),
            ),
        )

        assertEquals(BigDecimal("20.00"), PricingPolicy.totalFor(order))
    }
}
