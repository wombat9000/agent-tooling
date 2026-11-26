export type Heading = 'north' | 'east' | 'south' | 'west';
export type TurnCommand = 'left' | 'right';

export function turnLeft(heading: Heading): Heading {
  switch (heading) {
    case 'north': return 'west';
    case 'west': return 'south';
    case 'south': return 'east';
    case 'east': return 'north';
  }
}

export function turnRight(heading: Heading): Heading {
  switch (heading) {
    case 'north': return 'east';
    case 'east': return 'south';
    case 'south': return 'west';
    case 'west': return 'north';
  }
}
