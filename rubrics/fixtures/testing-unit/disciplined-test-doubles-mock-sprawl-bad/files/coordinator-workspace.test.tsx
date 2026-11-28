import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../components/QueueHeader', () => ({
  QueueHeader: ({ title }: { title: string }) => <div data-testid="queue-header">{title}</div>,
}));
vi.mock('../components/FilterToolbar', () => ({
  FilterToolbar: () => <div data-testid="filter-toolbar" />,
}));
vi.mock('../components/CaseSummaryBanner', () => ({
  CaseSummaryBanner: () => <div data-testid="summary-banner" />,
}));
vi.mock('../components/CaseTable', () => ({
  CaseTable: ({ count }: { count: number }) => <div data-testid="case-table">{count}</div>,
}));
vi.mock('../components/AssignmentDrawer', () => ({
  AssignmentDrawer: () => <div data-testid="assignment-drawer" />,
}));
vi.mock('../components/BulkActionsBar', () => ({
  BulkActionsBar: () => <div data-testid="bulk-actions-bar" />,
}));
vi.mock('../components/StatusLegend', () => ({
  StatusLegend: () => <div data-testid="status-legend" />,
}));
vi.mock('../hooks/useQueueFilters', () => ({
  useQueueFilters: () => ({ status: 'open', setStatus: vi.fn(), reset: vi.fn() }),
}));
vi.mock('../hooks/useSelectionState', () => ({
  useSelectionState: () => ({ selectedIds: ['c-1'], toggle: vi.fn(), clear: vi.fn() }),
}));
vi.mock('../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => undefined,
}));

import { CoordinatorWorkspace } from '../CoordinatorWorkspace';

describe('CoordinatorWorkspace', () => {
  it('renders the workspace layout regions', () => {
    render(<CoordinatorWorkspace title="Pending Queue" cases={[{ id: 'c-1' }, { id: 'c-2' }]} />);

    expect(screen.getByTestId('queue-header')).toHaveTextContent('Pending Queue');
    expect(screen.getByTestId('filter-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('summary-banner')).toBeInTheDocument();
    expect(screen.getByTestId('case-table')).toHaveTextContent('2');
    expect(screen.getByTestId('assignment-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-actions-bar')).toBeInTheDocument();
    expect(screen.getByTestId('status-legend')).toBeInTheDocument();
  });
});
