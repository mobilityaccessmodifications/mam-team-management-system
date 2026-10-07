import { OnboardingCredentialReviews } from '@/app/onboarding-review/review-list';
import { reviews } from './onboarding-review-actions.mjs';
import styles from '@/app/onboarding-review/review.module.css';
export function OnboardingReviewFixture() {
  return <main className={styles.page} data-company="mam"><h1>Onboarding review</h1><OnboardingCredentialReviews initialReviews={reviews} /></main>;
}
