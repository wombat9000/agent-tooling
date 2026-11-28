import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CaseHeader } from './CaseHeader';

function renderHeader(overrides: { showPhaseTwoFeatures?: boolean; canApprove?: boolean } = {}) {
  return render(
    <CaseHeader
      caseId="CASE-204"
      title="Facility inspection"
      status="PENDING_REVIEW"
      showPhaseTwoFeatures={overrides.showPhaseTwoFeatures ?? false}
      canApprove={overrides.canApprove ?? true}
      onApprove={vi.fn()}
    />,
  );
}

describe('CaseHeader', () => {
  it('renders phase-one actions when phase-two feature flag is off', () => {
    renderHeader({ showPhaseTwoFeatures: false });

    expect(screen.getByRole('heading', { name: 'Facility inspection' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve case' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Transfer to panel' })).toBeNull();
  });

  it('renders panel transfer action when phase-two feature flag is enabled', async () => {
    const user = userEvent.setup();
    renderHeader({ showPhaseTwoFeatures: true, canApprove: true });

    const transferButton = screen.getByRole('button', { name: 'Transfer to panel' });
    expect(transferButton).toBeVisible();
    await user.click(transferButton);

    expect(screen.getByRole('dialog', { name: 'Transfer case' })).toBeVisible();
  });

  it('disables approval when reviewer lacks approval permission', () => {
    renderHeader({ showPhaseTwoFeatures: false, canApprove: false });

    expect(screen.getByRole('button', { name: 'Approve case' })).toBeDisabled();
  });
});
