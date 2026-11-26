package com.acme.booking.http

import com.acme.booking.model.BookingRecord
import com.acme.booking.model.BookingStatus
import com.acme.booking.model.PricingTier

data class HttpResponse(val status: Int, val headers: Map<String, String>, val body: String)

fun formatBookingResponse(bookingId: String, booking: BookingRecord, pageSize: Int): HttpResponse {
    val summaryLabel = when (booking.status) {
        BookingStatus.CONFIRMED -> "confirmed"
        BookingStatus.PENDING -> "pending"
        BookingStatus.CANCELLED -> "cancelled"
    }
    val isPriority = booking.tier == PricingTier.ENTERPRISE
    val count = booking.guestIds.size.coerceAtMost(pageSize)
    return HttpResponse(
        status = 200,
        headers = mapOf("Content-Type" to "application/json"),
        body = """{"id":"$bookingId","status":"$summaryLabel","priority":$isPriority,"guests":$count}""",
    )
}
