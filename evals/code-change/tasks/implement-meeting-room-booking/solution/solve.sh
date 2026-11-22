#!/usr/bin/env bash
set -euo pipefail

cd /workspace
main=src/main/kotlin/booking
test=src/test/kotlin/booking
mkdir -p "$main" "$test" src/main/resources

cat > "$main/MeetingRoomBookingApplication.kt" <<'EOF'
package booking

import java.time.Clock
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.context.annotation.Bean

@SpringBootApplication
class MeetingRoomBookingApplication {
    @Bean
    fun clock(): Clock = Clock.systemUTC()
}

fun main(args: Array<String>) {
    runApplication<MeetingRoomBookingApplication>(*args)
}
EOF

cat > "$main/BookingStatus.kt" <<'EOF'
package booking

enum class BookingStatus(val isActive: Boolean) {
    PENDING(isActive = true),
    CONFIRMED(isActive = true),
    CANCELLED(isActive = false),
}
EOF

cat > "$main/RoomTier.kt" <<'EOF'
package booking

import java.time.Duration

enum class RoomTier(
    val cleanupBuffer: Duration,
    val initialBookingStatus: BookingStatus,
    val rescheduledBookingStatus: BookingStatus,
) {
    STANDARD(
        cleanupBuffer = Duration.ZERO,
        initialBookingStatus = BookingStatus.CONFIRMED,
        rescheduledBookingStatus = BookingStatus.CONFIRMED,
    ),
    EXECUTIVE(
        cleanupBuffer = Duration.ofMinutes(15),
        initialBookingStatus = BookingStatus.PENDING,
        rescheduledBookingStatus = BookingStatus.PENDING,
    ),
}
EOF

cat > "$main/TimeSlot.kt" <<'EOF'
package booking

import java.time.Duration
import java.time.Instant

data class TimeSlot(val startsAt: Instant, val endsAt: Instant) {
    init {
        require(startsAt < endsAt) { "The end must be later than the start" }
    }

    val duration: Duration
        get() = Duration.between(startsAt, endsAt)

    fun startsInPast(now: Instant): Boolean = startsAt < now

    fun isWithinCutoff(now: Instant, cutoff: Duration): Boolean =
        startsAt < now.plus(cutoff)

    fun conflictsWith(other: TimeSlot, buffer: Duration): Boolean {
        val bufferedStart = other.startsAt.minus(buffer)
        val bufferedEnd = other.endsAt.plus(buffer)
        return startsAt < bufferedEnd && endsAt > bufferedStart
    }
}
EOF

cat > "$main/BookingFailure.kt" <<'EOF'
package booking

sealed class BookingFailure(message: String) : RuntimeException(message)

class InvalidBookingRequest(message: String) : BookingFailure(message)

class BookingNotFound(message: String) : BookingFailure(message)

class BookingConflict(message: String) : BookingFailure(message)
EOF

cat > "$main/Room.kt" <<'EOF'
package booking

import java.time.Duration

data class Room(
    val id: String,
    val tier: RoomTier,
    val minAttendees: Int,
    val capacity: Int,
    val maxDuration: Duration,
    val equipment: Set<String>,
) {
    init {
        require(id.isNotBlank()) { "Room ID must not be blank" }
        require(minAttendees >= 1) { "Minimum attendees must be at least 1" }
        require(capacity >= minAttendees) { "Capacity must be at least minimum attendees" }
        val isPositiveDuration = !maxDuration.isNegative && !maxDuration.isZero
        require(isPositiveDuration) { "Max duration must be positive" }
    }

    fun supportsAttendees(attendees: Int): Boolean = attendees in minAttendees..capacity

    fun supportsDuration(slot: TimeSlot): Boolean = slot.duration <= maxDuration

    fun hasAllEquipment(required: Set<String>): Boolean = equipment.containsAll(required)

    fun validateBookingRequest(slot: TimeSlot, attendees: Int) {
        if (!supportsAttendees(attendees)) {
            throw InvalidBookingRequest("Attendees must be between $minAttendees and $capacity for room $id")
        }
        if (!supportsDuration(slot)) {
            throw InvalidBookingRequest("Booking duration exceeds max duration for room $id")
        }
    }

    fun hasConflict(candidate: TimeSlot, activeBookings: List<Booking>, excludedBookingId: String? = null): Boolean =
        activeBookings.any { existing ->
            val isCompetingBooking = existing.status.isActive && existing.id != excludedBookingId
            isCompetingBooking && candidate.conflictsWith(existing.slot, tier.cleanupBuffer)
        }

    fun isAvailableFor(
        slot: TimeSlot,
        attendees: Int,
        requiredEquipment: Set<String>,
        activeBookings: List<Booking>,
    ): Boolean {
        val satisfiesPolicy = supportsAttendees(attendees) &&
            supportsDuration(slot) &&
            hasAllEquipment(requiredEquipment)
        return satisfiesPolicy && !hasConflict(slot, activeBookings)
    }
}
EOF

cat > "$main/Booking.kt" <<'EOF'
package booking

import java.time.Duration
import java.time.Instant

data class Booking(
    val id: String,
    val roomId: String,
    val slot: TimeSlot,
    val attendees: Int,
    val status: BookingStatus,
) {
    init {
        require(id.isNotBlank()) { "Booking ID must not be blank" }
        require(roomId.isNotBlank()) { "Room ID must not be blank" }
        require(attendees >= 1) { "Attendees must be at least 1" }
    }

    fun confirm(): Booking {
        val isPending = status == BookingStatus.PENDING
        if (!isPending) throw BookingConflict("Only pending bookings can be confirmed")
        return copy(status = BookingStatus.CONFIRMED)
    }

    fun cancel(now: Instant): Booking {
        ensureMutable(now, action = "cancel")
        return copy(status = BookingStatus.CANCELLED)
    }

    fun reschedule(room: Room, newSlot: TimeSlot, newAttendees: Int, now: Instant): Booking {
        ensureMutable(now, action = "reschedule")
        if (newSlot.startsInPast(now)) throw InvalidBookingRequest("Booking cannot start in the past")
        room.validateBookingRequest(newSlot, newAttendees)
        return copy(
            slot = newSlot,
            attendees = newAttendees,
            status = room.tier.rescheduledBookingStatus,
        )
    }

    private fun ensureMutable(now: Instant, action: String) {
        if (!status.isActive) throw BookingConflict("Cannot $action a cancelled booking")
        val isInsideCutoff = slot.isWithinCutoff(now, CHANGE_CUTOFF)
        if (isInsideCutoff) throw BookingConflict("Cannot $action a booking within 15 minutes of start")
    }

    companion object {
        val CHANGE_CUTOFF: Duration = Duration.ofMinutes(15)

        fun create(id: String, room: Room, slot: TimeSlot, attendees: Int, now: Instant): Booking {
            if (slot.startsInPast(now)) throw InvalidBookingRequest("Booking cannot start in the past")
            room.validateBookingRequest(slot, attendees)
            return Booking(
                id = id,
                roomId = room.id,
                slot = slot,
                attendees = attendees,
                status = room.tier.initialBookingStatus,
            )
        }
    }
}
EOF

cat > "$main/BookingRepository.kt" <<'EOF'
package booking

import java.sql.ResultSet
import java.time.Duration
import java.time.OffsetDateTime
import java.time.ZoneOffset.UTC
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository

@Repository
class BookingRepository(private val jdbc: JdbcClient) {
    private val bookingMapper = RowMapper { row: ResultSet, _: Int ->
        Booking(
            id = row.getString("id"),
            roomId = row.getString("room_id"),
            slot = TimeSlot(
                row.getObject("starts_at", OffsetDateTime::class.java).toInstant(),
                row.getObject("ends_at", OffsetDateTime::class.java).toInstant(),
            ),
            attendees = row.getInt("attendees"),
            status = BookingStatus.valueOf(row.getString("status")),
        )
    }

    fun listRooms(): List<Room> {
        val equipmentByRoom = loadEquipmentByRoom()
        return jdbc.sql(
            "SELECT id, tier, min_attendees, capacity, max_duration_minutes FROM rooms ORDER BY id",
        ).query { row, _ -> mapRoom(row, equipmentByRoom) }.list()
    }

    fun findRoom(roomId: String): Room? {
        val equipment = loadEquipmentForRoom(roomId)
        return jdbc.sql(
            "SELECT id, tier, min_attendees, capacity, max_duration_minutes FROM rooms WHERE id = :id",
        ).param("id", roomId)
            .query { row, _ -> mapRoom(row, mapOf(roomId to equipment)) }
            .optional()
            .orElse(null)
    }

    // Locking the room row serializes availability checks and writes even when no bookings exist yet.
    fun lockRoom(roomId: String): Room? {
        val locked = jdbc.sql("SELECT id FROM rooms WHERE id = :id FOR UPDATE")
            .param("id", roomId)
            .query(String::class.java)
            .optional()
            .isPresent
        return if (locked) findRoom(roomId) else null
    }

    fun listActiveBookings(roomId: String): List<Booking> = jdbc.sql(
        """
        SELECT id, room_id, starts_at, ends_at, attendees, status
        FROM bookings
        WHERE room_id = :room AND status <> 'CANCELLED'
        ORDER BY starts_at, id
        """.trimIndent(),
    ).param("room", roomId).query(bookingMapper).list()

    fun listAllActiveBookings(): Map<String, List<Booking>> = jdbc.sql(
        """
        SELECT id, room_id, starts_at, ends_at, attendees, status
        FROM bookings
        WHERE status <> 'CANCELLED'
        ORDER BY starts_at, id
        """.trimIndent(),
    ).query(bookingMapper).list().groupBy { it.roomId }

    fun findBooking(id: String): Booking? = jdbc.sql(
        "SELECT id, room_id, starts_at, ends_at, attendees, status FROM bookings WHERE id = :id",
    ).param("id", id).query(bookingMapper).optional().orElse(null)

    fun insert(booking: Booking) {
        jdbc.sql(
            """
            INSERT INTO bookings (id, room_id, starts_at, ends_at, attendees, status)
            VALUES (:id, :room, :starts, :ends, :attendees, :status)
            """.trimIndent(),
        ).param("id", booking.id)
            .param("room", booking.roomId)
            .param("starts", booking.slot.startsAt.atOffset(UTC))
            .param("ends", booking.slot.endsAt.atOffset(UTC))
            .param("attendees", booking.attendees)
            .param("status", booking.status.name)
            .update()
    }

    fun update(booking: Booking) {
        jdbc.sql(
            """
            UPDATE bookings
            SET starts_at = :starts, ends_at = :ends, attendees = :attendees, status = :status
            WHERE id = :id
            """.trimIndent(),
        ).param("id", booking.id)
            .param("starts", booking.slot.startsAt.atOffset(UTC))
            .param("ends", booking.slot.endsAt.atOffset(UTC))
            .param("attendees", booking.attendees)
            .param("status", booking.status.name)
            .update()
    }

    private fun loadEquipmentByRoom(): Map<String, Set<String>> = jdbc.sql(
        "SELECT room_id, equipment FROM room_equipment",
    ).query { row, _ -> row.getString("room_id") to row.getString("equipment") }
        .list()
        .groupBy({ it.first }, { it.second })
        .mapValues { (_, items) -> items.toSet() }

    private fun loadEquipmentForRoom(roomId: String): Set<String> = jdbc.sql(
        "SELECT equipment FROM room_equipment WHERE room_id = :room",
    ).param("room", roomId).query(String::class.java).list().toSet()

    private fun mapRoom(row: ResultSet, equipmentByRoom: Map<String, Set<String>>): Room {
        val roomId = row.getString("id")
        return Room(
            id = roomId,
            tier = RoomTier.valueOf(row.getString("tier")),
            minAttendees = row.getInt("min_attendees"),
            capacity = row.getInt("capacity"),
            maxDuration = Duration.ofMinutes(row.getLong("max_duration_minutes")),
            equipment = equipmentByRoom[roomId].orEmpty(),
        )
    }
}
EOF

cat > "$main/BookingService.kt" <<'EOF'
package booking

import java.time.Clock
import java.util.UUID
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

@Service
class BookingService(
    private val repository: BookingRepository,
    private val clock: Clock,
) {
    fun listRoomBookings(roomId: String): List<Booking> {
        requireRoom(roomId)
        return repository.listActiveBookings(roomId)
    }

    fun getBooking(id: String): Booking = requireBooking(id)

    fun findAvailableRooms(slot: TimeSlot, attendees: Int, requiredEquipment: Set<String>): List<Room> {
        val now = clock.instant()
        if (slot.startsInPast(now)) throw InvalidBookingRequest("Search range cannot start in the past")
        val rooms = repository.listRooms()
        val activeByRoom = repository.listAllActiveBookings()
        return rooms.filter { room ->
            room.isAvailableFor(slot, attendees, requiredEquipment, activeByRoom[room.id].orEmpty())
        }
    }

    @Transactional
    fun create(roomId: String, slot: TimeSlot, attendees: Int): Booking {
        val room = lockRoom(roomId)
        val booking = Booking.create(UUID.randomUUID().toString(), room, slot, attendees, clock.instant())
        ensureAvailable(room, booking.slot, excludedBookingId = null)
        repository.insert(booking)
        return booking
    }

    @Transactional
    fun reschedule(id: String, newSlot: TimeSlot, newAttendees: Int): Booking {
        val (room, existing) = lockRoomAndBooking(id)
        val updated = existing.reschedule(room, newSlot, newAttendees, clock.instant())
        ensureAvailable(room, updated.slot, excludedBookingId = updated.id)
        repository.update(updated)
        return updated
    }

    @Transactional
    fun confirm(id: String): Booking {
        val (_, existing) = lockRoomAndBooking(id)
        val confirmed = existing.confirm()
        repository.update(confirmed)
        return confirmed
    }

    @Transactional
    fun cancel(id: String): Booking {
        val (_, existing) = lockRoomAndBooking(id)
        val cancelled = existing.cancel(clock.instant())
        repository.update(cancelled)
        return cancelled
    }

    private fun lockRoomAndBooking(id: String): Pair<Room, Booking> {
        val initial = requireBooking(id)
        val room = lockRoom(initial.roomId)
        val current = requireBooking(id)
        return room to current
    }

    private fun requireRoom(roomId: String): Room =
        repository.findRoom(roomId) ?: throw BookingNotFound("Unknown room: $roomId")

    private fun lockRoom(roomId: String): Room =
        repository.lockRoom(roomId) ?: throw BookingNotFound("Unknown room: $roomId")

    private fun requireBooking(id: String): Booking =
        repository.findBooking(id) ?: throw BookingNotFound("Unknown booking: $id")

    private fun ensureAvailable(room: Room, slot: TimeSlot, excludedBookingId: String?) {
        val activeBookings = repository.listActiveBookings(room.id)
        if (room.hasConflict(slot, activeBookings, excludedBookingId)) {
            throw BookingConflict("The room is not available for the requested time slot")
        }
    }
}
EOF

cat > "$main/BookingRequestParser.kt" <<'EOF'
package booking

import com.fasterxml.jackson.databind.JsonNode
import java.time.DateTimeException
import java.time.Instant
import java.time.OffsetDateTime
import org.springframework.stereotype.Component

data class ParsedBookingInput(val slot: TimeSlot, val attendees: Int)

data class ParsedAvailabilityQuery(val slot: TimeSlot, val attendees: Int, val equipment: Set<String>)

@Component
class BookingRequestParser {
    private val wholeSecondUtcPattern = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9]Z")

    fun parseBookingBody(body: JsonNode): ParsedBookingInput {
        if (!body.isObject) throw InvalidBookingRequest("Request body must be a JSON object")
        val startsAt = parseTimestamp(readTextField(body, "startsAt"))
        val endsAt = parseTimestamp(readTextField(body, "endsAt"))
        val attendees = parsePositiveIntField(body, "attendees")
        return ParsedBookingInput(createSlot(startsAt, endsAt), attendees)
    }

    fun parseAvailabilityQuery(
        startsAt: String?,
        endsAt: String?,
        attendees: String?,
        equipment: String?,
    ): ParsedAvailabilityQuery {
        val start = parseTimestamp(startsAt ?: throw InvalidBookingRequest("Missing startsAt"))
        val end = parseTimestamp(endsAt ?: throw InvalidBookingRequest("Missing endsAt"))
        val count = parsePositiveIntParam(attendees)
        val requiredEquipment = parseEquipmentParam(equipment)
        return ParsedAvailabilityQuery(createSlot(start, end), count, requiredEquipment)
    }

    private fun readTextField(body: JsonNode, field: String): String {
        val node = body.get(field)
        val isText = node != null && node.isTextual
        if (!isText) throw InvalidBookingRequest("Field '$field' must be a string")
        return node.textValue()
    }

    private fun parsePositiveIntField(body: JsonNode, field: String): Int {
        val node = body.get(field)
        val isWholeInteger = node != null && node.isIntegralNumber && node.canConvertToInt()
        if (!isWholeInteger) throw InvalidBookingRequest("Field '$field' must be an integer")
        val value = node.intValue()
        if (value < 1) throw InvalidBookingRequest("Field '$field' must be at least 1")
        return value
    }

    private fun parsePositiveIntParam(raw: String?): Int {
        val parsed = raw?.toIntOrNull() ?: throw InvalidBookingRequest("Query parameter 'attendees' must be an integer")
        if (parsed < 1) throw InvalidBookingRequest("Query parameter 'attendees' must be at least 1")
        return parsed
    }

    private fun parseEquipmentParam(raw: String?): Set<String> {
        if (raw.isNullOrBlank()) return emptySet()
        return raw.split(",").map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    }

    private fun parseTimestamp(value: String): Instant {
        val hasWholeSecondUtcFormat = wholeSecondUtcPattern.matches(value)
        if (!hasWholeSecondUtcFormat) throw InvalidBookingRequest("Expected a whole-second UTC timestamp")
        val parsed = try {
            OffsetDateTime.parse(value)
        } catch (error: DateTimeException) {
            throw InvalidBookingRequest("Invalid booking timestamp")
        }
        val isSupportedYear = parsed.year in 1..9999
        if (!isSupportedYear) throw InvalidBookingRequest("Expected a year from 0001 through 9999")
        return parsed.toInstant()
    }

    private fun createSlot(startsAt: Instant, endsAt: Instant): TimeSlot = try {
        TimeSlot(startsAt, endsAt)
    } catch (error: IllegalArgumentException) {
        throw InvalidBookingRequest(error.message ?: "Invalid time range")
    }
}
EOF

cat > "$main/BookingController.kt" <<'EOF'
package booking

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.http.HttpStatus.BAD_REQUEST
import org.springframework.http.HttpStatus.CONFLICT
import org.springframework.http.HttpStatus.CREATED
import org.springframework.http.HttpStatus.NOT_FOUND
import org.springframework.http.MediaType.APPLICATION_JSON_VALUE
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

data class BookingResponse(
    val id: String,
    val roomId: String,
    val startsAt: String,
    val endsAt: String,
    val attendees: Int,
    val status: String,
)

data class RoomResponse(
    val id: String,
    val tier: String,
    val minAttendees: Int,
    val capacity: Int,
    val equipment: List<String>,
)

@RestController
class BookingController(
    private val service: BookingService,
    private val parser: BookingRequestParser,
) {
    @GetMapping("/rooms/available", produces = [APPLICATION_JSON_VALUE])
    fun availableRooms(
        @RequestParam(required = false) startsAt: String?,
        @RequestParam(required = false) endsAt: String?,
        @RequestParam(required = false) attendees: String?,
        @RequestParam(required = false) equipment: String?,
    ): List<RoomResponse> {
        val query = parser.parseAvailabilityQuery(startsAt, endsAt, attendees, equipment)
        return service.findAvailableRooms(query.slot, query.attendees, query.equipment).map { it.toResponse() }
    }

    @PostMapping("/rooms/{roomId}/bookings", consumes = [APPLICATION_JSON_VALUE], produces = [APPLICATION_JSON_VALUE])
    @ResponseStatus(CREATED)
    fun create(@PathVariable roomId: String, @RequestBody body: JsonNode): BookingResponse {
        val input = parser.parseBookingBody(body)
        return service.create(roomId, input.slot, input.attendees).toResponse()
    }

    @GetMapping("/rooms/{roomId}/bookings", produces = [APPLICATION_JSON_VALUE])
    fun list(@PathVariable roomId: String): List<BookingResponse> =
        service.listRoomBookings(roomId).map { it.toResponse() }

    @GetMapping("/bookings/{id}", produces = [APPLICATION_JSON_VALUE])
    fun get(@PathVariable id: String): BookingResponse =
        service.getBooking(id).toResponse()

    @PatchMapping("/bookings/{id}", consumes = [APPLICATION_JSON_VALUE], produces = [APPLICATION_JSON_VALUE])
    fun reschedule(@PathVariable id: String, @RequestBody body: JsonNode): BookingResponse {
        val input = parser.parseBookingBody(body)
        return service.reschedule(id, input.slot, input.attendees).toResponse()
    }

    @PostMapping("/bookings/{id}/confirm", produces = [APPLICATION_JSON_VALUE])
    fun confirm(@PathVariable id: String): BookingResponse =
        service.confirm(id).toResponse()

    @PostMapping("/bookings/{id}/cancel", produces = [APPLICATION_JSON_VALUE])
    fun cancel(@PathVariable id: String): BookingResponse =
        service.cancel(id).toResponse()

    @ExceptionHandler(
        InvalidBookingRequest::class,
        HttpMessageNotReadableException::class,
        MissingServletRequestParameterException::class,
    )
    @ResponseStatus(BAD_REQUEST)
    fun badRequest() {}

    @ExceptionHandler(BookingNotFound::class)
    @ResponseStatus(NOT_FOUND)
    fun notFound() {}

    @ExceptionHandler(BookingConflict::class)
    @ResponseStatus(CONFLICT)
    fun conflict() {}

    private fun Booking.toResponse(): BookingResponse = BookingResponse(
        id = id,
        roomId = roomId,
        startsAt = slot.startsAt.toString(),
        endsAt = slot.endsAt.toString(),
        attendees = attendees,
        status = status.name,
    )

    private fun Room.toResponse(): RoomResponse = RoomResponse(
        id = id,
        tier = tier.name,
        minAttendees = minAttendees,
        capacity = capacity,
        equipment = equipment.sorted(),
    )
}
EOF

cat > src/main/resources/application.properties <<'EOF'
spring.jackson.deserialization.fail-on-trailing-tokens=true
EOF

cat > src/main/resources/schema.sql <<'EOF'
CREATE TABLE rooms (
    id VARCHAR(64) PRIMARY KEY,
    tier VARCHAR(32) NOT NULL,
    min_attendees INTEGER NOT NULL,
    capacity INTEGER NOT NULL,
    max_duration_minutes BIGINT NOT NULL
);

CREATE TABLE room_equipment (
    room_id VARCHAR(64) NOT NULL REFERENCES rooms(id),
    equipment VARCHAR(64) NOT NULL,
    PRIMARY KEY (room_id, equipment)
);

CREATE TABLE bookings (
    id VARCHAR(64) PRIMARY KEY,
    room_id VARCHAR(64) NOT NULL REFERENCES rooms(id),
    starts_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
    attendees INTEGER NOT NULL,
    status VARCHAR(32) NOT NULL
);

INSERT INTO rooms (id, tier, min_attendees, capacity, max_duration_minutes) VALUES
    ('atlas', 'STANDARD', 1, 6, 120),
    ('orion', 'STANDARD', 1, 12, 240),
    ('vega', 'EXECUTIVE', 4, 20, 240);

INSERT INTO room_equipment (room_id, equipment) VALUES
    ('atlas', 'whiteboard'),
    ('orion', 'projector'),
    ('orion', 'whiteboard'),
    ('vega', 'projector'),
    ('vega', 'video_conferencing'),
    ('vega', 'whiteboard');
EOF

cat > "$test/MeetingRoomBookingTest.kt" <<'EOF'
package booking

import com.fasterxml.jackson.databind.ObjectMapper
import java.time.Duration
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

@SpringBootTest
@AutoConfigureMockMvc
class MeetingRoomBookingTest {
    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var json: ObjectMapper

    @BeforeEach
    fun reset() {
        jdbc.update("DELETE FROM bookings")
    }

    @Test
    fun `domain enforces cutoff, buffer, and lifecycle transitions`() {
        val vega = Room("vega", RoomTier.EXECUTIVE, 4, 20, Duration.ofHours(4), setOf("projector"))
        val now = Instant.parse("2030-05-20T09:00:00Z")
        val slot = TimeSlot(Instant.parse("2030-05-20T10:00:00Z"), Instant.parse("2030-05-20T11:00:00Z"))

        val pending = Booking.create("b-1", vega, slot, 6, now)
        assertEquals(BookingStatus.PENDING, pending.status)

        val confirmed = pending.confirm()
        assertEquals(BookingStatus.CONFIRMED, confirmed.status)
        assertFailsWith<BookingConflict> { confirmed.confirm() }

        val tooClose = Instant.parse("2030-05-20T09:50:00Z")
        assertFailsWith<BookingConflict> { confirmed.cancel(tooClose) }

        val bufferCandidate = TimeSlot(Instant.parse("2030-05-20T11:10:00Z"), Instant.parse("2030-05-20T12:00:00Z"))
        assertTrue(vega.hasConflict(bufferCandidate, listOf(confirmed)))

        val clearCandidate = TimeSlot(Instant.parse("2030-05-20T11:15:00Z"), Instant.parse("2030-05-20T12:00:00Z"))
        assertFalse(vega.hasConflict(clearCandidate, listOf(confirmed)))
    }

    @Test
    fun `api handles booking lifecycle, policies, and availability search`() {
        val createdBody = mvc.perform(
            post("/rooms/vega/bookings")
                .contentType(APPLICATION_JSON)
                .content("""{"startsAt":"2030-05-20T10:00:00Z","endsAt":"2030-05-20T11:00:00Z","attendees":6}"""),
        ).andExpect(status().isCreated)
            .andExpect(jsonPath("$.status").value("PENDING"))
            .andReturn().response.contentAsString
        val id = json.readTree(createdBody)["id"].asText()

        mvc.perform(post("/bookings/$id/confirm"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.status").value("CONFIRMED"))

        mvc.perform(
            get("/rooms/available")
                .param("startsAt", "2030-05-20T11:00:00Z")
                .param("endsAt", "2030-05-20T12:00:00Z")
                .param("attendees", "4")
                .param("equipment", "projector"),
        ).andExpect(status().isOk)
            .andExpect(jsonPath("$.length()").value(1))
            .andExpect(jsonPath("$[0].id").value("orion"))

        mvc.perform(
            patch("/bookings/$id")
                .contentType(APPLICATION_JSON)
                .content("""{"startsAt":"2030-05-20T12:00:00Z","endsAt":"2030-05-20T13:00:00Z","attendees":8}"""),
        ).andExpect(status().isOk)
            .andExpect(jsonPath("$.status").value("PENDING"))
            .andExpect(jsonPath("$.attendees").value(8))

        mvc.perform(post("/bookings/$id/cancel"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.status").value("CANCELLED"))
    }
}
EOF
