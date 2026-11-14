import React from 'react';
import { KhetPatchLogo } from './BrandMark';

export function Footer({ onNavigate }: { onNavigate: (path: string) => void }) {
  const link = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    onNavigate(path);
  };

  return (
    <footer className="bg-[#03152B] text-slate-300 border-t border-white/10">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-12 grid grid-cols-1 md:grid-cols-4 gap-8">
        <div className="md:col-span-2 space-y-3">
          <KhetPatchLogo light />
          <p className="text-sm text-slate-300/90 max-w-md leading-relaxed">
            NASA Earth-observation-driven agricultural intelligence &amp; deterministic crop-rotation
            decision support. Built by Team Codex, Sanjivani University, Kopargaon, Maharashtra, India.
          </p>
          <p className="text-xs text-slate-400">
            Scientific Integrity Notice: Satellite observations retain native spatial resolution and
            timestamps. Regional estimates do not replace physical soil laboratory tests or local
            agronomist verification.
          </p>
        </div>

        <div className="space-y-2.5 text-sm">
          <div className="font-display font-semibold text-white">Platform</div>
          <ul className="space-y-1.5 text-slate-400">
            <li>
              <a href="/how-it-works" onClick={(e) => link(e, '/how-it-works')} className="hover:text-[#A7F33C]">
                How It Works
              </a>
            </li>
            <li>
              <a href="/nasa-data" onClick={(e) => link(e, '/nasa-data')} className="hover:text-[#A7F33C]">
                NASA Data &amp; Providers
              </a>
            </li>
            <li>
              <a href="/for-farmers" onClick={(e) => link(e, '/for-farmers')} className="hover:text-[#A7F33C]">
                For Farmers
              </a>
            </li>
            <li>
              <a href="/for-experts" onClick={(e) => link(e, '/for-experts')} className="hover:text-[#A7F33C]">
                For Agronomists &amp; FPOs
              </a>
            </li>
          </ul>
        </div>

        <div className="space-y-2.5 text-sm">
          <div className="font-display font-semibold text-white">Knowledge &amp; Access</div>
          <ul className="space-y-1.5 text-slate-400">
            <li>
              <a href="/resources" onClick={(e) => link(e, '/resources')} className="hover:text-[#A7F33C]">
                Crop Library &amp; FAQs
              </a>
            </li>
            <li>
              <a href="/about" onClick={(e) => link(e, '/about')} className="hover:text-[#A7F33C]">
                Methodology &amp; Trust
              </a>
            </li>
            <li>
              <a href="/login" onClick={(e) => link(e, '/login')} className="hover:text-[#A7F33C]">
                Workspace Log In
              </a>
            </li>
            <li>
              <a href="/signup" onClick={(e) => link(e, '/signup')} className="hover:text-[#A7F33C]">
                Register Farmer Account
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/10 py-4 px-4 sm:px-6 text-xs text-slate-400 max-w-[1280px] mx-auto flex flex-col sm:flex-row justify-between gap-2">
        <span>© {new Date().getUTCFullYear()} KhetPatch · NASA Space Apps Challenge · Team Codex</span>
        <span>Observe · Understand · Recommend · Act · Follow Up · Improve</span>
      </div>
    </footer>
  );
}
