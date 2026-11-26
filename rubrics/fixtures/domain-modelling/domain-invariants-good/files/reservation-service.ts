import { StayPeriod } from './date-range';
import { Reservation } from './reservation';

export interface ReservationRepository {
  save(reservation: Reservation): Promise<void>;
}

export async function createReservation(
  repository: ReservationRepository,
  input: { readonly id: string; readonly checkIn: string; readonly checkOut: string; readonly guests: number },
): Promise<Reservation> {
  const stay = StayPeriod.create(input.checkIn, input.checkOut);
  const reservation = Reservation.book(input.id, stay, input.guests);
  await repository.save(reservation);
  return reservation;
}
