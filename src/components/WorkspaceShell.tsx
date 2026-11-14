import React, { useEffect, useState } from 'react';
import { Bell, Check, Home, LogOut, Menu, RefreshCw, X } from 'lucide-react';
import { KhetPatchLogo } from './BrandMark';
import { ROLE_META, type AppRole } from '../../shared/types';
import { apiFetch } from '../lib/api';
import type { AuthenticatedContext } from '../../server/auth/authService';

export interface WorkspaceNavItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface WorkspaceShellProps {
  user: AuthenticatedContext;
  navItems: WorkspaceNavItem[];
  activeTab: string;
  onSelectTab: (id: string) => void;
  onSwitchRole: (role: AppRole) => Promise<void>;
  onNavigateHome: () => void;
  onLogout: () => void;
  lang?: 'en' | 'hi' | 'mr';
  onChangeLang?: (lang: 'en' | 'hi' | 'mr') => void;
  children: React.ReactNode;
}

interface NotificationRow {
  id: string;
  title: string;
  message: string;
  priority: string;
  category: string;
  read_flag: number;
  created_at: string;
}

export function WorkspaceShell({
  user,
  navItems,
  activeTab,
  onSelectTab,
  onSwitchRole,
  onNavigateHome,
  onLogout,
  lang = 'en',
  onChangeLang,
  children,
}: WorkspaceShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [switching, setSwitching] = useState(false);

  const meta = ROLE_META[user.activeRole];

  const loadNotifications = () => {
    apiFetch<{ notifications: NotificationRow[] }>('/notifications')
      .then((res) => setNotifications(res.notifications))
      .catch(() => {});
  };

  useEffect(() => {
    loadNotifications();
  }, [user.activeRole]);

  const unreadCount = notifications.filter((n) => n.read_flag === 0).length;

  const markRead = async (id: string) => {
    await apiFetch(`/notifications/${id}/read`, { method: 'POST' });
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read_flag: 1 } : n)));
  };

  const markAllRead = async () => {
    await apiFetch('/notifications/read-all', { method: 'POST' });
    setNotifications((prev) => prev.map((n) => ({ ...n, read_flag: 1 })));
  };

  const handleRoleChange = async (role: AppRole) => {
    if (role === user.activeRole) return;
    setSwitching(true);
    try {
      await onSwitchRole(role);
    } finally {
      setSwitching(false);
    }
  };

  const roleAccent =
    user.activeRole === 'FARMER'
      ? 'bg-[#063D2A] text-[#A7F33C]'
      : user.activeRole === 'AGRONOMIST'
      ? 'bg-[#071E38] text-[#27D7ED]'
      : user.activeRole === 'FPO_MANAGER'
      ? 'bg-[#0B2A48] text-amber-300'
      : user.activeRole === 'ORGANIZATION_ADMIN'
      ? 'bg-slate-900 text-emerald-300'
      : 'bg-[#03152B] text-[#6BEAFF]';

  return (
    <div className="min-h-screen flex bg-[#F8FBF6] text-[#10251D]">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 flex-col bg-[#03152B] text-white border-r border-white/10 shrink-0">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <button type="button" onClick={onNavigateHome} className="text-left">
            <KhetPatchLogo light />
          </button>
        </div>

        <div className="p-3.5 border-b border-white/10 space-y-1.5">
          <div className="text-[11px] font-mono-tabular text-slate-400">{meta.layoutName}</div>
          <div className={`inline-block text-xs font-bold px-2.5 py-1 rounded-md ${roleAccent}`}>
            {meta.label}
          </div>
          {user.isDemoUser && (
            <div className="text-[11px] text-amber-300">Shared Demo Identity</div>
          )}
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="Workspace navigation">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
                  active
                    ? 'bg-[#063D2A] text-[#A7F33C] border border-[#45B83A]/40'
                    : 'text-slate-200 hover:bg-white/5'
                }`}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-white/10 space-y-2">
          <button
            type="button"
            onClick={onNavigateHome}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-300 hover:bg-white/5"
          >
            <Home className="w-4 h-4" /> Public Site
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-red-300 hover:bg-red-500/10"
          >
            <LogOut className="w-4 h-4" /> Log Out
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 bg-white border-b border-[#DCE8DC] px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open workspace menu"
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 rounded-lg hover:bg-slate-100"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="truncate">
              <span className="text-xs text-[#52635C]">KhetPatch / </span>
              <span className="text-sm font-display font-bold text-[#10251D]">{meta.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {onChangeLang && (
              <select
                aria-label="Workspace Language"
                value={lang}
                onChange={(e) => onChangeLang(e.target.value as 'en' | 'hi' | 'mr')}
                className="px-2 py-1.5 text-xs font-semibold rounded-lg border border-[#DCE8DC] bg-[#F8FBF6] text-[#10251D]"
              >
                <option value="en">EN</option>
                <option value="hi">HI</option>
                <option value="mr">MR</option>
              </select>
            )}

            {user.availableRoles.length > 1 && (
              <div className="flex items-center gap-1.5">
                <label htmlFor="workspace-role-switcher" className="sr-only">
                  Switch Role Workspace
                </label>
                <select
                  id="workspace-role-switcher"
                  disabled={switching}
                  value={user.activeRole}
                  onChange={(e) => handleRoleChange(e.target.value as AppRole)}
                  className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-[#DCE8DC] bg-[#F8FBF6] text-[#10251D] cursor-pointer"
                >
                  {user.availableRoles.map((r) => (
                    <option key={r.role} value={r.role}>
                      {ROLE_META[r.role].label}
                    </option>
                  ))}
                </select>
                {switching && <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#075A36]" />}
              </div>
            )}

            <button
              type="button"
              aria-label={`Notifications (${unreadCount} unread)`}
              onClick={() => {
                loadNotifications();
                setNotifOpen(!notifOpen);
              }}
              className="relative p-2 rounded-lg border border-[#DCE8DC] hover:bg-[#F8FBF6]"
            >
              <Bell className="w-4 h-4 text-[#10251D]" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#075A36] text-white text-[10px] font-bold flex items-center justify-center">
                  {unreadCount}
                </span>
              )}
            </button>

            <span className="hidden sm:inline text-xs font-medium text-[#52635C] truncate max-w-[160px]">
              {user.fullName}
            </span>
          </div>
        </header>

        {/* Notifications Drawer */}
        {notifOpen && (
          <div className="bg-white border-b border-[#DCE8DC] px-4 sm:px-6 py-4 space-y-2 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#075A36]">
                Notifications ({notifications.length})
              </h3>
              <div className="flex items-center gap-3">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    className="text-xs font-semibold text-[#075A36] hover:underline"
                  >
                    Mark all read
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setNotifOpen(false)}
                  className="text-xs text-[#52635C] hover:underline"
                >
                  Close
                </button>
              </div>
            </div>
            {notifications.length === 0 ? (
              <p className="text-xs text-[#52635C]">No notifications recorded.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-60 overflow-y-auto">
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    className={`p-3 rounded-lg border text-xs flex items-start justify-between gap-2 ${
                      n.read_flag ? 'bg-[#F8FBF6] border-[#DCE8DC]' : 'bg-emerald-50/60 border-emerald-200'
                    }`}
                  >
                    <div>
                      <div className="font-semibold text-[#10251D]">{n.title}</div>
                      <p className="text-[#52635C] mt-0.5">{n.message}</p>
                      <div className="text-[10px] font-mono-tabular text-[#52635C] mt-1">
                        {n.created_at.slice(0, 16)} · {n.category}
                      </div>
                    </div>
                    {!n.read_flag && (
                      <button
                        type="button"
                        aria-label={`Mark notification ${n.title} read`}
                        onClick={() => markRead(n.id)}
                        className="p-1 rounded hover:bg-emerald-100 text-[#075A36] shrink-0"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Mobile Drawer */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 lg:hidden flex">
            <div className="w-64 bg-[#03152B] text-white p-4 flex flex-col justify-between">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <KhetPatchLogo light />
                  <button type="button" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <nav className="space-y-1">
                  {navItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onSelectTab(item.id);
                        setSidebarOpen(false);
                      }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium ${
                        activeTab === item.id ? 'bg-[#063D2A] text-[#A7F33C]' : 'text-slate-200'
                      }`}
                    >
                      <item.icon className="w-4 h-4" />
                      {item.label}
                    </button>
                  ))}
                </nav>
              </div>
              <button
                type="button"
                onClick={onLogout}
                className="flex items-center gap-2 px-3 py-2 text-xs text-red-300"
              >
                <LogOut className="w-4 h-4" /> Log Out
              </button>
            </div>
            <div className="flex-1 bg-black/50" onClick={() => setSidebarOpen(false)} />
          </div>
        )}

        <main className="flex-1 p-4 sm:p-6 max-w-[1360px] w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
