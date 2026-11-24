package billing

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

data class CreateInvoiceRequest(
    val customerId: String? = null,
    val amountCents: Long? = null,
    val currency: String? = null,
)

data class InvoiceResponse(
    val id: String,
    val customerId: String,
    val amountCents: Long,
    val currency: String,
    val status: String,
    val issuedAt: String,
    val paidAt: String?,
) {
    companion object {
        fun from(invoice: Invoice): InvoiceResponse =
            InvoiceResponse(
                id = invoice.id,
                customerId = invoice.customerId,
                amountCents = invoice.amount.amountCents,
                currency = invoice.amount.currency.name,
                status = invoice.status.name,
                issuedAt = invoice.issuedAt.toString(),
                paidAt = invoice.paidAt?.toString(),
            )
    }
}

@RestController
@RequestMapping("/invoices")
class InvoiceController(private val invoiceService: InvoiceService) {
    @PostMapping
    fun issue(@RequestBody request: CreateInvoiceRequest): ResponseEntity<InvoiceResponse> {
        val customerId = request.customerId ?: throw InvalidBillingRequest("customerId is required")
        val amountCents = request.amountCents ?: throw InvalidBillingRequest("amountCents is required")
        val currency = request.currency?.let(Currency::parse) ?: throw InvalidBillingRequest("currency is required")
        val created = invoiceService.issueInvoice(customerId, Money(amountCents, currency))
        return ResponseEntity.status(HttpStatus.CREATED).body(InvoiceResponse.from(created))
    }

    @GetMapping("/{id}")
    fun fetch(@PathVariable id: String): InvoiceResponse =
        InvoiceResponse.from(invoiceService.getInvoice(id))

    @PostMapping("/{id}/pay")
    fun pay(@PathVariable id: String): InvoiceResponse =
        InvoiceResponse.from(invoiceService.payInvoice(id))

    @PostMapping("/{id}/void")
    fun void(@PathVariable id: String): InvoiceResponse =
        InvoiceResponse.from(invoiceService.voidInvoice(id))
}
