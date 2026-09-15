import { BrandMark } from "@/components/brand-mark";
import { LoginForm } from "@/components/login-form";

const LOGIN_ERRORS: Record<string, string> = {
  confirmation: "That confirmation link is invalid or has expired. Contact your administrator for a new link.",
  configuration: "The service is temporarily unavailable. Try again later.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const params = await searchParams;
  const errorCode = Array.isArray(params.error) ? params.error[0] : params.error;
  const initialMessage = errorCode ? LOGIN_ERRORS[errorCode] ?? "Sign-in could not be completed. Try again." : "";

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
        <div className="auth-card">
          <h2 id="sign-in-title">Sign in</h2>
          <LoginForm initialMessage={initialMessage} />
        </div>
      </section>
    </main>
  );
}
