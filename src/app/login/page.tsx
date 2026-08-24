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
        <BrandMark />
        <div className="auth-message">
          <h1>Everything your team needs.</h1>
          <p>See leave, people tasks and your organisation in one private workspace.</p>
        </div>
      </section>
      <section className="auth-form-wrap" aria-labelledby="sign-in-title">
        <div className="auth-card">
          <h2 id="sign-in-title">Sign in</h2>
          <p>Enter your username and password.</p>
          <LoginForm initialMessage={initialMessage} />
        </div>
      </section>
    </main>
  );
}
