package shop

import java.math.BigDecimal

/** One product line in an order. Quantity is at least 1 and the unit price is not negative. */
data class OrderLine(val sku: String, val quantity: Int, val unitPrice: BigDecimal) {
    init {
        require(quantity >= 1) { "quantity must be at least 1, was $quantity" }
        require(unitPrice >= BigDecimal.ZERO) { "unitPrice must not be negative, was $unitPrice" }
    }

    fun lineTotal(): BigDecimal = unitPrice * quantity.toBigDecimal()
}

/** A customer's order. */
data class Order(val lines: List<OrderLine>) {
    fun subtotal(): BigDecimal = lines.fold(BigDecimal.ZERO) { sum, line -> sum + line.lineTotal() }
}
