import React, { useState } from 'react';
import { ArrowRight, Globe, LogOut, Menu, X } from 'lucide-react';
import { KhetPatchLogo } from './BrandMark';
import { t, type SupportedLang } from '../i18n/translations';
import { ROLE_WORKSPACES, type AppRole } from '../../shared/types';

export interface NavUser {
  fullName: string;
  activeRole: AppRole;
}

interface NavbarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  lang: SupportedLang;
  onChangeLang: (lang: SupportedLang) => void;
  user: NavUser | null;
  onLogout: () => void;
}

export function Navbar({
  currentPath,
  onNavigate,
  lang,
  onChangeLang,
  user,
  onLogout,
}: NavbarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = [
    { path: '/', label: t(lang, 'nav.home') },
    { path: '/how-it-works', label: t(lang, 'nav.howItWorks') },
    { path: '/nasa-data', label: t(lang, 'nav.nasaData') },
    { path: '/for-farmers', label: t(lang, 'nav.forFarmers') },
    { path: '/for-experts', label: t(lang, 'nav.forExperts') },
    { path: '/resources', label: t(lang, 'nav.resources') },
    { path: '/about', label: t(lang, 'nav.about') },
  ];

  const handleLink = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    setMobileOpen(false);
    onNavigate(path);
  };

  return (
    <header className="sticky top-0 z-50 bg-[#03152B]/95 backdrop-blur-md border-b border-white/10">
      <div className="max-w-[1480px] mx-auto px-5 sm:px-8 h-16 flex items-center justify-between gap-4">
        <a
          href="/"
          onClick={(e) => handleLink(e, '/')}
          className="focus-visible:outline-2 focus-visible:outline-[#A7F33C] rounded-md"
        >
          <KhetPatchLogo light />
        </a>

        <nav
          aria-label="Primary navigation"
          className="hidden lg:flex items-center gap-2 text-[13.5px] font-medium"
        >
          {navItems.map((item) => {
            const active = currentPath === item.path;
            return (
              <a
                key={item.path}
                href={item.path}
                onClick={(e) => handleLink(e, item.path)}
                className={`px-4 py-1.5 rounded-xl transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-[#093B2A] text-white border border-[#2C7E4B]/55 shadow-inner'
                    : 'text-slate-200 hover:text-white hover:bg-white/5'
                }`}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="hidden md:flex items-center gap-3 shrink-0">
          <label className="sr-only" htmlFor="lang-select">
            Select language
          </label>
          <div className="relative flex items-center">
            <Globe className="w-4 h-4 text-slate-200 absolute left-2 pointer-events-none" />
            <select
              id="lang-select"
              value={lang}
              onChange={(e) => onChangeLang(e.target.value as SupportedLang)}
              className="pl-7 pr-2.5 py-1.5 text-xs font-semibold text-white bg-transparent hover:bg-white/10 rounded-full focus-visible:outline-2 focus-visible:outline-[#A7F33C] cursor-pointer"
            >
              <option value="en" className="bg-[#071E38] text-white">EN</option>
              <option value="hi" className="bg-[#071E38] text-white">HI</option>
              <option value="mr" className="bg-[#071E38] text-white">MR</option>
            </select>
          </div>

          {user ? (
            <>
              <button
                type="button"
                onClick={() => onNavigate(ROLE_WORKSPACES[user.activeRole])}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold text-[#03152B] bg-gradient-to-r from-[#A8F83C] to-[#7BE129] hover:brightness-105 rounded-full transition-all whitespace-nowrap shrink-0"
              >
                Workspace <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={onLogout}
                aria-label="Log Out"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 border border-white/25 hover:bg-white/10 rounded-full transition-colors whitespace-nowrap shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <>
              <a
                href="/login"
                onClick={(e) => handleLink(e, '/login')}
                className="px-5 py-1.5 text-[13px] font-semibold text-white border border-white/35 hover:border-white/60 hover:bg-white/10 rounded-full transition-colors whitespace-nowrap shrink-0"
              >
                {t(lang, 'nav.login')}
              </a>
              <a
                href="/signup"
                onClick={(e) => handleLink(e, '/signup')}
                className="inline-flex items-center gap-1.5 px-5 py-1.5 text-[13px] font-bold text-[#03152B] bg-gradient-to-r from-[#A8F83C] to-[#7CE029] hover:brightness-105 rounded-full shadow-[0_0_18px_rgba(167,243,60,0.3)] transition-all whitespace-nowrap shrink-0"
              >
                {t(lang, 'nav.getStarted')} <ArrowRight className="w-3.5 h-3.5" />
              </a>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          className="lg:hidden p-2 rounded-lg text-white hover:bg-white/10"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="lg:hidden bg-[#071E38] border-t border-white/10 px-4 py-4 space-y-2">
          {navItems.map((item) => (
            <a
              key={item.path}
              href={item.path}
              onClick={(e) => handleLink(e, item.path)}
              className={`block px-3 py-2.5 rounded-lg text-sm font-medium ${
                currentPath === item.path
                  ? 'bg-[#063D2A] text-[#A7F33C]'
                  : 'text-slate-200 hover:bg-white/5'
              }`}
            >
              {item.label}
            </a>
          ))}
          <div className="pt-3 border-t border-white/10 flex flex-wrap items-center gap-2">
            <select
              aria-label="Language"
              value={lang}
              onChange={(e) => onChangeLang(e.target.value as SupportedLang)}
              className="px-3 py-2 text-xs font-medium text-white bg-white/10 rounded-lg border border-white/15"
            >
              <option value="en" className="bg-[#071E38]">English (EN)</option>
              <option value="hi" className="bg-[#071E38]">हिन्दी (HI)</option>
              <option value="mr" className="bg-[#071E38]">मराठी (MR)</option>
            </select>
            {user ? (
              <button
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                  onNavigate(ROLE_WORKSPACES[user.activeRole]);
                }}
                className="flex-1 px-4 py-2 text-xs font-bold text-[#03152B] bg-[#A7F33C] rounded-lg"
              >
                Open Workspace
              </button>
            ) : (
              <>
                <a
                  href="/login"
                  onClick={(e) => handleLink(e, '/login')}
                  className="px-4 py-2 text-xs font-semibold text-white border border-white/25 rounded-lg"
                >
                  {t(lang, 'nav.login')}
                </a>
                <a
                  href="/signup"
                  onClick={(e) => handleLink(e, '/signup')}
                  className="flex-1 text-center px-4 py-2 text-xs font-bold text-[#03152B] bg-[#A7F33C] rounded-lg"
                >
                  {t(lang, 'nav.getStarted')}
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
