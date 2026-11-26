import { bookingsOverlap, type RoomBooking } from './booking';
import { parseBookingRequest } from './booking-parser';
import type { BookingStore } from './booking-store';

export async function reserveRoom(
  store: BookingStore,
  id: string,
  rawPayload: Record<string, unknown>,
): Promise<RoomBooking> {
  const candidate = parseBookingRequest(rawPayload, id);
  const existing = await store.listForRoom(candidate.roomCode);
  if (existing.some((item) => bookingsOverlap(item, candidate))) {
    throw new Error(`Room ${candidate.roomCode} is already booked for that slot`);
  }
  await store.save(candidate);
  return candidate;
}
