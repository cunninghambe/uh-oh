import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, type IssueAnnotation } from '../api.js';
import { AnnotationTimeline } from './AnnotationTimeline.js';
import { ANNOTATIONS_PAGE_SIZE } from './AnnotationTimeline.utils.js';

const baseAnnotation: IssueAnnotation = {
  id: 'a1',
  author: 'agent',
  kind: 'root_cause',
  body: 'Line 1\nLine 2 with  extra   spaces',
  createdAt: Date.now() - 5 * 60_000,
};

const renderTimeline = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AnnotationTimeline issueId="i1" />
    </QueryClientProvider>,
  );
};

describe('AnnotationTimeline (v0.8 CONTRACT — SPEC §23 annotations)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when the annotations endpoint 404s (server v0.7 not landed yet)', async () => {
    vi.spyOn(api, 'listIssueAnnotations').mockRejectedValue(new ApiError(404, 'not found'));
    const { container } = renderTimeline();

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('shows an empty state when there are no annotations', async () => {
    vi.spyOn(api, 'listIssueAnnotations').mockResolvedValue({ annotations: [], total: 0 });
    renderTimeline();

    expect(await screen.findByText('No annotations yet.')).toBeInTheDocument();
  });

  it('renders kind badge, author, time, and a whitespace-preserved body', async () => {
    vi.spyOn(api, 'listIssueAnnotations').mockResolvedValue({
      annotations: [baseAnnotation],
      total: 1,
    });
    renderTimeline();

    // { selector: 'span' } disambiguates the KindBadge from the add-form's identically-labeled
    // "root cause" <option>, which is always present regardless of query state.
    expect(await screen.findByText('root cause', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('5m ago')).toBeInTheDocument();
    const body = screen.getByText(
      (_, el) => el?.tagName === 'PRE' && el.textContent === baseAnnotation.body,
    );
    expect(body).toBeInTheDocument();
    expect(body.className).toContain('whitespace-pre-wrap');
  });

  it('posting a new annotation defaults the author to "human" and refreshes the list', async () => {
    vi.spyOn(api, 'listIssueAnnotations').mockResolvedValue({ annotations: [], total: 0 });
    const addSpy = vi.spyOn(api, 'addIssueAnnotation').mockResolvedValue({
      annotation: {
        id: 'a2',
        author: 'human',
        kind: 'note',
        body: 'New note',
        createdAt: Date.now(),
      },
    });
    renderTimeline();

    await screen.findByText('No annotations yet.');

    fireEvent.change(screen.getByLabelText('Annotation body'), {
      target: { value: 'New note' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));

    await waitFor(() => {
      expect(addSpy).toHaveBeenCalledWith('i1', {
        body: 'New note',
        kind: 'note',
        author: 'human',
      });
    });
  });

  it('the kind selector does not offer "system" (server-written audit rows only)', async () => {
    vi.spyOn(api, 'listIssueAnnotations').mockResolvedValue({ annotations: [], total: 0 });
    renderTimeline();

    await screen.findByText('No annotations yet.');
    const select = screen.getByLabelText('Annotation kind');
    const optionLabels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionLabels).not.toContain('system');
  });

  it('the submit button is disabled for an empty/whitespace-only body', async () => {
    vi.spyOn(api, 'listIssueAnnotations').mockResolvedValue({ annotations: [], total: 0 });
    renderTimeline();

    await screen.findByText('No annotations yet.');
    expect(screen.getByRole('button', { name: 'Add annotation' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Annotation body'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Add annotation' })).toBeDisabled();
  });

  it('shows pagination controls only once total exceeds one page', async () => {
    const annotations = Array.from({ length: ANNOTATIONS_PAGE_SIZE }, (_, i) => ({
      ...baseAnnotation,
      id: `a${String(i)}`,
    }));
    vi.spyOn(api, 'listIssueAnnotations').mockResolvedValue({
      annotations,
      total: ANNOTATIONS_PAGE_SIZE,
    });
    renderTimeline();

    // { selector: 'span' } disambiguates the KindBadge from the add-form's identically-labeled
    // "root cause" <option>, which is always present regardless of query state.
    await screen.findAllByText('root cause', { selector: 'span' });
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('clicking Next requests the following offset page', async () => {
    const listSpy = vi.spyOn(api, 'listIssueAnnotations').mockResolvedValue({
      annotations: Array.from({ length: ANNOTATIONS_PAGE_SIZE }, (_, i) => ({
        ...baseAnnotation,
        id: `a${String(i)}`,
      })),
      total: ANNOTATIONS_PAGE_SIZE + 1,
    });
    renderTimeline();

    // { selector: 'span' } disambiguates the KindBadge from the add-form's identically-labeled
    // "root cause" <option>, which is always present regardless of query state.
    await screen.findAllByText('root cause', { selector: 'span' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith('i1', {
        limit: ANNOTATIONS_PAGE_SIZE,
        offset: ANNOTATIONS_PAGE_SIZE,
      });
    });
  });
});
