import React, { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, KeyRound, Shield, Sprout, Users } from 'lucide-react';
import { apiFetch, setStoredToken } from '../../lib/api';
import { signInWithGooglePopup, syncFirebaseUserProfile } from '../../lib/firebase';
import { ROLE_META, type AppRole } from '../../../shared/types';
import { KhetPatchLogo } from '../../components/BrandMark';
import type { AuthenticatedContext } from '../../../server/auth/authService';

interface AuthSuccessPayload {
  token: string;
  user: AuthenticatedContext;
  redirectRoute: string;
}

interface DemoInfo {
  enabled: boolean;
  email?: string;
  passwordHint?: string;
  roles?: AppRole[];
  note?: string;
}

export function LoginPage({
  onAuthSuccess,
  onNavigate,
}: {
  onAuthSuccess: (user: AuthenticatedContext, redirectRoute: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selectedRole, setSelectedRole] = useState<AppRole>('FARMER');
  const [demoInfo, setDemoInfo] = useState<DemoInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<DemoInfo>('/auth/demo-info')
      .then((res) => setDemoInfo(res))
      .catch(() => setDemoInfo({ enabled: false }));
  }, []);

  const submitLogin = async (e: React.FormEvent, roleOverride?: AppRole) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const targetRole = roleOverride || selectedRole;

    try {
      const res = await apiFetch<AuthSuccessPayload>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          requestedRole: targetRole,
        }),
      });
      setStoredToken(res.token);
      onAuthSuccess(res.user, res.redirectRoute);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  const launchDemoWorkspace = async (role: AppRole) => {
    if (!demoInfo?.enabled || !demoInfo.email || !demoInfo.passwordHint) return;
    setEmail(demoInfo.email);
    setPassword(demoInfo.passwordHint);
    setSelectedRole(role);
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch<AuthSuccessPayload>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: demoInfo.email,
          password: demoInfo.passwordHint,
          requestedRole: role,
        }),
      });
      setStoredToken(res.token);
      onAuthSuccess(res.user, res.redirectRoute);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Demo login failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      const { idToken, user: fbUser } = await signInWithGooglePopup();
      void syncFirebaseUserProfile(fbUser, 'en').catch(() => {});
      const res = await apiFetch<AuthSuccessPayload>('/auth/firebase-exchange', {
        method: 'POST',
        body: JSON.stringify({ idToken }),
      });
      setStoredToken(res.token);
      onAuthSuccess(res.user, res.redirectRoute);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google Sign-In failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#03152B] text-white py-12 px-4 sm:px-6 flex items-center justify-center">
      <div className="max-w-5xl w-full grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Standard Credential Login */}
        <div className="lg:col-span-5 bg-white text-[#10251D] rounded-2xl p-6 sm:p-8 shadow-xl space-y-5">
          <div className="space-y-1.5">
            <KhetPatchLogo light={false} />
            <h1 className="font-display font-extrabold text-2xl pt-2">Sign In to KhetPatch</h1>
            <p className="text-xs text-[#52635C]">
              Server-side session authentication and trusted database role resolution.
            </p>
          </div>

          <form onSubmit={(e) => submitLogin(e)} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-xs font-semibold text-[#10251D] mb-1">
                Email Address
              </label>
              <input
                id="login-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="farmer@example.com"
                className="w-full px-3.5 py-2.5 rounded-lg border border-[#DCE8DC] text-sm focus:outline-2 focus:outline-[#075A36]"
              />
            </div>

            <div>
              <label htmlFor="login-password" className="block text-xs font-semibold text-[#10251D] mb-1">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-lg border border-[#DCE8DC] text-sm focus:outline-2 focus:outline-[#075A36]"
              />
            </div>

            <div>
              <label htmlFor="login-role" className="block text-xs font-semibold text-[#10251D] mb-1">
                Target Workspace Role
              </label>
              <select
                id="login-role"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as AppRole)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-[#DCE8DC] text-sm bg-white focus:outline-2 focus:outline-[#075A36]"
              >
                {(Object.keys(ROLE_META) as AppRole[]).map((role) => (
                  <option key={role} value={role}>
                    {ROLE_META[role].label} ({role})
                  </option>
                ))}
              </select>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between text-xs">
              <span className="text-[#52635C]">Need help signing in?</span>
              <button
                type="button"
                onClick={() => onNavigate('/forgot-password')}
                className="font-semibold text-[#075A36] hover:underline"
              >
                Forgot password?
              </button>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-[#063D2A] hover:bg-[#075A36] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
            >
              <KeyRound className="w-4 h-4" />
              {loading ? 'Authenticating...' : 'Sign In'}
            </button>
          </form>

          <div className="relative py-1">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[#DCE8DC]" />
            </div>
            <div className="relative flex justify-center text-[11px] uppercase tracking-wide">
              <span className="bg-white px-2 text-[#52635C]">or</span>
            </div>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={handleGoogleSignIn}
            className="w-full py-2.5 px-4 rounded-lg border border-[#DCE8DC] hover:bg-[#F8FBF6] text-[#10251D] font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
          >
            Continue with Google
          </button>

          <div className="pt-3 border-t border-[#DCE8DC] text-xs text-[#52635C] flex items-center justify-between">
            <span>New farmer?</span>
            <button
              type="button"
              onClick={() => onNavigate('/signup')}
              className="font-semibold text-[#075A36] hover:underline"
            >
              Create Farmer Account →
            </button>
          </div>
        </div>

        {/* Shared Demo Identity 5-Workspace Cards */}
        <div className="lg:col-span-7 rounded-2xl bg-[#071E38] border border-[#27D7ED]/30 p-6 sm:p-8 space-y-5">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#A7F33C]">
              <Shield className="w-4 h-4" /> SHARED DEMO IDENTITY (5 ASSIGNED WORKSPACES)
            </div>
            <h2 className="font-display font-bold text-xl text-white">
              Select Any Authorized Role Workspace
            </h2>
            <p className="text-xs text-slate-300 leading-relaxed">
              {demoInfo?.enabled
                ? `One verified demo identity (${demoInfo.email}) holds five explicit role assignments in the database. Click any workspace card to authenticate and verify server-side role resolution.`
                : 'Demo authentication is disabled in this environment.'}
            </p>
          </div>

          {demoInfo?.enabled && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(Object.keys(ROLE_META) as AppRole[]).map((role) => {
                const meta = ROLE_META[role];
                return (
                  <button
                    key={role}
                    type="button"
                    disabled={loading}
                    onClick={() => launchDemoWorkspace(role)}
                    className="text-left p-4 rounded-xl bg-[#03152B]/80 hover:bg-[#063D2A]/80 border border-white/15 hover:border-[#A7F33C]/60 transition-all space-y-1.5 group disabled:opacity-60"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono-tabular text-[#27D7ED]">{meta.route}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-[#A7F33C] opacity-70 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                    <div className="font-display font-bold text-sm text-white">{meta.label}</div>
                    <p className="text-xs text-slate-300 leading-snug">{meta.description}</p>
                  </button>
                );
              })}
            </div>
          )}

          <div className="text-[11px] text-slate-400 border-t border-white/10 pt-3 flex flex-wrap items-center justify-between gap-2">
            <span>Public signups receive FARMER role only.</span>
            <span>Demo auth fails closed when APP_ENV=production.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SignupPage({
  onAuthSuccess,
  onNavigate,
}: {
  onAuthSuccess: (user: AuthenticatedContext, redirectRoute: string) => void;
  onNavigate: (path: string) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [language, setLanguage] = useState<'en' | 'hi' | 'mr'>('en');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<AuthSuccessPayload>('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ fullName, email, phone, password, language }),
      });
      setStoredToken(res.token);
      onAuthSuccess(res.user, res.redirectRoute);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#03152B] py-12 px-4 sm:px-6 flex items-center justify-center">
      <div className="max-w-md w-full bg-white text-[#10251D] rounded-2xl p-6 sm:p-8 shadow-xl space-y-5">
        <div className="space-y-1.5">
          <KhetPatchLogo light={false} />
          <h1 className="font-display font-extrabold text-2xl pt-2">Register Farmer Account</h1>
          <p className="text-xs text-[#52635C]">
            Public registration creates an isolated Farmer workspace. Elevated roles require an
            organization invitation.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div>
            <label htmlFor="signup-name" className="block text-xs font-semibold mb-1">
              Full Name
            </label>
            <input
              id="signup-name"
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g., Ramesh Kulkarni"
              className="w-full px-3.5 py-2 rounded-lg border border-[#DCE8DC] text-sm"
            />
          </div>

          <div>
            <label htmlFor="signup-email" className="block text-xs font-semibold mb-1">
              Email Address
            </label>
            <input
              id="signup-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ramesh@example.com"
              className="w-full px-3.5 py-2 rounded-lg border border-[#DCE8DC] text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="signup-phone" className="block text-xs font-semibold mb-1">
                Phone (Optional)
              </label>
              <input
                id="signup-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91-98..."
                className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
              />
            </div>
            <div>
              <label htmlFor="signup-lang" className="block text-xs font-semibold mb-1">
                Language
              </label>
              <select
                id="signup-lang"
                value={language}
                onChange={(e) => setLanguage(e.target.value as 'en' | 'hi' | 'mr')}
                className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm bg-white"
              >
                <option value="en">English</option>
                <option value="hi">Hindi</option>
                <option value="mr">Marathi</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="signup-password" className="block text-xs font-semibold mb-1">
              Password (min 8 characters)
            </label>
            <input
              id="signup-password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3.5 py-2 rounded-lg border border-[#DCE8DC] text-sm"
            />
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-lg bg-[#A7F33C] hover:bg-[#C4FF63] text-[#03152B] font-bold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
          >
            <Sprout className="w-4 h-4" />
            {loading ? 'Creating Account...' : 'Create Farmer Workspace'}
          </button>
        </form>

        <div className="pt-3 border-t border-[#DCE8DC] text-xs text-[#52635C] flex items-center justify-between">
          <span>Already registered?</span>
          <button
            type="button"
            onClick={() => onNavigate('/login')}
            className="font-semibold text-[#075A36] hover:underline"
          >
            Sign In →
          </button>
        </div>
      </div>
    </div>
  );
}

export function ForgotPasswordPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [step, setStep] = useState<'request' | 'reset' | 'done'>('request');
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRequestToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        message: string;
        resetToken?: string | null;
        previewResetToken?: string;
        expiresAt?: string;
      }>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setMessage(res.message);
      const tokenValue = res.previewResetToken || res.resetToken;
      if (tokenValue) {
        setPreviewToken(tokenValue);
        setToken(tokenValue);
      }
      setStep('reset');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to request password reset.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword }),
      });
      setMessage(res.message);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#03152B] py-12 px-4 sm:px-6 flex items-center justify-center">
      <div className="max-w-md w-full bg-white text-[#10251D] rounded-2xl p-6 sm:p-8 shadow-xl space-y-5">
        <div className="space-y-1.5">
          <KhetPatchLogo light={false} />
          <h1 className="font-display font-extrabold text-2xl pt-2">Reset Account Password</h1>
          <p className="text-xs text-[#52635C]">
            Request a one-time recovery token and set a new password (minimum 8 characters).
          </p>
        </div>

        {message && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-1">
            <div>{message}</div>
            {previewToken && (
              <div className="font-mono-tabular text-[11px] bg-white border border-emerald-200 rounded p-2 break-all">
                Non-production preview token (SMTP unconfigured): {previewToken}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
            {error}
          </div>
        )}

        {step === 'request' && (
          <form onSubmit={handleRequestToken} className="space-y-4">
            <div>
              <label htmlFor="forgot-email" className="block text-xs font-semibold mb-1">
                Registered Email Address
              </label>
              <input
                id="forgot-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="farmer@example.com"
                className="w-full px-3.5 py-2.5 rounded-lg border border-[#DCE8DC] text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-[#063D2A] hover:bg-[#075A36] text-white font-semibold text-sm disabled:opacity-60"
            >
              {loading ? 'Generating Token...' : 'Request Reset Token'}
            </button>
          </form>
        )}

        {step === 'reset' && (
          <form onSubmit={handleResetPassword} className="space-y-4">
            <div>
              <label htmlFor="reset-token" className="block text-xs font-semibold mb-1">
                Reset Token
              </label>
              <input
                id="reset-token"
                type="text"
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste reset token"
                className="w-full px-3.5 py-2.5 rounded-lg border border-[#DCE8DC] text-sm font-mono-tabular"
              />
            </div>
            <div>
              <label htmlFor="reset-password" className="block text-xs font-semibold mb-1">
                New Password (min 8 characters)
              </label>
              <input
                id="reset-password"
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-lg border border-[#DCE8DC] text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-[#A7F33C] hover:bg-[#C4FF63] text-[#03152B] font-bold text-sm disabled:opacity-60"
            >
              {loading ? 'Updating Password...' : 'Update Password'}
            </button>
          </form>
        )}

        {step === 'done' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#075A36]">
              <CheckCircle2 className="w-4 h-4" /> Your password has been updated.
            </div>
            <button
              type="button"
              onClick={() => onNavigate('/login')}
              className="w-full py-2.5 px-4 rounded-lg bg-[#063D2A] text-white font-semibold text-sm"
            >
              Return to Sign In →
            </button>
          </div>
        )}

        <div className="pt-3 border-t border-[#DCE8DC] text-xs text-[#52635C] flex items-center justify-between">
          <span>Remembered your password?</span>
          <button
            type="button"
            onClick={() => onNavigate('/login')}
            className="font-semibold text-[#075A36] hover:underline"
          >
            Back to Sign In →
          </button>
        </div>
      </div>
    </div>
  );
}

