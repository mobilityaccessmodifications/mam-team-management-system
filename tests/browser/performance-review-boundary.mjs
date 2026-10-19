const invoke = (name, args) => {
  const fixture = window.performanceReviewFixture;
  if (!fixture) throw new Error('Performance fixture boundary is not installed.');
  return fixture.invoke(name, args);
};
export const loadPerformanceReviews = previewPersonId => invoke('loadPerformanceReviews', previewPersonId === undefined ? [] : [previewPersonId]);
export const startPerformanceReview = input => invoke('startPerformanceReview', [input]);
export const mutatePerformanceReview = input => invoke('mutatePerformanceReview', [input]);
export const reconcilePerformanceReviewOperation = input => invoke('reconcilePerformanceReviewOperation', [input]);
export const getPerformanceReviewDocument = (reviewId, previewPersonId) => invoke('getPerformanceReviewDocument', previewPersonId === undefined ? [reviewId] : [reviewId, previewPersonId]);
export const createClient = () => ({ auth: { onAuthStateChange(callback) {
  const fixture = window.performanceReviewFixture;
  fixture.authListeners.add(callback);
  queueMicrotask(() => { if (fixture.authListeners.has(callback)) callback('INITIAL_SESSION', { user: { id: fixture.workspace.viewerContext.actorUserId } }); });
  return { data: { subscription: { unsubscribe() { fixture.authListeners.delete(callback); } } } };
} } });
