import { turnLeft, turnRight, type Heading } from './compass';

export interface Coordinates {
  readonly x: number;
  readonly y: number;
}

export interface RoverState {
  readonly position: Coordinates;
  readonly heading: Heading;
}

export type MovementCommand = 'left' | 'right' | 'forward';

function stepForward(position: Coordinates, heading: Heading): Coordinates {
  switch (heading) {
    case 'north': return { x: position.x, y: position.y + 1 };
    case 'east': return { x: position.x + 1, y: position.y };
    case 'south': return { x: position.x, y: position.y - 1 };
    case 'west': return { x: position.x - 1, y: position.y };
  }
}

export function applyCommand(state: RoverState, command: MovementCommand): RoverState {
  switch (command) {
    case 'left': return { ...state, heading: turnLeft(state.heading) };
    case 'right': return { ...state, heading: turnRight(state.heading) };
    case 'forward': return { ...state, position: stepForward(state.position, state.heading) };
  }
}
