import Link from "next/link";
import { listOnboardingCredentialReviews } from "./actions";
import { OnboardingCredentialReviews } from "./review-list";
import styles from "./review.module.css";

export default async function OnboardingReviewPage() {
  const result = await listOnboardingCredentialReviews();
  return (
    <main className={styles.page} data-company="mam">
      <Link href="/" prefetch={false}>Back to Directory</Link>
      <h1>Onboarding review</h1>
      {result.ok ? <OnboardingCredentialReviews initialReviews={result.reviews} /> : <>
        <p role="alert">{result.message}</p>
        <a href="/onboarding-review">Refresh list</a>
      </>}
    </main>
  );
}
