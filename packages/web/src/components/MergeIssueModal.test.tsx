import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, type SimilarIssue } from '../api.js';
import { MergeIssueModal } from './MergeIssueModal.js';

const similarIssue: SimilarIssue = {
  issue: {
    id: 'i2',
    projectId: 'p1',
    projectSlug: 'demo',
    title: 'NullPointerException: boom',
    status: 'open',
    platform: 'android',
    lastSeen: Date.now() - 5 * 60_000,
    eventCount: 12,
  },
  fixAttempts: [],
  annotationCount: 2,
};

const verifiedSimilarIssue: SimilarIssue = {
  ...similarIssue,
  issue: { ...similarIssue.issue, id: 'i3', title: 'NullPointerException: other' },
  fixAttempts: [
    {
      id: 'fa1',
      prUrl: 'https://github.com/org/repo/pull/1',
      state: 'verified',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ],
};

// The real merge endpoint responds { merged, mergedInto } — it does NOT echo the issue row.
const mergeResponse = { merged: true, mergedInto: 'i2' };

const renderModal = (onMerged = vi.fn(), onClose = vi.fn()) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MergeIssueModal issueId="i1" onClose={onClose} onMerged={onMerged} />
    </QueryClientProvider>,
  );
  return { ...utils, onMerged, onClose };
};

describe('MergeIssueModal (v0.9 CONTRACT — SPEC §24 issue merge)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists similar issues as click-to-select merge targets with title/project/status', async () => {
    vi.spyOn(api, 'getSimilarIssues').mockResolvedValue({ similar: [similarIssue] });
    renderModal();

    expect(await screen.findByText('NullPointerException: boom')).toBeInTheDocument();
    expect(screen.getByText('demo')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
  });

  it('shows a "verified fix" hint for a similar issue that has one', async () => {
    vi.spyOn(api, 'getSimilarIssues').mockResolvedValue({ similar: [verifiedSimilarIssue] });
    renderModal();

    expect(await screen.findByText('verified fix')).toBeInTheDocument();
  });

  it('shows an empty state when there are no similar issues', async () => {
    vi.spyOn(api, 'getSimilarIssues').mockResolvedValue({ similar: [] });
    renderModal();

    expect(await screen.findByText('No similar issues found.')).toBeInTheDocument();
  });

  it('falls back to the free-id-only message when the similar endpoint 404s (older server)', async () => {
    vi.spyOn(api, 'getSimilarIssues').mockRejectedValue(new ApiError(404, 'not found'));
    renderModal();

    expect(
      await screen.findByText(/No suggestions available — merge by issue id below instead\./),
    ).toBeInTheDocument();
    // The free-id field is still usable even though the suggestions call failed.
    expect(screen.getByLabelText('Target issue id')).toBeInTheDocument();
  });

  it('clicking a similar-issue row only selects it; the Merge button is the confirmation', async () => {
    vi.spyOn(api, 'getSimilarIssues').mockResolvedValue({ similar: [similarIssue] });
    const mergeSpy = vi.spyOn(api, 'mergeIssue').mockResolvedValue(mergeResponse);
    const { onMerged } = renderModal();

    const row = await screen.findByText('NullPointerException: boom');
    fireEvent.click(row);

    // Selection alone must NOT merge — merge is irreversible, so the POST only
    // fires from the explicit Merge button.
    expect(mergeSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Target issue id')).toHaveValue('i2');
    expect(row.closest('button')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

    await waitFor(() => {
      expect(mergeSpy).toHaveBeenCalledWith('i1', 'i2');
    });
    await waitFor(() => {
      expect(onMerged).toHaveBeenCalledWith('i2');
    });
  });

  it('typing a free issue id and submitting POSTs the merge with the trimmed id', async () => {
    vi.spyOn(api, 'getSimilarIssues').mockResolvedValue({ similar: [] });
    const mergeSpy = vi.spyOn(api, 'mergeIssue').mockResolvedValue(mergeResponse);
    const { onMerged } = renderModal();

    await screen.findByText('No similar issues found.');
    fireEvent.change(screen.getByLabelText('Target issue id'), {
      target: { value: '  i9  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

    await waitFor(() => {
      expect(mergeSpy).toHaveBeenCalledWith('i1', 'i9');
    });
    await waitFor(() => {
      expect(onMerged).toHaveBeenCalledWith('i9');
    });
  });

  it('the free-id submit button is disabled until something is typed', async () => {
    vi.spyOn(api, 'getSimilarIssues').mockResolvedValue({ similar: [] });
    renderModal();

    await screen.findByText('No similar issues found.');
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Target issue id'), {
      target: { value: 'i9' },
    });
    expect(screen.getByRole('button', { name: 'Merge' })).not.toBeDisabled();
  });

  it('surfaces a merge error (e.g. merge-into-merged) as visible text and does not navigate', async () => {
    vi.spyOn(api, 'getSimilarIssues').mockResolvedValue({ similar: [] });
    vi.spyOn(api, 'mergeIssue').mockRejectedValue(new ApiError(400, 'target_already_merged'));
    const { onMerged } = renderModal();

    await screen.findByText('No similar issues found.');
    fireEvent.change(screen.getByLabelText('Target issue id'), {
      target: { value: 'i9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

    expect(await screen.findByText('target_already_merged')).toBeInTheDocument();
    expect(onMerged).not.toHaveBeenCalled();
  });

  it('the close button calls onClose without merging', async () => {
    vi.spyOn(api, 'getSimilarIssues').mockResolvedValue({ similar: [] });
    const { onClose } = renderModal();

    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
