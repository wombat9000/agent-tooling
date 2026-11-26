export type DateTuple = [string, string];

export interface Reservation {
  id: string;
  dates: DateTuple;
  guestCount: number;
  status: string;
}
