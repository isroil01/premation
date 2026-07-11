/**
 * Review / approval state (spec §Collaboration V1 — approval flow). A document
 * moves Draft → In Review → Approved. Persisted locally.
 */

import { create } from 'zustand';

export type ReviewStatus = 'draft' | 'in-review' | 'approved';

export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  draft: 'Draft',
  'in-review': 'In Review',
  approved: 'Approved',
};

const KEY = 'motion-editor.review-status';

interface ReviewStore {
  status: ReviewStatus;
  setStatus: (s: ReviewStatus) => void;
}

function load(): ReviewStatus {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    return v === 'in-review' || v === 'approved' ? v : 'draft';
  } catch {
    return 'draft';
  }
}

export const useReviewStore = create<ReviewStore>((set) => ({
  status: load(),
  setStatus: (status) => {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, status); } catch { /* ignore */ }
    set({ status });
  },
}));
