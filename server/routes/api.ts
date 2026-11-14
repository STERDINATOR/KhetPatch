import { Router, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ROLE_WORKSPACES,
  type AppRole,
  type SeasonType,
  type WaterAvailability,
} from '../../shared/types';
import {
  authenticateCredentials,
  authenticateOrProvisionFirebaseUser,
  canAccessFarm,
  completePasswordReset,
  createAuthMiddleware,
  createPasswordResetToken,
  createSession,
  getTokenFromRequest,
  registerFarmerAccount,
  requireRole,
  resolveSessionFromRequest,
  resolveUserWorkspace,
} from '../auth/authService';
import { getDemoConfig } from '../db/seed';
import {
  calculatePolygonStats,
  computeSpatialGridIds,
  createSquareFieldGeoJson,
  resolveGeographicContext,
  reverseGeocodeCoordinates,
  searchLocalLocations,
} from '../intelligence/geoService';
import {
  getHeroMetricSummaries,
  getObservationDetailsForLocation,
  refreshAllProvidersForLocation,
  testProviderConnection,
} from '../intelligence/nasaConnectors';
import {
  activateFollowupsForApprovedPlan,
  buildFarmDecisionContext,
  evaluateWeatherRisksForField,
  loadCropCatalogue,
  markPlansForReassessment,
  runAndPersistRotationAnalysis,
  writeAuditLog,
} from '../intelligence/contextAndFollowup';
import { generateGroundedAssistantResponse } from '../intelligence/aiAssistant';
import { generateThreeRotationStrategies } from '../intelligence/cropRotationEngine';

const inflightRefreshes = new Map<string, Promise<unknown>>();
const ipRateWindows = new Map<string, { count: number; resetAt: number }>();

function checkPublicRateLimit(ip: string, limit = 25, windowMs = 5 * 60 * 1000): boolean {
  const now = Date.now();
  const entry = ipRateWindows.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRateWindows.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

function getOrCreateLandingSessionKey(req: Request, res: Response): string {
  const rawCookie = req.headers.cookie || '';
  const match = rawCookie.match(/(?:^|;\s*)khetpatch_loc_sid=([^;]+)/);
  if (match && match[1]) return decodeURIComponent(match[1]);
  const sid = crypto.randomUUID();
  res.cookie('khetpatch_loc_sid', sid, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  return sid;
}

function parseValidatedCoords(latRaw: unknown, lonRaw: unknown): { lat: number; lon: number } | null {
  if (latRaw === undefined || lonRaw === undefined || latRaw === '' || lonRaw === '') return null;
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  return { lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)) };
}

export function createApiRouter(db: Database.Database): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(db);

  async function deduplicatedRefresh(
    lat: number,
    lon: number,
    state?: string,
    district?: string,
    farmId?: string,
    fieldId?: string
  ) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const existing = inflightRefreshes.get(key);
    if (existing) return existing;
    const promise = refreshAllProvidersForLocation(db, {
      lat,
      lon,
      state: state || 'Maharashtra',
      district: district || 'Ahilyanagar',
      farmId,
      fieldId,
    }).finally(() => {
      inflightRefreshes.delete(key);
    });
    inflightRefreshes.set(key, promise);
    return promise;
  }

  function resolveEffectiveLandingLocation(req: Request): {
    selected: boolean;
    latitude: number | null;
    longitude: number | null;
    label: string | null;
    source: 'QUERY' | 'AUTHENTICATED_FARM' | 'SESSION' | 'SHOWCASE' | 'NONE';
    isShowcase: boolean;
  } {
    const queryCoords = parseValidatedCoords(req.query.lat, req.query.lon);
    if (queryCoords) {
      return {
        selected: true,
        latitude: queryCoords.lat,
        longitude: queryCoords.lon,
        label: req.query.label ? String(req.query.label) : `Selected Location (${queryCoords.lat.toFixed(4)}°N, ${queryCoords.lon.toFixed(4)}°E)`,
        source: 'QUERY',
        isShowcase: false,
      };
    }

    const sessionAuth = resolveSessionFromRequest(db, req);
    if (sessionAuth.ok) {
      const farm = db
        .prepare(
          'SELECT name, village, district, latitude, longitude FROM farms WHERE owner_user_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1'
        )
        .get(sessionAuth.auth.userId) as
        | { name: string; village: string; district: string; latitude: number; longitude: number }
        | undefined;
      if (farm) {
        return {
          selected: true,
          latitude: farm.latitude,
          longitude: farm.longitude,
          label: `${farm.village}, ${farm.district} (${farm.name})`,
          source: 'AUTHENTICATED_FARM',
          isShowcase: false,
        };
      }
    }

    const rawCookie = req.headers.cookie || '';
    const match = rawCookie.match(/(?:^|;\s*)khetpatch_loc_sid=([^;]+)/);
    if (match && match[1]) {
      const sid = decodeURIComponent(match[1]);
      const row = db
        .prepare('SELECT label, latitude, longitude, is_showcase FROM landing_locations WHERE session_key = ?')
        .get(sid) as { label: string; latitude: number; longitude: number; is_showcase: number } | undefined;
      if (row) {
        return {
          selected: true,
          latitude: row.latitude,
          longitude: row.longitude,
          label: row.label,
          source: 'SESSION',
          isShowcase: Boolean(row.is_showcase),
        };
      }
    }

    if (process.env.PUBLIC_SHOWCASE_LOCATION_ENABLED === 'true') {
      const scCoords = parseValidatedCoords(
        process.env.PUBLIC_SHOWCASE_LATITUDE,
        process.env.PUBLIC_SHOWCASE_LONGITUDE
      );
      if (scCoords) {
        return {
          selected: true,
          latitude: scCoords.lat,
          longitude: scCoords.lon,
          label: process.env.PUBLIC_SHOWCASE_LABEL || 'Public Showcase Location',
          source: 'SHOWCASE',
          isShowcase: true,
        };
      }
    }

    return {
      selected: false,
      latitude: null,
      longitude: null,
      label: null,
      source: 'NONE',
      isShowcase: false,
    };
  }

  // =========================================================================
  // 1. HEALTH & CONFIGURATION
  // =========================================================================
  router.get('/health', (_req: Request, res: Response) => {
    const dbCheck = db.prepare('SELECT 1 as ok').get() as { ok: number };
    const providers = db.prepare('SELECT source_id, status, last_success_at FROM provider_health').all();
    res.json({
      status: 'ok',
      app: 'KhetPatch',
      timestamp: new Date().toISOString(),
      database: dbCheck.ok === 1 ? 'connected' : 'error',
      providers,
      config: {
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
        earthdataConfigured: Boolean(process.env.EARTHDATA_TOKEN),
        imdConfigured: Boolean(process.env.IMD_API_KEY),
        agmarknetConfigured: Boolean(process.env.DATA_GOV_API_KEY),
        demoAuthEnabled: getDemoConfig().enabled,
        googleMapsConfigured: Boolean(
          process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY
        ),
      },
    });
  });

  router.get('/public/maps-config', (_req: Request, res: Response) => {
    const apiKey =
      process.env.VITE_GOOGLE_MAPS_API_KEY ||
      process.env.GOOGLE_MAPS_API_KEY ||
      '';
    res.json({ apiKey });
  });

  // =========================================================================
  // 2. PUBLIC EARTH-TO-FARM & LANDING NASA ENDPOINTS (NO FABRICATED TELEMETRY)
  // =========================================================================
  router.get('/landing/location', (req: Request, res: Response) => {
    res.json(resolveEffectiveLandingLocation(req));
  });

  router.post('/landing/location', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        label: z.string().min(1).max(160).optional(),
        locationMethod: z.enum(['SEARCH', 'GPS', 'MAP_PIN', 'COORDINATES', 'SHOWCASE']).optional(),
        fetchLive: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid latitude (-90..90) and longitude (-180..180) are required.' });
      return;
    }

    const { latitude, longitude } = parsed.data;
    const geo = resolveGeographicContext({ lat: latitude, lon: longitude });
    const label =
      parsed.data.label ||
      `${geo.district}, ${geo.state} (${latitude.toFixed(4)}°N, ${longitude.toFixed(4)}°E)`;
    const sid = getOrCreateLandingSessionKey(req, res);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO landing_locations (id, session_key, label, latitude, longitude, location_method, is_showcase, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key)
      DO UPDATE SET label=excluded.label, latitude=excluded.latitude, longitude=excluded.longitude,
                    location_method=excluded.location_method, is_showcase=excluded.is_showcase, updated_at=excluded.updated_at
    `).run(
      crypto.randomUUID(),
      sid,
      label,
      Number(latitude.toFixed(5)),
      Number(longitude.toFixed(5)),
      parsed.data.locationMethod || 'SEARCH',
      parsed.data.locationMethod === 'SHOWCASE' ? 1 : 0,
      now
    );

    if (parsed.data.fetchLive) {
      if (!checkPublicRateLimit(req.ip || 'unknown')) {
        res.status(429).json({ error: 'Too many live NASA refresh requests. Please retry shortly.' });
        return;
      }
      await deduplicatedRefresh(latitude, longitude, geo.state, geo.district);
    }

    const summary = getHeroMetricSummaries(db, latitude, longitude);
    res.json({
      location: {
        selected: true,
        latitude: Number(latitude.toFixed(5)),
        longitude: Number(longitude.toFixed(5)),
        label,
        isShowcase: parsed.data.locationMethod === 'SHOWCASE',
      },
      geo,
      ...summary,
    });
  });

  router.get('/landing/metrics', async (req: Request, res: Response) => {
    const loc = resolveEffectiveLandingLocation(req);
    if (!loc.selected || loc.latitude === null || loc.longitude === null) {
      res.json({
        location: { selected: false, latitude: null, longitude: null, label: null, source: 'NONE', isShowcase: false },
        geo: null,
        ...getHeroMetricSummaries(db),
      });
      return;
    }

    const geo = resolveGeographicContext({ lat: loc.latitude, lon: loc.longitude });
    if (req.query.fetch === '1') {
      if (!checkPublicRateLimit(req.ip || 'unknown')) {
        res.status(429).json({ error: 'Rate limit exceeded for live NASA data refresh.' });
        return;
      }
      await deduplicatedRefresh(loc.latitude, loc.longitude, geo.state, geo.district);
    }

    const summary = getHeroMetricSummaries(db, loc.latitude, loc.longitude);
    res.json({
      location: {
        selected: true,
        latitude: loc.latitude,
        longitude: loc.longitude,
        label: loc.label,
        source: loc.source,
        isShowcase: loc.isShowcase,
      },
      geo,
      ...summary,
    });
  });

  router.get('/nasa/rainfall', (req: Request, res: Response) => {
    const coords = parseValidatedCoords(req.query.lat, req.query.lon);
    if (!coords) {
      res.status(400).json({ error: 'Valid lat and lon query parameters are required.' });
      return;
    }
    const summary = getHeroMetricSummaries(db, coords.lat, coords.lon);
    res.json({ location: coords, metric: summary.metrics.find((m) => m.metricKey === 'rainfall') || null });
  });

  router.get('/nasa/soil-moisture', (req: Request, res: Response) => {
    const coords = parseValidatedCoords(req.query.lat, req.query.lon);
    if (!coords) {
      res.status(400).json({ error: 'Valid lat and lon query parameters are required.' });
      return;
    }
    const summary = getHeroMetricSummaries(db, coords.lat, coords.lon);
    res.json({ location: coords, metric: summary.metrics.find((m) => m.metricKey === 'soil_moisture') || null });
  });

  router.get('/nasa/vegetation', (req: Request, res: Response) => {
    const coords = parseValidatedCoords(req.query.lat, req.query.lon);
    if (!coords) {
      res.status(400).json({ error: 'Valid lat and lon query parameters are required.' });
      return;
    }
    const summary = getHeroMetricSummaries(db, coords.lat, coords.lon);
    res.json({ location: coords, metric: summary.metrics.find((m) => m.metricKey === 'ndvi') || null });
  });

  router.get('/nasa/temperature', (req: Request, res: Response) => {
    const coords = parseValidatedCoords(req.query.lat, req.query.lon);
    if (!coords) {
      res.status(400).json({ error: 'Valid lat and lon query parameters are required.' });
      return;
    }
    const summary = getHeroMetricSummaries(db, coords.lat, coords.lon);
    res.json({ location: coords, metric: summary.metrics.find((m) => m.metricKey === 'temperature') || null });
  });

  router.post('/nasa/refresh', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid latitude and longitude are required.' });
      return;
    }
    if (!checkPublicRateLimit(req.ip || 'unknown')) {
      res.status(429).json({ error: 'Rate limit exceeded for live NASA data refresh.' });
      return;
    }
    const geo = resolveGeographicContext({ lat: parsed.data.latitude, lon: parsed.data.longitude });
    const refreshResult = await deduplicatedRefresh(
      parsed.data.latitude,
      parsed.data.longitude,
      geo.state,
      geo.district
    );
    const summary = getHeroMetricSummaries(db, parsed.data.latitude, parsed.data.longitude);
    res.json({ location: parsed.data, geo, refreshResult, ...summary });
  });

  router.get('/nasa/provider-health', (_req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT ds.*, ph.status, ph.last_checked_at, ph.last_success_at,
                ph.latest_observation_at, ph.records_processed, ph.last_error, ph.credential_configured
         FROM data_sources ds
         JOIN provider_health ph ON ph.source_id = ds.id
         ORDER BY ds.id ASC`
      )
      .all();
    res.json({ providers: rows });
  });

  router.get('/nasa/observation-details', (req: Request, res: Response) => {
    const coords = parseValidatedCoords(req.query.lat, req.query.lon);
    if (!coords) {
      res.status(400).json({ error: 'Valid lat and lon query parameters are required.' });
      return;
    }
    res.json(getObservationDetailsForLocation(db, coords.lat, coords.lon));
  });

  // =========================================================================
  // 2B. UNIFIED LOCATION DETECTION, FARM PRIORITY & NASA SYNC (P0)
  // =========================================================================
  function isRecentNasaSyncFresh(lat: number, lon: number, locationType: string, maxAgeMinutes = 30): boolean {
    const rLat = Number(lat.toFixed(3));
    const rLon = Number(lon.toFixed(3));
    const row = db
      .prepare(
        `SELECT last_synced_at FROM nasa_observation_locations
         WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015 AND location_type = ?
         ORDER BY last_synced_at DESC LIMIT 1`
      )
      .get(rLat, rLon, locationType) as { last_synced_at: string | null } | undefined;
    if (!row?.last_synced_at) return false;
    const ageMs = Date.now() - new Date(row.last_synced_at).getTime();
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeMinutes * 60 * 1000;
  }

  function resolveUnifiedCurrentLocation(req: Request, res?: Response) {
    const authRes = resolveSessionFromRequest(db, req);
    const rawCookie = req.headers.cookie || '';
    const match = rawCookie.match(/(?:^|;\s*)khetpatch_loc_sid=([^;]+)/);
    const sid = match && match[1] ? decodeURIComponent(match[1]) : res ? getOrCreateLandingSessionKey(req, res) : null;

    if (authRes.ok) {
      const userId = authRes.auth.userId;
      const savedFarms = db
        .prepare(
          `SELECT id, name, village, taluka, district, state, country, latitude, longitude, location_confirmed, agroclimatic_zone, university_reference
           FROM farms WHERE owner_user_id = ? AND archived = 0 ORDER BY updated_at DESC`
        )
        .all(userId) as Array<{
        id: string;
        name: string;
        village: string;
        taluka: string;
        district: string;
        state: string;
        country: string;
        latitude: number;
        longitude: number;
        location_confirmed: number;
        agroclimatic_zone: string;
        university_reference: string;
      }>;

      const getFields = db.prepare(
        'SELECT id, farm_id, name, centroid_lat, centroid_lon, area_acres, current_crop FROM fields WHERE farm_id = ? ORDER BY created_at DESC'
      );
      const enrichedFarms = savedFarms.map((f) => ({
        ...f,
        fields: getFields.all(f.id) as Array<{
          id: string;
          farm_id: string;
          name: string;
          centroid_lat: number;
          centroid_lon: number;
          area_acres: number;
          current_crop: string | null;
        }>,
      }));

      const pref = db
        .prepare('SELECT * FROM user_location_preferences WHERE user_id = ?')
        .get(userId) as
        | { preferred_source: string; active_farm_id: string | null; active_field_id: string | null; allow_auto_detect: number }
        | undefined;

      const detectedRow = db
        .prepare('SELECT * FROM detected_locations WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(userId) as Record<string, unknown> | undefined;

      const selectedCtx = db
        .prepare('SELECT * FROM selected_location_contexts WHERE user_id = ?')
        .get(userId) as Record<string, unknown> | undefined;

      // Priority rule: If farmer has a saved farm AND hasn't explicitly switched active context to DEVICE_LOCATION
      if (enrichedFarms.length > 0 && (!selectedCtx || pref?.preferred_source !== 'DEVICE_LOCATION')) {
        const targetFarm =
          enrichedFarms.find((f) => f.id === (pref?.active_farm_id || selectedCtx?.farm_id)) || enrichedFarms[0];
        const targetField =
          targetFarm.fields.find((fl) => fl.id === (pref?.active_field_id || selectedCtx?.field_id)) ||
          targetFarm.fields[0] ||
          null;
        const lat = targetField ? targetField.centroid_lat : targetFarm.latitude;
        const lon = targetField ? targetField.centroid_lon : targetFarm.longitude;
        return {
          context: {
            selected: true,
            locationType: targetField ? ('FIELD' as const) : ('FARM' as const),
            label: targetField
              ? `Selected farm: ${targetFarm.name} — ${targetField.name} (${targetFarm.village})`
              : `Selected farm: ${targetFarm.name} (${targetFarm.village}, ${targetFarm.district})`,
            latitude: lat,
            longitude: lon,
            farmId: targetFarm.id,
            farmName: targetFarm.name,
            fieldId: targetField?.id || null,
            fieldName: targetField?.name || null,
            village: targetFarm.village,
            taluka: targetFarm.taluka,
            district: targetFarm.district,
            state: targetFarm.state,
            country: targetFarm.country,
            isShowcase: false,
          },
          detected: detectedRow || null,
          savedFarms: enrichedFarms,
          preferences: pref || { preferred_source: 'FARM', allow_auto_detect: 1 },
        };
      }

      if (selectedCtx) {
        return {
          context: {
            selected: true,
            locationType: String(selectedCtx.location_type) as 'DEVICE_LOCATION' | 'FARM' | 'FIELD' | 'MANUAL' | 'SHOWCASE',
            label: String(selectedCtx.label),
            latitude: Number(selectedCtx.latitude),
            longitude: Number(selectedCtx.longitude),
            accuracy_meters: selectedCtx.accuracy_meters !== null ? Number(selectedCtx.accuracy_meters) : null,
            captured_at: selectedCtx.captured_at ? String(selectedCtx.captured_at) : null,
            farmId: selectedCtx.farm_id ? String(selectedCtx.farm_id) : null,
            fieldId: selectedCtx.field_id ? String(selectedCtx.field_id) : null,
            village: selectedCtx.village ? String(selectedCtx.village) : null,
            taluka: selectedCtx.taluka ? String(selectedCtx.taluka) : null,
            district: selectedCtx.district ? String(selectedCtx.district) : null,
            state: selectedCtx.state ? String(selectedCtx.state) : null,
            country: selectedCtx.country ? String(selectedCtx.country) : null,
            timezone: selectedCtx.timezone ? String(selectedCtx.timezone) : null,
            resolved_address: selectedCtx.resolved_address ? String(selectedCtx.resolved_address) : null,
            resolution_source: selectedCtx.resolution_source ? String(selectedCtx.resolution_source) : null,
            isShowcase: false,
          },
          detected: detectedRow || null,
          savedFarms: enrichedFarms,
          preferences: pref || null,
        };
      }

      return {
        context: { selected: false, locationType: 'NONE' as const, label: null, latitude: null, longitude: null },
        detected: detectedRow || null,
        savedFarms: enrichedFarms,
        preferences: pref || null,
      };
    }

    // Anonymous / Public session resolution
    const detectedRow = sid
      ? (db.prepare('SELECT * FROM detected_locations WHERE session_key = ? ORDER BY created_at DESC LIMIT 1').get(sid) as
          | Record<string, unknown>
          | undefined)
      : undefined;

    const selectedCtx = sid
      ? (db.prepare('SELECT * FROM selected_location_contexts WHERE session_key = ?').get(sid) as
          | Record<string, unknown>
          | undefined)
      : undefined;

    if (selectedCtx) {
      return {
        context: {
          selected: true,
          locationType: String(selectedCtx.location_type) as 'DEVICE_LOCATION' | 'MANUAL' | 'SHOWCASE',
          label: String(selectedCtx.label),
          latitude: Number(selectedCtx.latitude),
          longitude: Number(selectedCtx.longitude),
          accuracy_meters: selectedCtx.accuracy_meters !== null ? Number(selectedCtx.accuracy_meters) : null,
          captured_at: selectedCtx.captured_at ? String(selectedCtx.captured_at) : null,
          village: selectedCtx.village ? String(selectedCtx.village) : null,
          taluka: selectedCtx.taluka ? String(selectedCtx.taluka) : null,
          district: selectedCtx.district ? String(selectedCtx.district) : null,
          state: selectedCtx.state ? String(selectedCtx.state) : null,
          country: selectedCtx.country ? String(selectedCtx.country) : null,
          timezone: selectedCtx.timezone ? String(selectedCtx.timezone) : null,
          resolved_address: selectedCtx.resolved_address ? String(selectedCtx.resolved_address) : null,
          resolution_source: selectedCtx.resolution_source ? String(selectedCtx.resolution_source) : null,
          isShowcase: selectedCtx.location_type === 'SHOWCASE',
        },
        detected: detectedRow || null,
        savedFarms: [],
        preferences: null,
      };
    }

    // Legacy landing_locations compatibility fallback
    if (sid) {
      const legacy = db.prepare('SELECT * FROM landing_locations WHERE session_key = ?').get(sid) as
        | { label: string; latitude: number; longitude: number; is_showcase: number }
        | undefined;
      if (legacy) {
        return {
          context: {
            selected: true,
            locationType: legacy.is_showcase ? ('SHOWCASE' as const) : ('MANUAL' as const),
            label: legacy.label,
            latitude: legacy.latitude,
            longitude: legacy.longitude,
            isShowcase: Boolean(legacy.is_showcase),
          },
          detected: detectedRow || null,
          savedFarms: [],
          preferences: null,
        };
      }
    }

    return {
      context: { selected: false, locationType: 'NONE' as const, label: null, latitude: null, longitude: null },
      detected: detectedRow || null,
      savedFarms: [],
      preferences: null,
    };
  }

  router.get('/location/current', (req: Request, res: Response) => {
    res.json(resolveUnifiedCurrentLocation(req));
  });

  router.post('/location/detect', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracy_meters: z.number().min(0).max(500000).nullable().optional(),
        captured_at: z.string().optional(),
        permission_status: z.enum(['granted', 'prompt', 'denied', 'unavailable']).default('granted'),
        trigger_sync: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid latitude (-90..90) and longitude (-180..180) are required.' });
      return;
    }

    const authRes = resolveSessionFromRequest(db, req);
    const sid = getOrCreateLandingSessionKey(req, res);
    const now = new Date().toISOString();
    const capturedAt = parsed.data.captured_at || now;
    const resolved = await reverseGeocodeCoordinates(db, {
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      accuracy_meters: parsed.data.accuracy_meters ?? null,
      captured_at: capturedAt,
    });

    db.prepare(`
      INSERT INTO detected_locations (
        id, session_key, user_id, latitude, longitude, accuracy_meters, captured_at,
        permission_status, resolved_address, village, taluka, district, state, country, timezone, resolution_source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      authRes.ok ? null : sid,
      authRes.ok ? authRes.auth.userId : null,
      resolved.latitude,
      resolved.longitude,
      resolved.accuracy_meters,
      capturedAt,
      parsed.data.permission_status,
      resolved.resolved_address,
      resolved.village,
      resolved.taluka,
      resolved.district,
      resolved.state,
      resolved.country,
      resolved.timezone,
      resolved.resolution_source,
      now
    );

    const readableName =
      [resolved.village, resolved.district, resolved.state].filter(Boolean).slice(0, 2).join(', ') ||
      `Device Location (${resolved.latitude.toFixed(4)}°N, ${resolved.longitude.toFixed(4)}°E)`;

    let hasSavedFarm = false;
    if (authRes.ok) {
      const farmCount = db
        .prepare('SELECT COUNT(*) as c FROM farms WHERE owner_user_id = ? AND archived = 0')
        .get(authRes.auth.userId) as { c: number };
      hasSavedFarm = farmCount.c > 0;
    }

    // Only auto-activate DEVICE_LOCATION context for public visitors OR authenticated users with no saved farm
    if (!hasSavedFarm) {
      if (authRes.ok) {
        db.prepare(`
          INSERT INTO selected_location_contexts (
            id, user_id, location_type, label, latitude, longitude, accuracy_meters, captured_at,
            resolved_address, village, taluka, district, state, country, timezone, resolution_source, is_confirmed_farm, updated_at
          ) VALUES (?, ?, 'DEVICE_LOCATION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            location_type='DEVICE_LOCATION', farm_id=NULL, field_id=NULL, label=excluded.label,
            latitude=excluded.latitude, longitude=excluded.longitude, accuracy_meters=excluded.accuracy_meters,
            captured_at=excluded.captured_at, resolved_address=excluded.resolved_address, village=excluded.village,
            taluka=excluded.taluka, district=excluded.district, state=excluded.state, country=excluded.country,
            timezone=excluded.timezone, resolution_source=excluded.resolution_source, is_confirmed_farm=0, updated_at=excluded.updated_at
        `).run(
          crypto.randomUUID(),
          authRes.auth.userId,
          readableName,
          resolved.latitude,
          resolved.longitude,
          resolved.accuracy_meters,
          capturedAt,
          resolved.resolved_address,
          resolved.village,
          resolved.taluka,
          resolved.district,
          resolved.state,
          resolved.country,
          resolved.timezone,
          resolved.resolution_source,
          now
        );
      } else {
        db.prepare(`
          INSERT INTO selected_location_contexts (
            id, session_key, location_type, label, latitude, longitude, accuracy_meters, captured_at,
            resolved_address, village, taluka, district, state, country, timezone, resolution_source, is_confirmed_farm, updated_at
          ) VALUES (?, ?, 'DEVICE_LOCATION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(session_key) DO UPDATE SET
            location_type='DEVICE_LOCATION', label=excluded.label, latitude=excluded.latitude, longitude=excluded.longitude,
            accuracy_meters=excluded.accuracy_meters, captured_at=excluded.captured_at, resolved_address=excluded.resolved_address,
            village=excluded.village, taluka=excluded.taluka, district=excluded.district, state=excluded.state,
            country=excluded.country, timezone=excluded.timezone, resolution_source=excluded.resolution_source, updated_at=excluded.updated_at
        `).run(
          crypto.randomUUID(),
          sid,
          readableName,
          resolved.latitude,
          resolved.longitude,
          resolved.accuracy_meters,
          capturedAt,
          resolved.resolved_address,
          resolved.village,
          resolved.taluka,
          resolved.district,
          resolved.state,
          resolved.country,
          resolved.timezone,
          resolved.resolution_source,
          now
        );

        db.prepare(`
          INSERT INTO landing_locations (id, session_key, label, latitude, longitude, location_method, is_showcase, updated_at)
          VALUES (?, ?, ?, ?, ?, 'GPS', 0, ?)
          ON CONFLICT(session_key) DO UPDATE SET label=excluded.label, latitude=excluded.latitude, longitude=excluded.longitude, location_method='GPS', updated_at=excluded.updated_at
        `).run(crypto.randomUUID(), sid, readableName, resolved.latitude, resolved.longitude, now);
      }
    }

    const current = resolveUnifiedCurrentLocation(req);
    const syncLat = current.context.selected && current.context.latitude !== null ? current.context.latitude : resolved.latitude;
    const syncLon = current.context.selected && current.context.longitude !== null ? current.context.longitude : resolved.longitude;
    const locType = current.context.locationType || 'DEVICE_LOCATION';

    if (parsed.data.trigger_sync && !isRecentNasaSyncFresh(syncLat, syncLon, locType, 15)) {
      if (!checkPublicRateLimit(req.ip || 'unknown')) {
        res.status(429).json({ error: 'Rate limit exceeded for live NASA data refresh.' });
        return;
      }
      await deduplicatedRefresh(
        syncLat,
        syncLon,
        resolved.state || 'Maharashtra',
        resolved.district || 'Ahilyanagar'
      );
    }

    const metricsSummary = getHeroMetricSummaries(db, syncLat, syncLon, {
      locationType: locType,
      farmId: current.context.farmId || null,
      fieldId: current.context.fieldId || null,
    });

    res.json({
      resolved,
      ...current,
      hasSavedFarm,
      requiresConfirmationToUpdateFarm: hasSavedFarm,
      ...metricsSummary,
    });
  });

  router.post('/location/select', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        locationType: z.enum(['DEVICE_LOCATION', 'FARM', 'FIELD', 'MANUAL', 'SHOWCASE']),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        label: z.string().min(1).max(160).optional(),
        farmId: z.string().optional(),
        fieldId: z.string().optional(),
        triggerSync: z.boolean().optional(),
        forceSync: z.boolean().optional(),
        confirmOverwriteFarmLocation: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid locationType and parameters are required.' });
      return;
    }

    const authRes = resolveSessionFromRequest(db, req);
    const sid = getOrCreateLandingSessionKey(req, res);
    const now = new Date().toISOString();
    const d = parsed.data;

    let targetLat = d.latitude ?? null;
    let targetLon = d.longitude ?? null;
    let targetLabel = d.label || null;
    let targetFarmId: string | null = d.farmId || null;
    let targetFieldId: string | null = d.fieldId || null;
    let stateName = 'Maharashtra';
    let districtName = 'Ahilyanagar';
    let villageName: string | null = null;
    let talukaName: string | null = null;
    let countryName: string | null = 'India';

    if ((d.locationType === 'FARM' || d.locationType === 'FIELD') && authRes.ok) {
      if (!targetFarmId) {
        res.status(400).json({ error: 'farmId is required when selecting a saved farm or field.' });
        return;
      }
      if (!canAccessFarm(db, authRes.auth, targetFarmId)) {
        res.status(403).json({ error: 'Not authorized to access the requested farm.' });
        return;
      }
      const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(targetFarmId) as Record<string, unknown> | undefined;
      if (!farm) {
        res.status(404).json({ error: 'Farm not found.' });
        return;
      }
      const field = targetFieldId
        ? (db.prepare('SELECT * FROM fields WHERE id = ? AND farm_id = ?').get(targetFieldId, targetFarmId) as
            | Record<string, unknown>
            | undefined)
        : (db.prepare('SELECT * FROM fields WHERE farm_id = ? ORDER BY created_at DESC LIMIT 1').get(targetFarmId) as
            | Record<string, unknown>
            | undefined);

      targetFieldId = field ? String(field.id) : null;
      targetLat = field ? Number(field.centroid_lat) : Number(farm.latitude);
      targetLon = field ? Number(field.centroid_lon) : Number(farm.longitude);
      villageName = String(farm.village);
      talukaName = String(farm.taluka);
      districtName = String(farm.district);
      stateName = String(farm.state);
      countryName = String(farm.country || 'India');
      targetLabel = field
        ? `Selected farm: ${String(farm.name)} — ${String(field.name)}`
        : `Selected farm: ${String(farm.name)} (${villageName}, ${districtName})`;

      db.prepare(`
        INSERT INTO user_location_preferences (id, user_id, allow_auto_detect, preferred_source, active_farm_id, active_field_id, updated_at)
        VALUES (?, ?, 1, 'FARM', ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET preferred_source='FARM', active_farm_id=excluded.active_farm_id, active_field_id=excluded.active_field_id, updated_at=excluded.updated_at
      `).run(crypto.randomUUID(), authRes.auth.userId, targetFarmId, targetFieldId, now);
    }

    if (targetLat === null || targetLon === null) {
      res.status(400).json({ error: 'Valid latitude and longitude are required.' });
      return;
    }

    const resolved = await reverseGeocodeCoordinates(db, {
      latitude: targetLat,
      longitude: targetLon,
      captured_at: now,
    });

    if (resolved.state) stateName = resolved.state;
    if (resolved.district) districtName = resolved.district;
    if (!targetLabel) {
      targetLabel =
        [resolved.village, resolved.district, resolved.state].filter(Boolean).slice(0, 2).join(', ') ||
        `${targetLat.toFixed(4)}°N, ${targetLon.toFixed(4)}°E`;
    }

    if (authRes.ok) {
      if (d.locationType === 'DEVICE_LOCATION') {
        db.prepare(`
          INSERT INTO user_location_preferences (id, user_id, allow_auto_detect, preferred_source, updated_at)
          VALUES (?, ?, 1, 'DEVICE_LOCATION', ?)
          ON CONFLICT(user_id) DO UPDATE SET preferred_source='DEVICE_LOCATION', updated_at=excluded.updated_at
        `).run(crypto.randomUUID(), authRes.auth.userId, now);
      }

      db.prepare(`
        INSERT INTO selected_location_contexts (
          id, user_id, location_type, farm_id, field_id, label, latitude, longitude, accuracy_meters, captured_at,
          resolved_address, village, taluka, district, state, country, timezone, resolution_source, is_confirmed_farm, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          location_type=excluded.location_type, farm_id=excluded.farm_id, field_id=excluded.field_id, label=excluded.label,
          latitude=excluded.latitude, longitude=excluded.longitude, resolved_address=excluded.resolved_address,
          village=excluded.village, taluka=excluded.taluka, district=excluded.district, state=excluded.state,
          country=excluded.country, timezone=excluded.timezone, resolution_source=excluded.resolution_source,
          is_confirmed_farm=excluded.is_confirmed_farm, updated_at=excluded.updated_at
      `).run(
        crypto.randomUUID(),
        authRes.auth.userId,
        d.locationType,
        targetFarmId,
        targetFieldId,
        targetLabel,
        targetLat,
        targetLon,
        resolved.accuracy_meters,
        now,
        resolved.resolved_address,
        villageName || resolved.village,
        talukaName || resolved.taluka,
        districtName,
        stateName,
        countryName,
        resolved.timezone,
        resolved.resolution_source,
        d.locationType === 'FARM' || d.locationType === 'FIELD' ? 1 : 0,
        now
      );
    } else {
      db.prepare(`
        INSERT INTO selected_location_contexts (
          id, session_key, location_type, label, latitude, longitude, accuracy_meters, captured_at,
          resolved_address, village, taluka, district, state, country, timezone, resolution_source, is_confirmed_farm, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          location_type=excluded.location_type, label=excluded.label, latitude=excluded.latitude, longitude=excluded.longitude,
          resolved_address=excluded.resolved_address, village=excluded.village, taluka=excluded.taluka,
          district=excluded.district, state=excluded.state, country=excluded.country, timezone=excluded.timezone,
          resolution_source=excluded.resolution_source, updated_at=excluded.updated_at
      `).run(
        crypto.randomUUID(),
        sid,
        d.locationType,
        targetLabel,
        targetLat,
        targetLon,
        resolved.accuracy_meters,
        now,
        resolved.resolved_address,
        resolved.village,
        resolved.taluka,
        resolved.district,
        resolved.state,
        resolved.country,
        resolved.timezone,
        resolved.resolution_source,
        now
      );

      db.prepare(`
        INSERT INTO landing_locations (id, session_key, label, latitude, longitude, location_method, is_showcase, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET label=excluded.label, latitude=excluded.latitude, longitude=excluded.longitude, location_method=excluded.location_method, updated_at=excluded.updated_at
      `).run(
        crypto.randomUUID(),
        sid,
        targetLabel,
        targetLat,
        targetLon,
        d.locationType === 'DEVICE_LOCATION' ? 'GPS' : 'SEARCH',
        d.locationType === 'SHOWCASE' ? 1 : 0,
        now
      );
    }

    if (d.triggerSync !== false && (d.forceSync || !isRecentNasaSyncFresh(targetLat, targetLon, d.locationType, 30))) {
      if (!checkPublicRateLimit(req.ip || 'unknown')) {
        res.status(429).json({ error: 'Rate limit exceeded for live NASA data refresh.' });
        return;
      }
      await deduplicatedRefresh(targetLat, targetLon, stateName, districtName, targetFarmId || undefined, targetFieldId || undefined);
    }

    const current = resolveUnifiedCurrentLocation(req);
    const summary = getHeroMetricSummaries(db, targetLat, targetLon, {
      locationType: d.locationType,
      farmId: targetFarmId,
      fieldId: targetFieldId,
    });
    res.json({ ...current, resolved, ...summary });
  });

  router.post('/location/clear', (req: Request, res: Response) => {
    const authRes = resolveSessionFromRequest(db, req);
    const rawCookie = req.headers.cookie || '';
    const match = rawCookie.match(/(?:^|;\s*)khetpatch_loc_sid=([^;]+)/);
    const sid = match && match[1] ? decodeURIComponent(match[1]) : null;

    if (authRes.ok) {
      db.prepare('DELETE FROM selected_location_contexts WHERE user_id = ?').run(authRes.auth.userId);
      db.prepare('DELETE FROM user_location_preferences WHERE user_id = ?').run(authRes.auth.userId);
    }
    if (sid) {
      db.prepare('DELETE FROM selected_location_contexts WHERE session_key = ?').run(sid);
      db.prepare('DELETE FROM landing_locations WHERE session_key = ?').run(sid);
      db.prepare('DELETE FROM detected_locations WHERE session_key = ?').run(sid);
    }
    const emptySummary = getHeroMetricSummaries(db);
    res.json({
      cleared: true,
      context: { selected: false, locationType: 'NONE', label: null, latitude: null, longitude: null },
      ...emptySummary,
    });
  });

  router.post('/nasa/sync-location', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        locationType: z.string().optional(),
        farmId: z.string().nullable().optional(),
        fieldId: z.string().nullable().optional(),
        force: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid latitude and longitude are required.' });
      return;
    }

    const { latitude, longitude } = parsed.data;
    const locType = parsed.data.locationType || 'POINT';
    const geo = resolveGeographicContext({ lat: latitude, lon: longitude });

    let usedCache = false;
    if (!parsed.data.force && isRecentNasaSyncFresh(latitude, longitude, locType, 30)) {
      usedCache = true;
    } else {
      if (!checkPublicRateLimit(req.ip || 'unknown')) {
        res.status(429).json({ error: 'Rate limit exceeded for live NASA refresh.' });
        return;
      }
      await deduplicatedRefresh(
        latitude,
        longitude,
        geo.state,
        geo.district,
        parsed.data.farmId || undefined,
        parsed.data.fieldId || undefined
      );
    }

    const summary = getHeroMetricSummaries(db, latitude, longitude, {
      locationType: locType,
      farmId: parsed.data.farmId || null,
      fieldId: parsed.data.fieldId || null,
    });
    res.json({
      syncedAt: new Date().toISOString(),
      usedCache,
      spatialGrids: computeSpatialGridIds(latitude, longitude),
      ...summary,
    });
  });

  router.get('/nasa/location-metrics', (req: Request, res: Response) => {
    const coords = parseValidatedCoords(req.query.lat, req.query.lon);
    if (coords) {
      const locType = req.query.locationType ? String(req.query.locationType) : 'POINT';
      const farmId = req.query.farmId ? String(req.query.farmId) : null;
      const fieldId = req.query.fieldId ? String(req.query.fieldId) : null;
      const summary = getHeroMetricSummaries(db, coords.lat, coords.lon, { locationType: locType, farmId, fieldId });
      res.json({ location: { selected: true, latitude: coords.lat, longitude: coords.lon, locationType: locType }, ...summary });
      return;
    }
    const current = resolveUnifiedCurrentLocation(req);
    if (!current.context.selected || current.context.latitude === null || current.context.longitude === null) {
      res.json({ location: current.context, ...getHeroMetricSummaries(db) });
      return;
    }
    const summary = getHeroMetricSummaries(db, current.context.latitude, current.context.longitude, {
      locationType: current.context.locationType,
      farmId: current.context.farmId || null,
      fieldId: current.context.fieldId || null,
    });
    res.json({ location: current.context, ...summary });
  });

  router.get('/nasa/location-status', (req: Request, res: Response) => {
    const coords = parseValidatedCoords(req.query.lat, req.query.lon);
    const providers = db
      .prepare(
        `SELECT ds.id, ds.name, ds.provider, ds.product_code, ds.spatial_resolution, ph.status, ph.last_checked_at, ph.last_success_at, ph.latest_observation_at, ph.last_error, ph.credential_configured
         FROM data_sources ds JOIN provider_health ph ON ph.source_id = ds.id ORDER BY ds.id ASC`
      )
      .all();
    const recentRuns = db
      .prepare('SELECT id, source_id, status, started_at, completed_at, records_processed, latest_observation_at, error_message FROM data_ingestion_runs ORDER BY started_at DESC LIMIT 12')
      .all();
    const obsLocation = coords
      ? db
          .prepare('SELECT * FROM nasa_observation_locations WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015 ORDER BY last_synced_at DESC LIMIT 1')
          .get(Number(coords.lat.toFixed(3)), Number(coords.lon.toFixed(3)))
      : null;

    res.json({ providers, recentRuns, observationLocation: obsLocation || null });
  });

  router.get('/nasa/location-provenance', (req: Request, res: Response) => {
    const coords = parseValidatedCoords(req.query.lat, req.query.lon);
    if (!coords) {
      res.status(400).json({ error: 'Valid lat and lon query parameters are required.' });
      return;
    }
    const rLat = Number(coords.lat.toFixed(3));
    const rLon = Number(coords.lon.toFixed(3));
    const details = getObservationDetailsForLocation(db, coords.lat, coords.lon);
    const obsLocations = db
      .prepare('SELECT * FROM nasa_observation_locations WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015')
      .all(rLat, rLon);
    const metricSnapshots = db
      .prepare('SELECT * FROM metric_snapshots WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015')
      .all(rLat, rLon);
    const resolutions = db
      .prepare('SELECT * FROM location_resolution_records WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015 ORDER BY created_at DESC LIMIT 5')
      .all(rLat, rLon);

    res.json({
      ...details,
      spatialGrids: computeSpatialGridIds(coords.lat, coords.lon),
      obsLocations,
      metricSnapshots,
      resolutions,
    });
  });

  router.get('/public/hero-metrics', async (req: Request, res: Response) => {
    const coords = parseValidatedCoords(req.query.lat, req.query.lon);
    const fetchLive = req.query.fetch === '1';

    if (coords) {
      const geo = resolveGeographicContext(coords);
      if (fetchLive) {
        if (!checkPublicRateLimit(req.ip || 'unknown')) {
          res.status(429).json({ error: 'Rate limit exceeded for live NASA refresh.' });
          return;
        }
        await deduplicatedRefresh(coords.lat, coords.lon, geo.state, geo.district);
      }
      const summary = getHeroMetricSummaries(db, coords.lat, coords.lon);
      res.json({ ...summary, geo });
      return;
    }

    res.json({ ...getHeroMetricSummaries(db), geo: null });
  });

  router.get('/public/strategy-preview', (req: Request, res: Response) => {
    const catalogue = loadCropCatalogue(db);
    const qLat = req.query.lat !== undefined ? Number(req.query.lat) : 19.8825;
    const qLon = req.query.lon !== undefined ? Number(req.query.lon) : 74.4789;
    const lat = Number.isFinite(qLat) && qLat >= -90 && qLat <= 90 ? qLat : 19.8825;
    const lon = Number.isFinite(qLon) && qLon >= -180 && qLon <= 180 ? qLon : 74.4789;
    const seasonParam = String(req.query.season || 'Rabi');
    const planningSeason = (['Kharif', 'Rabi', 'Zaid', 'Annual'].includes(seasonParam)
      ? seasonParam
      : 'Rabi') as SeasonType;

    const geo = resolveGeographicContext({ lat, lon });
    const heroSummary = getHeroMetricSummaries(db, lat, lon);
    const rainMetric = heroSummary.metrics.find((m) => m.metricKey === 'rainfall');
    const tempMetric = heroSummary.metrics.find((m) => m.metricKey === 'temperature');
    const soilMetric = heroSummary.metrics.find((m) => m.metricKey === 'soil_moisture');

    const previewContext = {
      contextVersion: 'public-preview',
      contextId: 'public-preview',
      generatedAt: new Date().toISOString(),
      farmerId: 'public-preview',
      farmId: 'public-preview',
      fieldId: 'public-preview',
      planningSeason,
      geography: {
        latitude: lat,
        longitude: lon,
        locationConfirmed: true,
        village: lat === 19.8825 && lon === 74.4789 ? 'Kopargaon' : `Pin (${lat.toFixed(2)}, ${lon.toFixed(2)})`,
        taluka: geo.district,
        district: geo.district,
        state: geo.state,
        country: 'India',
        agroclimaticZone: geo.agroclimaticZone,
        universityReference: geo.universityReference,
        nearestKvk: geo.nearestKvk,
        nearestMarkets: geo.nearestMarkets,
        fieldAreaAcres: 2.5,
        fieldAreaHectares: 1.012,
      },
      farmerRequirements: {
        maxBudgetInr: 42000,
        budgetPerAcreInr: 16800,
        waterAvailability: 'Limited' as WaterAvailability,
        irrigationType: 'Protective Drip + Furrow',
        riskTolerance: 'Moderate' as const,
        preferredCrops: ['Wheat'],
        avoidCrops: [],
        priorityFocus: 'Balanced' as const,
        laborAvailability: 'Family + Seasonal',
        machineryAccess: 'Rented Tractor',
        targetPlantingDate: null,
      },
      fieldHistory: {
        currentCrop: 'Soybean',
        previousCrops: [
          {
            cropName: 'Soybean',
            cropFamily: 'Fabaceae (Legume)',
            season: 'Kharif',
            year: 2026,
            plantingDate: '2026-06-24',
            harvestDate: '2026-10-12',
          },
        ],
        acceptedPlansCount: 0,
      },
      soilProfile: {
        soilType: 'Medium Black',
        ph: 7.3,
        organicCarbonPct: 0.56,
        nitrogenKgHa: 218,
        phosphorusKgHa: 16.5,
        potassiumKgHa: 295,
        ecDsM: 0.34,
        sourceLabel: 'Farmer Entered' as const,
        sampleDate: '2026-05-18',
        labName: 'Sample Reference (DEMO DATA)',
      },
      weatherContext: {
        recent7dRainfallMm: rainMetric?.value ?? null,
        recent30dRainfallMm: null,
        forecast7dRainfallMm: null,
        meanTempC: tempMetric?.value ?? null,
        maxTempC: null,
        consecutiveDryDays: null,
        et0MeanMmDay: null,
        sourceProvider:
          rainMetric?.value !== null ? 'NASA POWER + Open-Meteo (Live)' : 'Select location & fetch live NASA data',
        observationTimestamp: rainMetric?.observationEnd || null,
        imdWarningStatus: process.env.IMD_API_KEY ? 'Connected' : 'Awaiting credentials',
      },
      nasaObservations: {
        powerAvailable: rainMetric?.value !== null,
        gpmGranuleId: rainMetric?.granuleOrSceneId || null,
        smapGranuleId: soilMetric?.granuleOrSceneId || null,
        landsatSceneId: heroSummary.metrics.find((m) => m.metricKey === 'ndvi')?.granuleOrSceneId || null,
        soilMoistureSurface: soilMetric?.value ?? null,
        ndviLatest: null,
        dataGaps: ['Sample preview context (DEMO DATA) — log in and select your own farm for personalized planning.'],
      },
      marketContext: {
        availablePrices: [],
      },
      missingInformation: ['Sample preview context (DEMO DATA)'],
      evidenceReferences: [
        `${geo.universityReference} (${geo.agroclimaticZone})`,
        ...(rainMetric?.value !== null ? [`NASA POWER 7d Rain: ${rainMetric?.value} mm`] : []),
      ],
    };
    const result = generateThreeRotationStrategies(previewContext, catalogue);
    res.json({ ...result, geography: previewContext.geography, isDemoPreview: true });
  });

  router.get('/crops', (_req: Request, res: Response) => {
    res.json({ crops: loadCropCatalogue(db) });
  });

  router.get('/intelligence/provider-health', (_req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT ds.*, ph.status, ph.last_checked_at, ph.last_success_at,
                ph.latest_observation_at, ph.records_processed, ph.last_error, ph.credential_configured
         FROM data_sources ds
         JOIN provider_health ph ON ph.source_id = ds.id
         ORDER BY ds.id ASC`
      )
      .all();
    res.json({ providers: rows });
  });

  router.post('/intelligence/providers/:sourceId/test', async (req: Request, res: Response) => {
    const sourceId = String(req.params.sourceId);
    const lat = req.body?.lat !== undefined ? Number(req.body.lat) : 19.8825;
    const lon = req.body?.lon !== undefined ? Number(req.body.lon) : 74.4789;
    const testResult = await testProviderConnection(
      db,
      sourceId,
      Number.isFinite(lat) ? lat : 19.8825,
      Number.isFinite(lon) ? lon : 74.4789
    );
    res.json(testResult);
  });

  // =========================================================================
  // 3. AUTHENTICATION & WORKSPACE RESOLUTION
  // =========================================================================
  router.get('/auth/demo-info', (_req: Request, res: Response) => {
    const demo = getDemoConfig();
    if (!demo.enabled) {
      res.json({ enabled: false });
      return;
    }
    res.json({
      enabled: true,
      email: demo.email,
      passwordHint: demo.password,
      roles: ['FARMER', 'AGRONOMIST', 'FPO_MANAGER', 'ORGANIZATION_ADMIN', 'PLATFORM_ADMIN'],
      note: 'Single shared demo identity with five explicit role assignments (development/demo mode only).',
    });
  });

  router.post('/auth/login', (req: Request, res: Response) => {
    const parsed = z
      .object({
        email: z.string().email(),
        password: z.string().min(1),
        requestedRole: z
          .enum(['FARMER', 'AGRONOMIST', 'FPO_MANAGER', 'ORGANIZATION_ADMIN', 'PLATFORM_ADMIN'])
          .optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid email and password are required.' });
      return;
    }

    const result = authenticateCredentials(
      db,
      parsed.data.email,
      parsed.data.password,
      parsed.data.requestedRole
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.cookie('khetpatch_session', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ token: result.token, user: result.auth, redirectRoute: result.redirectRoute });
  });

  router.post('/auth/signup', (req: Request, res: Response) => {
    const parsed = z
      .object({
        email: z.string().email(),
        password: z.string().min(8, 'Password must be at least 8 characters'),
        fullName: z.string().min(2),
        phone: z.string().optional(),
        language: z.enum(['en', 'hi', 'mr']).optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid signup fields.' });
      return;
    }

    const result = registerFarmerAccount(db, parsed.data);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.cookie('khetpatch_session', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.status(201).json({ token: result.token, user: result.auth, redirectRoute: result.redirectRoute });
  });

  router.post('/auth/firebase-exchange', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        idToken: z.string().min(20),
        requestedRole: z
          .enum(['FARMER', 'AGRONOMIST', 'FPO_MANAGER', 'ORGANIZATION_ADMIN', 'PLATFORM_ADMIN'])
          .optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid Firebase ID token is required.' });
      return;
    }

    try {
      const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
      if (!fs.existsSync(cfgPath)) {
        res.status(503).json({ error: 'Firebase configuration is unavailable on this server.' });
        return;
      }
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { apiKey?: string };
      if (!cfg.apiKey) {
        res.status(503).json({ error: 'Firebase API key is not configured.' });
        return;
      }

      const verifyRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(cfg.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: parsed.data.idToken }),
        }
      );

      if (!verifyRes.ok) {
        res.status(401).json({ error: 'Unable to verify Firebase authentication token.' });
        return;
      }

      const verifyJson = (await verifyRes.json()) as {
        users?: Array<{ email?: string; emailVerified?: boolean; displayName?: string }>;
      };
      const fbUser = verifyJson.users?.[0];
      if (!fbUser?.email || !fbUser.emailVerified) {
        res.status(401).json({ error: 'Verified Google/Firebase email address is required.' });
        return;
      }

      const result = authenticateOrProvisionFirebaseUser(db, {
        email: fbUser.email,
        fullName: fbUser.displayName || fbUser.email.split('@')[0],
        requestedRole: parsed.data.requestedRole,
      });

      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      res.cookie('khetpatch_session', result.token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.json({ token: result.token, user: result.auth, redirectRoute: result.redirectRoute });
    } catch {
      res.status(500).json({ error: 'Firebase session verification failed.' });
    }
  });

  router.get('/auth/session', (req: Request, res: Response) => {
    const resolved = resolveSessionFromRequest(db, req);
    if (!resolved.ok) {
      res.json({ authenticated: false, user: null, redirectRoute: null });
      return;
    }
    res.json({
      authenticated: true,
      user: resolved.auth,
      redirectRoute: ROLE_WORKSPACES[resolved.auth.activeRole],
    });
  });

  router.get('/auth/me', requireAuth, (req: Request, res: Response) => {
    res.json({ user: req.auth, redirectRoute: ROLE_WORKSPACES[req.auth!.activeRole] });
  });

  router.post('/auth/switch-workspace', requireAuth, (req: Request, res: Response) => {
    const parsed = z
      .object({
        role: z.enum(['FARMER', 'AGRONOMIST', 'FPO_MANAGER', 'ORGANIZATION_ADMIN', 'PLATFORM_ADMIN']),
        organizationId: z.string().nullable().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid target workspace role is required.' });
      return;
    }

    const resolution = resolveUserWorkspace(
      db,
      req.auth!.userId,
      parsed.data.role as AppRole,
      parsed.data.organizationId
    );
    if (!resolution.allowed) {
      res.status(403).json({ error: resolution.error || 'Role not assigned to your identity.' });
      return;
    }

    const currentToken = getTokenFromRequest(req);
    if (currentToken) {
      db.prepare('UPDATE sessions SET active_role = ?, active_org_id = ? WHERE token = ?').run(
        resolution.role,
        resolution.organizationId,
        currentToken
      );
    } else {
      createSession(db, req.auth!.userId, resolution.role, resolution.organizationId);
    }

    writeAuditLog(db, req.auth!.userId, resolution.role, 'WORKSPACE_SWITCHED', 'SESSION', null, {
      toRole: resolution.role,
    });

    res.json({
      activeRole: resolution.role,
      activeOrgId: resolution.organizationId,
      redirectRoute: resolution.redirectRoute,
    });
  });

  router.post('/auth/logout', (req: Request, res: Response) => {
    const token = getTokenFromRequest(req);
    if (token) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
    res.clearCookie('khetpatch_session', { path: '/' });
    res.json({ ok: true });
  });

  router.post('/auth/forgot-password', (req: Request, res: Response) => {
    const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid email address is required.' });
      return;
    }
    const result = createPasswordResetToken(db, parsed.data.email);
    res.json(result);
  });

  router.post('/auth/reset-password', (req: Request, res: Response) => {
    const parsed = z
      .object({
        token: z.string().min(8),
        newPassword: z.string().min(8, 'New password must be at least 8 characters.'),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Valid token and password required.' });
      return;
    }

    const result = completePasswordReset(db, parsed.data.token, parsed.data.newPassword);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true, message: 'Password updated successfully. You may now sign in.' });
  });

  // =========================================================================
  // 4. LOCATION & GEOGRAPHIC CONTEXT RESOLUTION + SEARCH
  // =========================================================================
  router.get('/location/search', async (req: Request, res: Response) => {
    const q = String(req.query.q || '').trim();
    const localMatches = searchLocalLocations(q);
    if (localMatches.length > 0 || q.length < 3) {
      res.json({ results: localMatches });
      return;
    }

    // Optional live OpenStreetMap Nominatim lookup when user searches a town/village outside local registry
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const nomRes = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=5&countrycodes=in`,
        {
          headers: { 'User-Agent': 'KhetPatch/1.0 (Agricultural Intelligence)' },
          signal: controller.signal,
        }
      );
      clearTimeout(t);
      if (nomRes.ok) {
        const items = (await nomRes.json()) as Array<{
          display_name?: string;
          lat?: string;
          lon?: string;
          address?: {
            village?: string;
            town?: string;
            city?: string;
            county?: string;
            state_district?: string;
            state?: string;
          };
        }>;
        const mapped = items
          .map((item) => {
            const lat = Number(item.lat);
            const lon = Number(item.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            const addr = item.address || {};
            const village = addr.village || addr.town || addr.city || q;
            const district = addr.state_district || addr.county || village;
            const state = addr.state || 'India';
            return {
              label: item.display_name || `${village}, ${district}, ${state}`,
              village,
              taluka: addr.county || village,
              district,
              state,
              lat: Number(lat.toFixed(5)),
              lon: Number(lon.toFixed(5)),
              source: 'NOMINATIM' as const,
            };
          })
          .filter(Boolean);
        res.json({ results: mapped });
        return;
      }
    } catch {
      // Fallback cleanly to empty array when external geocoder is unreachable
    }
    res.json({ results: [] });
  });

  router.post('/location/resolve', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lon: z.number().min(-180).max(180).optional(),
        accuracy_meters: z.number().min(0).max(500000).nullable().optional(),
        captured_at: z.string().optional(),
        district: z.string().optional(),
        state: z.string().optional(),
      })
      .safeParse(req.body);

    const latVal = parsed.success ? parsed.data.latitude ?? parsed.data.lat : undefined;
    const lonVal = parsed.success ? parsed.data.longitude ?? parsed.data.lon : undefined;

    if (!parsed.success || latVal === undefined || lonVal === undefined) {
      res.status(400).json({ error: 'Valid latitude and longitude required.' });
      return;
    }

    const resolved = await reverseGeocodeCoordinates(db, {
      latitude: latVal,
      longitude: lonVal,
      accuracy_meters: parsed.data.accuracy_meters ?? null,
      captured_at: parsed.data.captured_at ?? null,
    });
    const geo = resolveGeographicContext({
      lat: resolved.latitude,
      lon: resolved.longitude,
      district: parsed.data.district || resolved.district || undefined,
      state: parsed.data.state || resolved.state || undefined,
    });
    res.json({ ...resolved, geo });
  });

  // =========================================================================
  // 5. FARMS & FIELDS (TENANT ISOLATION ENFORCED)
  // =========================================================================
  router.get('/farms', requireAuth, (req: Request, res: Response) => {
    const auth = req.auth!;
    let farms: Array<Record<string, unknown>>;

    if (auth.activeRole === 'FARMER') {
      farms = db
        .prepare('SELECT * FROM farms WHERE owner_user_id = ? AND archived = 0 ORDER BY created_at DESC')
        .all(auth.userId) as Array<Record<string, unknown>>;
    } else if (
      (auth.activeRole === 'AGRONOMIST' ||
        auth.activeRole === 'FPO_MANAGER' ||
        auth.activeRole === 'ORGANIZATION_ADMIN') &&
      auth.activeOrgId
    ) {
      farms = db
        .prepare(
          'SELECT f.*, u.full_name as owner_name FROM farms f JOIN users u ON u.id = f.owner_user_id WHERE (f.organization_id = ? OR f.owner_user_id = ?) AND f.archived = 0 ORDER BY f.created_at DESC'
        )
        .all(auth.activeOrgId, auth.userId) as Array<Record<string, unknown>>;
    } else {
      farms = db
        .prepare('SELECT * FROM farms WHERE owner_user_id = ? AND archived = 0 ORDER BY created_at DESC')
        .all(auth.userId) as Array<Record<string, unknown>>;
    }

    const getFields = db.prepare('SELECT * FROM fields WHERE farm_id = ? ORDER BY created_at DESC');
    const enriched = farms.map((farm) => ({
      ...farm,
      fields: getFields.all(String(farm.id)),
    }));
    res.json({ farms: enriched });
  });

  router.post('/farms', requireAuth, (req: Request, res: Response) => {
    const parsed = z
      .object({
        name: z.string().min(2),
        village: z.string().min(2),
        taluka: z.string().min(2),
        district: z.string().min(2),
        state: z.string().min(2),
        country: z.string().default('India'),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        locationAccuracyM: z.number().optional(),
        locationMethod: z.enum(['GEOLOCATION', 'MAP_PIN', 'SEARCH', 'MANUAL_COORDS']).default('MAP_PIN'),
        locationConfirmed: z.boolean().refine((v) => v === true, 'Please confirm that this location represents the actual farm.'),
        totalAreaAcres: z.number().positive(),
        farmingSystem: z.string().default('Mixed Cropping'),
        irrigationSource: z.string().default('Borewell + Rainfed'),
        waterAvailability: z.enum(['Rainfed', 'Limited', 'Irrigated']).default('Limited'),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid farm registration fields.' });
      return;
    }

    const d = parsed.data;
    const geo = resolveGeographicContext({
      lat: d.latitude,
      lon: d.longitude,
      district: d.district,
      state: d.state,
    });
    const farmId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO farms (
        id, owner_user_id, organization_id, name, village, taluka, district, state, country,
        latitude, longitude, coordinate_crs, location_accuracy_m, location_method, location_confirmed,
        agroclimatic_zone, university_reference, nearest_kvk, total_area_acres, farming_system,
        irrigation_source, water_availability, is_demo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EPSG:4326', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      farmId,
      req.auth!.userId,
      req.auth!.activeOrgId,
      d.name,
      d.village,
      d.taluka,
      d.district,
      d.state,
      d.country,
      d.latitude,
      d.longitude,
      d.locationAccuracyM ?? null,
      d.locationMethod,
      geo.agroclimaticZone,
      geo.universityReference,
      geo.nearestKvk,
      d.totalAreaAcres,
      d.farmingSystem,
      d.irrigationSource,
      d.waterAvailability,
      now,
      now
    );

    db.prepare(`
      INSERT INTO timeline_events (id, farm_id, field_id, event_type, title, description, actor_user_id, created_at)
      VALUES (?, ?, NULL, 'FARM_CREATED', ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      farmId,
      `Farm Registered: ${d.name}`,
      `Confirmed coordinates (${d.latitude.toFixed(4)}, ${d.longitude.toFixed(4)}) in ${d.village}, ${d.district}. Resolved zone: ${geo.agroclimaticZone}.`,
      req.auth!.userId,
      now
    );

    const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(farmId);
    res.status(201).json({ farm, geo });
  });

  router.patch('/farms/:farmId', requireAuth, (req: Request, res: Response) => {
    const farmId = String(req.params.farmId);
    if (!canAccessFarm(db, req.auth!, farmId)) {
      res.status(403).json({ error: 'Not authorized to update this farm.' });
      return;
    }

    const parsed = z
      .object({
        name: z.string().min(2).optional(),
        village: z.string().min(2).optional(),
        taluka: z.string().min(2).optional(),
        district: z.string().min(2).optional(),
        state: z.string().min(2).optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        locationAccuracyM: z.number().optional(),
        locationMethod: z.enum(['GEOLOCATION', 'MAP_PIN', 'SEARCH', 'MANUAL_COORDS']).optional(),
        locationConfirmed: z.boolean().optional(),
        totalAreaAcres: z.number().positive().optional(),
        waterAvailability: z.enum(['Rainfed', 'Limited', 'Irrigated']).optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid farm update values.' });
      return;
    }

    const existing = db.prepare('SELECT * FROM farms WHERE id = ?').get(farmId) as Record<string, unknown>;
    const d = parsed.data;
    const nextLat = d.latitude ?? Number(existing.latitude);
    const nextLon = d.longitude ?? Number(existing.longitude);
    const nextDistrict = d.district ?? String(existing.district);
    const nextState = d.state ?? String(existing.state);
    const locationChanged =
      d.latitude !== undefined || d.longitude !== undefined || d.district !== undefined || d.state !== undefined;

    if (locationChanged && d.locationConfirmed === false) {
      res.status(400).json({ error: 'Please confirm that updated coordinates represent the farm.' });
      return;
    }

    const geo = resolveGeographicContext({
      lat: nextLat,
      lon: nextLon,
      district: nextDistrict,
      state: nextState,
    });
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE farms
      SET name = ?, village = ?, taluka = ?, district = ?, state = ?,
          latitude = ?, longitude = ?, location_accuracy_m = ?, location_method = ?,
          agroclimatic_zone = ?, university_reference = ?, nearest_kvk = ?,
          total_area_acres = ?, water_availability = ?, updated_at = ?
      WHERE id = ?
    `).run(
      d.name ?? String(existing.name),
      d.village ?? String(existing.village),
      d.taluka ?? String(existing.taluka),
      nextDistrict,
      nextState,
      nextLat,
      nextLon,
      d.locationAccuracyM ?? existing.location_accuracy_m ?? null,
      d.locationMethod ?? String(existing.location_method),
      geo.agroclimaticZone,
      geo.universityReference,
      geo.nearestKvk,
      d.totalAreaAcres ?? Number(existing.total_area_acres),
      d.waterAvailability ?? String(existing.water_availability),
      now,
      farmId
    );

    if (locationChanged || d.waterAvailability) {
      const farmFields = db.prepare('SELECT id FROM fields WHERE farm_id = ?').all(farmId) as Array<{ id: string }>;
      for (const fl of farmFields) {
        markPlansForReassessment(
          db,
          fl.id,
          locationChanged
            ? `Farm location updated (${nextLat.toFixed(4)}, ${nextLon.toFixed(4)})`
            : `Farm water availability updated (${d.waterAvailability})`
        );
      }

      db.prepare(`
        INSERT INTO timeline_events (id, farm_id, field_id, event_type, title, description, actor_user_id, created_at)
        VALUES (?, ?, NULL, 'FARM_LOCATION_UPDATED', ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        farmId,
        'Farm Location / Profile Updated',
        `Coordinates: (${nextLat.toFixed(4)}, ${nextLon.toFixed(4)}) · Zone: ${geo.agroclimaticZone}. Existing plans flagged for reassessment.`,
        req.auth!.userId,
        now
      );
    }

    const updatedFarm = db.prepare('SELECT * FROM farms WHERE id = ?').get(farmId);
    res.json({ farm: updatedFarm, geo });
  });

  router.post('/fields', requireAuth, (req: Request, res: Response) => {
    const parsed = z
      .object({
        farmId: z.string().min(1),
        name: z.string().min(2),
        polygonCoordinates: z.array(z.tuple([z.number(), z.number()])).optional(),
        targetAcres: z.number().positive().optional(),
        soilType: z.string().optional(),
        currentCrop: z.string().optional(),
        previousCrop: z.string().optional(),
        plantingDate: z.string().optional(),
        expectedHarvestDate: z.string().optional(),
        irrigationMethod: z.string().default('Drip / Furrow'),
        waterAvailability: z.enum(['Rainfed', 'Limited', 'Irrigated']).default('Limited'),
        notes: z.string().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid field inputs.' });
      return;
    }

    const d = parsed.data;
    if (!canAccessFarm(db, req.auth!, d.farmId)) {
      res.status(403).json({ error: 'Not authorized to add fields to this farm.' });
      return;
    }

    const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(d.farmId) as Record<string, unknown>;
    let geoJsonStr: string;
    let areaAcres: number;
    let areaHectares: number;
    let centroidLat: number;
    let centroidLon: number;

    if (d.polygonCoordinates && d.polygonCoordinates.length >= 3) {
      const stats = calculatePolygonStats(d.polygonCoordinates);
      if (!stats.valid) {
        res.status(400).json({ error: stats.error || 'Invalid field polygon geometry.' });
        return;
      }
      const closed = [...d.polygonCoordinates, d.polygonCoordinates[0]];
      geoJsonStr = JSON.stringify({ type: 'Polygon', coordinates: [closed] });
      areaAcres = stats.areaAcres;
      areaHectares = stats.areaHectares;
      centroidLat = stats.centroid.lat;
      centroidLon = stats.centroid.lon;
    } else {
      const acres = d.targetAcres || 1.5;
      centroidLat = Number(farm.latitude);
      centroidLon = Number(farm.longitude);
      geoJsonStr = createSquareFieldGeoJson(centroidLat, centroidLon, acres);
      areaAcres = Number(acres.toFixed(3));
      areaHectares = Number((acres * 0.404686).toFixed(3));
    }

    const fieldId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO fields (
        id, farm_id, owner_user_id, name, geometry_geojson, centroid_lat, centroid_lon,
        area_acres, area_hectares, soil_type, current_crop, previous_crop,
        planting_date, expected_harvest_date, irrigation_method, water_availability, notes, is_demo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      fieldId,
      d.farmId,
      String(farm.owner_user_id),
      d.name,
      geoJsonStr,
      centroidLat,
      centroidLon,
      areaAcres,
      areaHectares,
      d.soilType || 'Medium Black',
      d.currentCrop || null,
      d.previousCrop || null,
      d.plantingDate || null,
      d.expectedHarvestDate || null,
      d.irrigationMethod,
      d.waterAvailability,
      d.notes || null,
      now,
      now
    );

    if (d.previousCrop) {
      const cropMeta = db
        .prepare('SELECT crop_family FROM crop_catalogue WHERE LOWER(name) = LOWER(?)')
        .get(d.previousCrop) as { crop_family: string } | undefined;
      db.prepare(`
        INSERT INTO crop_history (id, field_id, crop_name, crop_family, season, year, is_demo, created_at)
        VALUES (?, ?, ?, ?, 'Rabi', ?, 0, ?)
      `).run(
        crypto.randomUUID(),
        fieldId,
        d.previousCrop,
        cropMeta?.crop_family || 'Unspecified Family',
        new Date().getUTCFullYear(),
        now
      );
    }

    db.prepare(`
      INSERT INTO timeline_events (id, farm_id, field_id, event_type, title, description, actor_user_id, created_at)
      VALUES (?, ?, ?, 'FIELD_CREATED', ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      d.farmId,
      fieldId,
      `Field Added: ${d.name}`,
      `Polygon boundary stored (${areaAcres} acres / ${areaHectares} ha) at (${centroidLat.toFixed(4)}, ${centroidLon.toFixed(4)}).`,
      req.auth!.userId,
      now
    );

    const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId);
    res.status(201).json({ field });
  });

  router.patch('/fields/:fieldId/geometry', requireAuth, (req: Request, res: Response) => {
    const fieldId = String(req.params.fieldId);
    const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId) as Record<string, unknown> | undefined;
    if (!field || !canAccessFarm(db, req.auth!, String(field.farm_id))) {
      res.status(403).json({ error: 'Not authorized to edit this field.' });
      return;
    }

    const parsed = z
      .object({
        polygonCoordinates: z.array(z.tuple([z.number(), z.number()])).min(3),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'At least 3 coordinates required for field polygon.' });
      return;
    }

    const stats = calculatePolygonStats(parsed.data.polygonCoordinates);
    if (!stats.valid) {
      res.status(400).json({ error: stats.error });
      return;
    }

    const closed = [...parsed.data.polygonCoordinates, parsed.data.polygonCoordinates[0]];
    const geoJsonStr = JSON.stringify({ type: 'Polygon', coordinates: [closed] });
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE fields SET geometry_geojson = ?, centroid_lat = ?, centroid_lon = ?, area_acres = ?, area_hectares = ?, updated_at = ?
      WHERE id = ?
    `).run(geoJsonStr, stats.centroid.lat, stats.centroid.lon, stats.areaAcres, stats.areaHectares, now, fieldId);

    markPlansForReassessment(db, fieldId, 'Field boundary or area modified');
    const updated = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId);
    res.json({ field: updated });
  });

  // =========================================================================
  // 6. CROP HISTORY, SOIL TESTS, FARMER BUDGET & REQUIREMENTS
  // =========================================================================
  router.get('/fields/:fieldId/details', requireAuth, (req: Request, res: Response) => {
    const fieldId = String(req.params.fieldId);
    const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId) as Record<string, unknown> | undefined;
    if (!field || !canAccessFarm(db, req.auth!, String(field.farm_id))) {
      res.status(403).json({ error: 'Access denied to field record.' });
      return;
    }

    const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(String(field.farm_id));
    const history = db
      .prepare('SELECT * FROM crop_history WHERE field_id = ? ORDER BY year DESC, created_at DESC')
      .all(fieldId);
    const soilTests = db
      .prepare('SELECT * FROM soil_tests WHERE field_id = ? ORDER BY sample_date DESC, created_at DESC')
      .all(fieldId);
    const requirements = db
      .prepare('SELECT * FROM farmer_requirements WHERE field_id = ?')
      .get(fieldId);
    const plans = db
      .prepare('SELECT * FROM rotation_plans WHERE field_id = ? ORDER BY created_at DESC LIMIT 5')
      .all(fieldId);
    const tasks = db
      .prepare('SELECT * FROM tasks WHERE field_id = ? ORDER BY due_date ASC')
      .all(fieldId);
    const timeline = db
      .prepare('SELECT * FROM timeline_events WHERE field_id = ? OR (farm_id = ? AND field_id IS NULL) ORDER BY created_at DESC LIMIT 25')
      .all(fieldId, String(field.farm_id));

    res.json({ farm, field, history, soilTests, requirements, plans, tasks, timeline });
  });

  router.post('/crop-history', requireAuth, (req: Request, res: Response) => {
    const parsed = z
      .object({
        fieldId: z.string().min(1),
        cropName: z.string().min(2),
        cropFamily: z.string().min(2),
        season: z.enum(['Kharif', 'Rabi', 'Zaid', 'Annual']),
        year: z.number().int().min(2000).max(2035),
        plantingDate: z.string().optional(),
        harvestDate: z.string().optional(),
        yieldQPerAcre: z.number().nonnegative().optional(),
        pestDiseaseNotes: z.string().optional(),
        fertilizerIrrigationNotes: z.string().optional(),
        setAsCurrent: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid crop history details required.' });
      return;
    }
    const d = parsed.data;
    const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(d.fieldId) as Record<string, unknown> | undefined;
    if (!field || !canAccessFarm(db, req.auth!, String(field.farm_id))) {
      res.status(403).json({ error: 'Not authorized for this field.' });
      return;
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO crop_history (
        id, field_id, crop_name, crop_family, season, year, planting_date, harvest_date,
        yield_q_per_acre, pest_disease_notes, fertilizer_irrigation_notes, is_demo, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      id,
      d.fieldId,
      d.cropName,
      d.cropFamily,
      d.season,
      d.year,
      d.plantingDate || null,
      d.harvestDate || null,
      d.yieldQPerAcre ?? null,
      d.pestDiseaseNotes || null,
      d.fertilizerIrrigationNotes || null,
      now
    );

    if (d.setAsCurrent) {
      db.prepare('UPDATE fields SET previous_crop = current_crop, current_crop = ?, updated_at = ? WHERE id = ?').run(
        d.cropName,
        now,
        d.fieldId
      );
    }
    markPlansForReassessment(db, d.fieldId, `Crop history updated (${d.cropName})`);

    db.prepare(`
      INSERT INTO timeline_events (id, farm_id, field_id, event_type, title, description, actor_user_id, created_at)
      VALUES (?, ?, ?, 'CROP_HISTORY_ADDED', ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      String(field.farm_id),
      d.fieldId,
      `Crop Recorded: ${d.cropName} (${d.season} ${d.year})`,
      `Family: ${d.cropFamily}. ${d.pestDiseaseNotes ? `Notes: ${d.pestDiseaseNotes}` : ''}`,
      req.auth!.userId,
      now
    );

    res.status(201).json({ id });
  });

  router.post('/soil/:fieldId', requireAuth, (req: Request, res: Response) => {
    const fieldId = String(req.params.fieldId);
    const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId) as Record<string, unknown> | undefined;
    if (!field || !canAccessFarm(db, req.auth!, String(field.farm_id))) {
      res.status(403).json({ error: 'Not authorized for this field.' });
      return;
    }

    const parsed = z
      .object({
        sourceLabel: z.enum(['Lab Measured', 'Farmer Entered']).default('Farmer Entered'),
        labName: z.string().optional(),
        sampleDate: z.string().optional(),
        ph: z.number().min(3).max(11).optional(),
        ecDsM: z.number().min(0).max(20).optional(),
        organicCarbonPct: z.number().min(0).max(10).optional(),
        nitrogenKgHa: z.number().min(0).max(2000).optional(),
        phosphorusKgHa: z.number().min(0).max(500).optional(),
        potassiumKgHa: z.number().min(0).max(2000).optional(),
        notes: z.string().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid soil test values.' });
      return;
    }

    const d = parsed.data;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO soil_tests (
        id, field_id, source_label, lab_name, sample_date, ph, ec_ds_m,
        organic_carbon_pct, nitrogen_kg_ha, phosphorus_kg_ha, potassium_kg_ha, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fieldId,
      d.sourceLabel,
      d.labName || null,
      d.sampleDate || now.slice(0, 10),
      d.ph ?? null,
      d.ecDsM ?? null,
      d.organicCarbonPct ?? null,
      d.nitrogenKgHa ?? null,
      d.phosphorusKgHa ?? null,
      d.potassiumKgHa ?? null,
      d.notes || null,
      now
    );

    markPlansForReassessment(db, fieldId, 'New soil test parameters recorded');
    res.status(201).json({ id });
  });

  router.post('/farmer-requirements', requireAuth, (req: Request, res: Response) => {
    const parsed = z
      .object({
        farmId: z.string().min(1),
        fieldId: z.string().min(1),
        maxBudgetInr: z.number().positive().nullable(),
        waterAvailability: z.enum(['Rainfed', 'Limited', 'Irrigated']),
        riskTolerance: z.enum(['Low', 'Moderate', 'High']).default('Moderate'),
        priorityFocus: z.enum(['Lower Cost', 'Soil Health', 'Balanced', 'Water Saving']).default('Balanced'),
        preferredCrops: z.array(z.string()).default([]),
        avoidCrops: z.array(z.string()).default([]),
        laborAvailability: z.string().default('Family + Seasonal Hired'),
        machineryAccess: z.string().default('Rented Tractor'),
        targetPlantingDate: z.string().nullable().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid farmer requirement fields.' });
      return;
    }

    const d = parsed.data;
    const field = db.prepare('SELECT * FROM fields WHERE id = ? AND farm_id = ?').get(d.fieldId, d.farmId) as
      | Record<string, unknown>
      | undefined;
    if (!field || !canAccessFarm(db, req.auth!, d.farmId)) {
      res.status(403).json({ error: 'Not authorized to update field requirements.' });
      return;
    }

    const acres = Math.max(0.1, Number(field.area_acres));
    const perAcre = d.maxBudgetInr ? Math.round(d.maxBudgetInr / acres) : null;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO farmer_requirements (
        id, farmer_id, farm_id, field_id, max_budget_inr, budget_per_acre_inr,
        water_availability, risk_tolerance, priority_focus, preferred_crops_json,
        avoid_crops_json, labor_availability, machinery_access, target_planting_date, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(field_id) DO UPDATE SET
        max_budget_inr=excluded.max_budget_inr,
        budget_per_acre_inr=excluded.budget_per_acre_inr,
        water_availability=excluded.water_availability,
        risk_tolerance=excluded.risk_tolerance,
        priority_focus=excluded.priority_focus,
        preferred_crops_json=excluded.preferred_crops_json,
        avoid_crops_json=excluded.avoid_crops_json,
        labor_availability=excluded.labor_availability,
        machinery_access=excluded.machinery_access,
        target_planting_date=excluded.target_planting_date,
        updated_at=excluded.updated_at
    `).run(
      crypto.randomUUID(),
      req.auth!.userId,
      d.farmId,
      d.fieldId,
      d.maxBudgetInr,
      perAcre,
      d.waterAvailability,
      d.riskTolerance,
      d.priorityFocus,
      JSON.stringify(d.preferredCrops),
      JSON.stringify(d.avoidCrops),
      d.laborAvailability,
      d.machineryAccess,
      d.targetPlantingDate || null,
      now
    );

    db.prepare('UPDATE fields SET water_availability = ?, updated_at = ? WHERE id = ?').run(
      d.waterAvailability,
      now,
      d.fieldId
    );
    markPlansForReassessment(db, d.fieldId, 'Farmer budget, planting date, or water requirements updated');

    const saved = db.prepare('SELECT * FROM farmer_requirements WHERE field_id = ?').get(d.fieldId);
    res.json({ requirements: saved });
  });

  // =========================================================================
  // 7. NASA & WEATHER OBSERVATIONS FOR AUTHORIZED FIELDS
  // =========================================================================
  router.post('/nasa/refresh', requireAuth, async (req: Request, res: Response) => {
    const parsed = z
      .object({
        farmId: z.string().min(1),
        fieldId: z.string().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'farmId is required.' });
      return;
    }

    if (!canAccessFarm(db, req.auth!, parsed.data.farmId)) {
      res.status(403).json({ error: 'Not authorized to fetch data for this farm.' });
      return;
    }

    const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(parsed.data.farmId) as Record<string, unknown>;
    const field = parsed.data.fieldId
      ? (db.prepare('SELECT * FROM fields WHERE id = ? AND farm_id = ?').get(parsed.data.fieldId, parsed.data.farmId) as
          | Record<string, unknown>
          | undefined)
      : undefined;

    const lat = Number(field?.centroid_lat || farm.latitude);
    const lon = Number(field?.centroid_lon || farm.longitude);

    const results = await refreshAllProvidersForLocation(db, {
      lat,
      lon,
      state: String(farm.state),
      district: String(farm.district),
      farmId: String(farm.id),
      fieldId: field ? String(field.id) : undefined,
    });

    let weatherRisks = { triggered: 0, alerts: [] as string[] };
    if (field) {
      weatherRisks = evaluateWeatherRisksForField(
        db,
        String(farm.id),
        String(field.id),
        String(farm.owner_user_id)
      );
    }

    res.json({
      refreshedAt: new Date().toISOString(),
      coordinates: { lat, lon },
      results,
      weatherRisks,
    });
  });

  router.get('/nasa/observations', requireAuth, (req: Request, res: Response) => {
    const farmId = String(req.query.farmId || '');
    const fieldId = req.query.fieldId ? String(req.query.fieldId) : undefined;
    if (!farmId || !canAccessFarm(db, req.auth!, farmId)) {
      res.status(403).json({ error: 'Not authorized to view observations for this farm.' });
      return;
    }

    const farm = db.prepare('SELECT latitude, longitude FROM farms WHERE id = ?').get(farmId) as {
      latitude: number;
      longitude: number;
    };
    const field = fieldId
      ? (db.prepare('SELECT centroid_lat, centroid_lon FROM fields WHERE id = ?').get(fieldId) as
          | { centroid_lat: number; centroid_lon: number }
          | undefined)
      : undefined;

    const lat = field ? field.centroid_lat : farm.latitude;
    const lon = field ? field.centroid_lon : farm.longitude;

    const observations = db
      .prepare(
        `SELECT * FROM environmental_observations
         WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05
         ORDER BY observation_start DESC LIMIT 200`
      )
      .all(lat, lon);

    const heroSummary = getHeroMetricSummaries(db, lat, lon);
    res.json({ coordinates: { lat, lon }, metrics: heroSummary.metrics, observations });
  });

  router.get('/markets/prices', requireAuth, (req: Request, res: Response) => {
    const state = req.query.state ? String(req.query.state) : 'Maharashtra';
    const prices = db
      .prepare('SELECT * FROM market_prices WHERE state = ? OR is_demo = 1 ORDER BY is_demo ASC, arrival_date DESC LIMIT 30')
      .all(state);
    res.json({ prices });
  });

  // =========================================================================
  // 8. DECISION CONTEXT & CROP-ROTATION SOLVER
  // =========================================================================
  router.post('/decision-context/build', requireAuth, (req: Request, res: Response) => {
    const parsed = z
      .object({
        farmId: z.string().min(1),
        fieldId: z.string().min(1),
        planningSeason: z.enum(['Kharif', 'Rabi', 'Zaid', 'Annual']).default('Rabi'),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'farmId, fieldId, and planningSeason are required.' });
      return;
    }
    if (!canAccessFarm(db, req.auth!, parsed.data.farmId)) {
      res.status(403).json({ error: 'Not authorized for this farm.' });
      return;
    }

    const context = buildFarmDecisionContext(
      db,
      req.auth!.userId,
      parsed.data.farmId,
      parsed.data.fieldId,
      parsed.data.planningSeason
    );
    res.json({ context });
  });

  router.post('/rotation/analyze', requireAuth, (req: Request, res: Response) => {
    const parsed = z
      .object({
        farmId: z.string().min(1),
        fieldId: z.string().min(1),
        planningSeason: z.enum(['Kharif', 'Rabi', 'Zaid', 'Annual']).default('Rabi'),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'farmId, fieldId, and planningSeason are required.' });
      return;
    }
    if (!canAccessFarm(db, req.auth!, parsed.data.farmId)) {
      res.status(403).json({ error: 'Not authorized for this field.' });
      return;
    }

    const result = runAndPersistRotationAnalysis(
      db,
      req.auth!.userId,
      parsed.data.farmId,
      parsed.data.fieldId,
      parsed.data.planningSeason
    );
    res.status(201).json(result);
  });

  router.post('/rotation/:planId/approve', requireAuth, (req: Request, res: Response) => {
    const planId = String(req.params.planId);
    const plan = db.prepare('SELECT * FROM rotation_plans WHERE id = ?').get(planId) as
      | Record<string, unknown>
      | undefined;

    if (!plan || !canAccessFarm(db, req.auth!, String(plan.farm_id))) {
      res.status(403).json({ error: 'Not authorized to approve this rotation plan.' });
      return;
    }

    const parsed = z
      .object({
        strategyType: z.enum(['EXISTING', 'MINIMAL_CHANGE', 'ALTERNATIVE']),
        requestExpertReview: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid strategyType is required.' });
      return;
    }

    const strategies = JSON.parse(String(plan.strategies_json)) as Array<{
      strategyType: string;
      feasible: boolean;
      proposedCrop: string | null;
    }>;
    const chosen = strategies.find((s) => s.strategyType === parsed.data.strategyType);
    if (!chosen || !chosen.proposedCrop) {
      res.status(400).json({ error: 'Chosen strategy does not have a valid crop option.' });
      return;
    }
    if (!chosen.feasible && parsed.data.strategyType !== 'EXISTING') {
      res.status(400).json({ error: 'Cannot approve an unfeasible modification strategy.' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE rotation_plans
      SET selected_strategy_type = ?,
          selected_crop = ?,
          status = 'APPROVED',
          expert_review_status = CASE WHEN ? = 1 THEN 'PENDING_REVIEW' ELSE expert_review_status END,
          reassessment_needed = 0,
          updated_at = ?
      WHERE id = ?
    `).run(
      parsed.data.strategyType,
      chosen.proposedCrop,
      parsed.data.requestExpertReview ? 1 : 0,
      now,
      planId
    );

    const tasksCreated = activateFollowupsForApprovedPlan(db, planId, req.auth!.userId);
    res.json({ ok: true, planId, selectedCrop: chosen.proposedCrop, tasksCreated });
  });

  router.post('/rotation/:planId/request-review', requireAuth, (req: Request, res: Response) => {
    const planId = String(req.params.planId);
    const plan = db.prepare('SELECT * FROM rotation_plans WHERE id = ?').get(planId) as
      | Record<string, unknown>
      | undefined;

    if (!plan || !canAccessFarm(db, req.auth!, String(plan.farm_id))) {
      res.status(403).json({ error: 'Not authorized.' });
      return;
    }

    db.prepare(`UPDATE rotation_plans SET expert_review_status = 'PENDING_REVIEW', updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      planId
    );
    res.json({ ok: true });
  });

  // =========================================================================
  // 9. FOLLOW-UP & TASKS ENGINE + NOTIFICATIONS
  // =========================================================================
  router.get('/followups', requireAuth, (req: Request, res: Response) => {
    const auth = req.auth!;
    const rows = db
      .prepare(
        `SELECT t.*, f.name as farm_name, fl.name as field_name
         FROM tasks t
         JOIN farms f ON f.id = t.farm_id
         JOIN fields fl ON fl.id = t.field_id
         WHERE t.assigned_user_id = ? OR f.owner_user_id = ?
         ORDER BY t.due_date ASC`
      )
      .all(auth.userId, auth.userId);
    res.json({ tasks: rows });
  });

  router.post('/followups', requireAuth, (req: Request, res: Response) => {
    const parsed = z
      .object({
        farmId: z.string().min(1),
        fieldId: z.string().min(1),
        title: z.string().min(3),
        category: z.string().default('Field Activity'),
        reason: z.string().default('Farmer-scheduled operation'),
        dueDate: z.string().min(8),
        priority: z.enum(['Low', 'Medium', 'High']).default('Medium'),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid task fields required.' });
      return;
    }
    const d = parsed.data;
    if (!canAccessFarm(db, req.auth!, d.farmId)) {
      res.status(403).json({ error: 'Not authorized for this farm.' });
      return;
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO tasks (
        id, farm_id, field_id, assigned_user_id, category, title, reason,
        rule_reference, due_date, priority, status, trigger_event, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Farmer Created', ?, ?, 'UPCOMING', 'MANUAL', ?, ?)
    `).run(id, d.farmId, d.fieldId, req.auth!.userId, d.category, d.title, d.reason, d.dueDate, d.priority, now, now);

    res.status(201).json({ id });
  });

  router.post('/followups/:id/complete', requireAuth, (req: Request, res: Response) => {
    const taskId = String(req.params.id);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    if (!task || !canAccessFarm(db, req.auth!, String(task.farm_id))) {
      res.status(403).json({ error: 'Not authorized to update this task.' });
      return;
    }

    const parsed = z
      .object({
        feedback: z.string().min(2, 'Please enter a brief observation or completion note.'),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Completion note required.' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks SET status = 'COMPLETED', farmer_feedback = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(parsed.data.feedback, now, now, taskId);

    db.prepare(`
      INSERT INTO timeline_events (id, farm_id, field_id, event_type, title, description, actor_user_id, created_at)
      VALUES (?, ?, ?, 'TASK_COMPLETED', ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      String(task.farm_id),
      String(task.field_id),
      `Completed: ${String(task.title)}`,
      `Farmer feedback: ${parsed.data.feedback}`,
      req.auth!.userId,
      now
    );

    res.json({ ok: true });
  });

  router.post('/followups/:id/postpone', requireAuth, (req: Request, res: Response) => {
    const taskId = String(req.params.id);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    if (!task || !canAccessFarm(db, req.auth!, String(task.farm_id))) {
      res.status(403).json({ error: 'Not authorized.' });
      return;
    }

    const parsed = z
      .object({
        newDueDate: z.string().min(8),
        reason: z.string().min(2),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'New due date and reason required.' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks SET status = 'POSTPONED', due_date = ?, farmer_feedback = ?, updated_at = ?
      WHERE id = ?
    `).run(parsed.data.newDueDate, `Postponed: ${parsed.data.reason}`, now, taskId);

    db.prepare(`
      INSERT INTO timeline_events (id, farm_id, field_id, event_type, title, description, actor_user_id, created_at)
      VALUES (?, ?, ?, 'TASK_POSTPONED', ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      String(task.farm_id),
      String(task.field_id),
      `Postponed: ${String(task.title)} -> ${parsed.data.newDueDate}`,
      parsed.data.reason,
      req.auth!.userId,
      now
    );

    res.json({ ok: true });
  });

  router.get('/notifications', requireAuth, (req: Request, res: Response) => {
    const rows = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? AND dismissed = 0 ORDER BY created_at DESC LIMIT 30')
      .all(req.auth!.userId);
    res.json({ notifications: rows });
  });

  router.post('/notifications/:id/read', requireAuth, (req: Request, res: Response) => {
    db.prepare('UPDATE notifications SET read_flag = 1 WHERE id = ? AND user_id = ?').run(
      String(req.params.id),
      req.auth!.userId
    );
    res.json({ ok: true });
  });

  router.post('/notifications/read-all', requireAuth, (req: Request, res: Response) => {
    db.prepare('UPDATE notifications SET read_flag = 1 WHERE user_id = ?').run(req.auth!.userId);
    res.json({ ok: true });
  });

  // =========================================================================
  // 10. AI FARM ASSISTANT (GROUNDED SERVER-SIDE GEMINI + FALLBACK)
  // =========================================================================
  router.get('/assistant/history', requireAuth, (req: Request, res: Response) => {
    const fieldId = String(req.query.fieldId || '');
    const rows = db
      .prepare(
        'SELECT * FROM conversation_messages WHERE user_id = ? AND field_id = ? ORDER BY created_at ASC LIMIT 40'
      )
      .all(req.auth!.userId, fieldId);
    res.json({ messages: rows });
  });

  router.post('/assistant/ask', requireAuth, async (req: Request, res: Response) => {
    const parsed = z
      .object({
        farmId: z.string().min(1),
        fieldId: z.string().min(1),
        question: z.string().min(2).max(1500),
        language: z.enum(['en', 'hi', 'mr']).optional(),
        planningSeason: z.enum(['Kharif', 'Rabi', 'Zaid', 'Annual']).optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'farmId, fieldId, and a question are required.' });
      return;
    }

    const d = parsed.data;
    if (!canAccessFarm(db, req.auth!, d.farmId)) {
      res.status(403).json({ error: 'Not authorized to query AI assistant for this field.' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO conversation_messages (id, user_id, farm_id, field_id, role, content, created_at)
      VALUES (?, ?, ?, ?, 'user', ?, ?)
    `).run(crypto.randomUUID(), req.auth!.userId, d.farmId, d.fieldId, d.question, now);

    const reply = await generateGroundedAssistantResponse(db, {
      userId: req.auth!.userId,
      farmId: d.farmId,
      fieldId: d.fieldId,
      question: d.question,
      language: d.language || req.auth!.preferredLanguage,
      planningSeason: d.planningSeason,
    });

    db.prepare(`
      INSERT INTO conversation_messages (id, user_id, farm_id, field_id, role, content, context_id, evidence_json, created_at)
      VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      req.auth!.userId,
      d.farmId,
      d.fieldId,
      reply.answer,
      reply.contextId,
      JSON.stringify({ mode: reply.mode, citations: reply.evidenceCitations, disclaimer: reply.disclaimer }),
      new Date().toISOString()
    );

    res.json(reply);
  });

  // =========================================================================
  // 11. AGRONOMIST WORKSPACE ROUTES
  // =========================================================================
  router.get('/agronomist/overview', requireAuth, requireRole('AGRONOMIST'), (req: Request, res: Response) => {
    const orgId = req.auth!.activeOrgId;
    const plans = db
      .prepare(
        `SELECT rp.*, f.name as farm_name, f.district, f.state, fl.name as field_name, fl.area_acres, u.full_name as farmer_name
         FROM rotation_plans rp
         JOIN farms f ON f.id = rp.farm_id
         JOIN fields fl ON fl.id = rp.field_id
         JOIN users u ON u.id = rp.farmer_id
         WHERE f.organization_id = ? OR rp.farmer_id = ?
         ORDER BY CASE WHEN rp.expert_review_status = 'PENDING_REVIEW' THEN 0 ELSE 1 END, rp.created_at DESC
         LIMIT 50`
      )
      .all(orgId, req.auth!.userId);

    const farms = db
      .prepare(
        `SELECT f.*, u.full_name as farmer_name,
                (SELECT COUNT(*) FROM fields fl WHERE fl.farm_id = f.id) as field_count
         FROM farms f
         JOIN users u ON u.id = f.owner_user_id
         WHERE f.organization_id = ? OR f.owner_user_id = ?`
      )
      .all(orgId, req.auth!.userId);

    const crops = loadCropCatalogue(db);
    const providers = db
      .prepare(
        `SELECT ds.id, ds.name, ph.status, ph.last_success_at, ph.latest_observation_at
         FROM data_sources ds JOIN provider_health ph ON ph.source_id = ds.id`
      )
      .all();

    res.json({ plans, farms, crops, providers });
  });

  router.post('/expert-reviews/:planId', requireAuth, requireRole('AGRONOMIST'), (req: Request, res: Response) => {
    const planId = String(req.params.planId);
    const plan = db
      .prepare(
        `SELECT rp.*, f.organization_id FROM rotation_plans rp JOIN farms f ON f.id = rp.farm_id WHERE rp.id = ?`
      )
      .get(planId) as Record<string, unknown> | undefined;

    if (!plan || (req.auth!.activeOrgId && plan.organization_id !== req.auth!.activeOrgId)) {
      res.status(403).json({ error: 'Not authorized to review this plan.' });
      return;
    }

    const parsed = z
      .object({
        decision: z.enum(['APPROVED', 'REJECTED', 'NEEDS_MORE_INFO', 'MODIFIED']),
        notes: z.string().min(3),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Decision and expert notes (min 3 chars) required.' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE rotation_plans
      SET expert_review_status = ?, expert_reviewer_id = ?, expert_notes = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(parsed.data.decision, req.auth!.userId, parsed.data.notes, now, now, planId);

    db.prepare(`
      INSERT INTO notifications (id, user_id, farm_id, field_id, title, message, priority, category, evidence_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'High', 'EXPERT_REVIEW', ?, ?)
    `).run(
      crypto.randomUUID(),
      String(plan.farmer_id),
      String(plan.farm_id),
      String(plan.field_id),
      `Agronomist Review: ${parsed.data.decision}`,
      parsed.data.notes,
      planId,
      now
    );

    writeAuditLog(db, req.auth!.userId, 'AGRONOMIST', 'EXPERT_REVIEW_SUBMITTED', 'ROTATION_PLAN', planId, {
      decision: parsed.data.decision,
    });

    res.json({ ok: true });
  });

  router.get('/reports/csv', requireAuth, requireRole('AGRONOMIST', 'FPO_MANAGER'), (req: Request, res: Response) => {
    const orgId = req.auth!.activeOrgId;
    const rows = db
      .prepare(
        `SELECT f.name as farm_name, f.village, f.district, fl.name as field_name, fl.area_acres,
                fl.current_crop, fl.previous_crop, rp.planning_season, rp.selected_crop,
                rp.status as plan_status, rp.expert_review_status
         FROM fields fl
         JOIN farms f ON f.id = fl.farm_id
         LEFT JOIN rotation_plans rp ON rp.field_id = fl.id
         WHERE f.organization_id = ? OR f.owner_user_id = ?
         ORDER BY f.name ASC`
      )
      .all(orgId, req.auth!.userId) as Array<Record<string, unknown>>;

    const headers = [
      'Farm Name',
      'Village',
      'District',
      'Field Name',
      'Area (Acres)',
      'Current Crop',
      'Previous Crop',
      'Season',
      'Selected Rotation Crop',
      'Plan Status',
      'Expert Review',
    ];
    const escapeCsv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      headers.join(','),
      ...rows.map((r) =>
        [
          r.farm_name,
          r.village,
          r.district,
          r.field_name,
          r.area_acres,
          r.current_crop,
          r.previous_crop,
          r.planning_season,
          r.selected_crop,
          r.plan_status,
          r.expert_review_status,
        ]
          .map(escapeCsv)
          .join(',')
      ),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="khetpatch-fpo-field-summary.csv"');
    res.send(lines.join('\n'));
  });

  // =========================================================================
  // 12. FPO MANAGER & ORGANIZATION ADMIN WORKSPACE ROUTES
  // =========================================================================
  router.get('/organization/overview', requireAuth, requireRole('FPO_MANAGER'), (req: Request, res: Response) => {
    const orgId = req.auth!.activeOrgId;
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
    const members = db
      .prepare(
        `SELECT u.id, u.full_name, u.email, u.status, ur.role, ur.is_demo, ur.created_at
         FROM user_roles ur JOIN users u ON u.id = ur.user_id
         WHERE ur.organization_id = ?`
      )
      .all(orgId);

    const farmSummaries = db
      .prepare(
        `SELECT f.id, f.name, f.village, f.district, f.total_area_acres, f.water_availability, f.is_demo,
                u.full_name as farmer_name,
                (SELECT COUNT(*) FROM fields fl WHERE fl.farm_id = f.id) as fields_count,
                (SELECT COUNT(*) FROM tasks t WHERE t.farm_id = f.id AND t.status = 'COMPLETED') as completed_tasks,
                (SELECT COUNT(*) FROM tasks t WHERE t.farm_id = f.id AND t.status != 'COMPLETED') as open_tasks
         FROM farms f
         JOIN users u ON u.id = f.owner_user_id
         WHERE f.organization_id = ?`
      )
      .all(orgId);

    const plans = db
      .prepare(
        `SELECT rp.id, rp.planning_season, rp.selected_crop, rp.status, rp.expert_review_status, f.name as farm_name, fl.name as field_name
         FROM rotation_plans rp
         JOIN farms f ON f.id = rp.farm_id
         JOIN fields fl ON fl.id = rp.field_id
         WHERE f.organization_id = ?
         ORDER BY rp.created_at DESC LIMIT 25`
      )
      .all(orgId);

    res.json({ organization: org, members, farmSummaries, plans });
  });

  router.get('/organization/admin', requireAuth, requireRole('ORGANIZATION_ADMIN'), (req: Request, res: Response) => {
    const orgId = req.auth!.activeOrgId;
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
    const members = db
      .prepare(
        `SELECT ur.id as role_assignment_id, u.id as user_id, u.full_name, u.email, u.status, ur.role, ur.granted_by, ur.created_at
         FROM user_roles ur JOIN users u ON u.id = ur.user_id
         WHERE ur.organization_id = ?
         ORDER BY u.full_name ASC`
      )
      .all(orgId);
    const invitations = db
      .prepare('SELECT * FROM user_invitations WHERE organization_id = ? ORDER BY created_at DESC')
      .all(orgId);
    const auditLogs = db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 40')
      .all();

    res.json({ organization: org, members, invitations, auditLogs });
  });

  router.post('/organization/invitations', requireAuth, requireRole('ORGANIZATION_ADMIN'), (req: Request, res: Response) => {
    const parsed = z
      .object({
        email: z.string().email(),
        role: z.enum(['FARMER', 'AGRONOMIST', 'FPO_MANAGER', 'ORGANIZATION_ADMIN']), // Org Admin CANNOT grant PLATFORM_ADMIN
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: 'Valid email and permitted organization role required.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO user_invitations (id, email, role, organization_id, invited_by, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
    `).run(id, parsed.data.email.toLowerCase(), parsed.data.role, req.auth!.activeOrgId, req.auth!.userId, now);

    writeAuditLog(db, req.auth!.userId, 'ORGANIZATION_ADMIN', 'MEMBER_INVITED', 'INVITATION', id, {
      email: parsed.data.email,
      role: parsed.data.role,
    });

    res.status(201).json({ id, status: 'PENDING' });
  });

  router.post('/organization/users/:userId/status', requireAuth, requireRole('ORGANIZATION_ADMIN'), (req: Request, res: Response) => {
    const targetUserId = String(req.params.userId);
    const parsed = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid status.' });
      return;
    }
    if (targetUserId === req.auth!.userId) {
      res.status(400).json({ error: 'Cannot suspend your own active session account.' });
      return;
    }

    const membership = db
      .prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND organization_id = ?')
      .get(targetUserId, req.auth!.activeOrgId);
    if (!membership) {
      res.status(403).json({ error: 'User does not belong to your organization.' });
      return;
    }

    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(
      parsed.data.status,
      new Date().toISOString(),
      targetUserId
    );
    writeAuditLog(db, req.auth!.userId, 'ORGANIZATION_ADMIN', `USER_${parsed.data.status}`, 'USER', targetUserId);
    res.json({ ok: true });
  });

  // =========================================================================
  // 13. PLATFORM ADMIN WORKSPACE ROUTES
  // =========================================================================
  router.get('/platform/admin', requireAuth, requireRole('PLATFORM_ADMIN'), (_req: Request, res: Response) => {
    const counts = {
      organizations: (db.prepare('SELECT COUNT(*) as c FROM organizations').get() as { c: number }).c,
      users: (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c,
      farms: (db.prepare('SELECT COUNT(*) as c FROM farms').get() as { c: number }).c,
      fields: (db.prepare('SELECT COUNT(*) as c FROM fields').get() as { c: number }).c,
      observations: (db.prepare('SELECT COUNT(*) as c FROM environmental_observations').get() as { c: number }).c,
      rotationPlans: (db.prepare('SELECT COUNT(*) as c FROM rotation_plans').get() as { c: number }).c,
    };

    const providers = db
      .prepare(
        `SELECT ds.*, ph.status, ph.last_checked_at, ph.last_success_at,
                ph.latest_observation_at, ph.records_processed, ph.last_error, ph.credential_configured
         FROM data_sources ds JOIN provider_health ph ON ph.source_id = ds.id ORDER BY ds.id ASC`
      )
      .all();

    const ingestionRuns = db
      .prepare('SELECT * FROM data_ingestion_runs ORDER BY started_at DESC LIMIT 35')
      .all();

    const auditLogs = db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 40')
      .all();

    res.json({
      counts,
      providers,
      ingestionRuns,
      auditLogs,
      envStatus: {
        appEnv: process.env.APP_ENV || 'development',
        demoAuthEnabled: getDemoConfig().enabled,
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
        earthdataConfigured: Boolean(process.env.EARTHDATA_TOKEN),
        imdConfigured: Boolean(process.env.IMD_API_KEY),
        dataGovConfigured: Boolean(process.env.DATA_GOV_API_KEY),
      },
    });
  });

  router.post('/nasa/ingestion/run', requireAuth, requireRole('PLATFORM_ADMIN'), async (req: Request, res: Response) => {
    const lat = Number(req.body?.lat || 19.8825);
    const lon = Number(req.body?.lon || 74.4789);
    const result = await refreshAllProvidersForLocation(db, {
      lat,
      lon,
      state: 'Maharashtra',
      district: 'Ahilyanagar',
    });
    writeAuditLog(db, req.auth!.userId, 'PLATFORM_ADMIN', 'MANUAL_INGESTION_TRIGGERED', 'NASA_PIPELINE', null, {
      lat,
      lon,
    });
    res.json({ ok: true, result });
  });

  router.post('/platform/providers/:sourceId/test', requireAuth, requireRole('PLATFORM_ADMIN'), async (req: Request, res: Response) => {
    const sourceId = String(req.params.sourceId);
    const lat = req.body?.lat !== undefined ? Number(req.body.lat) : 19.8825;
    const lon = req.body?.lon !== undefined ? Number(req.body.lon) : 74.4789;
    const testResult = await testProviderConnection(
      db,
      sourceId,
      Number.isFinite(lat) ? lat : 19.8825,
      Number.isFinite(lon) ? lon : 74.4789
    );
    writeAuditLog(db, req.auth!.userId, 'PLATFORM_ADMIN', 'PROVIDER_CONNECTION_TESTED', 'DATA_SOURCE', sourceId, {
      verificationLabel: testResult.verificationLabel,
      httpStatus: testResult.httpStatus,
    });
    res.json(testResult);
  });

  return router;
}
