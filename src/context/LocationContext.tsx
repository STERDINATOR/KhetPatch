import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AuthenticatedContext } from '../../server/auth/authService';
import type {
  ActiveLocationContext,
  EnvironmentalMetricSummary,
  ReverseGeocodeResult,
  RotationAnalysisResult,
} from '../../shared/types';

export type GeolocationPermissionState =
  | 'checking'
  | 'prompt'
  | 'granted'
  | 'denied'
  | 'unsupported'
  | 'insecure';

export type LocationUpdateStatus =
  | 'idle'
  | 'checking_permission'
  | 'acquiring_gps'
  | 'resolving_address'
  | 'syncing_nasa'
  | 'ready'
  | 'error';

export interface SavedFarmSummary {
  id: string;
  name: string;
  village: string;
  taluka: string;
  district: string;
  state: string;
  latitude: number;
  longitude: number;
  fields: Array<{
    id: string;
    name: string;
    centroid_lat: number;
    centroid_lon: number;
    area_acres: number;
  }>;
}

export interface DetectedCoordinatesRecord {
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
  captured_at: string;
  resolved_address: string | null;
  village: string | null;
  taluka: string | null;
  district: string | null;
  state: string | null;
  country: string | null;
  timezone: string | null;
  resolution_source: string | null;
}

interface LocationContextValue {
  context: ActiveLocationContext;
  detected: DetectedCoordinatesRecord | null;
  savedFarms: SavedFarmSummary[];
  metrics: EnvironmentalMetricSummary[];
  strategyPreview: (RotationAnalysisResult & { isDemoPreview?: boolean }) | null;
  permissionStatus: GeolocationPermissionState;
  updateStatus: LocationUpdateStatus;
  initialLoading: boolean;
  syncing: boolean;
  error: string | null;
  lowAccuracyWarning: string | null;
  requiresConfirmationToSwitchToDevice: boolean;
  clearError: () => void;
  refreshUnifiedLocation: () => Promise<void>;
  detectMyLocation: (options?: { forceActivateDevice?: boolean }) => Promise<void>;
  selectManualLocation: (params: {
    latitude: number;
    longitude: number;
    label?: string;
    locationType?: 'MANUAL' | 'SHOWCASE';
  }) => Promise<void>;
  selectFarmOrField: (farmId: string, fieldId?: string | null) => Promise<void>;
  switchToDeviceLocation: () => Promise<void>;
  updateSavedFarmWithDeviceLocation: (farmId: string) => Promise<void>;
  syncCurrentLocationNasa: (force?: boolean) => Promise<void>;
  clearLocation: () => Promise<void>;
}

const DEFAULT_EMPTY_METRICS: EnvironmentalMetricSummary[] = [
  {
    metricKey: 'rainfall',
    label: 'Rainfall (Last 7 days)',
    value: null,
    unit: 'mm',
    provider: 'NASA GPM / POWER',
    dataset: 'GPM_3IMERGDF & POWER PRECTOTCORR',
    productVersion: 'V07 / Daily 2.0',
    spatialResolution: '0.1° (~10 km GPM) / 0.5° (POWER)',
    observationStart: null,
    observationEnd: null,
    retrievalTime: null,
    freshnessStatus: 'No suitable observation',
    qualityNote: 'Select or detect a location to fetch 7-day precipitation accumulation.',
    sourceUrl: 'https://disc.gsfc.nasa.gov/datasets/GPM_3IMERGDF_07/summary',
  },
  {
    metricKey: 'soil_moisture',
    label: 'Soil Moisture',
    value: null,
    unit: 'm³/m³',
    provider: 'NASA SMAP L4',
    dataset: 'SPL4SMGP',
    productVersion: 'v7 / Model Surface Fallback',
    spatialResolution: '9 km EASE-Grid 2.0',
    observationStart: null,
    observationEnd: null,
    retrievalTime: null,
    freshnessStatus: 'No suitable observation',
    qualityNote: 'Select or detect a location to retrieve surface soil moisture.',
    sourceUrl: 'https://smap.jpl.nasa.gov/',
  },
  {
    metricKey: 'ndvi',
    label: 'Vegetation Health',
    value: null,
    unit: 'NDVI',
    provider: 'Landsat 8/9 C2L2',
    dataset: 'LANDSAT_C2L2_SR',
    productVersion: 'Collection 2 Level-2',
    spatialResolution: '30 m',
    observationStart: null,
    observationEnd: null,
    retrievalTime: null,
    freshnessStatus: 'No suitable observation',
    qualityNote: 'Select or detect a location to discover the latest cloud-screened scene.',
    sourceUrl: 'https://landsatlook.usgs.gov/stac-server/',
  },
  {
    metricKey: 'temperature',
    label: 'Temperature (Avg.)',
    value: null,
    unit: '°C',
    provider: 'NASA POWER',
    dataset: 'POWER Daily Agroclimatology',
    productVersion: 'v2.0',
    spatialResolution: '0.5° × 0.625°',
    observationStart: null,
    observationEnd: null,
    retrievalTime: null,
    freshnessStatus: 'No suitable observation',
    qualityNote: 'Select or detect a location to retrieve NASA POWER 2m air temperature.',
    sourceUrl: 'https://power.larc.nasa.gov/',
  },
];

const CLEARED_SESSION_FLAG = 'kp_location_cleared';

const LocationContext = createContext<LocationContextValue | undefined>(undefined);

function isSecureOriginForGeolocation(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function neutralizeMetricValues(prev: EnvironmentalMetricSummary[]): EnvironmentalMetricSummary[] {
  const base = prev.length === 4 ? prev : DEFAULT_EMPTY_METRICS;
  return base.map((m) => ({
    ...m,
    value: null,
    series: undefined,
    granuleOrSceneId: null,
    gridCellId: null,
    pixelDistanceM: null,
    observationStart: null,
    observationEnd: null,
  }));
}

export function LocationProvider({
  authenticatedUser,
  authChecked,
  children,
}: {
  authenticatedUser: AuthenticatedContext | null;
  authChecked: boolean;
  children: React.ReactNode;
}) {
  const [context, setContext] = useState<ActiveLocationContext>({
    selected: false,
    locationType: 'NONE',
    label: null,
    latitude: null,
    longitude: null,
  });
  const [detected, setDetected] = useState<DetectedCoordinatesRecord | null>(null);
  const [savedFarms, setSavedFarms] = useState<SavedFarmSummary[]>([]);
  const [metrics, setMetrics] = useState<EnvironmentalMetricSummary[]>(DEFAULT_EMPTY_METRICS);
  const [strategyPreview, setStrategyPreview] = useState<
    (RotationAnalysisResult & { isDemoPreview?: boolean }) | null
  >(null);
  const [permissionStatus, setPermissionStatus] = useState<GeolocationPermissionState>('checking');
  const [updateStatus, setUpdateStatus] = useState<LocationUpdateStatus>('checking_permission');
  const [initialLoading, setInitialLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lowAccuracyWarning, setLowAccuracyWarning] = useState<string | null>(null);

  const requestSeqRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const autoDetectTriggeredRef = useRef(false);

  const startNewRequest = useCallback(() => {
    requestSeqRef.current += 1;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    return { seq: requestSeqRef.current, signal: controller.signal };
  }, []);

  const loadStrategyPreview = useCallback(async (lat: number, lon: number, signal?: AbortSignal) => {
    try {
      const res = await apiFetch<RotationAnalysisResult & { isDemoPreview?: boolean }>(
        `/public/strategy-preview?lat=${lat}&lon=${lon}`,
        { signal }
      );
      return res;
    } catch {
      return null;
    }
  }, []);

  const queryBrowserPermission = useCallback(async (): Promise<GeolocationPermissionState> => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return 'unsupported';
    }
    if (!isSecureOriginForGeolocation()) {
      return 'insecure';
    }
    try {
      if (navigator.permissions && typeof navigator.permissions.query === 'function') {
        const res = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
        const mapped = res.state as GeolocationPermissionState;
        res.onchange = () => {
          setPermissionStatus(res.state as GeolocationPermissionState);
        };
        return mapped;
      }
    } catch {
      // Safari / restricted contexts may throw on permissions.query
    }
    return 'prompt';
  }, []);

  const clearLocationFlags = () => {
    try {
      sessionStorage.removeItem(CLEARED_SESSION_FLAG);
    } catch {
      // ignore
    }
  };

  const acquireBrowserCoords = useCallback((): Promise<{
    latitude: number;
    longitude: number;
    accuracy_meters: number | null;
    captured_at: string;
  }> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('UNSUPPORTED_BROWSER'));
        return;
      }
      if (!isSecureOriginForGeolocation()) {
        reject(new Error('HTTPS_REQUIRED'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            latitude: Number(pos.coords.latitude.toFixed(6)),
            longitude: Number(pos.coords.longitude.toFixed(6)),
            accuracy_meters: Number.isFinite(pos.coords.accuracy)
              ? Math.round(pos.coords.accuracy)
              : null,
            captured_at: new Date(pos.timestamp || Date.now()).toISOString(),
          });
        },
        (geoErr) => {
          if (geoErr.code === 1) reject(new Error('PERMISSION_DENIED'));
          else if (geoErr.code === 2) reject(new Error('POSITION_UNAVAILABLE'));
          else if (geoErr.code === 3) reject(new Error('TIMEOUT'));
          else reject(new Error(geoErr.message || 'GEOLOCATION_FAILED'));
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 60000,
        }
      );
    });
  }, []);

  const detectMyLocation = useCallback(
    async (options?: { forceActivateDevice?: boolean }) => {
      const { seq, signal } = startNewRequest();
      clearLocationFlags();
      setError(null);
      setLowAccuracyWarning(null);
      setSyncing(true);
      setUpdateStatus('acquiring_gps');
      setMetrics((prev) => neutralizeMetricValues(prev));

      try {
        const coords = await acquireBrowserCoords();
        if (seq !== requestSeqRef.current) return;

        setPermissionStatus('granted');
        if (coords.accuracy_meters !== null && coords.accuracy_meters > 25000) {
          setLowAccuracyWarning(
            `Low location accuracy (±${Math.round(coords.accuracy_meters / 1000)} km). You can confirm a tighter village or map pin.`
          );
        }

        setUpdateStatus('resolving_address');

        const detectRes = await apiFetch<{
          resolved: ReverseGeocodeResult;
          context: ActiveLocationContext;
          detected: DetectedCoordinatesRecord | null;
          savedFarms: SavedFarmSummary[];
          hasSavedFarm: boolean;
          metrics: EnvironmentalMetricSummary[];
        }>('/location/detect', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy_meters: coords.accuracy_meters,
            captured_at: coords.captured_at,
            permission_status: 'granted',
            trigger_sync: true,
          }),
        });
        if (seq !== requestSeqRef.current) return;

        // If authenticated farmer explicitly requested switching context to device location
        if (options?.forceActivateDevice && detectRes.hasSavedFarm) {
          const switchRes = await apiFetch<{
            context: ActiveLocationContext;
            metrics: EnvironmentalMetricSummary[];
          }>('/location/select', {
            method: 'POST',
            signal,
            body: JSON.stringify({
              locationType: 'DEVICE_LOCATION',
              latitude: coords.latitude,
              longitude: coords.longitude,
              triggerSync: true,
            }),
          });
          if (seq !== requestSeqRef.current) return;
          setContext(switchRes.context);
          setMetrics(switchRes.metrics || DEFAULT_EMPTY_METRICS);
          setDetected(detectRes.detected);
          setSavedFarms(detectRes.savedFarms || []);
          const pLat = switchRes.context.latitude ?? coords.latitude;
          const pLon = switchRes.context.longitude ?? coords.longitude;
          const preview = await loadStrategyPreview(pLat, pLon, signal);
          if (seq === requestSeqRef.current && preview) setStrategyPreview(preview);
          setUpdateStatus('ready');
          return;
        }

        setDetected(detectRes.detected);
        setSavedFarms(detectRes.savedFarms || []);
        setContext(detectRes.context);
        setMetrics(detectRes.metrics || DEFAULT_EMPTY_METRICS);

        const pLat = detectRes.context.latitude ?? coords.latitude;
        const pLon = detectRes.context.longitude ?? coords.longitude;
        const preview = await loadStrategyPreview(pLat, pLon, signal);
        if (seq === requestSeqRef.current && preview) {
          setStrategyPreview(preview);
        }
        if (seq === requestSeqRef.current) {
          setUpdateStatus('ready');
        }
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        const msg = err instanceof Error ? err.message : 'GEOLOCATION_FAILED';
        if (msg === 'AbortError' || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        if (msg === 'PERMISSION_DENIED') {
          setPermissionStatus('denied');
          setError(
            'Location permission denied. Use "Choose Location" below to search a village, pin on the map, or enter coordinates.'
          );
        } else if (msg === 'POSITION_UNAVAILABLE') {
          setError('Device location services are currently disabled or unavailable. Choose a location manually.');
        } else if (msg === 'TIMEOUT') {
          setError('Location request timed out. Please try again or pick your farm on the map.');
        } else if (msg === 'UNSUPPORTED_BROWSER') {
          setPermissionStatus('unsupported');
          setError('Browser geolocation is not supported here. Select your location manually.');
        } else if (msg === 'HTTPS_REQUIRED') {
          setPermissionStatus('insecure');
          setError('Automatic geolocation requires HTTPS or localhost. Choose a location manually.');
        } else {
          setError(msg);
        }
        setUpdateStatus('error');
      } finally {
        if (seq === requestSeqRef.current) {
          setSyncing(false);
        }
      }
    },
    [acquireBrowserCoords, loadStrategyPreview, startNewRequest]
  );

  const refreshUnifiedLocation = useCallback(async () => {
    const { seq, signal } = startNewRequest();
    setInitialLoading(true);
    setError(null);

    try {
      const [perm, currentRes] = await Promise.all([
        queryBrowserPermission(),
        apiFetch<{
          context: ActiveLocationContext;
          detected: DetectedCoordinatesRecord | null;
          savedFarms: SavedFarmSummary[];
        }>('/location/current', { signal }),
      ]);
      if (seq !== requestSeqRef.current) return;

      setPermissionStatus(perm);
      setContext(currentRes.context);
      setDetected(currentRes.detected);
      setSavedFarms(currentRes.savedFarms || []);

      if (
        currentRes.context.selected &&
        currentRes.context.latitude !== null &&
        currentRes.context.longitude !== null
      ) {
        setUpdateStatus('syncing_nasa');
        const [metricsRes, previewRes] = await Promise.all([
          apiFetch<{ metrics: EnvironmentalMetricSummary[] }>('/nasa/location-metrics', { signal }),
          loadStrategyPreview(currentRes.context.latitude, currentRes.context.longitude, signal),
        ]);
        if (seq !== requestSeqRef.current) return;

        const hasValues = (metricsRes.metrics || []).some((m) => m.value !== null);
        if (hasValues) {
          setMetrics(metricsRes.metrics);
        } else {
          // Persist first sync for newly selected farm/session location
          const synced = await apiFetch<{ metrics: EnvironmentalMetricSummary[] }>('/nasa/sync-location', {
            method: 'POST',
            signal,
            body: JSON.stringify({
              latitude: currentRes.context.latitude,
              longitude: currentRes.context.longitude,
              locationType: currentRes.context.locationType,
              farmId: currentRes.context.farmId || null,
              fieldId: currentRes.context.fieldId || null,
            }),
          });
          if (seq !== requestSeqRef.current) return;
          setMetrics(synced.metrics || DEFAULT_EMPTY_METRICS);
        }

        if (previewRes) setStrategyPreview(previewRes);
        setUpdateStatus('ready');
      } else {
        setMetrics(DEFAULT_EMPTY_METRICS);
        const previewRes = await loadStrategyPreview(19.8825, 74.4789, signal);
        if (seq === requestSeqRef.current && previewRes) {
          setStrategyPreview(previewRes);
        }

        const wasCleared = (() => {
          try {
            return sessionStorage.getItem(CLEARED_SESSION_FLAG) === '1';
          } catch {
            return false;
          }
        })();

        // Step 1-2 of Section 1: If permission was previously granted and user has no saved active location, auto-acquire once
        if (perm === 'granted' && !wasCleared && !autoDetectTriggeredRef.current) {
          autoDetectTriggeredRef.current = true;
          setInitialLoading(false);
          await detectMyLocation();
          return;
        }

        setUpdateStatus('idle');
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setUpdateStatus('error');
    } finally {
      if (seq === requestSeqRef.current) {
        setInitialLoading(false);
      }
    }
  }, [detectMyLocation, loadStrategyPreview, queryBrowserPermission, startNewRequest]);

  useEffect(() => {
    if (!authChecked) return;
    void refreshUnifiedLocation();
  }, [authChecked, authenticatedUser?.userId, authenticatedUser?.activeRole, refreshUnifiedLocation]);

  const selectManualLocation = useCallback(
    async (params: {
      latitude: number;
      longitude: number;
      label?: string;
      locationType?: 'MANUAL' | 'SHOWCASE';
    }) => {
      const { seq, signal } = startNewRequest();
      clearLocationFlags();
      setError(null);
      setLowAccuracyWarning(null);
      setSyncing(true);
      setUpdateStatus('resolving_address');
      setMetrics((prev) => neutralizeMetricValues(prev));

      try {
        const res = await apiFetch<{
          context: ActiveLocationContext;
          metrics: EnvironmentalMetricSummary[];
        }>('/location/select', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            locationType: params.locationType || 'MANUAL',
            latitude: params.latitude,
            longitude: params.longitude,
            label: params.label,
            triggerSync: true,
          }),
        });
        if (seq !== requestSeqRef.current) return;

        setContext(res.context);
        setMetrics(res.metrics || DEFAULT_EMPTY_METRICS);
        const preview = await loadStrategyPreview(
          res.context.latitude ?? params.latitude,
          res.context.longitude ?? params.longitude,
          signal
        );
        if (seq === requestSeqRef.current && preview) setStrategyPreview(preview);
        if (seq === requestSeqRef.current) setUpdateStatus('ready');
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (seq === requestSeqRef.current) {
          setError(err instanceof Error ? err.message : 'Unable to fetch NASA observations.');
          setUpdateStatus('error');
        }
      } finally {
        if (seq === requestSeqRef.current) setSyncing(false);
      }
    },
    [loadStrategyPreview, startNewRequest]
  );

  const selectFarmOrField = useCallback(
    async (farmId: string, fieldId?: string | null) => {
      const { seq, signal } = startNewRequest();
      clearLocationFlags();
      setError(null);
      setLowAccuracyWarning(null);
      setSyncing(true);
      setUpdateStatus('syncing_nasa');
      setMetrics((prev) => neutralizeMetricValues(prev));

      try {
        const res = await apiFetch<{
          context: ActiveLocationContext;
          metrics: EnvironmentalMetricSummary[];
        }>('/location/select', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            locationType: fieldId ? 'FIELD' : 'FARM',
            farmId,
            fieldId: fieldId || undefined,
            triggerSync: true,
          }),
        });
        if (seq !== requestSeqRef.current) return;

        setContext(res.context);
        setMetrics(res.metrics || DEFAULT_EMPTY_METRICS);
        if (res.context.latitude !== null && res.context.longitude !== null) {
          const preview = await loadStrategyPreview(res.context.latitude, res.context.longitude, signal);
          if (seq === requestSeqRef.current && preview) setStrategyPreview(preview);
        }
        if (seq === requestSeqRef.current) setUpdateStatus('ready');
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (seq === requestSeqRef.current) {
          setError(err instanceof Error ? err.message : 'Unable to switch active farm context.');
          setUpdateStatus('error');
        }
      } finally {
        if (seq === requestSeqRef.current) setSyncing(false);
      }
    },
    [loadStrategyPreview, startNewRequest]
  );

  const switchToDeviceLocation = useCallback(async () => {
    if (detected) {
      const { seq, signal } = startNewRequest();
      clearLocationFlags();
      setError(null);
      setSyncing(true);
      setUpdateStatus('syncing_nasa');
      setMetrics((prev) => neutralizeMetricValues(prev));
      try {
        const res = await apiFetch<{
          context: ActiveLocationContext;
          metrics: EnvironmentalMetricSummary[];
        }>('/location/select', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            locationType: 'DEVICE_LOCATION',
            latitude: detected.latitude,
            longitude: detected.longitude,
            triggerSync: true,
          }),
        });
        if (seq !== requestSeqRef.current) return;
        setContext(res.context);
        setMetrics(res.metrics || DEFAULT_EMPTY_METRICS);
        setUpdateStatus('ready');
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (seq === requestSeqRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to switch to device location.');
          setUpdateStatus('error');
        }
      } finally {
        if (seq === requestSeqRef.current) setSyncing(false);
      }
      return;
    }
    await detectMyLocation({ forceActivateDevice: true });
  }, [detected, detectMyLocation, startNewRequest]);

  const updateSavedFarmWithDeviceLocation = useCallback(
    async (farmId: string) => {
      if (!detected) return;
      setSyncing(true);
      setError(null);
      try {
        await apiFetch(`/farms/${farmId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            latitude: detected.latitude,
            longitude: detected.longitude,
            village: detected.village || undefined,
            taluka: detected.taluka || undefined,
            district: detected.district || undefined,
            state: detected.state || undefined,
            locationMethod: 'GEOLOCATION',
            locationConfirmed: true,
          }),
        });
        await selectFarmOrField(farmId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to update saved farm coordinates.');
        setSyncing(false);
      }
    },
    [detected, selectFarmOrField]
  );

  const syncCurrentLocationNasa = useCallback(
    async (force = true) => {
      if (!context.selected || context.latitude === null || context.longitude === null) {
        return;
      }
      const { seq, signal } = startNewRequest();
      setSyncing(true);
      setError(null);
      setUpdateStatus('syncing_nasa');

      try {
        const res = await apiFetch<{
          metrics: EnvironmentalMetricSummary[];
        }>('/nasa/sync-location', {
          method: 'POST',
          signal,
          body: JSON.stringify({
            latitude: context.latitude,
            longitude: context.longitude,
            locationType: context.locationType,
            farmId: context.farmId || null,
            fieldId: context.fieldId || null,
            force,
          }),
        });
        if (seq !== requestSeqRef.current) return;
        setMetrics(res.metrics || DEFAULT_EMPTY_METRICS);
        setUpdateStatus('ready');
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (seq === requestSeqRef.current) {
          setError(err instanceof Error ? err.message : 'Live NASA refresh failed.');
          setUpdateStatus('error');
        }
      } finally {
        if (seq === requestSeqRef.current) setSyncing(false);
      }
    },
    [context, startNewRequest]
  );

  const clearLocation = useCallback(async () => {
    const { seq, signal } = startNewRequest();
    try {
      sessionStorage.setItem(CLEARED_SESSION_FLAG, '1');
    } catch {
      // ignore
    }
    setSyncing(true);
    setError(null);
    setLowAccuracyWarning(null);
    setMetrics(DEFAULT_EMPTY_METRICS);
    try {
      const res = await apiFetch<{
        context: ActiveLocationContext;
        metrics: EnvironmentalMetricSummary[];
      }>('/location/clear', { method: 'POST', signal });
      if (seq !== requestSeqRef.current) return;
      setContext(res.context);
      setDetected(null);
      setMetrics(res.metrics || DEFAULT_EMPTY_METRICS);
      setUpdateStatus('idle');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (seq === requestSeqRef.current) setUpdateStatus('error');
    } finally {
      if (seq === requestSeqRef.current) setSyncing(false);
    }
  }, [startNewRequest]);

  const requiresConfirmationToSwitchToDevice = Boolean(
    authenticatedUser && savedFarms.length > 0 && context.locationType === 'DEVICE_LOCATION'
  );

  return (
    <LocationContext.Provider
      value={{
        context,
        detected,
        savedFarms,
        metrics,
        strategyPreview,
        permissionStatus,
        updateStatus,
        initialLoading,
        syncing,
        error,
        lowAccuracyWarning,
        requiresConfirmationToSwitchToDevice,
        clearError: () => setError(null),
        refreshUnifiedLocation,
        detectMyLocation,
        selectManualLocation,
        selectFarmOrField,
        switchToDeviceLocation,
        updateSavedFarmWithDeviceLocation,
        syncCurrentLocationNasa,
        clearLocation,
      }}
    >
      {children}
    </LocationContext.Provider>
  );
}

export function useLocationContext() {
  const ctx = useContext(LocationContext);
  if (!ctx) {
    throw new Error('useLocationContext must be used inside LocationProvider');
  }
  return ctx;
}
