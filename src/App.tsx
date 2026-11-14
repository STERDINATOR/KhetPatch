import React, { useEffect, useState } from 'react';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { HomePage } from './pages/public/HomePage';
import {
  AboutPage,
  ForExpertsPage,
  ForFarmersPage,
  HowItWorksPage,
  NasaDataPage,
  ResourcesPage,
} from './pages/public/PublicSubpages';
import { ForgotPasswordPage, LoginPage, SignupPage } from './pages/auth/AuthPages';
import { FarmerWorkspace } from './pages/workspaces/FarmerWorkspace';
import {
  AgronomistWorkspace,
  FpoManagerWorkspace,
  OrgAdminWorkspace,
  PlatformAdminWorkspace,
} from './pages/workspaces/EnterpriseWorkspaces';
import { apiFetch, setStoredToken } from './lib/api';
import { signOutFirebase } from './lib/firebase';
import type { SupportedLang } from './i18n/translations';
import { ROLE_WORKSPACES, type AppRole } from '../shared/types';
import type { AuthenticatedContext } from '../server/auth/authService';

import { LocationProvider } from './context/LocationContext';

function AppRoutes() {
  const [path, setPath] = useState<string>(() => window.location.pathname || '/');
  const [lang, setLang] = useState<SupportedLang>('en');
  const [user, setUser] = useState<AuthenticatedContext | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState(false);

  const navigate = (nextPath: string) => {
    if (nextPath !== window.location.pathname) {
      window.history.pushState({}, '', nextPath);
    }
    setPath(nextPath);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || '/');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const onQuotaExceeded = () => setMapsQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuotaExceeded);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuotaExceeded);
  }, []);

  const quotaBanner = mapsQuotaExceeded ? (
    <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
      <span>
        Google Maps Platform quota reached. If you are the app owner, visit{' '}
        <a
          href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
          target="_blank"
          rel="noopener noreferrer"
          className="underline font-semibold text-amber-950 hover:text-amber-800"
        >
          maps developer site
        </a>{' '}
        for instructions to update your account.
      </span>
    </div>
  ) : null;

  const refreshMe = async () => {
    try {
      const res = await apiFetch<{ authenticated: boolean; user: AuthenticatedContext | null }>('/auth/session');
      setUser(res.user);
    } catch {
      setUser(null);
    } finally {
      setAuthChecked(true);
    }
  };

  useEffect(() => {
    refreshMe();
  }, []);

  const handleLogout = async () => {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {});
    await signOutFirebase();
    setStoredToken(null);
    setUser(null);
    navigate('/');
  };

  const handleSwitchRole = async (role: AppRole) => {
    const res = await apiFetch<{ redirectRoute: string }>('/auth/switch-workspace', {
      method: 'POST',
      body: JSON.stringify({ role }),
    });
    await refreshMe();
    navigate(res.redirectRoute);
  };

  const isWorkspaceRoute =
    path.startsWith('/farmer') ||
    path.startsWith('/workspace') ||
    path.startsWith('/organization') ||
    path.startsWith('/platform');

  let content: React.ReactNode;

  if (isWorkspaceRoute) {
    if (!authChecked) {
      content = (
        <div className="min-h-screen flex items-center justify-center bg-[#03152B] text-white text-sm">
          Verifying workspace session...
        </div>
      );
    } else if (!user) {
      content = (
        <>
          <Navbar
            currentPath="/login"
            onNavigate={navigate}
            lang={lang}
            onChangeLang={setLang}
            user={null}
            onLogout={handleLogout}
          />
          <LoginPage
            onAuthSuccess={(u, route) => {
              setUser(u);
              navigate(route);
            }}
            onNavigate={navigate}
          />
        </>
      );
    } else {
      const expectedRoute = ROLE_WORKSPACES[user.activeRole];
      if (path !== expectedRoute) {
        window.history.replaceState({}, '', expectedRoute);
      }

      if (user.activeRole === 'FARMER') {
        content = (
          <>
            {quotaBanner}
            <FarmerWorkspace
              user={user}
              lang={lang}
              onChangeLang={setLang}
              onSwitchRole={handleSwitchRole}
              onNavigateHome={() => navigate('/')}
              onLogout={handleLogout}
            />
          </>
        );
      } else if (user.activeRole === 'AGRONOMIST') {
        content = (
          <>
            {quotaBanner}
            <AgronomistWorkspace
              user={user}
              lang={lang}
              onChangeLang={setLang}
              onSwitchRole={handleSwitchRole}
              onNavigateHome={() => navigate('/')}
              onLogout={handleLogout}
            />
          </>
        );
      } else if (user.activeRole === 'FPO_MANAGER') {
        content = (
          <>
            {quotaBanner}
            <FpoManagerWorkspace
              user={user}
              lang={lang}
              onChangeLang={setLang}
              onSwitchRole={handleSwitchRole}
              onNavigateHome={() => navigate('/')}
              onLogout={handleLogout}
            />
          </>
        );
      } else if (user.activeRole === 'ORGANIZATION_ADMIN') {
        content = (
          <>
            {quotaBanner}
            <OrgAdminWorkspace
              user={user}
              lang={lang}
              onChangeLang={setLang}
              onSwitchRole={handleSwitchRole}
              onNavigateHome={() => navigate('/')}
              onLogout={handleLogout}
            />
          </>
        );
      } else {
        content = (
          <>
            {quotaBanner}
            <PlatformAdminWorkspace
              user={user}
              lang={lang}
              onChangeLang={setLang}
              onSwitchRole={handleSwitchRole}
              onNavigateHome={() => navigate('/')}
              onLogout={handleLogout}
            />
          </>
        );
      }
    }
  } else {
    content = (
      <div className="min-h-screen flex flex-col bg-[#F8FBF6]">
        {quotaBanner}
        <Navbar
          currentPath={path}
          onNavigate={navigate}
          lang={lang}
          onChangeLang={setLang}
          user={user ? { fullName: user.fullName, activeRole: user.activeRole } : null}
          onLogout={handleLogout}
        />

        <main className="flex-1">
          {path === '/' && <HomePage lang={lang} onNavigate={navigate} />}
          {path === '/how-it-works' && <HowItWorksPage onNavigate={navigate} />}
          {path === '/nasa-data' && <NasaDataPage />}
          {path === '/for-farmers' && <ForFarmersPage onNavigate={navigate} />}
          {path === '/for-experts' && <ForExpertsPage onNavigate={navigate} />}
          {path === '/resources' && <ResourcesPage />}
          {path === '/about' && <AboutPage />}
          {path === '/login' && (
            <LoginPage
              onAuthSuccess={(u, route) => {
                setUser(u);
                navigate(route);
              }}
              onNavigate={navigate}
            />
          )}
          {path === '/signup' && (
            <SignupPage
              onAuthSuccess={(u, route) => {
                setUser(u);
                navigate(route);
              }}
              onNavigate={navigate}
            />
          )}
          {path === '/forgot-password' && <ForgotPasswordPage onNavigate={navigate} />}
          {![
            '/',
            '/how-it-works',
            '/nasa-data',
            '/for-farmers',
            '/for-experts',
            '/resources',
            '/about',
            '/login',
            '/signup',
            '/forgot-password',
          ].includes(path) && <HomePage lang={lang} onNavigate={navigate} />}
        </main>

        <Footer onNavigate={navigate} />
      </div>
    );
  }

  return (
    <LocationProvider authenticatedUser={user} authChecked={authChecked}>
      {content}
    </LocationProvider>
  );
}

export default function App() {
  return <AppRoutes />;
}
