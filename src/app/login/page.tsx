import { BrandMark } from "@/components/brand-mark";
import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <BrandMark />
        <div className="auth-message">
          <h1>Keep the team covered.</h1>
          <p>See leave, availability and manager decisions in one private MAM workspace.</p>
        </div>
      </section>
      <section className="auth-form-wrap" aria-labelledby="sign-in-title">
        <div className="auth-card">
          <h2 id="sign-in-title">Sign in</h2>
          <p>No password to remember. We will send a secure link to your approved work email.</p>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
