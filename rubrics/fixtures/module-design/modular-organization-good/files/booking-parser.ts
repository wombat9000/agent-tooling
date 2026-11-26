import type { RoomBooking } from './booking';

export function parseBookingRequest(raw: Record<string, unknown>, id: string): RoomBooking {
  const roomCode = typeof raw.roomCode === 'string' ? raw.roomCode.trim() : '';
  const startHour = Number(raw.startHour);
  const endHour = Number(raw.endHour);
  if (!roomCode || !Number.isInteger(startHour) || !Number.isInteger(endHour) || endHour <= startHour) {
    throw new Error('Invalid room booking payload');
  }
  return { id, roomCode, startHour, endHour };
}
