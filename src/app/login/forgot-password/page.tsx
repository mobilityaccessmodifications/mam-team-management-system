import { BrandMark } from "@/components/brand-mark";
import { ForgotPasswordForm } from "@/components/password-recovery-form";

export default function PasswordRecoveryPage() {
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <div className="auth-story-content">
          <BrandMark />
          <div className="auth-story-copy">
            <span>Private team workspace</span>
            <h1>People work, made clear.</h1>
            <p>Leave, schedules, people records and day-to-day operations in one secure place.</p>
          </div>
          <small>MAM · Equipsy</small>
        </div>
      </section>
      <section className="auth-form-wrap" aria-labelledby="sign-in-title">
        <div className="auth-card auth-recovery-card">
          <h2 id="sign-in-title">Forgot password</h2>
          <ForgotPasswordForm />
        </div>
      </section>
    </main>
  );
}
