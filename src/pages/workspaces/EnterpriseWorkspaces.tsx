import React, { useEffect, useState } from 'react';
import {
  Activity,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Database,
  Download,
  FileText,
  RefreshCw,
  Satellite,
  Server,
  ShieldAlert,
  UserPlus,
  Users,
} from 'lucide-react';
import { WorkspaceShell, type WorkspaceNavItem } from '../../components/WorkspaceShell';
import { apiFetch } from '../../lib/api';
import type { AuthenticatedContext } from '../../../server/auth/authService';
import type { AppRole, CropCatalogueItem } from '../../../shared/types';

// ============================================================================
// 1. AGRONOMIST WORKSPACE (/workspace/dashboard — EnterpriseLayout)
// ============================================================================
export function AgronomistWorkspace({
  user,
  lang = 'en',
  onChangeLang,
  onSwitchRole,
  onNavigateHome,
  onLogout,
}: {
  user: AuthenticatedContext;
  lang?: 'en' | 'hi' | 'mr';
  onChangeLang?: (lang: 'en' | 'hi' | 'mr') => void;
  onSwitchRole: (role: AppRole) => Promise<void>;
  onNavigateHome: () => void;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState('reviews');
  const [data, setData] = useState<{
    plans: Array<Record<string, unknown>>;
    farms: Array<Record<string, unknown>>;
    crops: CropCatalogueItem[];
    providers: Array<Record<string, unknown>>;
  } | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [inspectingPlan, setInspectingPlan] = useState<Record<string, unknown> | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceData, setEvidenceData] = useState<{
    details: Record<string, unknown>;
    observations: { metrics?: Array<Record<string, unknown>> };
  } | null>(null);

  const load = () => {
    apiFetch<typeof data>('/agronomist/overview').then(setData).catch(() => {});
  };
  useEffect(() => {
    load();
  }, []);

  const inspectEvidence = async (plan: Record<string, unknown>) => {
    setInspectingPlan(plan);
    setEvidenceLoading(true);
    setEvidenceData(null);
    try {
      const [details, observations] = await Promise.all([
        apiFetch<Record<string, unknown>>(`/fields/${String(plan.field_id)}/details`),
        apiFetch<{ metrics?: Array<Record<string, unknown>> }>(
          `/nasa/observations?farmId=${String(plan.farm_id)}&fieldId=${String(plan.field_id)}`
        ),
      ]);
      setEvidenceData({ details, observations });
    } catch {
      setBanner('Unable to load field evidence details.');
    } finally {
      setEvidenceLoading(false);
    }
  };

  const submitReview = async (planId: string, decision: 'APPROVED' | 'REJECTED' | 'NEEDS_MORE_INFO') => {
    const notes = reviewNotes[planId] || `Agronomist ${decision.toLowerCase()} after inspecting field evidence.`;
    await apiFetch(`/expert-reviews/${planId}`, {
      method: 'POST',
      body: JSON.stringify({ decision, notes }),
    });
    setBanner(`Expert review (${decision}) recorded and farmer notified.`);
    load();
  };

  const navItems: WorkspaceNavItem[] = [
    { id: 'reviews', label: 'Expert Reviews', icon: ClipboardCheck },
    { id: 'farms', label: 'Advisory Farms', icon: Users },
    { id: 'rules', label: 'Crop Knowledge', icon: BookOpen },
  ];

  return (
    <WorkspaceShell
      user={user}
      lang={lang}
      onChangeLang={onChangeLang}
      navItems={navItems}
      activeTab={tab}
      onSelectTab={setTab}
      onSwitchRole={onSwitchRole}
      onNavigateHome={onNavigateHome}
      onLogout={onLogout}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-5 rounded-2xl border border-[#DCE8DC]">
          <div>
            <h1 className="font-display font-extrabold text-xl">Agronomist Advisory Console</h1>
            <p className="text-xs text-[#52635C]">
              Inspect field plans, verify environmental evidence, and validate regional crop rules.
            </p>
          </div>
          <a
            href="/api/v1/reports/csv"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
          >
            <Download className="w-3.5 h-3.5" /> Export Advisory CSV
          </a>
        </div>

        {banner && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
            {banner}
          </div>
        )}

        {tab === 'reviews' && (
          <div className="space-y-3">
            {(data?.plans || []).length === 0 ? (
              <div className="p-8 bg-white rounded-2xl border border-[#DCE8DC] text-sm text-[#52635C]">
                No rotation plans submitted yet. Run a rotation analysis in the Farmer Workspace to review it here.
              </div>
            ) : (
              data!.plans.map((p) => (
                <div key={String(p.id)} className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-xs text-[#52635C]">
                        {String(p.farmer_name)} · {String(p.farm_name)} ({String(p.district)}) · {String(p.field_name)}
                      </div>
                      <h2 className="font-display font-bold text-base">
                        {String(p.planning_season)} Rotation — {String(p.selected_crop || 'Draft')} ({String(p.status)})
                      </h2>
                    </div>
                    <span className="text-xs font-bold px-2.5 py-1 rounded bg-[#F8FBF6] border border-[#DCE8DC]">
                      {String(p.expert_review_status)}
                    </span>
                  </div>

                  {Boolean(p.expert_notes) && (
                    <div className="text-xs bg-[#F8FBF6] p-3 rounded-lg border border-[#DCE8DC]">
                      Recorded Note: {String(p.expert_notes)}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => inspectEvidence(p)}
                      className="px-3 py-1.5 rounded-lg border border-[#DCE8DC] bg-[#F8FBF6] hover:bg-[#E9F7E4] text-xs font-semibold text-[#075A36]"
                    >
                      Inspect Evidence &amp; Strategies
                    </button>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      value={reviewNotes[String(p.id)] || ''}
                      onChange={(e) => setReviewNotes({ ...reviewNotes, [String(p.id)]: e.target.value })}
                      placeholder="Enter agronomic review notes..."
                      className="flex-1 px-3 py-2 rounded-lg border border-[#DCE8DC] text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => submitReview(String(p.id), 'APPROVED')}
                      className="px-3.5 py-2 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => submitReview(String(p.id), 'NEEDS_MORE_INFO')}
                      className="px-3.5 py-2 rounded-lg bg-amber-100 text-amber-900 text-xs font-semibold"
                    >
                      Request Data
                    </button>
                    <button
                      type="button"
                      onClick={() => submitReview(String(p.id), 'REJECTED')}
                      className="px-3.5 py-2 rounded-lg bg-red-100 text-red-800 text-xs font-semibold"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {inspectingPlan && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true">
            <div className="bg-white rounded-2xl border border-[#DCE8DC] max-w-3xl w-full p-6 space-y-4 max-h-[88vh] overflow-y-auto shadow-2xl">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-[#075A36]">AGRONOMIST EVIDENCE PACK</div>
                  <h3 className="font-display font-bold text-lg">
                    {String(inspectingPlan.farm_name)} · {String(inspectingPlan.field_name)} ({String(inspectingPlan.planning_season)})
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setInspectingPlan(null)}
                  className="px-3 py-1 rounded-lg border border-[#DCE8DC] text-xs font-semibold"
                >
                  Close
                </button>
              </div>

              {evidenceLoading ? (
                <div className="text-xs text-[#52635C]">Loading field soil tests, history, and NASA observations...</div>
              ) : (
                <div className="space-y-4 text-xs">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-3 rounded-xl bg-[#F8FBF6] border border-[#DCE8DC] space-y-1">
                      <div className="font-bold text-[#075A36]">Latest Soil Test</div>
                      {Array.isArray(evidenceData?.details?.soilTests) && evidenceData.details.soilTests.length > 0 ? (
                        (() => {
                          const st = evidenceData.details.soilTests[0] as Record<string, unknown>;
                          return (
                            <div className="font-mono-tabular">
                              {String(st.source_label)} · pH {String(st.ph ?? '—')} · OC {String(st.organic_carbon_pct ?? '—')}% · N {String(st.nitrogen_kg_ha ?? '—')} kg/ha
                            </div>
                          );
                        })()
                      ) : (
                        <div className="text-amber-800">No lab or farmer soil test recorded.</div>
                      )}
                    </div>
                    <div className="p-3 rounded-xl bg-[#F8FBF6] border border-[#DCE8DC] space-y-1">
                      <div className="font-bold text-[#075A36]">NASA / Weather Snapshot</div>
                      {(evidenceData?.observations?.metrics || []).map((m, idx) => (
                        <div key={idx}>
                          {String(m.label)}: <strong>{m.value !== null ? `${String(m.value)} ${String(m.unit)}` : 'Unavailable'}</strong> ({String(m.freshnessStatus)})
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="font-bold text-[#075A36]">Evaluated 3-Strategy Constraints</div>
                    {(JSON.parse(String(inspectingPlan.strategies_json || '[]')) as Array<Record<string, unknown>>).map((s, idx) => (
                      <div key={idx} className="p-3 rounded-xl border border-[#DCE8DC] space-y-1">
                        <div className="flex justify-between font-bold">
                          <span>{String(s.title)} — {String(s.proposedCrop || 'None')}</span>
                          <span>{s.feasible ? 'FEASIBLE' : 'INFEASIBLE'}</span>
                        </div>
                        <p className="text-[#52635C]">{String(s.rationale || '')}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'farms' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(data?.farms || []).map((f) => (
              <div key={String(f.id)} className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-1.5 text-xs">
                <div className="font-display font-bold text-base">{String(f.name)}</div>
                <div className="text-[#52635C]">Farmer: {String(f.farmer_name)}</div>
                <div>{String(f.village)}, {String(f.district)}, {String(f.state)}</div>
                <div className="text-[#075A36] font-semibold">{String(f.agroclimatic_zone)}</div>
                <div className="font-mono-tabular">Fields: {String(f.field_count)} · Area: {String(f.total_area_acres)} ac</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'rules' && (
          <div className="bg-white rounded-2xl border border-[#DCE8DC] overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F8FBF6] border-b border-[#DCE8DC]">
                <tr>
                  <th className="p-3">Crop</th>
                  <th className="p-3">Family</th>
                  <th className="p-3">Seasons</th>
                  <th className="p-3">Water (mm)</th>
                  <th className="p-3">Cost / Acre</th>
                  <th className="p-3">Verified Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DCE8DC]">
                {(data?.crops || []).map((c) => (
                  <tr key={c.id}>
                    <td className="p-3 font-semibold">{c.name}</td>
                    <td className="p-3">{c.cropFamily}</td>
                    <td className="p-3">{c.suitableSeasons.join(', ')}</td>
                    <td className="p-3 font-mono-tabular">{c.waterNeedMm} mm</td>
                    <td className="p-3 font-mono-tabular">₹{c.estimatedCostPerAcreInr?.toLocaleString('en-IN')}</td>
                    <td className="p-3 text-[#52635C]">{c.sourceReference}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}

// ============================================================================
// 2. FPO MANAGER WORKSPACE (/organization/overview — OrganizationLayout)
// ============================================================================
export function FpoManagerWorkspace({
  user,
  lang = 'en',
  onChangeLang,
  onSwitchRole,
  onNavigateHome,
  onLogout,
}: {
  user: AuthenticatedContext;
  lang?: 'en' | 'hi' | 'mr';
  onChangeLang?: (lang: 'en' | 'hi' | 'mr') => void;
  onSwitchRole: (role: AppRole) => Promise<void>;
  onNavigateHome: () => void;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState<{
    organization: Record<string, unknown>;
    members: Array<Record<string, unknown>>;
    farmSummaries: Array<Record<string, unknown>>;
    plans: Array<Record<string, unknown>>;
  } | null>(null);

  useEffect(() => {
    apiFetch<typeof data>('/organization/overview').then(setData).catch(() => {});
  }, []);

  const navItems: WorkspaceNavItem[] = [
    { id: 'overview', label: 'FPO Overview', icon: Activity },
    { id: 'members', label: 'FPO Members', icon: Users },
    { id: 'plans', label: 'Rotation Plans', icon: FileText },
  ];

  return (
    <WorkspaceShell
      user={user}
      lang={lang}
      onChangeLang={onChangeLang}
      navItems={navItems}
      activeTab={tab}
      onSelectTab={setTab}
      onSwitchRole={onSwitchRole}
      onNavigateHome={onNavigateHome}
      onLogout={onLogout}
    >
      <div className="space-y-5">
        <div className="bg-white p-5 rounded-2xl border border-[#DCE8DC] flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display font-extrabold text-xl">
              {String(data?.organization?.name || 'FPO Operations Overview')}
            </h1>
            <p className="text-xs text-[#52635C]">
              District: {String(data?.organization?.district || '—')}, {String(data?.organization?.state || '—')}
            </p>
          </div>
          <a
            href="/api/v1/reports/csv"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
          >
            <Download className="w-3.5 h-3.5" /> Export FPO Report (CSV)
          </a>
        </div>

        {tab === 'overview' && (
          <div className="bg-white rounded-2xl border border-[#DCE8DC] overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F8FBF6] border-b border-[#DCE8DC]">
                <tr>
                  <th className="p-3">Farm</th>
                  <th className="p-3">Farmer</th>
                  <th className="p-3">Location</th>
                  <th className="p-3">Area (ac)</th>
                  <th className="p-3">Fields</th>
                  <th className="p-3">Tasks Done / Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DCE8DC]">
                {(data?.farmSummaries || []).map((f) => (
                  <tr key={String(f.id)}>
                    <td className="p-3 font-semibold">{String(f.name)}</td>
                    <td className="p-3">{String(f.farmer_name)}</td>
                    <td className="p-3">{String(f.village)}, {String(f.district)}</td>
                    <td className="p-3 font-mono-tabular">{String(f.total_area_acres)}</td>
                    <td className="p-3 font-mono-tabular">{String(f.fields_count)}</td>
                    <td className="p-3 font-mono-tabular">{String(f.completed_tasks)} / {String(f.open_tasks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'members' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(data?.members || []).map((m, idx) => (
              <div key={idx} className="bg-white p-4 rounded-xl border border-[#DCE8DC] text-xs flex justify-between">
                <div>
                  <div className="font-bold text-sm">{String(m.full_name)}</div>
                  <div className="text-[#52635C]">{String(m.email)}</div>
                </div>
                <span className="font-semibold text-[#075A36]">{String(m.role)}</span>
              </div>
            ))}
          </div>
        )}

        {tab === 'plans' && (
          <div className="space-y-3">
            {(data?.plans || []).map((p) => (
              <div key={String(p.id)} className="bg-white p-4 rounded-xl border border-[#DCE8DC] text-xs flex justify-between">
                <div>
                  <div className="font-bold">{String(p.farm_name)} · {String(p.field_name)}</div>
                  <div className="text-[#52635C]">{String(p.planning_season)} — {String(p.selected_crop || 'Draft')}</div>
                </div>
                <div className="font-semibold">{String(p.status)} ({String(p.expert_review_status)})</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}

// ============================================================================
// 3. ORGANIZATION ADMIN WORKSPACE (/organization/admin — OrganizationAdminLayout)
// ============================================================================
export function OrgAdminWorkspace({
  user,
  lang = 'en',
  onChangeLang,
  onSwitchRole,
  onNavigateHome,
  onLogout,
}: {
  user: AuthenticatedContext;
  lang?: 'en' | 'hi' | 'mr';
  onChangeLang?: (lang: 'en' | 'hi' | 'mr') => void;
  onSwitchRole: (role: AppRole) => Promise<void>;
  onNavigateHome: () => void;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState('users');
  const [data, setData] = useState<{
    organization: Record<string, unknown>;
    members: Array<Record<string, unknown>>;
    invitations: Array<Record<string, unknown>>;
    auditLogs: Array<Record<string, unknown>>;
  } | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'FARMER' | 'AGRONOMIST' | 'FPO_MANAGER'>('AGRONOMIST');
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    apiFetch<typeof data>('/organization/admin').then(setData).catch(() => {});
  };
  useEffect(() => {
    load();
  }, []);

  const sendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/organization/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    setInviteEmail('');
    setMsg('Organization invitation created and logged.');
    load();
  };

  const toggleUserStatus = async (userId: string, currentStatus: string) => {
    const next = currentStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    await apiFetch(`/organization/users/${userId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: next }),
    });
    setMsg(`User status updated to ${next}.`);
    load();
  };

  const navItems: WorkspaceNavItem[] = [
    { id: 'users', label: 'Users & Roles', icon: Users },
    { id: 'invites', label: 'Invitations', icon: UserPlus },
    { id: 'audit', label: 'Audit History', icon: ShieldAlert },
  ];

  return (
    <WorkspaceShell
      user={user}
      lang={lang}
      onChangeLang={onChangeLang}
      navItems={navItems}
      activeTab={tab}
      onSelectTab={setTab}
      onSwitchRole={onSwitchRole}
      onNavigateHome={onNavigateHome}
      onLogout={onLogout}
    >
      <div className="space-y-5">
        <div className="bg-white p-5 rounded-2xl border border-[#DCE8DC]">
          <h1 className="font-display font-extrabold text-xl">Organization Administration</h1>
          <p className="text-xs text-[#52635C]">
            Scoped to {String(data?.organization?.name || 'Organization')}. Organization admins
            cannot elevate accounts to Platform Admin.
          </p>
        </div>

        {msg && <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs">{msg}</div>}

        {tab === 'users' && (
          <div className="bg-white rounded-2xl border border-[#DCE8DC] overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F8FBF6] border-b border-[#DCE8DC]">
                <tr>
                  <th className="p-3">User</th>
                  <th className="p-3">Email</th>
                  <th className="p-3">Role</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DCE8DC]">
                {(data?.members || []).map((m) => (
                  <tr key={String(m.role_assignment_id)}>
                    <td className="p-3 font-semibold">{String(m.full_name)}</td>
                    <td className="p-3">{String(m.email)}</td>
                    <td className="p-3 font-mono-tabular">{String(m.role)}</td>
                    <td className="p-3">{String(m.status)}</td>
                    <td className="p-3">
                      {String(m.user_id) !== user.userId && (
                        <button
                          type="button"
                          onClick={() => toggleUserStatus(String(m.user_id), String(m.status))}
                          className="text-[#075A36] font-semibold hover:underline"
                        >
                          {String(m.status) === 'ACTIVE' ? 'Suspend' : 'Activate'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'invites' && (
          <div className="space-y-4 max-w-xl">
            <form onSubmit={sendInvite} className="bg-white p-5 rounded-2xl border border-[#DCE8DC] flex flex-wrap gap-2 text-xs">
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="agronomist@fpo.org"
                className="flex-1 px-3 py-2 rounded-lg border border-[#DCE8DC]"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'FARMER' | 'AGRONOMIST' | 'FPO_MANAGER')}
                className="px-3 py-2 rounded-lg border border-[#DCE8DC] bg-white"
              >
                <option value="AGRONOMIST">AGRONOMIST</option>
                <option value="FPO_MANAGER">FPO_MANAGER</option>
                <option value="FARMER">FARMER</option>
              </select>
              <button type="submit" className="px-4 py-2 rounded-lg bg-[#063D2A] text-white font-semibold">
                Send Invite
              </button>
            </form>

            <div className="space-y-2">
              {(data?.invitations || []).map((inv) => (
                <div key={String(inv.id)} className="bg-white p-3 rounded-xl border border-[#DCE8DC] text-xs flex justify-between">
                  <span>{String(inv.email)} · {String(inv.role)}</span>
                  <span className="font-mono-tabular">{String(inv.status)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'audit' && (
          <div className="bg-white rounded-2xl border border-[#DCE8DC] p-4 space-y-2">
            {(data?.auditLogs || []).map((a) => (
              <div key={String(a.id)} className="text-xs border-b border-[#DCE8DC] pb-2 flex justify-between">
                <span><strong>{String(a.action)}</strong> ({String(a.resource_type)})</span>
                <span className="font-mono-tabular text-[#52635C]">{String(a.created_at).slice(0, 19)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}

// ============================================================================
// 4. PLATFORM ADMIN WORKSPACE (/platform/admin — PlatformAdminLayout)
// ============================================================================
export function PlatformAdminWorkspace({
  user,
  lang = 'en',
  onChangeLang,
  onSwitchRole,
  onNavigateHome,
  onLogout,
}: {
  user: AuthenticatedContext;
  lang?: 'en' | 'hi' | 'mr';
  onChangeLang?: (lang: 'en' | 'hi' | 'mr') => void;
  onSwitchRole: (role: AppRole) => Promise<void>;
  onNavigateHome: () => void;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState('health');
  const [data, setData] = useState<{
    counts: Record<string, number>;
    providers: Array<Record<string, unknown>>;
    ingestionRuns: Array<Record<string, unknown>>;
    auditLogs: Array<Record<string, unknown>>;
    envStatus: Record<string, unknown>;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [testingSourceId, setTestingSourceId] = useState<string | null>(null);
  const [providerTests, setProviderTests] = useState<
    Record<string, { verificationLabel: string; httpStatus: number | null; checkedAt: string; detail: string }>
  >({});

  const load = () => {
    apiFetch<typeof data>('/platform/admin').then(setData).catch(() => {});
  };
  useEffect(() => {
    load();
  }, []);

  const triggerPipeline = async () => {
    setRunning(true);
    try {
      await apiFetch('/nasa/ingestion/run', { method: 'POST', body: JSON.stringify({ lat: 19.8825, lon: 74.4789 }) });
      load();
    } finally {
      setRunning(false);
    }
  };

  const testProvider = async (sourceId: string) => {
    setTestingSourceId(sourceId);
    try {
      const res = await apiFetch<{
        verificationLabel: string;
        httpStatus: number | null;
        checkedAt: string;
        detail: string;
      }>(`/platform/providers/${sourceId}/test`, {
        method: 'POST',
        body: JSON.stringify({ lat: 19.8825, lon: 74.4789 }),
      });
      setProviderTests((prev) => ({ ...prev, [sourceId]: res }));
      load();
    } finally {
      setTestingSourceId(null);
    }
  };

  const navItems: WorkspaceNavItem[] = [
    { id: 'health', label: 'Provider Health', icon: Satellite },
    { id: 'jobs', label: 'Ingestion Jobs', icon: Server },
    { id: 'audit', label: 'System Audit', icon: Database },
  ];

  return (
    <WorkspaceShell
      user={user}
      lang={lang}
      onChangeLang={onChangeLang}
      navItems={navItems}
      activeTab={tab}
      onSelectTab={setTab}
      onSwitchRole={onSwitchRole}
      onNavigateHome={onNavigateHome}
      onLogout={onLogout}
    >
      <div className="space-y-5">
        <div className="bg-white p-5 rounded-2xl border border-[#DCE8DC] flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display font-extrabold text-xl">Platform Operations &amp; NASA Pipeline Health</h1>
            <p className="text-xs text-[#52635C]">
              Live provider status, ingestion run history, and secret readiness.
            </p>
          </div>
          <button
            type="button"
            disabled={running}
            onClick={triggerPipeline}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#063D2A] text-white text-xs font-semibold disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
            {running ? 'Running Pipeline...' : 'Run NASA Ingestion Check'}
          </button>
        </div>

        {data?.counts && (
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            {Object.entries(data.counts).map(([k, v]) => (
              <div key={k} className="bg-white p-3.5 rounded-xl border border-[#DCE8DC]">
                <div className="text-[11px] text-[#52635C] capitalize">{k}</div>
                <div className="font-mono-tabular font-bold text-lg">{v}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'health' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(data?.providers || []).map((p) => {
              const sid = String(p.id);
              const pt = providerTests[sid];
              return (
                <div key={sid} className="bg-white p-4 rounded-xl border border-[#DCE8DC] text-xs space-y-2">
                  <div className="flex justify-between items-center">
                    <strong className="text-sm">{String(p.name)}</strong>
                    <span className="font-mono-tabular font-bold text-[#075A36]">{String(p.status)}</span>
                  </div>
                  <div className="text-[#52635C]">
                    Records: {String(p.records_processed)} · Latest Obs:{' '}
                    {p.latest_observation_at ? String(p.latest_observation_at).slice(0, 16) : 'None'}
                  </div>
                  {Boolean(p.last_error) && (
                    <div className="text-amber-800 bg-amber-50 border border-amber-200 p-2 rounded">
                      {String(p.last_error)}
                    </div>
                  )}
                  {pt && (
                    <div
                      className={`p-2 rounded border ${
                        pt.verificationLabel === 'Connected and verified'
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                          : 'bg-amber-50 border-amber-200 text-amber-900'
                      }`}
                    >
                      <strong>
                        {pt.verificationLabel} {pt.httpStatus ? `(HTTP ${pt.httpStatus})` : ''}
                      </strong>{' '}
                      · {pt.detail}
                    </div>
                  )}
                  <div className="pt-1">
                    <button
                      type="button"
                      disabled={testingSourceId === sid}
                      onClick={() => testProvider(sid)}
                      className="px-3 py-1 rounded-md border border-[#DCE8DC] bg-[#F8FBF6] hover:bg-[#E9F7E4] font-semibold text-[#075A36] disabled:opacity-50"
                    >
                      {testingSourceId === sid ? 'Testing Connection...' : 'Test Connection'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'jobs' && (
          <div className="bg-white rounded-2xl border border-[#DCE8DC] overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F8FBF6] border-b border-[#DCE8DC]">
                <tr>
                  <th className="p-3">Source</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Records</th>
                  <th className="p-3">Started</th>
                  <th className="p-3">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DCE8DC]">
                {(data?.ingestionRuns || []).map((r) => (
                  <tr key={String(r.id)}>
                    <td className="p-3 font-semibold">{String(r.source_id)}</td>
                    <td className="p-3 font-mono-tabular">{String(r.status)}</td>
                    <td className="p-3 font-mono-tabular">{String(r.records_processed)}</td>
                    <td className="p-3 font-mono-tabular">{String(r.started_at).slice(0, 19)}</td>
                    <td className="p-3 text-[#52635C]">{String(r.error_message || 'OK')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'audit' && (
          <div className="bg-white rounded-2xl border border-[#DCE8DC] p-4 space-y-2">
            {(data?.auditLogs || []).map((a) => (
              <div key={String(a.id)} className="text-xs border-b border-[#DCE8DC] pb-2 flex justify-between">
                <span><strong>{String(a.action)}</strong> · {String(a.actor_role || 'SYSTEM')}</span>
                <span className="font-mono-tabular text-[#52635C]">{String(a.created_at).slice(0, 19)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}
