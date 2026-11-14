import React, { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Compass, Database, MapPin, RefreshCw, Satellite, ShieldCheck, Sprout } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useLocationContext } from '../../context/LocationContext';
import type { CropCatalogueItem } from '../../../shared/types';

interface ProviderRow {
  id: string;
  name: string;
  provider: string;
  product_code: string;
  spatial_resolution: string;
  temporal_cadence: string;
  requires_credential: string | null;
  docs_url: string;
  status: string;
  last_checked_at: string | null;
  last_success_at: string | null;
  latest_observation_at: string | null;
  records_processed: number;
  last_error: string | null;
  credential_configured: number;
}

export function HowItWorksPage({ onNavigate }: { onNavigate: (p: string) => void }) {
  const steps = [
    {
      num: '01',
      title: 'Observe from Space & Local Stations',
      desc: 'When a farm is registered with confirmed coordinates, KhetPatch queries NASA POWER, NASA CMR (GPM IMERG, SMAP L4, Landsat/HLS), and Open-Meteo forecasts.',
    },
    {
      num: '02',
      title: 'Understand Land, Soil & History',
      desc: 'Field GeoJSON polygons calculate exact acreage, resolve the MPKV/ICAR agroclimatic zone, and combine crop-family history with lab or farmer soil tests.',
    },
    {
      num: '03',
      title: 'Evaluate Constraints & Budget',
      desc: 'Our deterministic solver validates season fit, sowing window, family rotation breaks, water capability, soil pH, and ₹ cultivation budget before ranking.',
    },
    {
      num: '04',
      title: 'Compare Three Rotation Strategies',
      desc: 'Farmers compare Existing, Minimal Change, and Alternative rotations side-by-side with full evidence trails and explicit missing-data disclosures.',
    },
    {
      num: '05',
      title: 'Act with Autonomous Follow-Ups',
      desc: 'Approving a plan generates crop-specific operational tasks. Forecast heavy rain or heat triggers automated review alerts and schedule adjustments.',
    },
    {
      num: '06',
      title: 'Improve Persistent Field Memory',
      desc: 'Completed tasks, postponed dates, and farmer observations are stored in the field timeline to inform the next seasonal planning cycle.',
    },
  ];

  return (
    <div className="max-w-[1160px] mx-auto px-4 sm:px-6 py-12 space-y-10">
      <div className="space-y-3 max-w-2xl">
        <div className="text-xs font-semibold tracking-wider text-[#075A36]">WORKFLOW ARCHITECTURE</div>
        <h1 className="font-display font-extrabold text-3xl sm:text-4xl text-[#10251D]">
          Observe → Understand → Recommend → Act → Follow Up → Improve
        </h1>
        <p className="text-[#52635C]">
          Every stage in KhetPatch persists structured records in the database so decisions stay
          reproducible, explainable, and synchronized with changing weather and budgets.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {steps.map((s) => (
          <div key={s.num} className="p-6 rounded-2xl bg-white border border-[#DCE8DC] space-y-2.5">
            <div className="text-xs font-mono-tabular font-bold text-[#075A36]">{s.num}</div>
            <h2 className="font-display font-bold text-lg text-[#10251D]">{s.title}</h2>
            <p className="text-sm text-[#52635C] leading-relaxed">{s.desc}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-[#03152B] text-white p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h3 className="font-display font-bold text-xl">Ready to test the full 5-role pipeline?</h3>
          <p className="text-sm text-slate-300 mt-1">
            Explore the Kopargaon demo farm or register your own field boundary.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('/login')}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#A7F33C] text-[#03152B] font-bold text-sm shrink-0"
        >
          Open Workspaces <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

interface ProviderTestResult {
  sourceId: string;
  verificationLabel: string;
  httpStatus: number | null;
  checkedAt: string;
  detail: string;
}

export function NasaDataPage() {
  const { context, metrics, syncing, detectMyLocation, syncCurrentLocationNasa } = useLocationContext();
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});

  const targetLat = context.selected && context.latitude !== null ? context.latitude : 19.8825;
  const targetLon = context.selected && context.longitude !== null ? context.longitude : 74.4789;
  const targetLabel = context.selected && context.label ? context.label : 'Kopargaon (Default Test Pin)';

  const loadHealth = () => {
    setLoading(true);
    apiFetch<{ providers: ProviderRow[] }>('/intelligence/provider-health')
      .then((res) => setProviders(res.providers))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadHealth();
  }, []);

  const runLiveTest = async () => {
    setTesting(true);
    try {
      if (context.selected) {
        await syncCurrentLocationNasa(true);
      } else {
        await apiFetch(`/public/hero-metrics?lat=${targetLat}&lon=${targetLon}&fetch=1`);
      }
      loadHealth();
    } finally {
      setTesting(false);
    }
  };

  const testSingleProvider = async (sourceId: string) => {
    setTestingId(sourceId);
    try {
      const res = await apiFetch<ProviderTestResult>(`/intelligence/providers/${sourceId}/test`, {
        method: 'POST',
        body: JSON.stringify({ lat: targetLat, lon: targetLon }),
      });
      setTestResults((prev) => ({ ...prev, [sourceId]: res }));
      loadHealth();
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-12 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-2 max-w-2xl">
          <div className="text-xs font-semibold tracking-wider text-[#075A36]">
            SCIENTIFIC PROVENANCE &amp; LIVE HEALTH
          </div>
          <h1 className="font-display font-extrabold text-3xl text-[#10251D]">
            NASA Earth Observations &amp; Weather Connectors
          </h1>
          <p className="text-sm text-[#52635C]">
            KhetPatch retains native spatial resolution, exact observation timestamps, and honest
            credential status for every integrated provider.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={syncing || testing}
            onClick={() => void detectMyLocation()}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[#DCE8DC] bg-white text-[#10251D] text-xs font-semibold hover:bg-[#F8FBF6] disabled:opacity-60"
          >
            <Compass className="w-4 h-4 text-[#075A36]" />
            Detect My Location
          </button>
          <button
            type="button"
            disabled={testing || syncing}
            onClick={runLiveTest}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#063D2A] text-white text-xs font-semibold hover:bg-[#075A36] disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${testing || syncing ? 'animate-spin' : ''}`} />
            {testing || syncing ? 'Querying Live NASA APIs...' : `Sync Active Location`}
          </button>
        </div>
      </div>

      {/* Active Synchronized Location Banner */}
      <div className="rounded-2xl bg-[#03152B] text-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-[#6BEAFF]" />
            <span className="font-bold text-sm">{targetLabel}</span>
            <span className="font-mono-tabular text-[#6BEAFF]">
              ({targetLat.toFixed(4)}°N, {targetLon.toFixed(4)}°E)
            </span>
          </div>
          <span className="px-2 py-0.5 rounded bg-white/10 font-mono-tabular text-[11px]">
            Context: {context.selected ? context.locationType : 'UNSELECTED'}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {metrics.map((m) => (
            <div key={m.metricKey} className="rounded-xl bg-white/8 border border-white/12 p-3 space-y-1">
              <div className="text-[11px] text-[#6BEAFF]">{m.label}</div>
              <div className="font-mono-tabular font-bold text-lg">
                {m.value !== null ? `${m.value} ${m.unit}` : syncing ? 'Syncing...' : 'Unavailable'}
              </div>
              <div className="text-[10.5px] text-slate-300 font-mono-tabular truncate">
                {m.gridCellId || m.spatialResolution}
              </div>
            </div>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-sm text-[#52635C] bg-white rounded-2xl border border-[#DCE8DC]">
          Loading provider registry...
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {providers.map((p) => {
            const tr = testResults[p.id];
            return (
              <div key={p.id} className="p-6 rounded-2xl bg-white border border-[#DCE8DC] space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono-tabular text-[#52635C]">{p.id}</div>
                    <h2 className="font-display font-bold text-lg text-[#10251D]">{p.name}</h2>
                    <div className="text-xs text-[#52635C]">{p.provider} · {p.product_code}</div>
                  </div>
                  <span
                    className={`text-xs font-semibold px-2.5 py-1 rounded-md ${
                      p.status === 'CONNECTED'
                        ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                        : p.status === 'AWAITING_CREDENTIALS'
                        ? 'bg-amber-50 text-amber-800 border border-amber-200'
                        : 'bg-slate-100 text-slate-700 border border-slate-200'
                    }`}
                  >
                    {p.status}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs bg-[#F8FBF6] p-3 rounded-xl border border-[#DCE8DC]">
                  <div>
                    <div className="text-[#52635C]">Native Resolution</div>
                    <div className="font-semibold">{p.spatial_resolution}</div>
                  </div>
                  <div>
                    <div className="text-[#52635C]">Temporal Cadence</div>
                    <div className="font-semibold">{p.temporal_cadence}</div>
                  </div>
                  <div>
                    <div className="text-[#52635C]">Latest Observation</div>
                    <div className="font-mono-tabular">
                      {p.latest_observation_at ? p.latest_observation_at.slice(0, 16) : 'Not fetched yet'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#52635C]">Records Processed</div>
                    <div className="font-mono-tabular font-semibold">{p.records_processed}</div>
                  </div>
                </div>

                {p.last_error && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                    {p.last_error}
                  </p>
                )}

                {tr && (
                  <div
                    className={`text-xs rounded-lg p-2.5 border space-y-0.5 ${
                      tr.verificationLabel === 'Connected and verified'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                        : 'bg-amber-50 border-amber-200 text-amber-900'
                    }`}
                  >
                    <div className="font-bold">
                      {tr.verificationLabel} {tr.httpStatus ? `(HTTP ${tr.httpStatus})` : ''} · {tr.checkedAt.slice(0, 19)}
                    </div>
                    <div>{tr.detail}</div>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-1">
                  <span className="text-[#52635C]">
                    {p.requires_credential ? `Credential: ${p.requires_credential}` : 'Public API (No Key Required)'}
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={testingId === p.id}
                      onClick={() => testSingleProvider(p.id)}
                      className="px-2.5 py-1 rounded-md border border-[#DCE8DC] bg-[#F8FBF6] hover:bg-[#E9F7E4] font-semibold text-[#075A36] disabled:opacity-50"
                    >
                      {testingId === p.id ? 'Testing...' : 'Test Connection'}
                    </button>
                    <a href={p.docs_url} target="_blank" rel="noreferrer" className="font-semibold text-[#075A36] hover:underline">
                      Docs ↗
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ForFarmersPage({ onNavigate }: { onNavigate: (p: string) => void }) {
  return (
    <div className="max-w-[1160px] mx-auto px-4 sm:px-6 py-12 space-y-8">
      <div className="space-y-3 max-w-2xl">
        <div className="text-xs font-semibold tracking-wider text-[#075A36]">FARMER WORKSPACE</div>
        <h1 className="font-display font-extrabold text-3xl sm:text-4xl text-[#10251D]">
          Practical Field Decisions in English, Hindi, and Marathi
        </h1>
        <p className="text-[#52635C]">
          Manage multiple farms and fields, record real soil test results, enter your ₹ cultivation
          budget, compare three feasible rotations, and track seasonal tasks.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {[
          { icon: Sprout, title: 'Field & Crop Memory', body: 'Draw field polygons on satellite imagery and keep complete planting, harvest, and pest history.' },
          { icon: Database, title: 'Budget-Aware Planning', body: 'Never get a recommendation that exceeds your per-acre budget or irrigation reality.' },
          { icon: CheckCircle2, title: 'Weather-Linked Follow-Ups', body: 'Receive crop-specific schedules and weather-triggered inspection alerts after plan approval.' },
        ].map((c) => (
          <div key={c.title} className="p-6 rounded-2xl bg-white border border-[#DCE8DC] space-y-2">
            <c.icon className="w-6 h-6 text-[#075A36]" />
            <h2 className="font-display font-bold text-lg">{c.title}</h2>
            <p className="text-sm text-[#52635C]">{c.body}</p>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onNavigate('/signup')}
        className="px-6 py-3 rounded-full bg-[#A7F33C] text-[#03152B] font-bold text-sm"
      >
        Create Farmer Account →
      </button>
    </div>
  );
}

export function ForExpertsPage({ onNavigate }: { onNavigate: (p: string) => void }) {
  return (
    <div className="max-w-[1160px] mx-auto px-4 sm:px-6 py-12 space-y-8">
      <div className="space-y-3 max-w-2xl">
        <div className="text-xs font-semibold tracking-wider text-[#075A36]">AGRONOMISTS &amp; FPOs</div>
        <h1 className="font-display font-extrabold text-3xl sm:text-4xl text-[#10251D]">
          Auditable Advisory, Plan Review, and FPO Operations
        </h1>
        <p className="text-[#52635C]">
          Agronomists and FPO Managers inspect farmer-authorized fields alongside NASA observations,
          MPKV/ICAR crop rules, and soil lab records before approving recommendations.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {[
          { icon: ShieldCheck, title: 'Expert Plan Validation', body: 'Approve, reject, or request additional field data with timestamped agronomic notes.' },
          { icon: Satellite, title: 'Evidence Inspection', body: 'Review exact NASA POWER records, granule IDs, and hard constraints evaluated per strategy.' },
          { icon: Database, title: 'Organization & Audit Controls', body: 'Scoped role permissions and CSV exports for authorized FPO farmer registers.' },
        ].map((c) => (
          <div key={c.title} className="p-6 rounded-2xl bg-white border border-[#DCE8DC] space-y-2">
            <c.icon className="w-6 h-6 text-[#075A36]" />
            <h2 className="font-display font-bold text-lg">{c.title}</h2>
            <p className="text-sm text-[#52635C]">{c.body}</p>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onNavigate('/login')}
        className="px-6 py-3 rounded-full bg-[#063D2A] text-white font-bold text-sm"
      >
        Sign In to Agronomist / FPO Workspace →
      </button>
    </div>
  );
}

export function ResourcesPage() {
  const [crops, setCrops] = useState<CropCatalogueItem[]>([]);
  useEffect(() => {
    apiFetch<{ crops: CropCatalogueItem[] }>('/crops').then((r) => setCrops(r.crops)).catch(() => {});
  }, []);

  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-12 space-y-8">
      <div className="space-y-2 max-w-2xl">
        <div className="text-xs font-semibold tracking-wider text-[#075A36]">AGRONOMIC KNOWLEDGE BASE</div>
        <h1 className="font-display font-extrabold text-3xl text-[#10251D]">
          Regional Crop Catalogue &amp; Rotation Rules (MPKV Rahuri / ICAR)
        </h1>
        <p className="text-sm text-[#52635C]">
          Verified crop durations, water requirements, family rotation rules, and reference costs used
          by the deterministic solver.
        </p>
      </div>

      <div className="overflow-x-auto bg-white rounded-2xl border border-[#DCE8DC]">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#F8FBF6] border-b border-[#DCE8DC] text-xs text-[#52635C]">
            <tr>
              <th className="py-3 px-4">Crop</th>
              <th className="py-3 px-4">Family</th>
              <th className="py-3 px-4">Seasons</th>
              <th className="py-3 px-4">Duration</th>
              <th className="py-3 px-4">Water</th>
              <th className="py-3 px-4">Est. Cost / Acre</th>
              <th className="py-3 px-4">Reference Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#DCE8DC]">
            {crops.map((c) => (
              <tr key={c.id} className="hover:bg-[#F8FBF6]/60">
                <td className="py-3 px-4 font-semibold">
                  {c.name} <span className="text-xs text-[#52635C] font-normal">({c.localNameMr})</span>
                </td>
                <td className="py-3 px-4 text-xs">{c.cropFamily}</td>
                <td className="py-3 px-4 text-xs">{c.suitableSeasons.join(', ')}</td>
                <td className="py-3 px-4 font-mono-tabular text-xs">{c.durationDaysMin}–{c.durationDaysMax} d</td>
                <td className="py-3 px-4 text-xs">{c.waterNeedLevel} (~{c.waterNeedMm} mm)</td>
                <td className="py-3 px-4 font-mono-tabular text-xs font-semibold">
                  {c.estimatedCostPerAcreInr ? `₹${c.estimatedCostPerAcreInr.toLocaleString('en-IN')}` : '—'}
                </td>
                <td className="py-3 px-4 text-xs text-[#52635C]">{c.sourceReference} ({c.sourceYear})</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AboutPage() {
  return (
    <div className="max-w-[960px] mx-auto px-4 sm:px-6 py-12 space-y-6">
      <div className="text-xs font-semibold tracking-wider text-[#075A36]">ABOUT KHETPATCH</div>
      <h1 className="font-display font-extrabold text-3xl text-[#10251D]">
        Scientific Integrity &amp; Farmer-First Design
      </h1>
      <p className="text-[#52635C] leading-relaxed">
        Developed by Team Codex at Sanjivani University, Kopargaon, Maharashtra for the NASA Space
        Apps Challenge, KhetPatch bridges the gap between Earth-observation datasets and real-world
        cropping decisions.
      </p>
      <div className="p-6 rounded-2xl bg-white border border-[#DCE8DC] space-y-3">
        <h2 className="font-display font-bold text-lg">Responsible-Use Principles</h2>
        <ul className="list-disc pl-5 space-y-2 text-sm text-[#52635C]">
          <li>Never fabricate satellite observations, nutrient levels, or guaranteed market returns.</li>
          <li>Keep deterministic agronomic constraints separate from generative LLM explanations.</li>
          <li>Always preserve native spatial resolution and data latency timestamps.</li>
          <li>Enforce server-side authorization and tenant isolation across all five roles.</li>
        </ul>
      </div>
    </div>
  );
}
