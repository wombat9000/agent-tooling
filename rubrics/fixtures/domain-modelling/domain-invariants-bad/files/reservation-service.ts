import type { Reservation } from './reservation-types';

export function buildReservation(
  id: string,
  checkIn: string,
  checkOut: string,
  guestCount: number,
  status: string = 'confirmed',
): Reservation {
  return { id, dates: [checkIn, checkOut], guestCount, status };
}

export function markReservationCancelled(reservation: Reservation): Reservation {
  return { ...reservation, status: 'cancelled' };
}
