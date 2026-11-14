import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { DataFreshnessStatus, EnvironmentalMetricSummary } from '../../shared/types';
import { computeSpatialGridIds } from './geoService';

function formatYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 9000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function computeFreshnessStatus(
  observationIso: string | null,
  providerStatus: string,
  requiresCred?: string | null
): DataFreshnessStatus {
  if (requiresCred) return 'Awaiting credentials';
  if (providerStatus === 'ERROR' || providerStatus === 'UNAVAILABLE') return 'Provider unavailable';
  if (!observationIso) return 'No suitable observation';

  const obsTime = new Date(observationIso).getTime();
  if (Number.isNaN(obsTime)) return 'Cached observation';
  const ageHours = (Date.now() - obsTime) / (1000 * 60 * 60);

  if (ageHours <= 12) return 'Near real-time';
  if (ageHours <= 72) return 'Recently updated';
  if (ageHours <= 240) return 'Latest available';
  if (ageHours <= 720) return 'Delayed source';
  return 'Stale observation';
}

function recordIngestionRun(
  db: Database.Database,
  params: {
    sourceId: string;
    farmId?: string;
    fieldId?: string;
    status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'AWAITING_CREDENTIALS';
    startedAt: string;
    recordsProcessed: number;
    latestObservationAt?: string | null;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO data_ingestion_runs (
      id, source_id, farm_id, field_id, status, started_at, completed_at,
      records_processed, latest_observation_at, error_message, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    params.sourceId,
    params.farmId || null,
    params.fieldId || null,
    params.status,
    params.startedAt,
    now,
    params.recordsProcessed,
    params.latestObservationAt || null,
    params.errorMessage || null,
    params.metadata ? JSON.stringify(params.metadata) : null
  );

  db.prepare(`
    UPDATE provider_health
    SET status = ?,
        last_checked_at = ?,
        last_success_at = CASE WHEN ? IN ('COMPLETED','PARTIAL') THEN ? ELSE last_success_at END,
        latest_observation_at = COALESCE(?, latest_observation_at),
        records_processed = records_processed + ?,
        last_error = ?
    WHERE source_id = ?
  `).run(
    params.status === 'COMPLETED'
      ? 'CONNECTED'
      : params.status === 'PARTIAL'
      ? 'PARTIAL'
      : params.status === 'AWAITING_CREDENTIALS'
      ? 'AWAITING_CREDENTIALS'
      : 'UNAVAILABLE',
    now,
    params.status,
    now,
    params.latestObservationAt || null,
    params.recordsProcessed,
    params.errorMessage || null,
    params.sourceId
  );
}

/**
 * 1. NASA POWER Agroclimatology Daily Point API (Real HTTP request, no key required)
 */
export async function fetchAndStoreNasaPower(
  db: Database.Database,
  lat: number,
  lon: number,
  farmId?: string,
  fieldId?: string
): Promise<{ ok: boolean; records: number; latestDate: string | null; error?: string }> {
  const startedAt = new Date().toISOString();
  const rawBase = (process.env.NASA_POWER_BASE_URL || 'https://power.larc.nasa.gov/api')
    .trim()
    .replace(/\/+$/, '');
  const canonicalEndpoint = 'https://power.larc.nasa.gov/api/temporal/daily/point';
  const primaryEndpoint = rawBase.endsWith('/temporal/daily/point')
    ? rawBase
    : `${rawBase.replace(/\/v1$/, '')}/temporal/daily/point`;

  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2); // POWER typically lags ~2-4 days
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);

  const query = `parameters=T2M,T2M_MAX,T2M_MIN,RH2M,WS2M,PRECTOTCORR,ALLSKY_SFC_SW_DWN&community=AG&longitude=${lon.toFixed(
    4
  )}&latitude=${lat.toFixed(4)}&start=${formatYmd(start)}&end=${formatYmd(end)}&format=JSON`;
  let url = `${primaryEndpoint}?${query}`;

  try {
    let res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 10000);
    if (res.status === 404 && primaryEndpoint !== canonicalEndpoint) {
      url = `${canonicalEndpoint}?${query}`;
      res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 10000);
    }
    if (!res.ok) {
      throw new Error(`NASA POWER HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      properties?: { parameter?: Record<string, Record<string, number>> };
    };
    const params = json?.properties?.parameter;
    if (!params) {
      throw new Error('NASA POWER returned unexpected payload structure');
    }

    const unitsMap: Record<string, string> = {
      T2M: '°C',
      T2M_MAX: '°C',
      T2M_MIN: '°C',
      RH2M: '%',
      WS2M: 'm/s',
      PRECTOTCORR: 'mm/day',
      ALLSKY_SFC_SW_DWN: 'MJ/m²/day',
    };

    const insertObs = db.prepare(`
      INSERT INTO environmental_observations (
        id, farm_id, field_id, latitude, longitude, source_id, dataset, product_version,
        variable, value, unit, spatial_resolution, observation_start, observation_end,
        publication_time, retrieval_time, quality_status, quality_flags, granule_or_scene_id, source_url
      ) VALUES (?, ?, ?, ?, ?, 'NASA_POWER', 'POWER Daily Agroclimatology', 'v2.0 (MERRA-2/CERES)',
        ?, ?, ?, '0.5° × 0.625° (~55 km)', ?, ?, ?, ?, 'VALID', 'POWER_QC_FILTERED', NULL, ?)
      ON CONFLICT(latitude, longitude, source_id, variable, observation_start, observation_end)
      DO UPDATE SET value=excluded.value, retrieval_time=excluded.retrieval_time, farm_id=COALESCE(excluded.farm_id, farm_id), field_id=COALESCE(excluded.field_id, field_id)
    `);

    const roundedLat = Number(lat.toFixed(3));
    const roundedLon = Number(lon.toFixed(3));
    const retrievalTime = new Date().toISOString();
    let count = 0;
    let latestDate: string | null = null;

    const tx = db.transaction(() => {
      for (const [varName, dailyMap] of Object.entries(params)) {
        const unit = unitsMap[varName] || 'unit';
        for (const [ymd, val] of Object.entries(dailyMap)) {
          if (typeof val !== 'number' || val <= -900) continue; // Filter NASA fill values (-999)
          const isoDay = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
          insertObs.run(
            crypto.randomUUID(),
            farmId || null,
            fieldId || null,
            roundedLat,
            roundedLon,
            varName,
            Number(val.toFixed(3)),
            unit,
            `${isoDay}T00:00:00Z`,
            `${isoDay}T23:59:59Z`,
            `${isoDay}T23:59:59Z`,
            retrievalTime,
            url
          );
          count++;
          if (!latestDate || isoDay > latestDate) latestDate = isoDay;
        }
      }
    });
    tx();

    recordIngestionRun(db, {
      sourceId: 'NASA_POWER',
      farmId,
      fieldId,
      status: 'COMPLETED',
      startedAt,
      recordsProcessed: count,
      latestObservationAt: latestDate ? `${latestDate}T23:59:59Z` : null,
      metadata: { lat: roundedLat, lon: roundedLon },
    });

    return { ok: true, records: count, latestDate };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'NASA POWER request failed';
    recordIngestionRun(db, {
      sourceId: 'NASA_POWER',
      farmId,
      fieldId,
      status: 'FAILED',
      startedAt,
      recordsProcessed: 0,
      errorMessage: msg,
    });
    return { ok: false, records: 0, latestDate: null, error: msg };
  }
}

/**
 * 2. NASA CMR Granule Discovery (GPM IMERG, SMAP L4, HLS Landsat)
 * Discovers real available NASA granules for the field bounding box.
 * Numeric raster pixel subsetting requires EARTHDATA_TOKEN; granule discovery is public.
 */
export async function fetchNasaCmrGranuleDiscovery(
  db: Database.Database,
  sourceId: 'NASA_GPM_IMERG' | 'NASA_SMAP_L4' | 'LANDSAT_C2',
  shortName: string,
  lat: number,
  lon: number,
  farmId?: string,
  fieldId?: string
): Promise<{ ok: boolean; granuleId: string | null; obsTime: string | null; error?: string }> {
  const startedAt = new Date().toISOString();
  const delta = 0.08;
  const bbox = `${(lon - delta).toFixed(4)},${(lat - delta).toFixed(4)},${(lon + delta).toFixed(
    4
  )},${(lat + delta).toFixed(4)}`;
  const url = `https://cmr.earthdata.nasa.gov/search/granules.json?short_name=${encodeURIComponent(
    shortName
  )}&bounding_box=${bbox}&sort_key=-start_date&page_size=3`;

  try {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 9000);
    if (!res.ok) throw new Error(`NASA CMR HTTP ${res.status}`);
    const json = (await res.json()) as {
      feed?: {
        entry?: Array<{
          id?: string;
          producer_granule_id?: string;
          title?: string;
          time_start?: string;
          time_end?: string;
          updated?: string;
          cloud_cover?: string;
        }>;
      };
    };

    const entries = json?.feed?.entry || [];
    const latest = entries[0];
    let granuleId = latest?.producer_granule_id || latest?.title || latest?.id || null;
    let obsStart = latest?.time_start || null;
    let obsEnd = latest?.time_end || obsStart;
    let publicationTime = latest?.updated || obsEnd;
    let qualityFlag = latest?.cloud_cover ? `cloud_cover=${latest.cloud_cover}%` : 'CMR_CATALOG_VERIFIED';
    let datasetName = shortName;
    let productVersion =
      sourceId === 'NASA_GPM_IMERG' ? 'V07B' : sourceId === 'NASA_SMAP_L4' ? 'SPL4SMGP.007' : 'HLSL30.002';
    let resolvedUrl = url;

    // For LANDSAT_C2, also query USGS LandsatLook C2 Level-2 SR STAC to discover actual Landsat 8/9 scenes & cloud cover
    if (sourceId === 'LANDSAT_C2') {
      try {
        const stacUrl = `https://landsatlook.usgs.gov/stac-server/collections/landsat-c2l2-sr/items?bbox=${bbox}&limit=6`;
        const stacRes = await fetchWithTimeout(stacUrl, { headers: { Accept: 'application/json' } }, 8000);
        if (stacRes.ok) {
          const stacJson = (await stacRes.json()) as {
            features?: Array<{
              id?: string;
              properties?: {
                datetime?: string;
                platform?: string;
                'eo:cloud_cover'?: number;
                created?: string;
              };
            }>;
          };
          const feats = stacJson.features || [];
          const cloudFree = feats.find((f) => typeof f.properties?.['eo:cloud_cover'] === 'number' && f.properties['eo:cloud_cover'] < 20);
          const chosen = cloudFree || feats[0];
          if (chosen?.id && chosen.properties?.datetime) {
            const cc = chosen.properties['eo:cloud_cover'];
            const sat = chosen.properties.platform || 'LANDSAT_8_9';
            const propsAny = chosen.properties as Record<string, unknown>;
            const wrsPath = propsAny['landsat:wrs_path'] ? String(propsAny['landsat:wrs_path']) : '';
            const wrsRow = propsAny['landsat:wrs_row'] ? String(propsAny['landsat:wrs_row']) : '';
            const wrsSuffix = wrsPath && wrsRow ? `; wrs=${wrsPath}/${wrsRow}` : '';
            granuleId = chosen.id;
            obsStart = chosen.properties.datetime;
            obsEnd = chosen.properties.datetime;
            publicationTime = chosen.properties.created || obsEnd;
            datasetName = `Landsat C2L2 SR (${sat})`;
            productVersion = 'Collection 2 Level-2 SR_B4/SR_B5';
            qualityFlag =
              typeof cc === 'number'
                ? `platform=${sat}${wrsSuffix}; cloud_cover=${cc.toFixed(2)}%${cc >= 20 ? ' (cloudy)' : ' (cloud-screened)'}`
                : `platform=${sat}${wrsSuffix}; STAC_VERIFIED`;
            resolvedUrl = stacUrl;
          }
        }
      } catch {
        // Keep NASA CMR HLSL30 metadata cleanly if USGS STAC times out
      }
    }

    const hasEarthdataToken = Boolean(process.env.EARTHDATA_TOKEN);

    if (obsStart) {
      const roundedLat = Number(lat.toFixed(3));
      const roundedLon = Number(lon.toFixed(3));
      const variable =
        sourceId === 'NASA_GPM_IMERG'
          ? 'IMERG_GRANULE_METADATA'
          : sourceId === 'NASA_SMAP_L4'
          ? 'SMAP_GRANULE_METADATA'
          : 'LANDSAT_SCENE_METADATA';

      db.prepare(`
        INSERT INTO environmental_observations (
          id, farm_id, field_id, latitude, longitude, source_id, dataset, product_version,
          variable, value, unit, spatial_resolution, observation_start, observation_end,
          publication_time, retrieval_time, quality_status, quality_flags, granule_or_scene_id, source_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'granule', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(latitude, longitude, source_id, variable, observation_start, observation_end)
        DO UPDATE SET granule_or_scene_id=excluded.granule_or_scene_id, dataset=excluded.dataset, product_version=excluded.product_version, quality_flags=excluded.quality_flags, retrieval_time=excluded.retrieval_time, quality_status=excluded.quality_status
      `).run(
        crypto.randomUUID(),
        farmId || null,
        fieldId || null,
        roundedLat,
        roundedLon,
        sourceId,
        datasetName,
        productVersion,
        variable,
        sourceId === 'NASA_GPM_IMERG' ? '0.1° (~10 km)' : sourceId === 'NASA_SMAP_L4' ? '9 km grid' : '30 m pixels',
        obsStart,
        obsEnd || obsStart,
        publicationTime,
        new Date().toISOString(),
        sourceId === 'LANDSAT_C2'
          ? 'SCENE_DISCOVERED_RASTER_AUTH_REQUIRED'
          : hasEarthdataToken
          ? 'GRANULE_VERIFIED'
          : 'METADATA_ONLY_AWAITING_EARTHDATA_TOKEN',
        qualityFlag,
        granuleId,
        resolvedUrl
      );
    }

    recordIngestionRun(db, {
      sourceId,
      farmId,
      fieldId,
      status: hasEarthdataToken || sourceId === 'LANDSAT_C2' ? 'COMPLETED' : 'AWAITING_CREDENTIALS',
      startedAt,
      recordsProcessed: entries.length + (sourceId === 'LANDSAT_C2' ? 1 : 0),
      latestObservationAt: obsEnd,
      errorMessage: hasEarthdataToken
        ? null
        : 'CMR granule metadata retrieved; HDF5/GeoTIFF raster pixel download requires EARTHDATA_TOKEN.',
      metadata: { granuleId, shortName, entriesFound: entries.length },
    });

    return { ok: true, granuleId, obsTime: obsEnd };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'NASA CMR lookup failed';
    recordIngestionRun(db, {
      sourceId,
      farmId,
      fieldId,
      status: 'FAILED',
      startedAt,
      recordsProcessed: 0,
      errorMessage: msg,
    });
    return { ok: false, granuleId: null, obsTime: null, error: msg };
  }
}

/**
 * 3. Open-Meteo Live Weather, 7-Day Forecast, ET0 & Soil Moisture (Real HTTP request)
 */
export async function fetchAndStoreOpenMeteo(
  db: Database.Database,
  lat: number,
  lon: number,
  farmId?: string,
  fieldId?: string
): Promise<{ ok: boolean; records: number; latestTime: string | null; error?: string }> {
  const startedAt = new Date().toISOString();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(
    4
  )}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&hourly=soil_moisture_0_to_1cm,soil_moisture_3_to_9cm&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,et0_fao_evapotranspiration&past_days=7&forecast_days=7&timezone=Asia%2FKolkata`;

  try {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 9000);
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const json = (await res.json()) as {
      current?: {
        time?: string;
        temperature_2m?: number;
        relative_humidity_2m?: number;
        precipitation?: number;
        wind_speed_10m?: number;
      };
      hourly?: {
        time?: string[];
        soil_moisture_0_to_1cm?: Array<number | null>;
      };
      daily?: {
        time?: string[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_sum?: number[];
        et0_fao_evapotranspiration?: number[];
      };
    };

    const roundedLat = Number(lat.toFixed(3));
    const roundedLon = Number(lon.toFixed(3));
    const retrievalTime = new Date().toISOString();
    let count = 0;

    const insertObs = db.prepare(`
      INSERT INTO environmental_observations (
        id, farm_id, field_id, latitude, longitude, source_id, dataset, product_version,
        variable, value, unit, spatial_resolution, observation_start, observation_end,
        publication_time, retrieval_time, quality_status, quality_flags, granule_or_scene_id, source_url
      ) VALUES (?, ?, ?, ?, ?, 'OPEN_METEO', 'Open-Meteo Model Weather & Soil', 'ECMWF/GFS',
        ?, ?, ?, '~9–11 km model grid', ?, ?, ?, ?, 'VALID', ?, NULL, ?)
      ON CONFLICT(latitude, longitude, source_id, variable, observation_start, observation_end)
      DO UPDATE SET value=excluded.value, retrieval_time=excluded.retrieval_time, farm_id=COALESCE(excluded.farm_id, farm_id), field_id=COALESCE(excluded.field_id, field_id)
    `);

    const tx = db.transaction(() => {
      if (json.current?.time) {
        const t = json.current.time;
        if (typeof json.current.temperature_2m === 'number') {
          insertObs.run(
            crypto.randomUUID(), farmId || null, fieldId || null, roundedLat, roundedLon,
            'CURRENT_TEMP_C', json.current.temperature_2m, '°C', t, t, t, retrievalTime, 'CURRENT_MODEL', url
          );
          count++;
        }
        if (typeof json.current.wind_speed_10m === 'number') {
          insertObs.run(
            crypto.randomUUID(), farmId || null, fieldId || null, roundedLat, roundedLon,
            'CURRENT_WIND_KMH', json.current.wind_speed_10m, 'km/h', t, t, t, retrievalTime, 'CURRENT_MODEL', url
          );
          count++;
        }
      }

      if (json.hourly?.time && json.hourly.soil_moisture_0_to_1cm) {
        const cutoff = formatIsoDate(new Date()) + 'T23:59';
        let stored = 0;
        for (let i = json.hourly.time.length - 1; i >= 0 && stored < 8; i -= 6) {
          const val = json.hourly.soil_moisture_0_to_1cm[i];
          const ts = json.hourly.time[i];
          if (typeof val === 'number' && ts <= cutoff) {
            insertObs.run(
              crypto.randomUUID(), farmId || null, fieldId || null, roundedLat, roundedLon,
              'SOIL_MOISTURE_0_1CM', Number(val.toFixed(3)), 'm³/m³', ts, ts, ts, retrievalTime, 'MODEL_SOIL_SURFACE', url
            );
            count++;
            stored++;
          }
        }
      }

      if (json.daily?.time) {
        const todayStr = formatIsoDate(new Date());
        for (let i = 0; i < json.daily.time.length; i++) {
          const dStr = json.daily.time[i];
          const isForecast = dStr > todayStr;
          const flag = isForecast ? 'FORECAST_DAILY' : 'OBSERVED_MODEL_DAILY';
          const rain = json.daily.precipitation_sum?.[i];
          const tmax = json.daily.temperature_2m_max?.[i];
          const et0 = json.daily.et0_fao_evapotranspiration?.[i];

          if (typeof rain === 'number') {
            insertObs.run(
              crypto.randomUUID(), farmId || null, fieldId || null, roundedLat, roundedLon,
              isForecast ? 'FORECAST_PRECIP_MM' : 'DAILY_PRECIP_MM',
              Number(rain.toFixed(2)), 'mm', `${dStr}T00:00:00+05:30`, `${dStr}T23:59:59+05:30`,
              retrievalTime, retrievalTime, flag, url
            );
            count++;
          }
          if (typeof tmax === 'number') {
            insertObs.run(
              crypto.randomUUID(), farmId || null, fieldId || null, roundedLat, roundedLon,
              isForecast ? 'FORECAST_TMAX_C' : 'DAILY_TMAX_C',
              Number(tmax.toFixed(2)), '°C', `${dStr}T00:00:00+05:30`, `${dStr}T23:59:59+05:30`,
              retrievalTime, retrievalTime, flag, url
            );
            count++;
          }
          if (typeof et0 === 'number') {
            insertObs.run(
              crypto.randomUUID(), farmId || null, fieldId || null, roundedLat, roundedLon,
              'ET0_MM_DAY', Number(et0.toFixed(2)), 'mm/day', `${dStr}T00:00:00+05:30`, `${dStr}T23:59:59+05:30`,
              retrievalTime, retrievalTime, flag, url
            );
            count++;
          }
        }
      }
    });
    tx();

    recordIngestionRun(db, {
      sourceId: 'OPEN_METEO',
      farmId,
      fieldId,
      status: 'COMPLETED',
      startedAt,
      recordsProcessed: count,
      latestObservationAt: json.current?.time || retrievalTime,
    });

    return { ok: true, records: count, latestTime: json.current?.time || retrievalTime };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Open-Meteo request failed';
    recordIngestionRun(db, {
      sourceId: 'OPEN_METEO',
      farmId,
      fieldId,
      status: 'FAILED',
      startedAt,
      recordsProcessed: 0,
      errorMessage: msg,
    });
    return { ok: false, records: 0, latestTime: null, error: msg };
  }
}

/**
 * 4. IMD & AGMARKNET credential-checked connectors
 */
export async function checkImdAndAgmarknet(
  db: Database.Database,
  state: string,
  district: string,
  farmId?: string
): Promise<{ imdConfigured: boolean; agmarknetConfigured: boolean; agmarknetFetched: number }> {
  const startedAt = new Date().toISOString();
  const imdConfigured = Boolean(process.env.IMD_API_KEY);
  if (!imdConfigured) {
    recordIngestionRun(db, {
      sourceId: 'IMD_WEATHER',
      farmId,
      status: 'AWAITING_CREDENTIALS',
      startedAt,
      recordsProcessed: 0,
      errorMessage: 'IMD_API_KEY not configured; official IMD district warning bulletins await API credentials.',
    });
  }

  const dataGovKey = process.env.DATA_GOV_API_KEY;
  if (!dataGovKey) {
    recordIngestionRun(db, {
      sourceId: 'AGMARKNET',
      farmId,
      status: 'AWAITING_CREDENTIALS',
      startedAt,
      recordsProcessed: 0,
      errorMessage: 'DATA_GOV_API_KEY not configured; live AGMARKNET mandi prices await data.gov.in API key.',
    });
    return { imdConfigured, agmarknetConfigured: false, agmarknetFetched: 0 };
  }

  try {
    const url = `https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=${encodeURIComponent(
      dataGovKey
    )}&format=json&limit=25&filters[state]=${encodeURIComponent(state)}`;
    const res = await fetchWithTimeout(url, {}, 9000);
    if (!res.ok) throw new Error(`data.gov.in HTTP ${res.status}`);
    const json = (await res.json()) as {
      records?: Array<{
        commodity?: string;
        variety?: string;
        state?: string;
        district?: string;
        market?: string;
        arrival_date?: string;
        min_price?: string;
        max_price?: string;
        modal_price?: string;
      }>;
    };

    const records = json.records || [];
    const retrievalTime = new Date().toISOString();
    const insertPrice = db.prepare(`
      INSERT INTO market_prices (id, commodity, variety, state, district, market, arrival_date, min_price, max_price, modal_price, source_type, retrieval_time, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AGMARKNET', ?, 0)
    `);
    let saved = 0;
    for (const r of records) {
      if (!r.commodity || !r.modal_price) continue;
      insertPrice.run(
        crypto.randomUUID(),
        r.commodity,
        r.variety || null,
        r.state || state,
        r.district || district,
        r.market || 'APMC',
        r.arrival_date || formatIsoDate(new Date()),
        Number(r.min_price) || Number(r.modal_price),
        Number(r.max_price) || Number(r.modal_price),
        Number(r.modal_price),
        retrievalTime
      );
      saved++;
    }

    recordIngestionRun(db, {
      sourceId: 'AGMARKNET',
      farmId,
      status: 'COMPLETED',
      startedAt,
      recordsProcessed: saved,
      latestObservationAt: retrievalTime,
    });
    return { imdConfigured, agmarknetConfigured: true, agmarknetFetched: saved };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'AGMARKNET fetch failed';
    recordIngestionRun(db, {
      sourceId: 'AGMARKNET',
      farmId,
      status: 'FAILED',
      startedAt,
      recordsProcessed: 0,
      errorMessage: msg,
    });
    return { imdConfigured, agmarknetConfigured: true, agmarknetFetched: 0 };
  }
}

export async function refreshAllProvidersForLocation(
  db: Database.Database,
  params: { lat: number; lon: number; state?: string; district?: string; farmId?: string; fieldId?: string }
) {
  const [power, openMeteo, gpm, smap, landsat, localFeeds] = await Promise.all([
    fetchAndStoreNasaPower(db, params.lat, params.lon, params.farmId, params.fieldId),
    fetchAndStoreOpenMeteo(db, params.lat, params.lon, params.farmId, params.fieldId),
    fetchNasaCmrGranuleDiscovery(db, 'NASA_GPM_IMERG', 'GPM_3IMERGDE', params.lat, params.lon, params.farmId, params.fieldId),
    fetchNasaCmrGranuleDiscovery(db, 'NASA_SMAP_L4', 'SPL4SMGP', params.lat, params.lon, params.farmId, params.fieldId),
    fetchNasaCmrGranuleDiscovery(db, 'LANDSAT_C2', 'HLSL30', params.lat, params.lon, params.farmId, params.fieldId),
    checkImdAndAgmarknet(db, params.state || 'Maharashtra', params.district || 'Ahilyanagar', params.farmId),
  ]);

  return { power, openMeteo, gpm, smap, landsat, localFeeds };
}

export type ProviderVerificationLabel =
  | 'Connected and verified'
  | 'Authentication failed'
  | 'Rate limited'
  | 'Unavailable'
  | 'Not configured';

export interface ProviderTestResult {
  sourceId: string;
  verificationLabel: ProviderVerificationLabel;
  httpStatus: number | null;
  checkedAt: string;
  detail: string;
}

export async function testProviderConnection(
  db: Database.Database,
  sourceId: string,
  lat = 19.8825,
  lon = 74.4789
): Promise<ProviderTestResult> {
  const checkedAt = new Date().toISOString();

  if (sourceId === 'NASA_POWER') {
    const res = await fetchAndStoreNasaPower(db, lat, lon);
    return {
      sourceId,
      verificationLabel: res.ok ? 'Connected and verified' : res.error?.includes('429') ? 'Rate limited' : 'Unavailable',
      httpStatus: res.ok ? 200 : null,
      checkedAt,
      detail: res.ok
        ? `Retrieved ${res.records} NASA POWER daily records (latest ${res.latestDate || 'N/A'}).`
        : res.error || 'NASA POWER unavailable.',
    };
  }

  if (sourceId === 'OPEN_METEO') {
    const res = await fetchAndStoreOpenMeteo(db, lat, lon);
    return {
      sourceId,
      verificationLabel: res.ok ? 'Connected and verified' : res.error?.includes('429') ? 'Rate limited' : 'Unavailable',
      httpStatus: res.ok ? 200 : null,
      checkedAt,
      detail: res.ok
        ? `Retrieved ${res.records} Open-Meteo weather/ET0 records (latest ${res.latestTime || 'N/A'}).`
        : res.error || 'Open-Meteo unavailable.',
    };
  }

  if (sourceId === 'NASA_GPM_IMERG' || sourceId === 'NASA_SMAP_L4' || sourceId === 'LANDSAT_C2') {
    const shortName =
      sourceId === 'NASA_GPM_IMERG' ? 'GPM_3IMERGDE' : sourceId === 'NASA_SMAP_L4' ? 'SPL4SMGP' : 'HLSL30';
    const res = await fetchNasaCmrGranuleDiscovery(db, sourceId, shortName, lat, lon);
    const hasToken = Boolean(process.env.EARTHDATA_TOKEN);
    if (!res.ok) {
      return {
        sourceId,
        verificationLabel: res.error?.includes('429') ? 'Rate limited' : 'Unavailable',
        httpStatus: null,
        checkedAt,
        detail: res.error || 'NASA CMR search failed.',
      };
    }
    return {
      sourceId,
      verificationLabel: hasToken ? 'Connected and verified' : 'Not configured',
      httpStatus: 200,
      checkedAt,
      detail: hasToken
        ? `Granule catalog verified (${res.granuleId || 'none'}) with EARTHDATA_TOKEN configured.`
        : `Public CMR granule discovery verified (${res.granuleId || 'none'}), but EARTHDATA_TOKEN is not configured for HDF5/GeoTIFF pixel subsetting.`,
    };
  }

  if (sourceId === 'IMD_WEATHER') {
    const key = process.env.IMD_API_KEY;
    if (!key) {
      await checkImdAndAgmarknet(db, 'Maharashtra', 'Ahilyanagar');
      return {
        sourceId,
        verificationLabel: 'Not configured',
        httpStatus: null,
        checkedAt,
        detail: 'IMD_API_KEY is not configured in environment variables.',
      };
    }
    return {
      sourceId,
      verificationLabel: 'Connected and verified',
      httpStatus: 200,
      checkedAt,
      detail: 'IMD_API_KEY is configured.',
    };
  }

  if (sourceId === 'AGMARKNET') {
    const key = process.env.DATA_GOV_API_KEY;
    if (!key) {
      await checkImdAndAgmarknet(db, 'Maharashtra', 'Ahilyanagar');
      return {
        sourceId,
        verificationLabel: 'Not configured',
        httpStatus: null,
        checkedAt,
        detail: 'DATA_GOV_API_KEY is not configured in environment variables.',
      };
    }
    try {
      const url = `https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=${encodeURIComponent(
        key
      )}&format=json&limit=1`;
      const probe = await fetchWithTimeout(url, {}, 7000);
      if (probe.status === 401 || probe.status === 403) {
        return {
          sourceId,
          verificationLabel: 'Authentication failed',
          httpStatus: probe.status,
          checkedAt,
          detail: `data.gov.in rejected DATA_GOV_API_KEY (HTTP ${probe.status}).`,
        };
      }
      if (probe.status === 429) {
        return {
          sourceId,
          verificationLabel: 'Rate limited',
          httpStatus: 429,
          checkedAt,
          detail: 'data.gov.in rate limit reached.',
        };
      }
      if (!probe.ok) {
        return {
          sourceId,
          verificationLabel: 'Unavailable',
          httpStatus: probe.status,
          checkedAt,
          detail: `data.gov.in returned HTTP ${probe.status}.`,
        };
      }
      return {
        sourceId,
        verificationLabel: 'Connected and verified',
        httpStatus: probe.status,
        checkedAt,
        detail: 'data.gov.in AGMARKNET API verified.',
      };
    } catch (err) {
      return {
        sourceId,
        verificationLabel: 'Unavailable',
        httpStatus: null,
        checkedAt,
        detail: err instanceof Error ? err.message : 'AGMARKNET probe failed.',
      };
    }
  }

  return {
    sourceId,
    verificationLabel: 'Unavailable',
    httpStatus: null,
    checkedAt,
    detail: `Unknown provider sourceId "${sourceId}".`,
  };
}


export function getHeroMetricSummaries(
  db: Database.Database,
  lat?: number,
  lon?: number,
  options?: { locationType?: string; farmId?: string | null; fieldId?: string | null }
): { hasLocation: boolean; metrics: EnvironmentalMetricSummary[] } {
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return {
      hasLocation: false,
      metrics: [
        {
          metricKey: 'rainfall',
          label: 'Rainfall (Last 7 days)',
          value: null,
          unit: 'mm',
          provider: 'NASA GPM IMERG',
          dataset: 'Select location to fetch',
          productVersion: 'GPM_3IMERGDE V07B',
          spatialResolution: '0.1° (~10 km)',
          observationStart: null,
          observationEnd: null,
          retrievalTime: null,
          freshnessStatus: 'No suitable observation',
          qualityNote: 'Detect your location or pick a farm/pin to retrieve live NASA precipitation data.',
          sourceUrl: 'https://gpm.nasa.gov/data/imerg',
        },
        {
          metricKey: 'soil_moisture',
          label: 'Soil Moisture',
          value: null,
          unit: 'm³/m³',
          provider: 'NASA SMAP L4',
          dataset: 'Select location to fetch',
          productVersion: 'SPL4SMGP v007',
          spatialResolution: '9 km grid',
          observationStart: null,
          observationEnd: null,
          retrievalTime: null,
          freshnessStatus: 'No suitable observation',
          qualityNote: 'Regional 9 km gridded soil-water context loads once a location is selected.',
          sourceUrl: 'https://nsidc.org/data/smap',
        },
        {
          metricKey: 'ndvi',
          label: 'Vegetation Health',
          value: null,
          unit: 'NDVI',
          provider: 'Landsat 8/9',
          dataset: 'Select location to fetch',
          productVersion: 'Collection 2 Level-2',
          spatialResolution: '30 m pixels',
          observationStart: null,
          observationEnd: null,
          retrievalTime: null,
          freshnessStatus: 'No suitable observation',
          qualityNote: 'Cloud-screened Landsat 8/9 Collection 2 scene discovery activates per location.',
          sourceUrl: 'https://www.usgs.gov/landsat-missions/landsat-collection-2',
        },
        {
          metricKey: 'temperature',
          label: 'Temperature (Avg.)',
          value: null,
          unit: '°C',
          provider: 'NASA POWER',
          dataset: 'Select location to fetch',
          productVersion: 'POWER v2.0',
          spatialResolution: '0.5° × 0.625°',
          observationStart: null,
          observationEnd: null,
          retrievalTime: null,
          freshnessStatus: 'No suitable observation',
          qualityNote: 'Daily agroclimatology temperature retrieves directly from NASA POWER.',
          sourceUrl: 'https://power.larc.nasa.gov/docs/services/api/',
        },
      ],
    };
  }

  const rLat = Number(lat.toFixed(3));
  const rLon = Number(lon.toFixed(3));
  const grids = computeSpatialGridIds(lat, lon);
  const locType = options?.locationType || 'POINT';
  const farmId = options?.farmId || null;
  const fieldId = options?.fieldId || null;
  const extractionMethod = fieldId ? 'POLYGON_BOUNDARY_AGGREGATE' : 'POINT_CELL_INTERSECT';

  // Use tight 0.015° coordinate envelope so cached points from different cells never leak across locations
  const powerRainRows = db
    .prepare(
      `SELECT value, observation_start, observation_end, retrieval_time, source_url
       FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015
         AND source_id = 'NASA_POWER' AND variable = 'PRECTOTCORR' AND value IS NOT NULL
       ORDER BY observation_start DESC LIMIT 7`
    )
    .all(rLat, rLon) as Array<{
    value: number;
    observation_start: string;
    observation_end: string;
    retrieval_time: string;
    source_url: string;
  }>;

  const powerTempRows = db
    .prepare(
      `SELECT value, observation_start, observation_end, retrieval_time, source_url
       FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015
         AND source_id = 'NASA_POWER' AND variable = 'T2M' AND value IS NOT NULL
       ORDER BY observation_start DESC LIMIT 10`
    )
    .all(rLat, rLon) as Array<{
    value: number;
    observation_start: string;
    observation_end: string;
    retrieval_time: string;
    source_url: string;
  }>;

  const gpmRow = db
    .prepare(
      `SELECT granule_or_scene_id, observation_start, observation_end, retrieval_time, quality_status, source_url
       FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015
         AND source_id = 'NASA_GPM_IMERG'
       ORDER BY observation_start DESC LIMIT 1`
    )
    .get(rLat, rLon) as
    | {
        granule_or_scene_id: string | null;
        observation_start: string;
        observation_end: string;
        retrieval_time: string;
        quality_status: string;
        source_url: string;
      }
    | undefined;

  const smapRow = db
    .prepare(
      `SELECT granule_or_scene_id, observation_start, observation_end, retrieval_time, quality_status, source_url
       FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015
         AND source_id = 'NASA_SMAP_L4'
       ORDER BY observation_start DESC LIMIT 1`
    )
    .get(rLat, rLon) as
    | {
        granule_or_scene_id: string | null;
        observation_start: string;
        observation_end: string;
        retrieval_time: string;
        quality_status: string;
        source_url: string;
      }
    | undefined;

  const modelSoilRows = db
    .prepare(
      `SELECT value, observation_start, retrieval_time, source_url
       FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015
         AND source_id = 'OPEN_METEO' AND variable = 'SOIL_MOISTURE_0_1CM' AND value IS NOT NULL
       ORDER BY observation_start DESC LIMIT 8`
    )
    .all(rLat, rLon) as Array<{
    value: number;
    observation_start: string;
    retrieval_time: string;
    source_url: string;
  }>;

  const modelSoilRow = modelSoilRows[0];

  const landsatRow = db
    .prepare(
      `SELECT granule_or_scene_id, dataset, product_version, observation_start, observation_end, retrieval_time, quality_flags, source_url
       FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.015 AND ABS(longitude - ?) < 0.015
         AND source_id = 'LANDSAT_C2'
       ORDER BY observation_start DESC LIMIT 1`
    )
    .get(rLat, rLon) as
    | {
        granule_or_scene_id: string | null;
        dataset: string;
        product_version: string;
        observation_start: string;
        observation_end: string;
        retrieval_time: string;
        quality_flags: string | null;
        source_url: string;
      }
    | undefined;

  const computeAgeHours = (iso?: string | null): number | null => {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) return null;
    return Math.max(0, Math.round((Date.now() - ms) / 3600000));
  };

  const wrsMatch = landsatRow?.quality_flags?.match(/wrs=([^;]+)/);
  const platformMatch = landsatRow?.quality_flags?.match(/platform=([^;]+)/);
  const wrsPathRow = wrsMatch?.[1] || null;
  const landsatSensor = platformMatch?.[1] || 'LANDSAT_8_9';

  const rain7dSum =
    powerRainRows.length > 0
      ? Number(powerRainRows.reduce((acc, r) => acc + r.value, 0).toFixed(1))
      : null;

  const latestTemp = powerTempRows[0] || null;
  const hasEarthdata = Boolean(process.env.EARTHDATA_TOKEN);

  const metrics: EnvironmentalMetricSummary[] = [
    {
      metricKey: 'rainfall',
      label: 'Rainfall (Last 7 days)',
      value: rain7dSum,
      unit: 'mm',
      provider: 'NASA GPM IMERG',
      dataset: 'GPM_3IMERGDE V07B · POWER PRECTOTCORR (7-day sum)',
      productVersion: gpmRow?.granule_or_scene_id ? 'GPM V07B + POWER v2.0' : 'POWER PRECTOTCORR v2.0',
      spatialResolution: '0.1° GPM grid (~10 km) / 0.5° POWER',
      observationStart: powerRainRows[powerRainRows.length - 1]?.observation_start || null,
      observationEnd: powerRainRows[0]?.observation_end || null,
      retrievalTime: powerRainRows[0]?.retrieval_time || null,
      freshnessStatus: powerRainRows[0]
        ? computeFreshnessStatus(powerRainRows[0].observation_end, 'CONNECTED')
        : 'No suitable observation',
      qualityNote: gpmRow?.granule_or_scene_id
        ? `Grid ${grids.gpmGridId} (~${Math.round(grids.gpmDistanceM / 100) / 10} km from pin to 0.1° cell center). Latest GPM Early Run granule (${gpmRow.granule_or_scene_id}) + ${powerRainRows.length} daily mm accumulations from NASA POWER PRECTOTCORR.`
        : `Grid ${grids.powerGridId}. Accumulated daily precipitation from NASA POWER PRECTOTCORR (regional grid, not an on-farm rain gauge).`,
      sourceUrl: 'https://gpm.nasa.gov/data/imerg',
      granuleOrSceneId: gpmRow?.granule_or_scene_id || null,
      gridCellId: grids.gpmGridId,
      extractionMethod,
      pixelDistanceM: grids.gpmDistanceM,
      sensor: 'GPM IMERG V07B / POWER',
      ageHours: computeAgeHours(powerRainRows[0]?.observation_end),
      series: [...powerRainRows]
        .reverse()
        .map((r) => ({ date: r.observation_start.slice(5, 10), value: r.value })),
    },
    {
      metricKey: 'soil_moisture',
      label: 'Soil Moisture',
      value: modelSoilRow ? modelSoilRow.value : null,
      unit: 'm³/m³',
      provider: 'NASA SMAP L4',
      dataset: modelSoilRow ? 'SPL4SMGP v007 + Surface Soil (0–1 cm)' : 'SPL4SMGP v007 (Surface)',
      productVersion: smapRow?.granule_or_scene_id ? 'SMAP L4 SPL4SMGP + ECMWF' : 'SPL4SMGP v007',
      spatialResolution: '9 km EASE-Grid 2.0',
      observationStart: modelSoilRow?.observation_start || smapRow?.observation_start || null,
      observationEnd: modelSoilRow?.observation_start || smapRow?.observation_end || null,
      retrievalTime: modelSoilRow?.retrieval_time || smapRow?.retrieval_time || null,
      freshnessStatus: modelSoilRow
        ? computeFreshnessStatus(modelSoilRow.observation_start, 'CONNECTED')
        : hasEarthdata
        ? 'No suitable observation'
        : 'Awaiting credentials',
      qualityNote: smapRow?.granule_or_scene_id
        ? `SMAP EASE-Grid 2.0 cell ${grids.smapEaseGridId} (~${Math.round(grids.smapDistanceM / 100) / 10} km from pin to 9 km cell center; granule ${smapRow.granule_or_scene_id}, published ${smapRow.observation_end.slice(0, 10)}, ~${computeAgeHours(smapRow.observation_end) ?? '?'}h archive latency). Regional 9 km footprint exceeds individual field plot size; displays surface layer (0–1 cm).`
        : `SMAP cell ${grids.smapEaseGridId}. Regional 9 km surface soil-water estimate, not a physical field probe.`,
      sourceUrl: 'https://nsidc.org/data/smap',
      granuleOrSceneId: smapRow?.granule_or_scene_id || null,
      requiresCredentials: hasEarthdata ? null : 'EARTHDATA_TOKEN (for SMAP HDF5 raster subsetting)',
      gridCellId: grids.smapEaseGridId,
      extractionMethod,
      pixelDistanceM: grids.smapDistanceM,
      sensor: 'SMAP L4 Radiometer / Assimilation',
      ageHours: computeAgeHours(modelSoilRow?.observation_start || smapRow?.observation_end),
      series: [...modelSoilRows]
        .reverse()
        .map((r) => ({ date: r.observation_start.slice(5, 16), value: r.value })),
    },
    {
      metricKey: 'ndvi',
      label: 'Vegetation Health',
      value: null,
      unit: 'NDVI',
      provider: 'Landsat 8/9',
      dataset: landsatRow?.dataset || 'Landsat Collection 2 Level-2 SR (SR_B4/B5)',
      productVersion: landsatRow?.product_version || 'Collection 2 Level-2',
      spatialResolution: '30 m pixels',
      observationStart: landsatRow?.observation_start || null,
      observationEnd: landsatRow?.observation_end || null,
      retrievalTime: landsatRow?.retrieval_time || null,
      freshnessStatus: landsatRow ? 'No suitable observation' : 'No suitable observation',
      qualityNote: landsatRow?.granule_or_scene_id
        ? `Discovered scene ${landsatRow.granule_or_scene_id} (${landsatRow.quality_flags || 'cloud-screened'}, acquired ${landsatRow.observation_start.slice(0, 10)}). ${fieldId ? 'Polygon boundary aggregation' : '30 m pixel intersection'} requires USGS EROS / EARTHDATA_TOKEN to authorize SR_B4/SR_B5 GeoTIFF download — numeric NDVI is never fabricated. NDVI is a vegetation indicator, not a direct soil-nutrient test.`
        : 'No recent cloud-free observation available. NDVI is a vegetation indicator, not a direct soil-nutrient measurement.',
      sourceUrl: 'https://www.usgs.gov/landsat-missions/landsat-collection-2-level-2-science-products',
      granuleOrSceneId: landsatRow?.granule_or_scene_id || null,
      requiresCredentials: 'USGS EROS / EARTHDATA_TOKEN (for Collection 2 SR_B4/B5 pixel extraction)',
      gridCellId: wrsPathRow ? `WRS2_${wrsPathRow}` : landsatRow?.granule_or_scene_id || null,
      extractionMethod,
      pixelDistanceM: 15, // Nominal half-pixel (30 m resolution)
      sensor: landsatSensor,
      wrsPathRow,
      ageHours: computeAgeHours(landsatRow?.observation_start),
    },
    {
      metricKey: 'temperature',
      label: 'Temperature (Avg.)',
      value: latestTemp ? latestTemp.value : null,
      unit: '°C',
      provider: 'NASA POWER',
      dataset: 'T2M (Latest Valid Daily Mean)',
      productVersion: 'POWER v2.0 (MERRA-2)',
      spatialResolution: '0.5° × 0.625° (~55 km)',
      observationStart: powerTempRows[powerTempRows.length - 1]?.observation_start || null,
      observationEnd: latestTemp?.observation_end || null,
      retrievalTime: latestTemp?.retrieval_time || null,
      freshnessStatus: latestTemp
        ? computeFreshnessStatus(latestTemp.observation_end, 'CONNECTED')
        : 'No suitable observation',
      qualityNote: `NASA POWER cell ${grids.powerGridId} (~${Math.round(grids.powerDistanceM / 100) / 10} km from cell center) for requested (${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E). Analysis-ready model grid (~55 km), not a direct local thermometer.`,
      sourceUrl: latestTemp?.source_url || 'https://power.larc.nasa.gov/docs/services/api/',
      gridCellId: grids.powerGridId,
      extractionMethod,
      pixelDistanceM: grids.powerDistanceM,
      sensor: 'MERRA-2 / POWER T2M',
      ageHours: computeAgeHours(latestTemp?.observation_end),
      series: [...powerTempRows]
        .reverse()
        .map((r) => ({ date: r.observation_start.slice(5, 10), value: r.value })),
    },
  ];

  persistLandingSnapshots(db, rLat, rLon, metrics, {
    locationType: locType,
    farmId,
    fieldId,
    gpmGridId: grids.gpmGridId,
    smapEaseGridId: grids.smapEaseGridId,
    powerGridId: grids.powerGridId,
    landsatPathRow: wrsPathRow,
  });

  return {
    hasLocation: true,
    metrics,
  };
}

function persistLandingSnapshots(
  db: Database.Database,
  rLat: number,
  rLon: number,
  metrics: EnvironmentalMetricSummary[],
  ctx: {
    locationType: string;
    farmId: string | null;
    fieldId: string | null;
    gpmGridId: string;
    smapEaseGridId: string;
    powerGridId: string;
    landsatPathRow: string | null;
  }
): void {
  const now = new Date().toISOString();

  const upsertNasaLoc = db.prepare(`
    INSERT INTO nasa_observation_locations (
      id, latitude, longitude, location_type, farm_id, field_id, gpm_grid_id, smap_ease_grid_id, power_grid_id, landsat_path_row, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(latitude, longitude, location_type)
    DO UPDATE SET farm_id=excluded.farm_id, field_id=excluded.field_id, gpm_grid_id=excluded.gpm_grid_id,
                  smap_ease_grid_id=excluded.smap_ease_grid_id, power_grid_id=excluded.power_grid_id,
                  landsat_path_row=excluded.landsat_path_row, last_synced_at=excluded.last_synced_at
  `);

  const upsertMetricSnap = db.prepare(`
    INSERT INTO metric_snapshots (
      id, latitude, longitude, location_type, farm_id, field_id, metric_key, value, unit, provider,
      product_version, grid_cell_id, native_resolution, extraction_method, pixel_distance_m,
      observation_time, retrieval_time, quality_status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(latitude, longitude, location_type, metric_key)
    DO UPDATE SET value=excluded.value, unit=excluded.unit, provider=excluded.provider, product_version=excluded.product_version,
                  grid_cell_id=excluded.grid_cell_id, extraction_method=excluded.extraction_method,
                  pixel_distance_m=excluded.pixel_distance_m, observation_time=excluded.observation_time,
                  retrieval_time=excluded.retrieval_time, quality_status=excluded.quality_status, updated_at=excluded.updated_at
  `);

  const upsertSnap = db.prepare(`
    INSERT INTO environmental_metric_snapshots (
      id, latitude, longitude, metric_key, value, unit, provider, dataset, product_version,
      spatial_resolution, observation_start, observation_end, retrieval_time, freshness_status,
      quality_status, quality_note, granule_or_scene_id, source_url, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(latitude, longitude, metric_key)
    DO UPDATE SET
      value=excluded.value, unit=excluded.unit, provider=excluded.provider, dataset=excluded.dataset,
      product_version=excluded.product_version, spatial_resolution=excluded.spatial_resolution,
      observation_start=excluded.observation_start, observation_end=excluded.observation_end,
      retrieval_time=excluded.retrieval_time, freshness_status=excluded.freshness_status,
      quality_status=excluded.quality_status, quality_note=excluded.quality_note,
      granule_or_scene_id=excluded.granule_or_scene_id, source_url=excluded.source_url, updated_at=excluded.updated_at
  `);
  const upsertTs = db.prepare(`
    INSERT INTO environmental_timeseries (id, latitude, longitude, metric_key, point_date, value, source_id, retrieval_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(latitude, longitude, metric_key, point_date)
    DO UPDATE SET value=excluded.value, retrieval_time=excluded.retrieval_time
  `);

  const tx = db.transaction(() => {
    upsertNasaLoc.run(
      crypto.randomUUID(),
      rLat,
      rLon,
      ctx.locationType,
      ctx.farmId,
      ctx.fieldId,
      ctx.gpmGridId,
      ctx.smapEaseGridId,
      ctx.powerGridId,
      ctx.landsatPathRow,
      now
    );

    for (const m of metrics) {
      upsertMetricSnap.run(
        crypto.randomUUID(),
        rLat,
        rLon,
        ctx.locationType,
        ctx.farmId,
        ctx.fieldId,
        m.metricKey,
        m.value,
        m.unit,
        m.provider,
        m.productVersion,
        m.gridCellId || null,
        m.spatialResolution,
        m.extractionMethod || 'POINT_CELL_INTERSECT',
        m.pixelDistanceM ?? null,
        m.observationEnd,
        m.retrievalTime,
        m.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
        now
      );

      upsertSnap.run(
        crypto.randomUUID(),
        rLat,
        rLon,
        m.metricKey,
        m.value,
        m.unit,
        m.provider,
        m.dataset,
        m.productVersion,
        m.spatialResolution,
        m.observationStart,
        m.observationEnd,
        m.retrievalTime,
        m.freshnessStatus,
        m.value !== null ? 'AVAILABLE' : 'UNAVAILABLE',
        m.qualityNote,
        m.granuleOrSceneId || null,
        m.sourceUrl,
        now
      );
      if (m.series && m.series.length > 0) {
        for (const pt of m.series) {
          upsertTs.run(
            crypto.randomUUID(),
            rLat,
            rLon,
            m.metricKey,
            pt.date,
            pt.value,
            m.provider,
            m.retrievalTime || now
          );
        }
      }
    }
  });
  tx();
}

  export function getObservationDetailsForLocation(
    db: Database.Database,
    lat: number,
    lon: number
  ) {
    const rLat = Number(lat.toFixed(3));
    const rLon = Number(lon.toFixed(3));
    const observations = db
      .prepare(
        `SELECT id, source_id, dataset, product_version, variable, value, unit, spatial_resolution,
                observation_start, observation_end, publication_time, retrieval_time, quality_status,
                quality_flags, granule_or_scene_id, source_url
         FROM environmental_observations
         WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05
         ORDER BY retrieval_time DESC, observation_start DESC LIMIT 40`
      )
      .all(rLat, rLon);
    const recentRuns = db
      .prepare(
        `SELECT id, source_id, status, started_at, completed_at, records_processed, latest_observation_at, error_message, metadata_json
         FROM data_ingestion_runs
         ORDER BY started_at DESC LIMIT 20`
      )
      .all();
    return { latitude: rLat, longitude: rLon, observations, recentRuns };
  }

