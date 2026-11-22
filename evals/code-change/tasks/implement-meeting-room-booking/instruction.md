# Meeting Room Booking

Build a Kotlin Spring Boot JSON API for booking meeting rooms. The starter contains
only the Gradle setup. Create the application, database initialization, and tests.

## Project and storage

- Use the provided Spring Boot Web, JDBC, and in-memory H2 dependencies. Use SQL
  through Spring JDBC or plain JDBC. Hibernate, JPA, and other ORMs are out of scope.
- Put production Kotlin under `src/main/kotlin/booking/`. The Spring Boot
  application class must be `booking.MeetingRoomBookingApplication`, and the app must
  start with `./gradlew bootRun`. Keep the provided build configuration.
- Initialize three rooms at startup with zero bookings. There are no endpoints to add
  or remove rooms:

  | Room ID | Tier | Min attendees | Capacity | Max duration | Cleanup buffer | Equipment |
  | --- | --- | --- | --- | --- | --- | --- |
  | `atlas` | `STANDARD` | `1` | `6` | 2 hours | 0 minutes | `whiteboard` |
  | `orion` | `STANDARD` | `1` | `12` | 4 hours | 0 minutes | `projector`, `whiteboard` |
  | `vega` | `EXECUTIVE` | `4` | `20` | 4 hours | 15 minutes | `projector`, `video_conferencing`, `whiteboard` |

- H2 is the source of truth for bookings. Use its current state when listing bookings,
  searching availability, and checking for conflicts. The verifier also checks persisted
  state in the `bookings` table. Include these unquoted columns: `id`, `room_id`, and
  `status` as `VARCHAR`, `attendees` as `INTEGER`, and `starts_at` and `ends_at` as
  `TIMESTAMP WITH TIME ZONE`. Store `status` as `'PENDING'`, `'CONFIRMED'`, or
  `'CANCELLED'`. The rest of the schema and the way you initialize it are up to you.

## Booking rules

- Create and reschedule requests use the same JSON body with `startsAt` (string),
  `endsAt` (string), and `attendees` (JSON integer, at least `1`). Accept UTC timestamps
  in `YYYY-MM-DDTHH:MM:SSZ` format with whole-second precision, years 0001 through 9999,
  and seconds 00 through 59. Return times in the same format. Use
  `Content-Type: application/json` for request and success bodies.
- A booking covers its start instant up to and excluding its end instant. The end must
  be later than the start.
- **Time-based rules (relative to current UTC time):**
  - Bookings cannot start in the past (`startsAt` must not be earlier than the current
    time). This applies to both creating and rescheduling.
  - An active booking cannot be cancelled or rescheduled within 15 minutes of its current
    start time (i.e., when `startsAt` is less than 15 minutes from now, including bookings
    that have already started).
- **Room policy rules:**
  - `attendees` must be within the room's `[minAttendees, capacity]` range.
  - The booking duration (`endsAt - startsAt`) must not exceed the room's max duration.
  - Only active bookings (`PENDING` and `CONFIRMED`) occupy a room; `CANCELLED` bookings
    do not block slots.
  - For `STANDARD` rooms (`0` minutes cleanup buffer), back-to-back active bookings are
    allowed; overlapping active bookings are rejected.
  - For `EXECUTIVE` rooms (`15` minutes cleanup buffer), there must be at least 15 minutes
    between any two active bookings in the room (a new or rescheduled booking cannot start
    less than 15 minutes after an existing active booking ends, nor end less than 15
    minutes before an existing active booking starts).
  - Different rooms can be booked for the same period.
- **Booking lifecycle:**
  - Generate each booking ID on the server. It must be unique and contain only ASCII
    letters, digits, underscores, or hyphens.
  - Creating a booking in a `STANDARD` room sets its status to `CONFIRMED`. Creating a
    booking in an `EXECUTIVE` room sets its status to `PENDING`.
  - Confirming transitions a `PENDING` booking to `CONFIRMED`. Confirming an already
    `CONFIRMED` or `CANCELLED` booking is rejected.
  - Cancelling transitions a `PENDING` or `CONFIRMED` booking to `CANCELLED`, keeping the
    row persisted in H2 and freeing its slot. Cancelling an already `CANCELLED` booking
    is rejected.
  - Rescheduling is allowed for `PENDING` and `CONFIRMED` bookings and rejected for
    `CANCELLED` bookings. It replaces `startsAt`, `endsAt`, and `attendees`, retains `id`
    and `roomId`, and cannot conflict with itself. Rescheduling a `CONFIRMED` booking in
    an `EXECUTIVE` room resets its status to `PENDING`; in a `STANDARD` room it remains
    `CONFIRMED`.
- **Atomicity:**
  - Checking availability and saving or updating a booking must be atomic. Two concurrent
    requests cannot both claim conflicting slots (including cleanup buffers) in the same
    room. A failed reschedule, confirmation, or cancellation must preserve the original
    booking unchanged.

## Availability search

- `GET /rooms/available` accepts query parameters:
  - `startsAt` (required): whole-second UTC timestamp
  - `endsAt` (required): whole-second UTC timestamp
  - `attendees` (required): positive integer
  - `equipment` (optional): comma-separated list of required equipment names (for example,
    `equipment=projector,whiteboard`); if omitted or blank, no equipment filter applies
- Reject missing or invalid parameters, invalid or past time ranges, or non-positive
  `attendees` with `400`.
- Return `200` and a JSON array of matching rooms sorted by `id` ascending (or `[]` if
  none match). A room matches when:
  - `attendees` is within its `[minAttendees, capacity]` range,
  - the requested duration does not exceed its max duration,
  - it has all requested equipment (exact match; unknown equipment matches no rooms), and
  - it has no active booking conflicting with the requested slot (including the room's
    cleanup buffer).

## HTTP contract

| Method and path | Successful response |
| --- | --- |
| `POST /rooms/{roomId}/bookings` | `201` and the created booking |
| `GET /rooms/{roomId}/bookings` | `200` and a JSON array of active (`PENDING` and `CONFIRMED`) bookings in ascending `startsAt` order, or `[]` |
| `GET /bookings/{id}` | `200` and the booking (including `CANCELLED`) |
| `PATCH /bookings/{id}` | `200` and the updated booking |
| `POST /bookings/{id}/confirm` | `200` and the confirmed booking |
| `POST /bookings/{id}/cancel` | `200` and the cancelled booking |
| `GET /rooms/available` | `200` and a JSON array of matching rooms sorted by `id` ascending, or `[]` |

Booking responses contain `id`, `roomId`, `startsAt`, `endsAt`, `attendees`, and `status`:

```json
{
  "id": "booking-42",
  "roomId": "vega",
  "startsAt": "2030-05-20T09:00:00Z",
  "endsAt": "2030-05-20T10:00:00Z",
  "attendees": 6,
  "status": "PENDING"
}
```

Room responses from `GET /rooms/available` contain `id`, `tier`, `minAttendees`,
`capacity`, and `equipment` (sorted alphabetically):

```json
{
  "id": "orion",
  "tier": "STANDARD",
  "minAttendees": 1,
  "capacity": 12,
  "equipment": ["projector", "whiteboard"]
}
```

- Return `400` for malformed JSON, missing or invalid fields/parameters, invalid
  timestamps, invalid or past time ranges, durations exceeding the room's max duration,
  or `attendees` outside the room's allowed range.
- Return `404` for unknown rooms and unknown booking IDs.
- Return `409` for overlaps (including cleanup buffer conflicts), invalid lifecycle
  transitions (confirming a non-`PENDING` booking, cancelling or rescheduling a
  `CANCELLED` booking), and cancelling or rescheduling within 15 minutes of the booking's
  current `startsAt`.
- Error bodies and precedence when a request has multiple errors are up to you.

## Tests and verification

Write tests under `src/test/kotlin/booking/`. Cover normal booking behavior, room
policies, lifecycle transitions, time cutoffs, availability search, and rejected
operations. Verify with `./gradlew test`.
