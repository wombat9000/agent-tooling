package orders

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest

@SpringBootTest
class OrderFulfillmentIntegrationTest @Autowired constructor(
    private val orderService: OrderService,
    private val orderRepository: OrderRepository,
) {
    @Test
    fun `persists paid order through real OrderService and real OrderRepository`() {
        val placed = orderService.placeOrder("ord-2", 4_900L)
        val reloaded = orderRepository.findById("ord-2")
        assertEquals(placed, reloaded)
    }
}
