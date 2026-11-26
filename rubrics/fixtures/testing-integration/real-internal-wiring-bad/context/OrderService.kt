package orders

interface PaymentGateway {
    fun charge(orderId: String, amountCents: Long): String
}

interface OrderRepository {
    fun save(order: OrderRecord): OrderRecord
    fun findById(id: String): OrderRecord?
}

data class OrderRecord(val id: String, val amountCents: Long, val receiptId: String, val status: String)

class OrderService(
    private val repository: OrderRepository,
    private val paymentGateway: PaymentGateway,
) {
    fun placeOrder(id: String, amountCents: Long): OrderRecord {
        val receipt = paymentGateway.charge(id, amountCents)
        return repository.save(OrderRecord(id, amountCents, receipt, "PAID"))
    }
}
