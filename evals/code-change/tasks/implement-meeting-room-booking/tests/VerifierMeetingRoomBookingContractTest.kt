package booking

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import java.time.Instant
import java.time.OffsetDateTime
import java.time.temporal.ChronoUnit.SECONDS
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit.SECONDS as TIME_SECONDS
import javax.sql.DataSource
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.http.MediaType
import org.springframework.http.MediaType.APPLICATION_JSON
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.MvcResult
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post

@SpringBootTest(classes = [MeetingRoomBookingApplication::class])
@AutoConfigureMockMvc
class VerifierMeetingRoomBookingContractTest {
    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var json: ObjectMapper
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var dataSource: DataSource

    @BeforeEach
    fun clearBookings() {
        jdbc.update("DELETE FROM bookings")
    }

    @Test
    fun `standard rooms auto-confirm, sort ascending, and allow back-to-back slots`() {
        assertEquals(emptyList(), bookings("atlas"))
        assertEquals(emptyList(), bookings("orion"))
        assertEquals(emptyList(), bookings("vega"))

        val later = read(create("atlas", slot(11, 12, 4)), 201)
        val earlier = read(create("atlas", slot(9, 11, 6)), 201)
        val otherRoom = read(create("orion", slot(9, 11, 10)), 201)

        assertBooking(later, "atlas", time(11), time(12), 4, "CONFIRMED")
        assertBooking(earlier, "atlas", time(9), time(11), 6, "CONFIRMED")
        assertBooking(otherRoom, "orion", time(9), time(11), 10, "CONFIRMED")
        assertEquals(3, setOf(id(later), id(earlier), id(otherRoom)).size)
        assertEquals(listOf(earlier, later), bookings("atlas"))
        assertEquals(listOf(otherRoom), bookings("orion"))
        assertEquals(earlier, read(fetch(id(earlier)), 200))
    }

    @Test
    fun `executive room enforces approval lifecycle and 15-minute cleanup buffer`() {
        val pending = read(create("vega", slot(10, 11, 6)), 201)
        assertBooking(pending, "vega", time(10), time(11), 6, "PENDING")
        assertStored(pending)

        // Buffer conflicts before and after active booking (even while PENDING)
        assertStatus(409, create("vega", body(time(11, 0), time(12, 0), 5)), "0m gap after")
        assertStatus(409, create("vega", body(time(11, 14), time(12, 0), 5)), "14m gap after")
        assertStatus(409, create("vega", body(time(9, 0), time(9, 46), 5)), "14m gap before")

        // Exact 15-minute gap before and after is allowed
        val before = read(create("vega", body(time(9, 0), time(9, 45), 4)), 201)
        val after = read(create("vega", body(time(11, 15), time(12, 0), 4)), 201)
        assertEquals(listOf(before, pending, after), bookings("vega"))

        // Confirm transitions PENDING -> CONFIRMED; confirming again returns 409
        val confirmed = read(confirm(id(pending)), 200)
        assertBooking(confirmed, "vega", time(10), time(11), 6, "CONFIRMED")
        assertStored(confirmed)
        assertStatus(409, confirm(id(pending)), "confirm already confirmed")

        // Rescheduling a CONFIRMED executive booking resets it to PENDING and ignores its own slot/buffer
        val moved = read(move(id(pending), body(time(13, 0), time(14, 0), 8)), 200)
        assertBooking(moved, "vega", time(13, 0), time(14, 0), 8, "PENDING")
        assertEquals(id(pending), id(moved))
        assertStored(moved)

        // Rescheduling within its own prior window works too
        val selfOverlap = read(move(id(pending), body(time(13, 10), time(14, 10), 8)), 200)
        assertBooking(selfOverlap, "vega", time(13, 10), time(14, 10), 8, "PENDING")
    }

    @Test
    fun `room capacity and max duration policies are enforced on create and reschedule`() {
        // atlas: 1..6 attendees, max 2h
        assertStatus(400, create("atlas", slot(9, 10, 7)), "atlas attendees > 6")
        assertStatus(400, create("atlas", body(time(9, 0), "2030-05-20T11:00:01Z", 2)), "atlas duration > 2h")
        val atlas = read(create("atlas", slot(9, 11, 6)), 201)
        assertStatus(400, move(id(atlas), slot(12, 15, 2)), "atlas reschedule duration > 2h")
        assertStatus(400, move(id(atlas), slot(12, 13, 7)), "atlas reschedule attendees > 6")
        assertStored(atlas)

        // orion: 1..12 attendees, max 4h
        assertStatus(400, create("orion", slot(9, 10, 13)), "orion attendees > 12")
        assertStatus(400, create("orion", slot(9, 14, 4)), "orion duration > 4h")
        assertStatus(201, create("orion", slot(9, 13, 12)), "orion max capacity & max duration")

        // vega: 4..20 attendees, max 4h
        assertStatus(400, create("vega", slot(9, 10, 3)), "vega attendees < 4")
        assertStatus(400, create("vega", slot(9, 10, 21)), "vega attendees > 20")
        assertStatus(400, create("vega", slot(9, 14, 4)), "vega duration > 4h")
        assertStatus(201, create("vega", slot(9, 13, 20)), "vega max capacity & max duration")
    }

    @Test
    fun `overlaps are rejected on standard rooms and failed reschedules preserve original booking`() {
        val original = read(create("orion", slot(10, 12, 3)), 201)
        for ((start, end) in listOf(8 to 11, 11 to 13, 10 to 12, 10 to 11, 9 to 13)) {
            assertStatus(409, create("orion", slot(start, end, 2)), "overlap $start-$end")
        }

        val other = read(create("orion", slot(13, 15, 2)), 201)
        assertStatus(409, move(id(original), slot(12, 14, 3)), "reschedule overlap")
        assertEquals(listOf(original, other), bookings("orion"))
        assertStored(original)

        val updated = read(move(id(original), slot(11, 13, 5)), 200)
        assertBooking(updated, "orion", time(11), time(13), 5, "CONFIRMED")
        assertEquals(id(original), id(updated))
        assertEquals(listOf(updated, other), bookings("orion"))
        assertStored(updated)
        assertStatus(201, create("orion", slot(10, 11, 2)), "freed slot after reschedule")
    }

    @Test
    fun `cancelling persists CANCELLED status in H2, frees slot, and blocks further transitions`() {
        val booking = read(create("vega", slot(10, 11, 5)), 201)
        dataSource.connection.use { connection ->
            assertTrue(connection.metaData.url.startsWith("jdbc:h2:mem:"))
        }
        assertStored(booking)

        val cancelled = read(cancel(id(booking)), 200)
        assertBooking(cancelled, "vega", time(10), time(11), 5, "CANCELLED")
        assertStored(cancelled)
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM bookings WHERE status = 'CANCELLED'", Int::class.java))
        assertEquals(emptyList(), bookings("vega"))
        assertEquals(cancelled, read(fetch(id(booking)), 200))

        // No transitions allowed on a CANCELLED booking
        assertStatus(409, cancel(id(booking)), "cancel twice")
        assertStatus(409, confirm(id(booking)), "confirm cancelled")
        assertStatus(409, move(id(booking), slot(12, 13, 5)), "reschedule cancelled")

        // Slot (including buffer) is freed immediately
        assertStatus(201, create("vega", slot(10, 11, 5)), "rebook freed executive slot")
    }

    @Test
    fun `past bookings are rejected and 15-minute cutoff blocks late cancel or reschedule`() {
        val now = Instant.now().truncatedTo(SECONDS)
        val pastStart = now.minusSeconds(600).toString()
        val futureEnd = now.plusSeconds(1800).toString()
        assertStatus(400, create("atlas", body(pastStart, futureEnd, 2)), "create in past")
        assertStatus(400, available(pastStart, futureEnd, 2), "search in past")

        // Booking starting in 10 minutes: valid to create, but inside 15-minute cutoff for cancel/reschedule
        val soonStart = now.plusSeconds(600).toString()
        val soonEnd = now.plusSeconds(2400).toString()
        val soonBooking = read(create("atlas", body(soonStart, soonEnd, 2)), 201)
        assertStatus(409, cancel(id(soonBooking)), "cancel within 15m cutoff")
        assertStatus(409, move(id(soonBooking), slot(10, 11, 2)), "reschedule within 15m cutoff")
        assertStored(soonBooking)

        // Booking starting in 30 minutes: outside cutoff, can be rescheduled (to future, not past) and cancelled
        val laterStart = now.plusSeconds(1800).toString()
        val laterEnd = now.plusSeconds(3600).toString()
        val laterBooking = read(create("orion", body(laterStart, laterEnd, 2)), 201)
        assertStatus(400, move(id(laterBooking), body(pastStart, futureEnd, 2)), "reschedule into past")
        assertStored(laterBooking)
        val moved = read(move(id(laterBooking), slot(10, 11, 3)), 200)
        assertBooking(moved, "orion", time(10), time(11), 3, "CONFIRMED")
        val cancelled = read(cancel(id(laterBooking)), 200)
        assertEquals("CANCELLED", cancelled.path("status").textValue())
    }

    @Test
    fun `availability search filters by capacity, duration, equipment, and active conflicts including buffers`() {
        val allThree = readArray(available(time(10), time(11), 4))
        assertEquals(listOf("atlas", "orion", "vega"), allThree.map { it.path("id").textValue() })
        assertRoom(allThree[0], "atlas", "STANDARD", 1, 6, setOf("whiteboard"))
        assertRoom(allThree[1], "orion", "STANDARD", 1, 12, setOf("projector", "whiteboard"))
        assertRoom(allThree[2], "vega", "EXECUTIVE", 4, 20, setOf("projector", "video_conferencing", "whiteboard"))

        // Attendees & duration filters
        assertEquals(listOf("atlas", "orion"), roomIds(available(time(10), time(11), 2)))
        assertEquals(listOf("orion", "vega"), roomIds(available(time(10), time(11), 8)))
        assertEquals(listOf("vega"), roomIds(available(time(10), time(11), 15)))
        assertEquals(listOf("orion", "vega"), roomIds(available(time(10), time(13), 4)))
        assertEquals(emptyList(), roomIds(available(time(10), time(15), 4)))

        // Equipment filters
        assertEquals(listOf("orion", "vega"), roomIds(available(time(10), time(11), 4, "projector")))
        assertEquals(listOf("vega"), roomIds(available(time(10), time(11), 4, "projector,video_conferencing")))
        assertEquals(emptyList(), roomIds(available(time(10), time(11), 4, "projector,coffee_machine")))

        // Active conflicts (including executive buffer) exclude rooms; cancelled bookings do not
        val vegaBooking = read(create("vega", slot(10, 11, 5)), 201)
        read(create("orion", slot(10, 11, 4)), 201)
        assertEquals(listOf("atlas"), roomIds(available(time(10), time(11), 4)))
        // 11:00-12:00 is free on orion & atlas, but blocked by vega's 15m cleanup buffer
        assertEquals(listOf("atlas", "orion"), roomIds(available(time(11), time(12), 4)))
        // 11:15-12:00 clears vega's buffer
        assertEquals(listOf("atlas", "orion", "vega"), roomIds(available(time(11, 15), time(12, 0), 4)))

        read(cancel(id(vegaBooking)), 200)
        assertEquals(listOf("atlas", "vega"), roomIds(available(time(10), time(11), 4)))

        // Invalid search parameters return 400
        assertStatus(400, mvc.perform(get("/rooms/available")).andReturn(), "missing params")
        assertStatus(400, available(time(11), time(11), 2), "equal start and end")
        assertStatus(400, available(time(12), time(11), 2), "end before start")
        assertStatus(400, available("bad-time", time(11), 2), "invalid startsAt")
        assertStatus(400, available(time(10), time(11), 0), "zero attendees")
        assertStatus(400, mvc.perform(get("/rooms/available").param("startsAt", time(10)).param("endsAt", time(11)).param("attendees", "abc")).andReturn(), "non-int attendees")
    }

    @Test
    fun `reads and writes reflect direct H2 changes`() {
        val booking = read(create("atlas", slot(9, 10, 2)), 201)
        assertEquals(1, jdbc.update("UPDATE bookings SET status = 'CANCELLED' WHERE id = ?", id(booking)))
        assertEquals(emptyList(), bookings("atlas"))
        assertEquals("CANCELLED", read(fetch(id(booking)), 200).path("status").textValue())
        assertTrue("atlas" in roomIds(available(time(9), time(10), 2)))

        assertEquals(1, jdbc.update("DELETE FROM bookings WHERE id = ?", id(booking)))
        assertStatus(404, fetch(id(booking)))
        assertStatus(404, move(id(booking), slot(10, 11, 2)))
    }

    @Test
    fun `unknown room and booking IDs return 404`() {
        assertStatus(404, list("missing"))
        assertStatus(404, create("missing", slot(9, 10, 2)))
        assertStatus(404, fetch("missing"))
        assertStatus(404, move("missing", slot(9, 10, 2)))
        assertStatus(404, confirm("missing"))
        assertStatus(404, cancel("missing"))
    }

    @Test
    fun `malformed input is rejected without changing persisted bookings`() {
        val original = read(create("atlas", slot(9, 10, 2)), 201)
        val invalidBodies = listOf(
            "{",
            """{"startsAt":"${time(10)}","attendees":2}""",
            """{"startsAt":"${time(10)}","endsAt":"${time(11)}"}""",
            """{"startsAt":null,"endsAt":"${time(11)}","attendees":2}""",
            """{"startsAt":1,"endsAt":"${time(11)}","attendees":2}""",
            """{"startsAt":"${time(10)}","endsAt":"${time(11)}","attendees":0}""",
            """{"startsAt":"${time(10)}","endsAt":"${time(11)}","attendees":-2}""",
            """{"startsAt":"${time(10)}","endsAt":"${time(11)}","attendees":null}""",
            """{"startsAt":"${time(10)}","endsAt":"${time(11)}","attendees":"abc"}""",
            body("2030-02-30T09:00:00Z", time(11), 2),
            body("2030-05-20T09:00:00+00:00", time(11), 2),
            body("2030-05-20T09:00:00.010Z", time(11), 2),
            body("2030-05-20T09:00:60Z", time(11), 2),
            body("0000-05-20T09:00:00Z", time(11), 2),
            body(time(11), "2030-05-20T24:00:00Z", 2),
            slot(11, 11, 2),
            slot(12, 11, 2),
        )
        for (body in invalidBodies) {
            assertStatus(400, create("atlas", body), "POST body=$body")
            assertStatus(400, move(id(original), body), "PATCH body=$body")
        }
        assertEquals(listOf(original), bookings("atlas"))
        assertStored(original)
    }

    @Test
    fun `only one concurrent request can claim conflicting slots including executive buffers`() {
        val executor = Executors.newFixedThreadPool(4)
        try {
            // Standard room exact conflict race
            for (hour in 9..11) {
                val startTogether = CyclicBarrier(4)
                val attempts = List(4) {
                    executor.submit<Int> {
                        startTogether.await(5, TIME_SECONDS)
                        create("atlas", slot(hour, hour + 1, 2)).response.status
                    }
                }
                val statuses = attempts.map { it.get(15, TIME_SECONDS) }.sorted()
                assertEquals(listOf(201, 409, 409, 409), statuses)
            }
            assertEquals(3, bookings("atlas").size)

            // Executive room buffer conflict race: [10:00,11:00) and [11:00,12:00) mutually conflict via 15m buffer
            val bufferBarrier = CyclicBarrier(4)
            val bufferBodies = listOf(slot(10, 11, 6), slot(10, 11, 6), slot(11, 12, 6), slot(11, 12, 6))
            val bufferAttempts = bufferBodies.map { requestBody ->
                executor.submit<Int> {
                    bufferBarrier.await(5, TIME_SECONDS)
                    create("vega", requestBody).response.status
                }
            }
            val bufferStatuses = bufferAttempts.map { it.get(15, TIME_SECONDS) }.sorted()
            assertEquals(listOf(201, 409, 409, 409), bufferStatuses)
            assertEquals(1, bookings("vega").size)
        } finally {
            executor.shutdownNow()
        }
    }

    private fun create(room: String, body: String): MvcResult =
        mvc.perform(post("/rooms/{roomId}/bookings", room).contentType(APPLICATION_JSON).content(body)).andReturn()

    private fun list(room: String): MvcResult = mvc.perform(get("/rooms/{roomId}/bookings", room)).andReturn()

    private fun fetch(id: String): MvcResult = mvc.perform(get("/bookings/{id}", id)).andReturn()

    private fun move(id: String, body: String): MvcResult =
        mvc.perform(patch("/bookings/{id}", id).contentType(APPLICATION_JSON).content(body)).andReturn()

    private fun confirm(id: String): MvcResult = mvc.perform(post("/bookings/{id}/confirm", id)).andReturn()

    private fun cancel(id: String): MvcResult = mvc.perform(post("/bookings/{id}/cancel", id)).andReturn()

    private fun available(startsAt: String, endsAt: String, attendees: Int, equipment: String? = null): MvcResult {
        val request = get("/rooms/available")
            .param("startsAt", startsAt)
            .param("endsAt", endsAt)
            .param("attendees", attendees.toString())
        if (equipment != null) request.param("equipment", equipment)
        return mvc.perform(request).andReturn()
    }

    private fun bookings(room: String): List<JsonNode> = readArray(list(room))

    private fun roomIds(result: MvcResult): List<String> = readArray(result).map { it.path("id").textValue() }

    private fun readArray(result: MvcResult): List<JsonNode> {
        val body = read(result, 200)
        assertTrue(body.isArray, "Expected a JSON array, got $body")
        return body.toList()
    }

    private fun read(result: MvcResult, status: Int): JsonNode {
        assertStatus(status, result)
        val contentType = result.response.contentType?.let(MediaType::parseMediaType)
        assertTrue(contentType != null && APPLICATION_JSON.includes(contentType), "Expected application/json, got $contentType")
        return json.readTree(result.response.contentAsString)
    }

    private fun assertStatus(expected: Int, result: MvcResult, context: String? = null) {
        val message = listOfNotNull(context, result.response.contentAsString.ifEmpty { null }).joinToString(" | ")
        assertEquals(expected, result.response.status, message)
    }

    private fun assertBooking(
        booking: JsonNode,
        room: String,
        startsAt: String,
        endsAt: String,
        attendees: Int,
        status: String,
    ) {
        assertTrue(id(booking).matches(Regex("[A-Za-z0-9_-]+")), "Invalid booking ID: ${id(booking)}")
        assertEquals(room, booking.path("roomId").textValue())
        assertEquals(startsAt, booking.path("startsAt").textValue())
        assertEquals(endsAt, booking.path("endsAt").textValue())
        assertEquals(attendees, booking.path("attendees").intValue())
        assertEquals(status, booking.path("status").textValue())
    }

    private fun assertRoom(
        room: JsonNode,
        id: String,
        tier: String,
        minAttendees: Int,
        capacity: Int,
        equipment: Set<String>,
    ) {
        assertEquals(id, room.path("id").textValue())
        assertEquals(tier, room.path("tier").textValue())
        assertEquals(minAttendees, room.path("minAttendees").intValue())
        assertEquals(capacity, room.path("capacity").intValue())
        val actualEquipment = room.path("equipment").map { it.textValue() }
        assertEquals(equipment.sorted(), actualEquipment)
    }

    private fun assertStored(booking: JsonNode) {
        val rows = jdbc.query(
            "SELECT room_id, starts_at, ends_at, attendees, status FROM bookings WHERE id = ?",
            { row, _ ->
                listOf(
                    row.getString("room_id"),
                    row.getObject("starts_at", OffsetDateTime::class.java).toInstant().toString(),
                    row.getObject("ends_at", OffsetDateTime::class.java).toInstant().toString(),
                    row.getInt("attendees").toString(),
                    row.getString("status"),
                )
            },
            id(booking),
        )
        val expected = listOf("roomId", "startsAt", "endsAt", "attendees", "status").map { booking[it].asText() }
        assertEquals(listOf(expected), rows)
    }

    private fun id(booking: JsonNode): String = booking.path("id").textValue()

    private fun time(hour: Int, minute: Int = 0): String =
        "2030-05-20T${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00Z"

    private fun slot(startHour: Int, endHour: Int, attendees: Int): String =
        body(time(startHour), time(endHour), attendees)

    private fun body(start: String, end: String, attendees: Int): String =
        """{"startsAt":"$start","endsAt":"$end","attendees":$attendees}"""
}
