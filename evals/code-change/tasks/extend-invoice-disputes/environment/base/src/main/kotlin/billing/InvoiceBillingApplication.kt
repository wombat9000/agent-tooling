package billing

import java.time.Clock
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean
import org.springframework.boot.runApplication
import org.springframework.context.annotation.Bean

@SpringBootApplication
class InvoiceBillingApplication {
    @Bean
    fun clock(): Clock = Clock.systemUTC()

    @Bean
    @ConditionalOnMissingBean(NotificationGateway::class)
    fun notificationGateway(): NotificationGateway = LoggingNotificationGateway()
}

fun main(args: Array<String>) {
    runApplication<InvoiceBillingApplication>(*args)
}
