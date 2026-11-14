import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  CloudRain,
  Compass,
  Database,
  Droplets,
  Info,
  Layers,
  Leaf,
  MapPin,
  Play,
  RefreshCw,
  Satellite,
  Search,
  ShieldCheck,
  Sprout,
  Thermometer,
  X,
} from 'lucide-react';
import { NasaEmblem } from '../../components/BrandMark';
import { FieldMap } from '../../components/FieldMap';
import { t, type SupportedLang } from '../../i18n/translations';
import { apiFetch } from '../../lib/api';
import { useLocationContext } from '../../context/LocationContext';
import type {
  EnvironmentalMetricSummary,
  StrategyEvaluation,
} from '../../../shared/types';

import heroEarthFarmImg from '../../assets/images/hero_earth_farm_1794545664097.jpg';
import strategyExistingImg from '../../assets/images/strategy_existing_crop_1794545665050.jpg';
import strategyMinimalImg from '../../assets/images/strategy_minimal_seedlings_1794545664868.jpg';
import strategyAlternativeImg from '../../assets/images/strategy_alternative_fields_1794545665983.jpg';

interface HomePageProps {
  lang: SupportedLang;
  onNavigate: (path: string) => void;
}

const STRATEGY_IMAGES: Record<string, string> = {
  EXISTING: strategyExistingImg,
  MINIMAL_CHANGE: strategyMinimalImg,
  ALTERNATIVE: strategyAlternativeImg,
};

interface LocationSearchResult {
  label: string;
  village: string;
  taluka: string;
  district: string;
  state: string;
  lat: number;
  lon: number;
}

interface LandingLocationState {
  selected: boolean;
  latitude: number | null;
  longitude: number | null;
  label: string | null;
  source?: string;
  isShowcase?: boolean;
}

interface ObservationDetailRecord {
  id: string;
  source_id: string;
  dataset: string;
  variable: string;
  value: number | null;
  unit: string | null;
  observation_start: string;
  retrieval_time: string;
  quality_status: string;
  quality_flags: string | null;
  granule_or_scene_id: string | null;
}

interface ProvenanceDetailsResponse {
  observations: ObservationDetailRecord[];
  spatialGrids?: {
    gpmGridId: string;
    gpmDistanceM: number;
    smapEaseGridId: string;
    smapDistanceM: number;
    powerGridId: string;
    powerDistanceM: number;
  };
  obsLocations?: Array<{
    grid_cell_id: string;
    pixel_distance_m: number;
    extraction_method: string;
    spatial_resolution: string;
    last_synced_at: string;
  }>;
}

export function HomePage({ lang, onNavigate }: HomePageProps) {
  const {
    context: locationState,
    detected,
    savedFarms,
    metrics,
    strategyPreview,
    permissionStatus,
    updateStatus,
    initialLoading,
    syncing: loadingMetrics,
    error: contextError,
    lowAccuracyWarning,
    clearError,
    detectMyLocation,
    selectManualLocation,
    selectFarmOrField,
    switchToDeviceLocation,
    updateSavedFarmWithDeviceLocation,
    syncCurrentLocationNasa,
    clearLocation,
  } = useLocationContext();

  const [selectedMetric, setSelectedMetric] = useState<EnvironmentalMetricSummary | null>(null);
  const [observationDetails, setObservationDetails] = useState<ObservationDetailRecord[]>([]);
  const [provenanceData, setProvenanceData] = useState<ProvenanceDetailsResponse | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const [activeStrategyModal, setActiveStrategyModal] = useState<StrategyEvaluation | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Location Picker Modal State (Search, GPS, Map Pin, Coords, Privacy)
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [locationTab, setLocationTab] = useState<'search' | 'map' | 'coords'>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<LocationSearchResult[]>([]);
  const [searchingLocation, setSearchingLocation] = useState(false);
  const [mapPinLat, setMapPinLat] = useState(19.8825);
  const [mapPinLon, setMapPinLon] = useState(74.4789);
  const [manualLat, setManualLat] = useState('19.8825');
  const [manualLon, setManualLon] = useState('74.4789');
  const [confirmOverwriteFarm, setConfirmOverwriteFarm] = useState(false);

  const fetchError = localError || contextError;

  useEffect(() => {
    if (locationState.latitude !== null && locationState.longitude !== null) {
      setMapPinLat(locationState.latitude);
      setMapPinLon(locationState.longitude);
      setManualLat(String(locationState.latitude));
      setManualLon(String(locationState.longitude));
    }
  }, [locationState.latitude, locationState.longitude]);

  const persistAndFetchLocation = async (
    lat: number,
    lon: number,
    label: string
  ) => {
    setLocalError(null);
    clearError();
    await selectManualLocation({
      latitude: lat,
      longitude: lon,
      label,
      locationType: 'MANUAL',
    });
    setShowLocationModal(false);
  };

  const handleRefreshCurrentLocation = async () => {
    if (!locationState.selected || locationState.latitude === null || locationState.longitude === null) {
      setShowLocationModal(true);
      return;
    }
    setLocalError(null);
    await syncCurrentLocationNasa(true);
  };

  const handleSearchLocations = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearchingLocation(true);
    setLocalError(null);
    try {
      const res = await apiFetch<{ results: LocationSearchResult[] }>(
        `/location/search?q=${encodeURIComponent(searchQuery.trim())}`
      );
      setSearchResults(res.results || []);
      if (!res.results || res.results.length === 0) {
        setLocalError(
          'No matching district/village found. Try "Select from Map" or "Enter Coordinates".'
        );
      }
    } catch {
      setLocalError('Location search temporarily unavailable.');
    } finally {
      setSearchingLocation(false);
    }
  };

  const handleManualCoordsSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const lat = Number(manualLat);
    const lon = Number(manualLon);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      setLocalError('Enter valid latitude (-90 to 90) and longitude (-180 to 180).');
      return;
    }
    void persistAndFetchLocation(
      Number(lat.toFixed(4)),
      Number(lon.toFixed(4)),
      `Coordinates (${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E)`
    );
  };

  const handleUseMyLocation = async () => {
    setLocalError(null);
    clearError();
    await detectMyLocation({ forceActivateDevice: savedFarms.length > 0 });
  };

  const openMetricProvenanceModal = (m: EnvironmentalMetricSummary) => {
    setSelectedMetric(m);
    setObservationDetails([]);
    setProvenanceData(null);
    if (locationState.latitude !== null && locationState.longitude !== null) {
      setLoadingDetails(true);
      apiFetch<ProvenanceDetailsResponse>(
        `/nasa/location-provenance?lat=${locationState.latitude}&lon=${locationState.longitude}`
      )
        .then((res) => {
          setProvenanceData(res);
          setObservationDetails(res.observations || []);
        })
        .catch(() => {})
        .finally(() => setLoadingDetails(false));
    }
  };

  const metricVisualStyle = (key: EnvironmentalMetricSummary['metricKey']) => {
    if (key === 'rainfall') {
      return {
        card: 'bg-gradient-to-r from-[#073B5E]/88 via-[#0B4D75]/84 to-[#105F88]/78 border-[#55D8F2]/55 hover:border-[#7BE6FA]',
        iconBg: 'bg-[#12729C]/75 border-[#6BEAFF]/50',
        icon: <CloudRain className="w-5 h-5 text-white drop-shadow" />,
      };
    }
    if (key === 'soil_moisture') {
      return {
        card: 'bg-gradient-to-r from-[#073A5A]/88 via-[#0A5373]/84 to-[#0F6580]/78 border-[#4BDDF0]/50 hover:border-[#7AEAF8]',
        iconBg: 'bg-[#107898]/75 border-[#59E2F5]/50',
        icon: <Droplets className="w-5 h-5 text-[#6BEAFF] drop-shadow" />,
      };
    }
    if (key === 'ndvi') {
      return {
        card: 'bg-gradient-to-r from-[#0A412A]/88 via-[#125A35]/84 to-[#186B3B]/78 border-[#6EDB5B]/55 hover:border-[#A7F33C]',
        iconBg: 'bg-[#217C3F]/75 border-[#83E86B]/55',
        icon: <Leaf className="w-5 h-5 text-[#A7F33C] drop-shadow" />,
      };
    }
    return {
      card: 'bg-gradient-to-r from-[#2B3721]/88 via-[#3F4521]/84 to-[#544F1E]/78 border-[#E7B54B]/55 hover:border-[#FCD34D]',
      iconBg: 'bg-[#7A6320]/70 border-[#FBBF24]/50',
      icon: <Thermometer className="w-5 h-5 text-amber-300 drop-shadow" />,
    };
  };

  const renderCardChart = (m: EnvironmentalMetricSummary) => {
    const series = m.series || [];
    if (m.metricKey === 'ndvi') {
      if (m.value !== null && series.length >= 2) {
        const vals = series.map((s) => s.value);
        const min = Math.min(...vals, 0);
        const max = Math.max(...vals, 0.8);
        const range = Math.max(0.05, max - min);
        return (
          <div className="flex items-end gap-1 h-7" aria-hidden="true">
            {vals.slice(-7).map((v, i) => {
              const h = Math.max(18, Math.round(((v - min) / range) * 100));
              return <span key={i} style={{ height: `${h}%` }} className="w-1.5 rounded-t-sm bg-[#86F142]" />;
            })}
          </div>
        );
      }
      return (
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-black/25 border border-white/15 text-emerald-100 whitespace-nowrap">
          {m.granuleOrSceneId ? 'Scene Indexed' : locationState.selected ? 'No NDVI Pixel' : 'Awaiting Pin'}
        </span>
      );
    }

    if (series.length < 2) {
      return (
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-black/25 border border-white/15 text-slate-200/85 whitespace-nowrap">
          {locationState.selected ? 'Single Obs' : 'Select Pin'}
        </span>
      );
    }

    const vals = series.map((s) => s.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = Math.max(0.01, max - min);

    if (m.metricKey === 'rainfall') {
      const paddedSlots = 7;
      const recent = vals.slice(-paddedSlots);
      const missingCount = Math.max(0, paddedSlots - recent.length);
      return (
        <div className="flex items-end gap-1 h-7" aria-hidden="true">
          {Array.from({ length: missingCount }).map((_, idx) => (
            <span
              key={`gap-${idx}`}
              className="w-1.5 h-1.5 rounded-sm bg-white/15"
              title="Day observation unavailable"
            />
          ))}
          {recent.map((v, i) => {
            const h = v <= 0 ? 18 : Math.max(24, Math.round(((v - min) / range) * 100));
            return (
              <span
                key={`rain-${i}`}
                style={{ height: `${h}%` }}
                className={`w-1.5 rounded-t-sm ${
                  v > 0 ? 'bg-[#38E2F8]' : 'bg-[#38E2F8]/35'
                }`}
              />
            );
          })}
        </div>
      );
    }

    const pts = vals
      .slice(-8)
      .map((v, i, arr) => {
        const x = (i / Math.max(1, arr.length - 1)) * 66;
        const y = 24 - ((v - min) / range) * 18;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

    return (
      <svg width="68" height="28" viewBox="0 0 68 28" aria-hidden="true" className="shrink-0 overflow-visible">
        <polyline
          fill="none"
          stroke={m.metricKey === 'temperature' ? '#F59E0B' : '#33E1F7'}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={pts}
        />
      </svg>
    );
  };

  const strategyCardConfigs: Array<{
    key: 'EXISTING' | 'MINIMAL_CHANGE' | 'ALTERNATIVE';
    num: number;
    title: string;
    desc: string;
    cardStyle: string;
    badgeStyle: string;
    btnStyle: string;
  }> = [
    {
      key: 'EXISTING',
      num: 1,
      title: t(lang, 'strat.1.title'),
      desc: t(lang, 'strat.1.desc'),
      cardStyle: 'bg-[#E9F7E4] border-[#C6E6BD]',
      badgeStyle: 'bg-[#1D7F3C] text-white',
      btnStyle: 'bg-[#D6EED0] text-[#10251D] hover:bg-[#C1E4B8]',
    },
    {
      key: 'MINIMAL_CHANGE',
      num: 2,
      title: t(lang, 'strat.2.title'),
      desc: t(lang, 'strat.2.desc'),
      cardStyle: 'bg-[#FFF5DE] border-[#F6DFAC]',
      badgeStyle: 'bg-[#D97706] text-white',
      btnStyle: 'bg-[#FCE8BE] text-[#10251D] hover:bg-[#F7DA9E]',
    },
    {
      key: 'ALTERNATIVE',
      num: 3,
      title: t(lang, 'strat.3.title'),
      desc: t(lang, 'strat.3.desc'),
      cardStyle: 'bg-[#F3EEFF] border-[#DFD2FC]',
      badgeStyle: 'bg-[#7C3AED] text-white',
      btnStyle: 'bg-[#E6DCFD] text-[#10251D] hover:bg-[#D5C4FB]',
    },
  ];

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div>
      {/* =====================================================================
          HERO SECTION — Earth Observation Artwork, Floating NASA Cards,
          Bottom Capsule Process Bar & Convex White Arch Transition
      ===================================================================== */}
      <section className="relative overflow-hidden bg-[#03152B] text-white">
        {/* Background Earth-to-Farm Scene */}
        <div className="absolute inset-0">
          <img
            src={heroEarthFarmImg}
            alt="NASA Earth observation satellite scanning Indian agricultural fields and soil roots"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover object-[52%_32%]"
          />
          {/* Left-focused directional gradient so center Earth, Satellite, Beam, Fields & Roots remain vivid */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(92deg, rgba(3,18,38,0.86) 0%, rgba(3,18,38,0.68) 28%, rgba(3,18,38,0.16) 46%, rgba(3,18,38,0.04) 68%, rgba(3,18,38,0.34) 100%)',
            }}
          />
          <div
            className="absolute inset-x-0 bottom-0 h-20"
            style={{
              background: 'linear-gradient(to top, rgba(3,21,43,0.72), transparent)',
            }}
          />
        </div>

        <div className="relative max-w-[1480px] mx-auto px-5 sm:px-8 pt-5 pb-6 lg:pt-6 lg:pb-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
            {/* LEFT HERO COPY & 4 INDICATOR CIRCLES */}
            <div className="lg:col-span-5 space-y-3.5">
              <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-[#061C36]/80 border border-white/25 backdrop-blur-md">
                <NasaEmblem />
                <span className="text-xs font-medium text-slate-100 tracking-wide">
                  {t(lang, 'hero.badge')}
                </span>
              </div>

              <h1 className="font-display font-extrabold tracking-tight leading-[1.06] text-[clamp(2.25rem,3.6vw,3.35rem)] text-balance drop-shadow-[0_2px_10px_rgba(0,0,0,0.45)]">
                <span className="block text-white">{t(lang, 'hero.title1')}</span>
                <span className="block text-[#A7F33C]">{t(lang, 'hero.title2')}</span>
                <span className="block text-white">{t(lang, 'hero.title3')}</span>
              </h1>

              <p className="text-[14.5px] sm:text-[15.5px] text-slate-100/95 leading-relaxed max-w-[485px] drop-shadow-[0_1px_6px_rgba(0,0,0,0.45)]">
                {t(lang, 'hero.subtitle')}
              </p>

              <div className="flex flex-wrap items-center gap-3 pt-0.5">
                <button
                  type="button"
                  onClick={() => onNavigate('/login')}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-gradient-to-r from-[#A8F83C] to-[#7CE029] hover:brightness-105 text-[#03152B] font-bold text-sm transition-all shadow-[0_0_22px_rgba(167,243,60,0.35)] whitespace-nowrap"
                >
                  {t(lang, 'hero.ctaPrimary')} <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('/how-it-works')}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[#071E38]/75 hover:bg-[#0B2A48] text-white border border-white/30 font-semibold text-sm backdrop-blur-sm transition-colors whitespace-nowrap"
                >
                  {t(lang, 'hero.ctaSecondary')} <Play className="w-3.5 h-3.5 fill-current" />
                </button>
              </div>

              {/* Four Feature Indicators */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-white/15">
                {[
                  { icon: Sprout, label: t(lang, 'hero.feat1') },
                  { icon: Satellite, label: t(lang, 'hero.feat2') },
                  { icon: Layers, label: t(lang, 'hero.feat3') },
                  { icon: ShieldCheck, label: t(lang, 'hero.feat4') },
                ].map((f, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-[11.5px] text-slate-100">
                    <span className="w-8 h-8 rounded-full bg-[#05292A]/85 border border-[#6FE358]/60 flex items-center justify-center shrink-0">
                      <f.icon className="w-4 h-4 text-[#A7F33C]" />
                    </span>
                    <span className="leading-tight font-medium">{f.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* CENTER OPEN SPACE FOR EARTH, INDIA, SATELLITE & BEAM */}
            <div className="hidden lg:block lg:col-span-3 xl:col-span-4" aria-hidden="true" />

            {/* RIGHT FLOATING LOCATION BAR + 4 REAL NASA METRIC CARDS */}
            <div id="nasa-metrics" className="lg:col-span-4 xl:col-span-3 space-y-2.5">
              {/* Compact Location Detection & Context Bar */}
              <div className="rounded-xl bg-[#041830]/84 border border-[#55D8F2]/40 backdrop-blur-md px-3 py-2 space-y-1.5">
                {!locationState.selected ? (
                  <>
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-100">
                      <span className="flex items-center gap-1.5 font-medium truncate">
                        <MapPin className="w-3.5 h-3.5 text-[#6BEAFF] shrink-0" />
                        {loadingMetrics || updateStatus === 'acquiring_gps' || updateStatus === 'resolving_address'
                          ? 'Detecting location...'
                          : initialLoading
                          ? 'Checking location...'
                          : permissionStatus === 'denied'
                          ? 'Location blocked — choose manually'
                          : 'Explore Earth observations around you.'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={loadingMetrics}
                        onClick={() => void handleUseMyLocation()}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#A7F33C] hover:bg-[#BDF863] text-[#03152B] text-[11px] font-bold transition-colors whitespace-nowrap disabled:opacity-60"
                      >
                        <Compass className="w-3.5 h-3.5" /> Detect My Location
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowLocationModal(true)}
                        className="px-2.5 py-1.5 rounded-lg bg-white/12 hover:bg-white/22 text-white text-[11px] font-semibold transition-colors whitespace-nowrap"
                      >
                        Choose Location
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between gap-1.5">
                    <button
                      type="button"
                      onClick={() => setShowLocationModal(true)}
                      className="flex items-center gap-1.5 min-w-0 text-left text-xs text-slate-100 hover:text-[#A7F33C] transition-colors"
                    >
                      <MapPin className="w-3.5 h-3.5 text-[#6BEAFF] shrink-0" />
                      <span className="truncate font-medium">
                        {locationState.label}
                        {locationState.locationType === 'DEVICE_LOCATION' &&
                        locationState.accuracy_meters != null
                          ? ` (±${locationState.accuracy_meters}m)`
                          : ''}
                      </span>
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="px-1.5 py-0.5 rounded bg-[#0A4A35] border border-[#6FE358]/40 text-[9.5px] font-semibold text-[#C4FF63] whitespace-nowrap">
                        {locationState.locationType === 'FARM' || locationState.locationType === 'FIELD'
                          ? 'Farm'
                          : locationState.locationType === 'DEVICE_LOCATION'
                          ? 'Device'
                          : 'Manual'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowLocationModal(true)}
                        className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/20 text-[10.5px] font-semibold text-white transition-colors whitespace-nowrap"
                      >
                        Change
                      </button>
                      <button
                        type="button"
                        aria-label="Clear selected location"
                        disabled={loadingMetrics}
                        onClick={() => void clearLocation()}
                        className="p-1 rounded-md bg-white/10 hover:bg-white/20 text-slate-200 transition-colors disabled:opacity-50"
                      >
                        <X className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        aria-label="Refresh NASA observations"
                        disabled={loadingMetrics}
                        onClick={() => void handleRefreshCurrentLocation()}
                        className="p-1 rounded-md bg-white/10 hover:bg-white/20 text-[#6BEAFF] transition-colors disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${loadingMetrics ? 'animate-spin' : ''}`} />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {(fetchError || lowAccuracyWarning) && (
                <div className="rounded-lg bg-amber-950/90 border border-amber-400/50 px-3 py-1.5 text-[11px] text-amber-100">
                  {fetchError || lowAccuracyWarning}
                </div>
              )}

              {/* 4 Floating Frosted Metric Cards */}
              {metrics.map((m) => {
                const st = metricVisualStyle(m.metricKey);
                const mainValueDisplay =
                  m.value !== null
                    ? `${m.value} ${m.unit}`
                    : loadingMetrics
                    ? 'Syncing NASA...'
                    : m.metricKey === 'ndvi' && locationState.selected
                    ? 'No cloud-free obs.'
                    : locationState.selected
                    ? 'Unavailable'
                    : 'Select location';

                return (
                  <button
                    key={m.metricKey}
                    type="button"
                    aria-label={`Inspect provenance for ${m.label}`}
                    onClick={() => openMetricProvenanceModal(m)}
                    className={`w-full text-left rounded-2xl border backdrop-blur-md px-3.5 py-2.5 transition-all flex items-center justify-between gap-2.5 shadow-lg group ${st.card}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${st.iconBg}`}
                      >
                        {st.icon}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[11.5px] font-medium text-slate-100/90 leading-tight truncate">
                          {m.label}
                        </div>
                        <div
                          className={`font-bold font-mono-tabular leading-tight mt-0.5 ${
                            m.value !== null ? 'text-[19px] text-white' : 'text-[12.5px] text-slate-200'
                          }`}
                        >
                          {mainValueDisplay}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {renderCardChart(m)}
                      <span className="text-[9.5px] text-slate-200/75 group-hover:text-[#A7F33C] inline-flex items-center gap-0.5">
                        <Info className="w-2.5 h-2.5" /> {m.provider}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* =================================================================
              BOTTOM HERO CAPSULE BAR ("From Space to Your Farm")
          ================================================================= */}
          <div className="relative z-10 mt-4 rounded-full bg-gradient-to-r from-[#0A3E2D]/92 via-[#082C2E]/90 to-[#062229]/92 border border-[#6FE358]/40 backdrop-blur-md shadow-[0_10px_30px_rgba(0,0,0,0.35)] overflow-hidden">
            <div className="flex flex-col lg:flex-row items-stretch">
              <div className="bg-gradient-to-r from-[#136945]/95 to-[#0D4A35]/90 px-7 py-3 flex items-center justify-center lg:justify-start lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-[#6FE358]/25">
                <span className="font-display font-bold text-sm sm:text-base text-white tracking-tight">
                  {t(lang, 'strip.title')}
                </span>
              </div>

              <div className="flex-1 grid grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    icon: Satellite,
                    label: t(lang, 'strip.step1'),
                    action: () => setShowLocationModal(true),
                  },
                  {
                    icon: Layers,
                    label: t(lang, 'strip.step2'),
                    action: () => scrollToSection('core-system'),
                  },
                  {
                    icon: Sprout,
                    label: t(lang, 'strip.step3'),
                    action: () => scrollToSection('rotation-strategies'),
                  },
                  {
                    icon: ShieldCheck,
                    label: t(lang, 'strip.step4'),
                    action: () => onNavigate('/login'),
                  },
                ].map((step, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={step.action}
                    className="px-4 py-2.5 flex items-center justify-center lg:justify-start gap-2.5 hover:bg-white/5 transition-colors relative text-left"
                  >
                    <span className="w-8 h-8 rounded-full bg-[#042426]/85 border border-[#72DF5E]/65 flex items-center justify-center shrink-0">
                      <step.icon className="w-4 h-4 text-[#A7F33C]" />
                    </span>
                    <span className="text-xs sm:text-[13px] font-medium text-white leading-snug">
                      {step.label}
                    </span>
                    {idx < 3 && (
                      <ArrowRight
                        className="hidden lg:block w-4 h-4 text-slate-300/75 ml-auto shrink-0"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Convex Curved Transition into Cream/White Content Surface */}
        <div className="relative w-full overflow-hidden leading-none pointer-events-none -mt-4">
          <svg
            viewBox="0 0 1440 44"
            preserveAspectRatio="none"
            className="w-full h-7 sm:h-9 block"
            aria-hidden="true"
          >
            <path
              d="M0,44 Q720,-28 1440,44 L1440,44 L0,44 Z"
              fill="#F8FBF6"
            />
          </svg>
        </div>
      </section>

      {/* =====================================================================
          THREE CROP-ROTATION STRATEGIES SECTION (Visible within 1648x923 fold)
      ===================================================================== */}
      <section
        id="rotation-strategies"
        className="pt-2 pb-10 px-5 sm:px-8 bg-[#F8FBF6] border-b border-[#DCE8DC]"
      >
        <div className="max-w-[1440px] mx-auto">
          <div className="text-center max-w-5xl mx-auto space-y-1">
            <div className="flex items-center justify-center gap-3 text-[11px] font-bold tracking-[0.14em] text-[#10251D]">
              <span className="h-px w-14 bg-[#45B83A]/70" aria-hidden="true" />
              <span>{t(lang, 'strat.eyebrow')}</span>
              <span className="h-px w-14 bg-[#45B83A]/70" aria-hidden="true" />
            </div>
            <h2 className="font-display font-extrabold text-2xl sm:text-[31px] text-[#10251D] tracking-tight">
              {lang === 'en' ? (
                <>
                  Three Crop-Rotation Strategies for{' '}
                  <span className="text-[#1E9B3B]">Smarter Farming</span>
                </>
              ) : (
                t(lang, 'strat.heading')
              )}
            </h2>
            <p className="text-xs sm:text-sm text-[#52635C]">{t(lang, 'strat.sub')}</p>
          </div>

          <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-5">
            {strategyCardConfigs.map((cfg) => {
              const liveStrat = strategyPreview?.strategies.find(
                (s) => s.strategyType === cfg.key
              );
              return (
                <div
                  key={cfg.key}
                  onClick={() => {
                    if (liveStrat) setActiveStrategyModal(liveStrat);
                  }}
                  className={`rounded-2xl border p-3.5 flex items-center gap-3.5 transition-shadow hover:shadow-md cursor-pointer ${cfg.cardStyle}`}
                >
                  <img
                    src={STRATEGY_IMAGES[cfg.key]}
                    alt={cfg.title}
                    referrerPolicy="no-referrer"
                    className="w-24 h-20 sm:w-28 sm:h-22 rounded-xl object-cover shrink-0 border border-black/10"
                  />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-6 h-6 rounded-full text-xs font-bold inline-flex items-center justify-center shrink-0 ${cfg.badgeStyle}`}
                      >
                        {cfg.num}
                      </span>
                      <h3 className="font-display font-bold text-[15px] sm:text-base text-[#10251D] truncate">
                        {cfg.title}
                      </h3>
                    </div>
                    <p className="text-xs text-[#52635C] leading-snug line-clamp-3">
                      {cfg.desc}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Inspect ${cfg.title} comparison`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (liveStrat) setActiveStrategyModal(liveStrat);
                    }}
                    className={`w-9 h-9 rounded-full inline-flex items-center justify-center shrink-0 transition-colors ${cfg.btnStyle}`}
                  >
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* =====================================================================
          CORE PRODUCT CYCLE & UNIFIED INTELLIGENCE
      ===================================================================== */}
      <section id="core-system" className="py-14 px-5 sm:px-8 bg-white border-b border-[#DCE8DC]">
        <div className="max-w-[1320px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
          <div className="lg:col-span-5 space-y-4">
            <div className="text-xs font-semibold tracking-wider text-[#075A36]">
              PERSISTENT FARM OPERATING SYSTEM
            </div>
            <h2 className="font-display font-extrabold text-3xl text-[#10251D] tracking-tight text-balance">
              Observe. Understand. Recommend. Act. Follow Up. Improve.
            </h2>
            <p className="text-[#52635C] leading-relaxed">
              KhetPatch retains persistent field boundaries, crop-family history, soil test records,
              cultivation budgets, and real NASA Earth observations—driving a deterministic
              constraint solver and continuous follow-up engine.
            </p>
            <div className="pt-2 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onNavigate('/login')}
                className="px-5 py-2.5 rounded-lg bg-[#063D2A] hover:bg-[#075A36] text-white text-sm font-semibold transition-colors"
              >
                Try 5-Role Interactive Demo
              </button>
              <button
                type="button"
                onClick={() => onNavigate('/nasa-data')}
                className="px-5 py-2.5 rounded-lg border border-[#DCE8DC] hover:bg-[#F8FBF6] text-[#10251D] text-sm font-semibold transition-colors"
              >
                Inspect NASA Connectors
              </button>
            </div>
          </div>

          <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              {
                title: '01. Verified Location & Geometry',
                desc: 'Field boundaries stored as GeoJSON polygons with spherical area calculation and MPKV/ICAR agroclimatic zone resolution.',
                icon: MapPin,
              },
              {
                title: '02. Multi-Source NASA & Weather',
                desc: 'Live NASA POWER agroclimatology, NASA CMR GPM/SMAP granule discovery, USGS LandsatLook STAC, and Open-Meteo ET0 forecasts.',
                icon: Satellite,
              },
              {
                title: '03. Budget & Constraint Solver',
                desc: 'Hard checks on season, sowing window, family break rules, water capability, soil pH, and ₹ cultivation budget before ranking.',
                icon: Database,
              },
              {
                title: '04. Autonomous Follow-Up Engine',
                desc: 'Approved plans generate crop-specific tasks; forecast rain/heat spikes trigger traceable schedule review notifications.',
                icon: CheckCircle2,
              },
            ].map((item) => (
              <div
                key={item.title}
                className="p-5 rounded-2xl border border-[#DCE8DC] bg-[#F8FBF6]/70 space-y-2"
              >
                <div className="w-9 h-9 rounded-lg bg-[#063D2A] text-[#A7F33C] flex items-center justify-center">
                  <item.icon className="w-4 h-4" />
                </div>
                <h3 className="font-display font-bold text-base text-[#10251D]">{item.title}</h3>
                <p className="text-sm text-[#52635C] leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* =====================================================================
          FIVE ROLE-BASED WORKSPACES PREVIEW + CTA
      ===================================================================== */}
      <section id="workspaces" className="py-14 px-5 sm:px-8 bg-[#03152B] text-white">
        <div className="max-w-[1320px] mx-auto space-y-8">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div className="space-y-2 max-w-2xl">
              <div className="text-xs font-semibold tracking-wider text-[#A7F33C]">
                BUILT FOR EVERY AGRICULTURAL STAKEHOLDER
              </div>
              <h2 className="font-display font-extrabold text-3xl text-white">
                Five Dedicated, Permission-Enforced Workspaces
              </h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('/login')}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#A7F33C] hover:bg-[#C4FF63] text-[#03152B] font-bold text-sm self-start md:self-auto"
            >
              Launch Workspace <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {[
              {
                role: 'Farmer',
                route: '/farmer/home',
                summary:
                  'Fields, soil tests, ₹ budget, 3 rotation strategies, tasks & grounded AI assistant.',
              },
              {
                role: 'Agronomist',
                route: '/workspace/dashboard',
                summary:
                  'Field evidence inspection, MPKV/ICAR rules & expert plan approval.',
              },
              {
                role: 'FPO Manager',
                route: '/organization/overview',
                summary:
                  'Member register, aggregate crop coverage, follow-up compliance & CSV export.',
              },
              {
                role: 'Org Admin',
                route: '/organization/admin',
                summary:
                  'Organization invitations, scoped role assignment & access audit trail.',
              },
              {
                role: 'Platform Admin',
                route: '/platform/admin',
                summary:
                  'NASA provider health, ingestion pipeline runs & system telemetry.',
              },
            ].map((w) => (
              <div
                key={w.role}
                className="p-4 rounded-xl bg-[#071E38] border border-white/10 flex flex-col justify-between gap-3"
              >
                <div className="space-y-1.5">
                  <div className="text-xs font-mono-tabular text-[#27D7ED]">{w.route}</div>
                  <h3 className="font-display font-bold text-base text-white">{w.role}</h3>
                  <p className="text-xs text-slate-300 leading-relaxed">{w.summary}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('/login')}
                  className="text-xs font-semibold text-[#A7F33C] hover:underline text-left"
                >
                  Open in Demo →
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* =====================================================================
          LOCATION SELECTOR MODAL (Search, GPS, Interactive Map Pin, Coords)
      ===================================================================== */}
      {showLocationModal && (
        <div
          className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="location-modal-title"
        >
          <div className="bg-white text-[#10251D] rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-[#DCE8DC] space-y-4 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-[#075A36]">
                  REAL-TIME NASA EARTH OBSERVATION QUERY
                </div>
                <h3 id="location-modal-title" className="font-display font-bold text-xl mt-0.5">
                  Select Location for Live Satellite &amp; Weather Data
                </h3>
              </div>
              <button
                type="button"
                aria-label="Close location modal"
                onClick={() => setShowLocationModal(false)}
                className="p-1.5 rounded-lg hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Device vs Saved Farm Context Isolation & Privacy Note */}
            {savedFarms.length > 0 && (
              <div className="rounded-xl bg-[#F8FBF6] border border-[#C6E6BD] p-3.5 space-y-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold text-[#063D2A]">
                    Location Context: Saved Farm Priority
                  </span>
                  <span className="font-mono-tabular text-[11px] text-[#52635C]">
                    Active: {locationState.locationType}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {savedFarms.map((sf) => (
                    <button
                      key={sf.id}
                      type="button"
                      disabled={loadingMetrics}
                      onClick={() => {
                        void selectFarmOrField(sf.id, sf.fields?.[0]?.id || null);
                        setShowLocationModal(false);
                      }}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${
                        locationState.farmId === sf.id
                          ? 'bg-[#063D2A] text-white border-[#063D2A]'
                          : 'bg-white text-[#10251D] border-[#DCE8DC] hover:bg-[#E9F7E4]'
                      }`}
                    >
                      Saved Farm: {sf.name} ({sf.village})
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={loadingMetrics}
                    onClick={() => {
                      void switchToDeviceLocation();
                      setShowLocationModal(false);
                    }}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${
                      locationState.locationType === 'DEVICE_LOCATION'
                        ? 'bg-[#063D2A] text-white border-[#063D2A]'
                        : 'bg-white text-[#10251D] border-[#DCE8DC] hover:bg-[#E9F7E4]'
                    }`}
                  >
                    Use Current Device Location
                  </button>
                </div>
                {detected && locationState.locationType === 'DEVICE_LOCATION' && (
                  <div className="pt-1 border-t border-[#DCE8DC] space-y-2">
                    <div className="text-amber-900">
                      Device coordinates ({detected.latitude.toFixed(4)}°N, {detected.longitude.toFixed(4)}°E) do
                      not automatically modify your saved farm boundary.
                    </div>
                    <label className="flex items-center gap-2 font-medium">
                      <input
                        type="checkbox"
                        checked={confirmOverwriteFarm}
                        onChange={(e) => setConfirmOverwriteFarm(e.target.checked)}
                      />
                      Confirm that this device location represents my saved farm &quot;{savedFarms[0].name}&quot;.
                    </label>
                    {confirmOverwriteFarm && (
                      <button
                        type="button"
                        disabled={loadingMetrics}
                        onClick={async () => {
                          await updateSavedFarmWithDeviceLocation(savedFarms[0].id);
                          setConfirmOverwriteFarm(false);
                          setShowLocationModal(false);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-[#A7F33C] text-[#03152B] font-bold text-xs"
                      >
                        Confirm &amp; Update Farm Location
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 4 Selection Modes Header */}
            <div className="flex flex-wrap items-center gap-2 border-b border-[#DCE8DC] pb-3">
              <button
                type="button"
                onClick={() => setLocationTab('search')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  locationTab === 'search'
                    ? 'bg-[#063D2A] text-white'
                    : 'bg-[#F8FBF6] text-[#10251D] border border-[#DCE8DC]'
                }`}
              >
                <Search className="w-3.5 h-3.5" /> Search Village / District
              </button>
              <button
                type="button"
                onClick={() => setLocationTab('map')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  locationTab === 'map'
                    ? 'bg-[#063D2A] text-white'
                    : 'bg-[#F8FBF6] text-[#10251D] border border-[#DCE8DC]'
                }`}
              >
                <MapPin className="w-3.5 h-3.5" /> Select from Map
              </button>
              <button
                type="button"
                onClick={() => setLocationTab('coords')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  locationTab === 'coords'
                    ? 'bg-[#063D2A] text-white'
                    : 'bg-[#F8FBF6] text-[#10251D] border border-[#DCE8DC]'
                }`}
              >
                Enter Coordinates
              </button>
              <button
                type="button"
                disabled={loadingMetrics}
                onClick={() => {
                  void handleUseMyLocation();
                  setShowLocationModal(false);
                }}
                className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#E9F7E4] hover:bg-[#D6EED0] text-[#063D2A] border border-[#C6E6BD] text-xs font-semibold transition-colors"
              >
                <Compass className="w-3.5 h-3.5" /> Detect My Location
              </button>
            </div>

            {locationTab === 'search' && (
              <div className="space-y-3">
                <form onSubmit={handleSearchLocations} className="flex gap-2">
                  <input
                    type="text"
                    aria-label="Search village or district name"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Type village, taluka or district (e.g., Kopargaon, Shirdi, Ludhiana)..."
                    className="flex-1 px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm text-[#10251D]"
                  />
                  <button
                    type="submit"
                    disabled={searchingLocation}
                    className="px-4 py-2 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
                  >
                    {searchingLocation ? 'Searching...' : 'Search'}
                  </button>
                </form>

                {searchResults.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded-xl border border-[#DCE8DC] divide-y divide-[#DCE8DC]">
                    {searchResults.map((loc, idx) => (
                      <button
                        key={`${loc.lat}-${loc.lon}-${idx}`}
                        type="button"
                        disabled={loadingMetrics}
                        onClick={() =>
                          void persistAndFetchLocation(loc.lat, loc.lon, loc.label)
                        }
                        className="w-full text-left px-3.5 py-2.5 text-xs hover:bg-[#F8FBF6] flex items-center justify-between gap-2"
                      >
                        <span className="font-medium text-[#10251D]">{loc.label}</span>
                        <span className="font-mono-tabular text-[#075A36]">
                          {loc.lat.toFixed(4)}°N, {loc.lon.toFixed(4)}°E
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="pt-1 space-y-1.5">
                  <div className="text-[11px] font-semibold text-[#52635C]">
                    Quick Regional Test Pins (Real Live Queries):
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      {
                        label: 'Kopargaon, Maharashtra',
                        lat: 19.8825,
                        lon: 74.4789,
                      },
                      {
                        label: 'Ludhiana, Punjab',
                        lat: 30.901,
                        lon: 75.8573,
                      },
                      {
                        label: 'Nashik, Maharashtra',
                        lat: 19.9975,
                        lon: 73.7898,
                      },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        disabled={loadingMetrics}
                        onClick={() =>
                          void persistAndFetchLocation(preset.lat, preset.lon, preset.label)
                        }
                        className="px-3 py-1.5 rounded-lg border border-[#DCE8DC] bg-[#F8FBF6] hover:bg-[#E9F7E4] text-xs font-medium text-[#10251D]"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {locationTab === 'map' && (
              <div className="space-y-3">
                <p className="text-xs text-[#52635C]">
                  Click anywhere on the map to place a pin, then fetch live NASA satellite &amp;
                  weather observations for those exact coordinates.
                </p>
                <FieldMap
                  centerLat={mapPinLat}
                  centerLon={mapPinLon}
                  mode="pick_point"
                  onPickPoint={(lat, lon) => {
                    setMapPinLat(lat);
                    setMapPinLon(lon);
                  }}
                  heightClass="h-64"
                />
                <div className="flex items-center justify-between gap-3 pt-1">
                  <div className="text-xs font-mono-tabular text-[#10251D]">
                    Pinned: {mapPinLat.toFixed(4)}°N, {mapPinLon.toFixed(4)}°E
                  </div>
                  <button
                    type="button"
                    disabled={loadingMetrics}
                    onClick={() =>
                      void persistAndFetchLocation(
                        mapPinLat,
                        mapPinLon,
                        `Map Pin (${mapPinLat.toFixed(4)}°N, ${mapPinLon.toFixed(4)}°E)`
                      )
                    }
                    className="px-4 py-2 rounded-lg bg-[#A7F33C] text-[#03152B] font-bold text-xs"
                  >
                    {loadingMetrics ? 'Fetching NASA Data...' : 'Confirm Pin & Fetch NASA Data'}
                  </button>
                </div>
              </div>
            )}

            {locationTab === 'coords' && (
              <form onSubmit={handleManualCoordsSubmit} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="coord-lat" className="block text-xs font-semibold mb-1">
                      Latitude (-90 to 90)
                    </label>
                    <input
                      id="coord-lat"
                      type="number"
                      step="0.0001"
                      value={manualLat}
                      onChange={(e) => setManualLat(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] font-mono-tabular text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="coord-lon" className="block text-xs font-semibold mb-1">
                      Longitude (-180 to 180)
                    </label>
                    <input
                      id="coord-lon"
                      type="number"
                      step="0.0001"
                      value={manualLon}
                      onChange={(e) => setManualLon(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] font-mono-tabular text-sm"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={loadingMetrics}
                  className="px-4 py-2 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
                >
                  {loadingMetrics ? 'Fetching Live Data...' : 'Fetch NASA Observations'}
                </button>
              </form>
            )}

            {/* Clear Location Privacy Disclosure & Clear Control */}
            <div className="rounded-xl bg-[#F8FBF6] border border-[#DCE8DC] p-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#52635C]">
              <span>
                Location Privacy: Single-request browser coordinates are used solely to resolve local NASA satellite grid cells and are never tracked in the background.
              </span>
              {locationState.selected && (
                <button
                  type="button"
                  onClick={() => {
                    void clearLocation();
                    setShowLocationModal(false);
                  }}
                  className="px-2.5 py-1 rounded-md border border-[#DCE8DC] bg-white hover:bg-red-50 text-red-700 font-semibold whitespace-nowrap"
                >
                  Clear Location
                </button>
              )}
            </div>

            {fetchError && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
                {fetchError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          DATA SOURCE DETAIL & PROVENANCE MODAL (METRIC CLICK)
      ===================================================================== */}
      {selectedMetric && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="metric-modal-title"
        >
          <div className="bg-white text-[#10251D] rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-[#DCE8DC] space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-[#075A36]">
                  ENVIRONMENTAL DATA PROVENANCE &amp; LIMITATIONS
                </div>
                <h3 id="metric-modal-title" className="font-display font-bold text-xl mt-0.5">
                  {selectedMetric.label}
                </h3>
              </div>
              <button
                type="button"
                aria-label="Close provenance dialog"
                onClick={() => setSelectedMetric(null)}
                className="p-1.5 rounded-lg hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm bg-[#F8FBF6] p-4 rounded-xl border border-[#DCE8DC]">
              <div>
                <div className="text-xs text-[#52635C]">Observed Value</div>
                <div className="font-bold font-mono-tabular text-base">
                  {selectedMetric.value !== null
                    ? `${selectedMetric.value} ${selectedMetric.unit}`
                    : 'Unavailable'}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#52635C]">Freshness</div>
                <div className="font-semibold text-xs text-[#063D2A]">
                  {selectedMetric.freshnessStatus}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#52635C]">Native Resolution</div>
                <div className="font-medium text-xs">{selectedMetric.spatialResolution}</div>
              </div>
              <div>
                <div className="text-xs text-[#52635C]">Provider / Dataset</div>
                <div className="font-medium text-xs">
                  {selectedMetric.provider} · {selectedMetric.productVersion}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#52635C]">Granule / Scene ID</div>
                <div className="font-mono-tabular text-[11px] break-all">
                  {selectedMetric.granuleOrSceneId || 'Grid point aggregate'}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#52635C]">Observation / Retrieval</div>
                <div className="font-mono-tabular text-[11px]">
                  {selectedMetric.observationEnd
                    ? selectedMetric.observationEnd.slice(0, 16)
                    : '—'}{' '}
                  / {selectedMetric.retrievalTime ? selectedMetric.retrievalTime.slice(0, 16) : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#52635C]">Grid Cell / Sensor</div>
                <div className="font-mono-tabular text-[11px] break-all">
                  {selectedMetric.gridCellId || '—'}
                  {selectedMetric.sensor ? ` (${selectedMetric.sensor})` : ''}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#52635C]">Extraction / Pixel Dist.</div>
                <div className="font-mono-tabular text-[11px]">
                  {selectedMetric.extractionMethod || 'POINT_CELL_INTERSECT'}
                  {selectedMetric.pixelDistanceM != null ? ` · ${selectedMetric.pixelDistanceM} m` : ''}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#52635C]">WRS-2 / Observation Age</div>
                <div className="font-mono-tabular text-[11px]">
                  {selectedMetric.wrsPathRow || '—'}
                  {selectedMetric.ageHours != null ? ` · ${selectedMetric.ageHours}h old` : ''}
                </div>
              </div>
            </div>

            {provenanceData?.spatialGrids && (
              <div className="rounded-xl bg-[#F8FBF6] border border-[#DCE8DC] p-3 text-[11px] text-[#52635C] space-y-1">
                <div className="font-semibold text-[#063D2A]">Spatial Grid Intersections (WGS84 / EPSG:4326)</div>
                <div className="font-mono-tabular">
                  GPM: {provenanceData.spatialGrids.gpmGridId} ({provenanceData.spatialGrids.gpmDistanceM} m) · SMAP:{' '}
                  {provenanceData.spatialGrids.smapEaseGridId} ({provenanceData.spatialGrids.smapDistanceM} m) · POWER:{' '}
                  {provenanceData.spatialGrids.powerGridId} ({provenanceData.spatialGrids.powerDistanceM} m)
                </div>
              </div>
            )}

            <p className="text-xs text-[#52635C] leading-relaxed">{selectedMetric.qualityNote}</p>

            {selectedMetric.requiresCredentials && (
              <div className="text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3">
                Credential Disclosure:{' '}
                <span className="font-mono-tabular font-semibold">
                  {selectedMetric.requiresCredentials}
                </span>
              </div>
            )}

            {locationState.selected && (
              <div className="space-y-1.5">
                <div className="text-xs font-bold text-[#10251D]">
                  Recent Stored Provider Records ({locationState.latitude?.toFixed(3)}°N,{' '}
                  {locationState.longitude?.toFixed(3)}°E)
                </div>
                {loadingDetails ? (
                  <p className="text-xs text-[#52635C]">Loading raw observation log...</p>
                ) : observationDetails.length === 0 ? (
                  <p className="text-xs text-[#52635C]">
                    No stored observation rows yet for this pin. Click Refresh or pick a pin.
                  </p>
                ) : (
                  <div className="max-h-40 overflow-y-auto border border-[#DCE8DC] rounded-xl divide-y divide-[#DCE8DC] text-[11px]">
                    {observationDetails.slice(0, 10).map((obs) => (
                      <div key={obs.id} className="px-3 py-1.5 flex items-center justify-between gap-2">
                        <span className="font-medium text-[#10251D] truncate">
                          {obs.source_id} · {obs.variable}
                        </span>
                        <span className="font-mono-tabular text-[#52635C] truncate">
                          {obs.value !== null
                            ? `${obs.value} ${obs.unit || ''}`
                            : obs.granule_or_scene_id || obs.quality_status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-[#DCE8DC]">
              <a
                href={selectedMetric.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-semibold text-[#075A36] hover:underline"
              >
                Official Provider Documentation ↗
              </a>
              <button
                type="button"
                onClick={() => setSelectedMetric(null)}
                className="px-4 py-2 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          STRATEGY COMPARISON MODAL (STRATEGY CARD CLICK)
      ===================================================================== */}
      {activeStrategyModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="strategy-modal-title"
        >
          <div className="bg-white text-[#10251D] rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-[#DCE8DC] space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-[#075A36]">
                  DETERMINISTIC ROTATION PREVIEW · {strategyPreview?.algorithmVersion}
                </div>
                <h3 id="strategy-modal-title" className="font-display font-bold text-xl mt-0.5">
                  {activeStrategyModal.title}
                  {activeStrategyModal.proposedCrop ? ` — ${activeStrategyModal.proposedCrop}` : ''}
                </h3>
              </div>
              <button
                type="button"
                aria-label="Close strategy comparison"
                onClick={() => setActiveStrategyModal(null)}
                className="p-1.5 rounded-lg hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-[#F8FBF6] p-3.5 rounded-xl border border-[#DCE8DC] text-xs">
              <div>
                <div className="text-[#52635C]">Feasibility</div>
                <div
                  className={`font-bold ${
                    activeStrategyModal.feasible ? 'text-[#1D7F3C]' : 'text-red-700'
                  }`}
                >
                  {activeStrategyModal.feasible ? 'FEASIBLE' : 'CONSTRAINT VIOLATION'}
                </div>
              </div>
              <div>
                <div className="text-[#52635C]">Crop Family</div>
                <div className="font-semibold">{activeStrategyModal.cropFamily || '—'}</div>
              </div>
              <div>
                <div className="text-[#52635C]">Est. Cost (2.5 ac)</div>
                <div className="font-mono-tabular font-bold">
                  {activeStrategyModal.estimatedTotalCostInr !== null
                    ? `₹${activeStrategyModal.estimatedTotalCostInr.toLocaleString('en-IN')}`
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-[#52635C]">Sowing Window</div>
                <div className="font-semibold">{activeStrategyModal.sowingWindow || '—'}</div>
              </div>
            </div>

            <p className="text-sm text-[#10251D] leading-relaxed">{activeStrategyModal.rationale}</p>

            {activeStrategyModal.costBreakdown && (
              <div className="bg-[#F8FBF6] border border-[#DCE8DC] rounded-xl p-3.5 space-y-2">
                <div className="text-xs font-bold text-[#075A36]">
                  Stage-Wise Estimated Cost Breakdown (Per Acre · Indicative MPKV Reference)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                  <div>
                    <div className="text-[#52635C]">Seeds</div>
                    <div className="font-mono-tabular font-semibold">
                      ₹{activeStrategyModal.costBreakdown.seeds.toLocaleString('en-IN')}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#52635C]">Land Prep</div>
                    <div className="font-mono-tabular font-semibold">
                      ₹{activeStrategyModal.costBreakdown.landPrep.toLocaleString('en-IN')}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#52635C]">Fertilizer</div>
                    <div className="font-mono-tabular font-semibold">
                      ₹{activeStrategyModal.costBreakdown.fertilizer.toLocaleString('en-IN')}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#52635C]">Irrigation</div>
                    <div className="font-mono-tabular font-semibold">
                      ₹{activeStrategyModal.costBreakdown.irrigation.toLocaleString('en-IN')}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#52635C]">Labor &amp; Harvest</div>
                    <div className="font-mono-tabular font-semibold">
                      ₹{activeStrategyModal.costBreakdown.laborAndHarvest.toLocaleString('en-IN')}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeStrategyModal.hardConstraintsPassed.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-[#1D7F3C] mb-1">
                  Hard Constraints Passed
                </div>
                <ul className="space-y-1 text-xs text-[#52635C] list-disc pl-5">
                  {activeStrategyModal.hardConstraintsPassed.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            {activeStrategyModal.hardConstraintsFailed.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-red-700 mb-1">
                  Hard Constraints Failed
                </div>
                <ul className="space-y-1 text-xs text-red-700 list-disc pl-5">
                  {activeStrategyModal.hardConstraintsFailed.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-[#DCE8DC]">
              <span className="text-xs text-[#52635C]">
                Public contextual preview ({locationState.label || 'Kopargaon Sample'}). Log in for
                your persistent farm history &amp; budget.
              </span>
              <button
                type="button"
                onClick={() => {
                  setActiveStrategyModal(null);
                  onNavigate('/login');
                }}
                className="px-4 py-2 rounded-lg bg-[#A7F33C] text-[#03152B] font-bold text-xs whitespace-nowrap"
              >
                Run On Your Farm →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
