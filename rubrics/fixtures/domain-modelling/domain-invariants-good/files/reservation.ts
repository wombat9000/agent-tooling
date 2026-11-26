import { StayPeriod } from './date-range';

export type ReservationStatus = 'confirmed' | 'cancelled';

export class Reservation {
  readonly id: string;
  readonly stay: StayPeriod;
  readonly guestCount: number;
  readonly status: ReservationStatus;

  private constructor(id: string, stay: StayPeriod, guestCount: number, status: ReservationStatus) {
    this.id = id;
    this.stay = stay;
    this.guestCount = guestCount;
    this.status = status;
  }

  static book(id: string, stay: StayPeriod, guestCount: number): Reservation {
    if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 6) {
      throw new Error('Guest count must be an integer between 1 and 6');
    }
    return new Reservation(id, stay, guestCount, 'confirmed');
  }

  cancel(): Reservation {
    if (this.status === 'cancelled') {
      throw new Error('Reservation is already cancelled');
    }
    return new Reservation(this.id, this.stay, this.guestCount, 'cancelled');
  }
}
