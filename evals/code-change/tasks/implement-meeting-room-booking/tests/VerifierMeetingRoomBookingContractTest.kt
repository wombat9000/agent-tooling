package booking

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import java.time.OffsetDateTime
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit.SECONDS
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
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
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
    fun `bookings are sorted per room and adjacent slots can share a boundary`() {
        assertEquals(emptyList(), bookings("atlas"))
        assertEquals(emptyList(), bookings("orion"))

        val later = read(create("atlas", slot(11, 12)), 201)
        val earlier = read(create("atlas", slot(9, 11)), 201)
        val otherRoom = read(create("orion", slot(9, 11)), 201)
        assertBooking(later, "atlas", 11, 12)
        assertBooking(earlier, "atlas", 9, 11)
        assertBooking(otherRoom, "orion", 9, 11)
        assertEquals(3, setOf(id(later), id(earlier), id(otherRoom)).size)
        assertEquals(listOf(earlier, later), bookings("atlas"))
        assertEquals(listOf(otherRoom), bookings("orion"))
    }

    @Test
    fun `overlaps are rejected including exact matches and enclosing ranges`() {
        val booking = read(create("atlas", slot(10, 12)), 201)
        for ((start, end) in listOf(8 to 11, 11 to 13, 10 to 12, 10 to 11, 9 to 13)) {
            assertStatus(409, create("atlas", slot(start, end)))
        }
        assertEquals(listOf(booking), bookings("atlas"))
    }

    @Test
    fun `rescheduling ignores the current booking and preserves it on rejection`() {
        val original = read(create("atlas", slot(9, 11)), 201)
        val other = read(create("atlas", slot(12, 14)), 201)

        assertStatus(409, move(id(original), slot(11, 13)))
        assertEquals(listOf(original, other), bookings("atlas"))
        assertStored(original)

        val updated = read(move(id(original), slot(10, 12)), 200)
        assertBooking(updated, "atlas", 10, 12)
        assertEquals(id(original), id(updated))
        assertEquals(listOf(updated, other), bookings("atlas"))
        assertStored(updated)
        assertStatus(201, create("atlas", slot(9, 10)))
    }

    @Test
    fun `cancelling removes the booking from H2 and frees its slot`() {
        val booking = read(create("atlas", slot(9, 10)), 201)
        dataSource.connection.use { connection ->
            assertTrue(connection.metaData.url.startsWith("jdbc:h2:mem:"))
        }
        assertStored(booking)

        val cancelled = mvc.perform(delete("/bookings/{id}", id(booking))).andReturn()
        assertStatus(204, cancelled)
        assertEquals("", cancelled.response.contentAsString)
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM bookings", Int::class.java))
        assertEquals(emptyList(), bookings("atlas"))
        assertStatus(404, mvc.perform(delete("/bookings/{id}", id(booking))).andReturn())
        assertStatus(201, create("atlas", slot(9, 10)))
    }

    @Test
    fun `listing reflects changes in H2`() {
        val booking = read(create("atlas", slot(9, 10)), 201)
        assertEquals(1, jdbc.update("DELETE FROM bookings WHERE id = ?", id(booking)))
        assertEquals(emptyList(), bookings("atlas"))
        assertStatus(404, move(id(booking), slot(10, 11)))
    }

    @Test
    fun `unknown room and booking IDs return 404`() {
        assertStatus(404, list("missing"))
        assertStatus(404, create("missing", slot(9, 10)))
        assertStatus(404, move("missing", slot(9, 10)))
        assertStatus(404, mvc.perform(delete("/bookings/missing")).andReturn())
    }

    @Test
    fun `malformed input is rejected without changing persisted bookings`() {
        val original = read(create("atlas", slot(9, 10)), 201)
        val invalidBodies = listOf(
            "{",
            """{"startsAt":"${time(10)}"}""",
            """{"startsAt":null,"endsAt":"${time(11)}"}""",
            """{"startsAt":1,"endsAt":"${time(11)}"}""",
            body("2030-02-30T09:00:00Z", time(11)),
            body("2030-05-20T09:00:00+00:00", time(11)),
            body("2030-05-20T09:00:00.010Z", time(11)),
            body("2030-05-20T09:00:60Z", time(11)),
            body("0000-05-20T09:00:00Z", time(11)),
            body(time(11), "2030-05-20T24:00:00Z"),
            slot(11, 11),
            slot(12, 11),
        )
        for (body in invalidBodies) {
            assertStatus(400, create("atlas", body), "POST body=$body")
            assertStatus(400, move(id(original), body), "PATCH body=$body")
        }
        assertEquals(listOf(original), bookings("atlas"))
        assertStored(original)
    }

    @Test
    fun `only one concurrent request can claim a room slot`() {
        val executor = Executors.newFixedThreadPool(4)
        try {
            for (hour in 9..12) {
                val startTogether = CyclicBarrier(4)
                val attempts = List(4) {
                    executor.submit<Int> {
                        startTogether.await(5, SECONDS)
                        create("atlas", slot(hour, hour + 1)).response.status
                    }
                }
                val statuses = attempts.map { it.get(15, SECONDS) }.sorted()
                assertEquals(listOf(201, 409, 409, 409), statuses)
            }
            assertEquals(4, bookings("atlas").size)
        } finally {
            executor.shutdownNow()
        }
    }

    private fun create(room: String, body: String): MvcResult =
        mvc.perform(post("/rooms/{roomId}/bookings", room).contentType(APPLICATION_JSON).content(body)).andReturn()

    private fun list(room: String): MvcResult = mvc.perform(get("/rooms/{roomId}/bookings", room)).andReturn()

    private fun bookings(room: String): List<JsonNode> {
        val body = read(list(room), 200)
        assertTrue(body.isArray, "Expected a JSON array, got $body")
        return body.toList()
    }

    private fun move(id: String, body: String): MvcResult =
        mvc.perform(patch("/bookings/{id}", id).contentType(APPLICATION_JSON).content(body)).andReturn()

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

    private fun assertBooking(booking: JsonNode, room: String, start: Int, end: Int) {
        assertTrue(id(booking).matches(Regex("[A-Za-z0-9_-]+")))
        assertEquals(room, booking.path("roomId").textValue())
        assertEquals(time(start), booking.path("startsAt").textValue())
        assertEquals(time(end), booking.path("endsAt").textValue())
    }

    private fun assertStored(booking: JsonNode) {
        val rows = jdbc.query(
            "SELECT room_id, starts_at, ends_at FROM bookings WHERE id = ?",
            { row, _ ->
                listOf(
                    row.getString("room_id"),
                    row.getObject("starts_at", OffsetDateTime::class.java).toInstant().toString(),
                    row.getObject("ends_at", OffsetDateTime::class.java).toInstant().toString(),
                )
            },
            id(booking),
        )
        val expected = listOf("roomId", "startsAt", "endsAt").map { booking[it].asText() }
        assertEquals(listOf(expected), rows)
    }

    private fun id(booking: JsonNode): String = booking.path("id").textValue()

    private fun time(hour: Int): String = "2030-05-20T${hour.toString().padStart(2, '0')}:00:00Z"

    private fun slot(start: Int, end: Int): String = body(time(start), time(end))

    private fun body(start: String, end: String): String = """{"startsAt":"$start","endsAt":"$end"}"""
}
