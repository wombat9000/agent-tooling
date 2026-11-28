import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FilterDisclosure } from '../FilterDisclosure';
import { partitionUploadedFiles } from '../upload-mapper';

describe('FilterDisclosure', () => {
  it('toggles the filter panel open and updates accessible state on click', async () => {
    const user = userEvent.setup();
    render(<FilterDisclosure activeCount={2} />);

    const toggle = screen.getByRole('button', { name: /Filters \(2\)/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Filter options' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('2 filters applied');
  });
});

describe('partitionUploadedFiles', () => {
  it('separates valid PDFs into accepted and oversized files into rejected', () => {
    const result = partitionUploadedFiles([
      { name: 'receipt.pdf', sizeBytes: 120_000, mimeType: 'application/pdf' },
      { name: 'archive.pdf', sizeBytes: 25_000_000, mimeType: 'application/pdf' },
    ]);

    expect(result.accepted).toEqual([{ name: 'receipt.pdf', sizeBytes: 120_000 }]);
    expect(result.rejected).toEqual([{ name: 'archive.pdf', reason: 'FILE_TOO_LARGE' }]);
  });
});
