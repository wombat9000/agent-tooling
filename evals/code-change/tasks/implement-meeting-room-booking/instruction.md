# Meeting Room Booking

Build a Kotlin Spring Boot JSON API for booking meeting rooms. The starter contains
only the Gradle setup. Create the application, database initialization, and tests.

## Project and storage

- Use the provided Spring Boot Web, JDBC, and in-memory H2 dependencies. Use SQL
  through Spring JDBC or plain JDBC. Hibernate, JPA, and other ORMs are out of scope.
- Put production Kotlin under `src/main/kotlin/booking/`. The Spring Boot
  application class must be `booking.MeetingRoomBookingApplication`, and the app must
  start with `./gradlew bootRun`. Keep the provided build configuration.
- Initialize two rooms with IDs `atlas` and `orion` at startup. Start with zero bookings.
  There are no endpoints to add or remove rooms.
- H2 is the source of truth for bookings. Use its current state when listing
  bookings and checking for conflicts. The verifier also checks persisted state
  in the `bookings` table. Include these unquoted columns: `id` and `room_id`
  as `VARCHAR`, and `starts_at` and `ends_at` as `TIMESTAMP WITH TIME ZONE`.
  The rest of the schema and the way you initialize it are up to you.

## Booking rules

- Create and reschedule requests use the same JSON body with `startsAt` and `endsAt`
  strings. Accept UTC timestamps in `YYYY-MM-DDTHH:MM:SSZ` format with whole-second
  precision, years 0001 through 9999, and seconds 00 through 59. Return times in
  the same format. Use `Content-Type: application/json` for request and success bodies.
- A booking covers its start instant up to and excluding its end instant. The end
  must be later than the start. Back-to-back bookings in the same room are allowed.
  Overlapping bookings in the same room are rejected. Different rooms can be booked
  for the same period.
- Generate each booking ID on the server. It must be unique and contain only ASCII
  letters, digits, underscores, or hyphens. Rescheduling retains the ID and room.
  A booking cannot conflict with itself.
- Checking availability and saving a booking must be atomic. Two concurrent requests
  cannot both claim overlapping slots in the same room. A failed reschedule must
  preserve the original booking. A successful cancellation frees the slot.

## HTTP contract

| Method and path | Successful response |
| --- | --- |
| `POST /rooms/{roomId}/bookings` | `201` and the created booking |
| `GET /rooms/{roomId}/bookings` | `200` and a JSON array of bookings in ascending start-time order, or `[]` for an empty room |
| `PATCH /bookings/{id}` | `200` and the updated booking, with both timestamps taken from the request |
| `DELETE /bookings/{id}` | `204` with an empty body |

Booking responses contain `id`, `roomId`, `startsAt`, and `endsAt` as strings.
For example, a booking response could be:

```json
{
  "id": "booking-42",
  "roomId": "atlas",
  "startsAt": "2030-05-20T09:00:00Z",
  "endsAt": "2030-05-20T10:00:00Z"
}
```

- Return `400` for malformed JSON, missing or invalid timestamps, and invalid time ranges.
- Return `404` for unknown rooms and unknown bookings, including cancelling a booking twice.
- Return `409` for overlaps.
- Error bodies and precedence when a request has multiple errors are up to you.

## Tests and verification

Write tests under `src/test/kotlin/booking/`. Cover normal booking behavior, time boundaries,
and rejected operations. Verify with `./gradlew test`.
