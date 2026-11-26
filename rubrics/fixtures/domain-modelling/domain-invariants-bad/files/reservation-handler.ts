import { buildReservation } from './reservation-service';

export function handleCreateReservation(body: { id: string; checkIn: string; checkOut: string; guests: number }) {
  if (body.guests < 1 || body.guests > 6) {
    return { status: 400, error: 'Invalid guest count' };
  }
  if (Date.parse(body.checkOut) <= Date.parse(body.checkIn)) {
    return { status: 400, error: 'Check-out must follow check-in' };
  }
  return { status: 201, data: buildReservation(body.id, body.checkIn, body.checkOut, body.guests) };
}
