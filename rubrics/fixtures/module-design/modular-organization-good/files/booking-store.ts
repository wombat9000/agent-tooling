import type { RoomBooking } from './booking';

export interface BookingStore {
  listForRoom(roomCode: string): Promise<readonly RoomBooking[]>;
  save(booking: RoomBooking): Promise<void>;
}
