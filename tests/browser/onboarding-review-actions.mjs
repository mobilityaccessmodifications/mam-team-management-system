export const reviews = ONBOARDING_REVIEW_RESULTS.list.reviews;
window.reviewCalls = [];
window.reviewReads = 0;
let committed = false;
export async function cancelOnboardingCredentialReview(input) {
  window.reviewCalls.push(input);
  const outcome = new URLSearchParams(location.search).get('outcome') ?? 'success';
  if (new URLSearchParams(location.search).has('hold')) await new Promise(resolve => { window.releaseReview = resolve; });
  const result = ONBOARDING_REVIEW_RESULTS[outcome];
  if (!result) throw new Error('Unimplemented synthetic cancellation outcome');
  committed = result.ok;
  return result;
}
export async function listOnboardingCredentialReviews() {
  window.reviewReads++;
  return committed ? ONBOARDING_REVIEW_RESULTS.empty : ONBOARDING_REVIEW_RESULTS.refreshed;
}
