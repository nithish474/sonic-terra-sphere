import { useState } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in to SoniSphere | Acoustic Field Lab" },
      {
        name: "description",
        content:
          "Sign in to SoniSphere with email and password or Google to record, analyse and archive bioacoustic field captures.",
      },
      { property: "og:title", content: "Sign in to SoniSphere" },
      {
        property: "og:description",
        content: "Access your SoniSphere acoustic field lab: recordings, ecosystem metrics and soil rigidity trends.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

type Mode = "signin" | "signup" | "forgot-email" | "forgot-otp" | "forgot-password";

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const done = () => navigate({ to: "/" });

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Welcome back to the field lab.");
    done();
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        data: { display_name: displayName || email.split("@")[0] },
      },
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Account created. If confirmation is required, check your inbox.");
    done();
  }

  async function google() {
    setBusy(true);
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) {
      setBusy(false);
      return toast.error("Google sign-in failed. Please try again.");
    }
    if (result.redirected) return;
    setBusy(false);
    done();
  }

  async function sendOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(`A 6-digit reset code was sent to ${email}.`);
    setMode("forgot-otp");
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ email, token: otp, type: "email" });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Code verified. Choose a new password.");
    setMode("forgot-password");
  }

  async function setNew(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 6) return toast.error("Password must be at least 6 characters.");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Password updated — you're signed in.");
    done();
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
      <div className="animate-aurora pointer-events-none absolute -left-32 top-0 h-[28rem] w-[28rem] rounded-full opacity-25 blur-3xl aurora-fill" />
      <div
        className="animate-aurora pointer-events-none absolute -right-24 bottom-0 h-[24rem] w-[24rem] rounded-full opacity-20 blur-3xl aurora-fill"
        style={{ animationDelay: "5s" }}
      />

      <div className="glass relative w-full max-w-md rounded-3xl p-8">
        <Link to="/" className="mb-8 flex items-center gap-3">
          <span className="glow flex h-10 w-10 items-center justify-center rounded-full aurora-fill text-primary-foreground">
            <span className="text-sm font-bold">S</span>
          </span>
          <div>
            <p className="font-display text-lg font-semibold leading-none">SoniSphere</p>
            <p className="text-xs text-muted-foreground">Acoustic field lab</p>
          </div>
        </Link>

        {(mode === "signin" || mode === "signup") && (
          <>
            <h1 className="font-display text-2xl font-semibold">
              {mode === "signin" ? "Sign in" : "Create your account"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === "signin"
                ? "Continue to your recordings and ecosystem dashboard."
                : "Start capturing soundscapes and tracking soil rigidity."}
            </p>

            <form onSubmit={mode === "signin" ? signIn : signUp} className="mt-6 space-y-4">
              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="name">Display name</Label>
                  <Input
                    id="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Field researcher"
                    autoComplete="name"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@field.org"
                  autoComplete="email"
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  {mode === "signin" && (
                    <button
                      type="button"
                      onClick={() => setMode("forgot-email")}
                      className="text-xs text-primary hover:underline"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                />
              </div>
              <Button type="submit" variant="hero" className="w-full" disabled={busy}>
                {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
              </Button>
            </form>

            <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>

            <Button type="button" variant="outline" className="w-full" onClick={google} disabled={busy}>
              <GoogleMark />
              Continue with Google
            </Button>

            <p className="mt-6 text-center text-sm text-muted-foreground">
              {mode === "signin" ? "New to SoniSphere?" : "Already have an account?"}{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              >
                {mode === "signin" ? "Create an account" : "Sign in"}
              </button>
            </p>
          </>
        )}

        {mode === "forgot-email" && (
          <>
            <h1 className="font-display text-2xl font-semibold">Reset your password</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              We'll email you a 6-digit one-time code to verify it's you.
            </p>
            <form onSubmit={sendOtp} className="mt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reset-email">Account email</Label>
                <Input
                  id="reset-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@field.org"
                />
              </div>
              <Button type="submit" variant="hero" className="w-full" disabled={busy}>
                {busy ? "Sending…" : "Send OTP code"}
              </Button>
            </form>
            <BackToSignIn onClick={() => setMode("signin")} />
          </>
        )}

        {mode === "forgot-otp" && (
          <>
            <h1 className="font-display text-2xl font-semibold">Enter the code</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Sent to <span className="text-foreground">{email}</span>. The code expires shortly.
            </p>
            <form onSubmit={verifyOtp} className="mt-6 space-y-5">
              <div className="flex justify-center">
                <InputOTP maxLength={6} value={otp} onChange={setOtp}>
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <InputOTPSlot key={i} index={i} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
              <Button type="submit" variant="hero" className="w-full" disabled={busy || otp.length < 6}>
                {busy ? "Verifying…" : "Verify code"}
              </Button>
              <button
                type="button"
                onClick={() => setMode("forgot-email")}
                className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
              >
                Didn't get it? Send another code
              </button>
            </form>
            <BackToSignIn onClick={() => setMode("signin")} />
          </>
        )}

        {mode === "forgot-password" && (
          <>
            <h1 className="font-display text-2xl font-semibold">Choose a new password</h1>
            <p className="mt-1 text-sm text-muted-foreground">Your identity is verified. Set a new password below.</p>
            <form onSubmit={setNew} className="mt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  required
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </div>
              <Button type="submit" variant="hero" className="w-full" disabled={busy}>
                {busy ? "Updating…" : "Update password"}
              </Button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

function BackToSignIn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-6 w-full text-center text-sm text-muted-foreground hover:text-foreground"
    >
      ← Back to sign in
    </button>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M12 10.2v3.9h5.5c-.24 1.42-1.67 4.16-5.5 4.16-3.31 0-6.01-2.74-6.01-6.12S8.69 6.02 12 6.02c1.88 0 3.14.8 3.86 1.49l2.63-2.53C16.8 3.44 14.62 2.5 12 2.5 6.98 2.5 2.9 6.58 2.9 11.6s4.08 9.1 9.1 9.1c5.26 0 8.74-3.7 8.74-8.9 0-.6-.06-1.06-.15-1.52H12z"
      />
    </svg>
  );
}
