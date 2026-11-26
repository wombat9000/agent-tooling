package orders

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.test.web.client.TestRestTemplate
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class OrderApiIntegrationTest @Autowired constructor(
    private val restTemplate: TestRestTemplate,
    private val orderRepository: OrderRepository,
) {
    @TestConfiguration
    class ExternalBoundaryConfig {
        @Bean
        @Primary
        fun fakePaymentGateway(): PaymentGateway = object : PaymentGateway {
            override fun charge(orderId: String, amountCents: Long): String = "rcpt-$orderId"
        }
    }

    @Test
    fun `POST orders wires real controller, service, and repository while faking only external payment provider`() {
        val response = restTemplate.postForEntity("/orders", mapOf("id" to "ord-1", "amountCents" to 2_500L), OrderRecord::class.java)
        assertEquals(201, response.statusCode.value())
        assertEquals("rcpt-ord-1", response.body?.receiptId)
        assertEquals("PAID", orderRepository.findById("ord-1")?.status)
    }
}
