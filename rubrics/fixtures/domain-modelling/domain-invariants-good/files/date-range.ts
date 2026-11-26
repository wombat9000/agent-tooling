export class StayPeriod {
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly nights: number;

  private constructor(checkInDate: string, checkOutDate: string, nights: number) {
    this.checkInDate = checkInDate;
    this.checkOutDate = checkOutDate;
    this.nights = nights;
  }

  static create(checkInDate: string, checkOutDate: string): StayPeriod {
    const startMs = Date.parse(checkInDate);
    const endMs = Date.parse(checkOutDate);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error('Check-out date must be after check-in date');
    }
    const nights = Math.round((endMs - startMs) / 86_400_000);
    if (nights < 1 || nights > 30) {
      throw new Error('Stay length must be between 1 and 30 nights');
    }
    return new StayPeriod(checkInDate, checkOutDate, nights);
  }
}
