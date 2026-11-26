package orders

import com.ninjasquad.springmockk.MockkBean
import com.ninjasquad.springmockk.SpykBean
import io.mockk.every
import io.mockk.verify
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest

@SpringBootTest
class OrderFulfillmentIntegrationTest {
    @SpykBean
    private lateinit var orderService: OrderService

    @MockkBean
    private lateinit var orderRepository: OrderRepository

    @Test
    fun `spies on internal service and mocks internal repository inside full-stack context`() {
        val fakeRecord = OrderRecord("ord-2", 4_900L, "rcpt-2", "PAID")
        every { orderRepository.save(any()) } returns fakeRecord

        val placed = orderService.placeOrder("ord-2", 4_900L)
        assertEquals(fakeRecord, placed)
        verify { orderRepository.save(any()) }
    }
}
