#!/usr/bin/env bash
set -euo pipefail

cd /workspace
main=src/main/kotlin/booking
test=src/test/kotlin/booking
mkdir -p "$main" "$test" src/main/resources

cat > "$main/MeetingRoomBookingApplication.kt" <<'EOF'
package booking

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class MeetingRoomBookingApplication

fun main(args: Array<String>) {
    runApplication<MeetingRoomBookingApplication>(*args)
}
EOF

cat > "$main/TimeSlot.kt" <<'EOF'
package booking

import java.time.Instant

data class TimeSlot(val startsAt: Instant, val endsAt: Instant) {
    init {
        require(startsAt < endsAt) { "The end must be later than the start" }
    }
}
EOF

cat > "$main/Booking.kt" <<'EOF'
package booking

data class Booking(val id: String, val roomId: String, val slot: TimeSlot)
EOF

cat > "$main/BookingFailure.kt" <<'EOF'
package booking

sealed class BookingFailure(message: String) : RuntimeException(message)

class BookingNotFound(message: String) : BookingFailure(message)

class BookingConflict : BookingFailure("The room is already booked during that time")
EOF

cat > "$main/BookingRepository.kt" <<'EOF'
package booking

import java.sql.ResultSet
import java.time.OffsetDateTime
import java.time.ZoneOffset.UTC
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository

@Repository
class BookingRepository(private val jdbc: JdbcClient) {
    private val mapper = RowMapper { row: ResultSet, _: Int ->
        Booking(
            id = row.getString("id"),
            roomId = row.getString("room_id"),
            slot = TimeSlot(
                row.getObject("starts_at", OffsetDateTime::class.java).toInstant(),
                row.getObject("ends_at", OffsetDateTime::class.java).toInstant(),
            ),
        )
    }

    fun roomExists(roomId: String): Boolean = jdbc.sql("SELECT id FROM rooms WHERE id = :room")
        .param("room", roomId).query(String::class.java).optional().isPresent

    // A stable room row can be locked even when that room has no bookings yet.
    fun lockRoom(roomId: String): Boolean = jdbc.sql("SELECT id FROM rooms WHERE id = :room FOR UPDATE")
        .param("room", roomId).query(String::class.java).optional().isPresent

    fun list(roomId: String): List<Booking> = jdbc.sql(
        "SELECT id, room_id, starts_at, ends_at FROM bookings WHERE room_id = :room ORDER BY starts_at",
    ).param("room", roomId).query(mapper).list()

    fun find(id: String): Booking? = jdbc.sql(
        "SELECT id, room_id, starts_at, ends_at FROM bookings WHERE id = :id",
    ).param("id", id).query(mapper).optional().orElse(null)

    fun hasOverlap(candidate: Booking): Boolean = jdbc.sql(
        """
        SELECT EXISTS (
            SELECT 1 FROM bookings
            WHERE room_id = :room AND id <> :id
                AND starts_at < :ends AND ends_at > :starts
        )
        """.trimIndent(),
    ).param("room", candidate.roomId)
        .param("id", candidate.id)
        .param("starts", candidate.slot.startsAt.atOffset(UTC))
        .param("ends", candidate.slot.endsAt.atOffset(UTC))
        .query(Boolean::class.javaObjectType).single()

    fun insert(booking: Booking) {
        jdbc.sql("INSERT INTO bookings (id, room_id, starts_at, ends_at) VALUES (:id, :room, :starts, :ends)")
            .param("id", booking.id)
            .param("room", booking.roomId)
            .param("starts", booking.slot.startsAt.atOffset(UTC))
            .param("ends", booking.slot.endsAt.atOffset(UTC))
            .update()
    }

    fun reschedule(booking: Booking) {
        jdbc.sql("UPDATE bookings SET starts_at = :starts, ends_at = :ends WHERE id = :id")
            .param("id", booking.id)
            .param("starts", booking.slot.startsAt.atOffset(UTC))
            .param("ends", booking.slot.endsAt.atOffset(UTC))
            .update()
    }

    fun delete(id: String) {
        jdbc.sql("DELETE FROM bookings WHERE id = :id").param("id", id).update()
    }
}
EOF

cat > "$main/BookingService.kt" <<'EOF'
package booking

import java.util.UUID
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

@Service
class BookingService(private val bookings: BookingRepository) {
    fun list(roomId: String): List<Booking> {
        if (!bookings.roomExists(roomId)) throw BookingNotFound("Unknown room: $roomId")
        return bookings.list(roomId)
    }

    @Transactional
    fun create(roomId: String, slot: TimeSlot): Booking {
        lockRoom(roomId)
        val booking = Booking(UUID.randomUUID().toString(), roomId, slot)
        checkAvailability(booking)
        bookings.insert(booking)
        return booking
    }

    @Transactional
    fun reschedule(id: String, slot: TimeSlot): Booking {
        val updated = lockBooking(id).copy(slot = slot)
        checkAvailability(updated)
        bookings.reschedule(updated)
        return updated
    }

    @Transactional
    fun cancel(id: String) {
        lockBooking(id)
        bookings.delete(id)
    }

    private fun lockBooking(id: String): Booking {
        lockRoom(findBooking(id).roomId)
        return findBooking(id)
    }

    private fun findBooking(id: String): Booking = bookings.find(id) ?: throw BookingNotFound("Unknown booking: $id")

    private fun lockRoom(roomId: String) {
        if (!bookings.lockRoom(roomId)) throw BookingNotFound("Unknown room: $roomId")
    }

    private fun checkAvailability(booking: Booking) {
        if (bookings.hasOverlap(booking)) throw BookingConflict()
    }
}
EOF

cat > "$main/BookingController.kt" <<'EOF'
package booking

import java.time.DateTimeException
import java.time.Instant
import java.time.OffsetDateTime
import org.springframework.http.HttpStatus.BAD_REQUEST
import org.springframework.http.HttpStatus.CONFLICT
import org.springframework.http.HttpStatus.CREATED
import org.springframework.http.HttpStatus.NOT_FOUND
import org.springframework.http.HttpStatus.NO_CONTENT
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException

@RestController
class BookingController(private val service: BookingService) {
    private val timestampPattern = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")

    data class Request(val startsAt: String, val endsAt: String)
    data class Response(val id: String, val roomId: String, val startsAt: String, val endsAt: String)

    @PostMapping("/rooms/{roomId}/bookings")
    @ResponseStatus(CREATED)
    fun create(@PathVariable roomId: String, @RequestBody request: Request): Response =
        service.create(roomId, request.toSlot()).toResponse()

    @GetMapping("/rooms/{roomId}/bookings")
    fun list(@PathVariable roomId: String): List<Response> = service.list(roomId).map { it.toResponse() }

    @PatchMapping("/bookings/{id}")
    fun reschedule(@PathVariable id: String, @RequestBody request: Request): Response =
        service.reschedule(id, request.toSlot()).toResponse()

    @DeleteMapping("/bookings/{id}")
    @ResponseStatus(NO_CONTENT)
    fun cancel(@PathVariable id: String) = service.cancel(id)

    @ExceptionHandler(BookingNotFound::class)
    @ResponseStatus(NOT_FOUND)
    fun notFound() {}

    @ExceptionHandler(BookingConflict::class)
    @ResponseStatus(CONFLICT)
    fun conflict() {}

    private fun Request.toSlot(): TimeSlot = try {
        TimeSlot(parseTimestamp(startsAt), parseTimestamp(endsAt))
    } catch (error: DateTimeException) {
        throw ResponseStatusException(BAD_REQUEST, "Invalid booking timestamp", error)
    } catch (error: IllegalArgumentException) {
        throw ResponseStatusException(BAD_REQUEST, error.message, error)
    }

    private fun parseTimestamp(value: String): Instant {
        require(timestampPattern.matches(value) && !value.startsWith("0000")) { "Expected a whole-second UTC timestamp" }
        return OffsetDateTime.parse(value).toInstant()
    }

    private fun Booking.toResponse(): Response = Response(id, roomId, slot.startsAt.toString(), slot.endsAt.toString())
}
EOF

cat > src/main/resources/application.properties <<'EOF'
spring.jackson.deserialization.fail-on-trailing-tokens=true
EOF

cat > src/main/resources/schema.sql <<'EOF'
CREATE TABLE rooms (id VARCHAR(64) PRIMARY KEY);
INSERT INTO rooms VALUES ('atlas'), ('orion');

CREATE TABLE bookings (
    id VARCHAR(64) PRIMARY KEY,
    room_id VARCHAR(64) NOT NULL REFERENCES rooms(id),
    starts_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
    CHECK (starts_at < ends_at)
);

CREATE INDEX bookings_room_start ON bookings (room_id, starts_at);
EOF

cat > "$test/BookingServiceTest.kt" <<'EOF'
package booking

import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest

@SpringBootTest
class BookingServiceTest {
    @Autowired private lateinit var service: BookingService

    @Test
    fun `adjacent slots succeed and a rejected move preserves the original slot`() {
        val first = service.create("atlas", slot(9, 10))
        val adjacent = service.create("atlas", slot(10, 11))

        assertFailsWith<BookingConflict> { service.reschedule(first.id, slot(9, 11)) }
        assertEquals(listOf(first, adjacent), service.list("atlas"))

        service.cancel(adjacent.id)
        val moved = service.reschedule(first.id, slot(9, 11))
        assertEquals(first.id, moved.id)
        assertEquals(listOf(moved), service.list("atlas"))
    }

    @Test
    fun `empty ranges cannot be booked`() {
        assertFailsWith<IllegalArgumentException> { slot(10, 10) }
    }

    private fun slot(start: Int, end: Int): TimeSlot = TimeSlot(time(start), time(end))

    private fun time(hour: Int): Instant = Instant.parse("2030-05-20T${hour.toString().padStart(2, '0')}:00:00Z")
}
EOF
