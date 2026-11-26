import type { SupportTicket } from './types';

type OperatorFn = (actual: unknown, expected: unknown) => boolean;

export interface FilterRuleNode {
  readonly field: string;
  readonly operator: string;
  readonly value: unknown;
  readonly priority?: number;
}

export interface FilterDslProgram {
  readonly combinator: 'AND' | 'OR';
  readonly rules: readonly FilterRuleNode[];
  readonly metadata?: { readonly futureVersion?: number; readonly experimentalHint?: string };
}

const OPERATOR_REGISTRY: Record<string, OperatorFn> = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  isNull: (a) => a === null,
};

export class TicketRuleEngine {
  private readonly operators: Record<string, OperatorFn>;

  constructor(customOperators: Record<string, OperatorFn> = {}) {
    this.operators = { ...OPERATOR_REGISTRY, ...customOperators };
  }

  compile(program: FilterDslProgram): (ticket: SupportTicket) => boolean {
    const ordered = [...program.rules].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    return (ticket) => {
      const record = ticket as unknown as Record<string, unknown>;
      const results = ordered.map((rule) => {
        const fn = this.operators[rule.operator];
        if (!fn) throw new Error(`Unknown operator: ${rule.operator}`);
        return fn(record[rule.field], rule.value);
      });
      return program.combinator === 'AND' ? results.every(Boolean) : results.some(Boolean);
    };
  }
}

export class TicketFilterFacade {
  private readonly engine = new TicketRuleEngine();

  apply(tickets: readonly SupportTicket[], program: FilterDslProgram): SupportTicket[] {
    return tickets.filter(this.engine.compile(program));
  }
}

export function filterOpenTickets(tickets: readonly SupportTicket[]): SupportTicket[] {
  return new TicketFilterFacade().apply(tickets, {
    combinator: 'AND',
    rules: [{ field: 'status', operator: 'eq', value: 'open' }],
  });
}
