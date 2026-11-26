export interface RoomBooking {
  readonly id: string;
  readonly roomCode: string;
  readonly startHour: number;
  readonly endHour: number;
}

export function bookingsOverlap(left: RoomBooking, right: RoomBooking): boolean {
  return left.roomCode === right.roomCode && left.startHour < right.endHour && right.startHour < left.endHour;
}
