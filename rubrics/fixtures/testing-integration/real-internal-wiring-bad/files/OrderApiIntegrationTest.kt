package orders

import com.ninjasquad.springmockk.MockkBean
import io.mockk.every
import io.mockk.verify
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.client.TestRestTemplate

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class OrderApiIntegrationTest @Autowired constructor(
    private val restTemplate: TestRestTemplate,
) {
    @MockkBean
    private lateinit var orderService: OrderService

    @MockkBean
    private lateinit var orderRepository: OrderRepository

    @Test
    fun `mocks internal OrderService inside full-stack SpringBootTest`() {
        every { orderService.placeOrder("ord-1", 2_500L) } returns OrderRecord("ord-1", 2_500L, "rcpt-1", "PAID")

        val response = restTemplate.postForEntity("/orders", mapOf("id" to "ord-1", "amountCents" to 2_500L), OrderRecord::class.java)
        assertEquals(201, response.statusCode.value())
        verify(exactly = 1) { orderService.placeOrder("ord-1", 2_500L) }
    }
}
