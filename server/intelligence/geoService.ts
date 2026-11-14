import type { GeoPoint } from '../../shared/types';

export interface GeographicContextResolution {
  agroclimaticZone: string;
  universityReference: string;
  nearestKvk: string;
  nearestMarkets: string[];
  state: string;
  district: string;
}

const EARTH_RADIUS_METERS = 6371000;

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineDistanceKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLon * sinLon;
  return (2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))) / 1000;
}

/**
 * Computes spherical polygon area in square meters (Girard's / Chamberlain-Duquette approximation)
 * for GeoJSON-ordered rings [[lon, lat], ...].
 */
export function calculatePolygonAreaSqMeters(ring: Array<[number, number]>): number {
  if (!Array.isArray(ring) || ring.length < 3) return 0;

  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring
      : [...ring, ring[0]];

  let total = 0;
  for (let i = 0; i < closed.length - 1; i++) {
    const [lon1, lat1] = closed[i];
    const [lon2, lat2] = closed[i + 1];
    total += toRadians(lon2 - lon1) * (2 + Math.sin(toRadians(lat1)) + Math.sin(toRadians(lat2)));
  }

  return Math.abs((total * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS) / 2);
}

export function calculatePolygonStats(ring: Array<[number, number]>): {
  valid: boolean;
  error?: string;
  areaSqMeters: number;
  areaHectares: number;
  areaAcres: number;
  centroid: GeoPoint;
  bbox: [number, number, number, number];
} {
  if (!Array.isArray(ring) || ring.length < 3) {
    return {
      valid: false,
      error: 'A field polygon requires at least 3 distinct coordinates.',
      areaSqMeters: 0,
      areaHectares: 0,
      areaAcres: 0,
      centroid: { lat: 0, lon: 0 },
      bbox: [0, 0, 0, 0],
    };
  }

  for (const pt of ring) {
    if (
      !Array.isArray(pt) ||
      pt.length < 2 ||
      !Number.isFinite(pt[0]) ||
      !Number.isFinite(pt[1]) ||
      pt[1] < -90 ||
      pt[1] > 90 ||
      pt[0] < -180 ||
      pt[0] > 180
    ) {
      return {
        valid: false,
        error: 'Invalid coordinate pair detected in field polygon.',
        areaSqMeters: 0,
        areaHectares: 0,
        areaAcres: 0,
        centroid: { lat: 0, lon: 0 },
        bbox: [0, 0, 0, 0],
      };
    }
  }

  const areaSqMeters = calculatePolygonAreaSqMeters(ring);
  if (areaSqMeters < 50) {
    return {
      valid: false,
      error: 'Field polygon area is too small (< 50 m²). Please draw a valid boundary.',
      areaSqMeters,
      areaHectares: 0,
      areaAcres: 0,
      centroid: { lat: ring[0][1], lon: ring[0][0] },
      bbox: [ring[0][0], ring[0][1], ring[0][0], ring[0][1]],
    };
  }

  let sumLat = 0;
  let sumLon = 0;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const uniquePts =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;

  for (const [lon, lat] of uniquePts) {
    sumLon += lon;
    sumLat += lat;
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }

  const areaHectares = Number((areaSqMeters / 10000).toFixed(3));
  const areaAcres = Number((areaSqMeters / 4046.8564224).toFixed(3));

  return {
    valid: true,
    areaSqMeters: Math.round(areaSqMeters),
    areaHectares,
    areaAcres,
    centroid: {
      lat: Number((sumLat / uniquePts.length).toFixed(6)),
      lon: Number((sumLon / uniquePts.length).toFixed(6)),
    },
    bbox: [minLon, minLat, maxLon, maxLat],
  };
}

export function createSquareFieldGeoJson(centerLat: number, centerLon: number, targetAcres: number): string {
  const areaSqM = Math.max(404.686, targetAcres * 4046.8564224);
  const halfSideM = Math.sqrt(areaSqM) / 2;
  const dLat = (halfSideM / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const dLon = dLat / Math.cos(toRadians(centerLat));

  const ring: Array<[number, number]> = [
    [Number((centerLon - dLon).toFixed(6)), Number((centerLat - dLat).toFixed(6))],
    [Number((centerLon + dLon).toFixed(6)), Number((centerLat - dLat).toFixed(6))],
    [Number((centerLon + dLon).toFixed(6)), Number((centerLat + dLat).toFixed(6))],
    [Number((centerLon - dLon).toFixed(6)), Number((centerLat + dLat).toFixed(6))],
    [Number((centerLon - dLon).toFixed(6)), Number((centerLat - dLat).toFixed(6))],
  ];

  return JSON.stringify({
    type: 'Polygon',
    coordinates: [ring],
  });
}

interface ZoneEntry {
  districtKeywords: string[];
  state: string;
  latRange: [number, number];
  lonRange: [number, number];
  agroclimaticZone: string;
  universityReference: string;
  nearestKvk: string;
  nearestMarkets: string[];
}

const AGROCLIMATIC_REGISTRY: ZoneEntry[] = [
  {
    districtKeywords: ['ahilyanagar', 'ahmednagar', 'kopargaon', 'rahata', 'shrirampur', 'sangamner', 'rahuri', 'solapur', 'pune'],
    state: 'Maharashtra',
    latRange: [17.5, 20.15],
    lonRange: [73.9, 76.2],
    agroclimaticZone: 'Maharashtra Scarcity Zone (MH-6 / NARP)',
    universityReference: 'Mahatma Phule Krishi Vidyapeeth (MPKV), Rahuri',
    nearestKvk: 'KVK Babhaleshwar (Ahilyanagar)',
    nearestMarkets: ['Kopargaon APMC', 'Rahata APMC', 'Lasalgaon APMC', 'Shrirampur APMC'],
  },
  {
    districtKeywords: ['nashik', 'niphad', 'lasalgaon', 'satara', 'kolhapur', 'sangli'],
    state: 'Maharashtra',
    latRange: [15.8, 20.6],
    lonRange: [73.2, 74.6],
    agroclimaticZone: 'Western Maharashtra Plain & Sub-Montane Zone (MH-4/5)',
    universityReference: 'Mahatma Phule Krishi Vidyapeeth (MPKV), Rahuri',
    nearestKvk: 'KVK Nashik (YCMOU Campus)',
    nearestMarkets: ['Lasalgaon APMC', 'Pimpalgaon Baswant APMC', 'Nashik APMC'],
  },
  {
    districtKeywords: ['nagpur', 'amravati', 'akola', 'wardha', 'yavatmal', 'buldhana'],
    state: 'Maharashtra',
    latRange: [19.8, 21.7],
    lonRange: [76.2, 80.2],
    agroclimaticZone: 'Central Vidarbha Moderate Rainfall Zone (MH-8)',
    universityReference: 'Dr. Panjabrao Deshmukh Krishi Vidyapeeth (PDKV), Akola',
    nearestKvk: 'KVK CICR Nagpur',
    nearestMarkets: ['Nagpur Kalamna APMC', 'Amravati APMC', 'Akola APMC'],
  },
  {
    districtKeywords: ['aurangabad', 'chhatrapati sambhajinagar', 'jalna', 'latur', 'parbhani', 'nanded', 'beed'],
    state: 'Maharashtra',
    latRange: [18.0, 20.6],
    lonRange: [75.0, 78.2],
    agroclimaticZone: 'Central Maharashtra Plateau / Marathwada Zone (MH-7)',
    universityReference: 'Vasantrao Naik Marathwada Krishi Vidyapeeth (VNMKV), Parbhani',
    nearestKvk: 'KVK Aurangabad (Paithan Road)',
    nearestMarkets: ['Chhatrapati Sambhajinagar APMC', 'Jalna APMC', 'Latur APMC'],
  },
  {
    districtKeywords: ['ludhiana', 'amritsar', 'patiala', 'jalandhar', 'bathinda', 'punjab'],
    state: 'Punjab',
    latRange: [29.5, 32.5],
    lonRange: [73.8, 76.9],
    agroclimaticZone: 'Trans-Gangetic Plains Region (ICAR Zone VI)',
    universityReference: 'Punjab Agricultural University (PAU), Ludhiana',
    nearestKvk: 'KVK Samrala (Ludhiana)',
    nearestMarkets: ['Khanna Grain Market', 'Ludhiana Mandi', 'Jagraon Mandi'],
  },
  {
    districtKeywords: ['indore', 'ujjain', 'dewas', 'bhopal', 'sehore', 'vidisha', 'madhya pradesh'],
    state: 'Madhya Pradesh',
    latRange: [21.5, 25.5],
    lonRange: [74.5, 79.0],
    agroclimaticZone: 'Malwa Plateau / Vindhyan Plateau Agroclimatic Zone',
    universityReference: 'Rajmata Vijayaraje Scindia Krishi Vishwa Vidyalaya (RVSKVV), Gwalior',
    nearestKvk: 'KVK Indore (Kasturbagram)',
    nearestMarkets: ['Indore Chhavni Mandi', 'Dewas Mandi', 'Ujjain Mandi'],
  },
];

export function resolveGeographicContext(input: {
  lat: number;
  lon: number;
  district?: string;
  state?: string;
}): GeographicContextResolution {
  const normalizedDist = (input.district || '').trim().toLowerCase();
  const normalizedState = (input.state || '').trim().toLowerCase();

  for (const entry of AGROCLIMATIC_REGISTRY) {
    if (
      normalizedDist &&
      entry.districtKeywords.some((k) => normalizedDist.includes(k) || k.includes(normalizedDist))
    ) {
      return {
        agroclimaticZone: entry.agroclimaticZone,
        universityReference: entry.universityReference,
        nearestKvk: entry.nearestKvk,
        nearestMarkets: entry.nearestMarkets,
        state: input.state || entry.state,
        district: input.district || 'Ahilyanagar',
      };
    }
  }

  for (const entry of AGROCLIMATIC_REGISTRY) {
    if (
      input.lat >= entry.latRange[0] &&
      input.lat <= entry.latRange[1] &&
      input.lon >= entry.lonRange[0] &&
      input.lon <= entry.lonRange[1]
    ) {
      return {
        agroclimaticZone: entry.agroclimaticZone,
        universityReference: entry.universityReference,
        nearestKvk: entry.nearestKvk,
        nearestMarkets: entry.nearestMarkets,
        state: input.state || entry.state,
        district: input.district || 'Regional District',
      };
    }
  }

  if (normalizedState.includes('maharashtra')) {
    return {
      agroclimaticZone: 'Maharashtra Plateau Agricultural Zone',
      universityReference: 'Mahatma Phule Krishi Vidyapeeth (MPKV) / ICAR',
      nearestKvk: 'District KVK (Maharashtra)',
      nearestMarkets: ['District APMC Market'],
      state: input.state || 'Maharashtra',
      district: input.district || 'District',
    };
  }

  return {
    agroclimaticZone: 'Indian Agro-Ecological Sub-Region (ICAR General)',
    universityReference: 'ICAR Regional Agricultural Research Station',
    nearestKvk: `District KVK (${input.district || 'Regional'})`,
    nearestMarkets: [`${input.district || 'Local'} APMC Mandi`],
    state: input.state || 'India',
    district: input.district || 'District',
  };
}

export interface LocationSearchResult {
  label: string;
  village: string;
  taluka: string;
  district: string;
  state: string;
  lat: number;
  lon: number;
  source: 'LOCAL_REGISTRY' | 'NOMINATIM';
}

const KNOWN_AGRICULTURAL_LOCATIONS: LocationSearchResult[] = [
  { label: 'Kopargaon, Ahilyanagar, Maharashtra', village: 'Kopargaon', taluka: 'Kopargaon', district: 'Ahilyanagar', state: 'Maharashtra', lat: 19.8825, lon: 74.4789, source: 'LOCAL_REGISTRY' },
  { label: 'Shirdi / Rahata, Ahilyanagar, Maharashtra', village: 'Rahata', taluka: 'Rahata', district: 'Ahilyanagar', state: 'Maharashtra', lat: 19.7138, lon: 74.4771, source: 'LOCAL_REGISTRY' },
  { label: 'Shrirampur, Ahilyanagar, Maharashtra', village: 'Shrirampur', taluka: 'Shrirampur', district: 'Ahilyanagar', state: 'Maharashtra', lat: 19.6203, lon: 74.6562, source: 'LOCAL_REGISTRY' },
  { label: 'Sangamner, Ahilyanagar, Maharashtra', village: 'Sangamner', taluka: 'Sangamner', district: 'Ahilyanagar', state: 'Maharashtra', lat: 19.5724, lon: 74.2072, source: 'LOCAL_REGISTRY' },
  { label: 'Rahuri (MPKV), Ahilyanagar, Maharashtra', village: 'Rahuri', taluka: 'Rahuri', district: 'Ahilyanagar', state: 'Maharashtra', lat: 19.3924, lon: 74.6487, source: 'LOCAL_REGISTRY' },
  { label: 'Lasalgaon, Nashik, Maharashtra', village: 'Lasalgaon', taluka: 'Niphad', district: 'Nashik', state: 'Maharashtra', lat: 20.1436, lon: 74.2336, source: 'LOCAL_REGISTRY' },
  { label: 'Niphad, Nashik, Maharashtra', village: 'Niphad', taluka: 'Niphad', district: 'Nashik', state: 'Maharashtra', lat: 20.0736, lon: 74.1072, source: 'LOCAL_REGISTRY' },
  { label: 'Baramati, Pune, Maharashtra', village: 'Baramati', taluka: 'Baramati', district: 'Pune', state: 'Maharashtra', lat: 18.1518, lon: 74.5777, source: 'LOCAL_REGISTRY' },
  { label: 'Chhatrapati Sambhajinagar, Maharashtra', village: 'Paithan Road', taluka: 'Aurangabad', district: 'Chhatrapati Sambhajinagar', state: 'Maharashtra', lat: 19.8762, lon: 75.3433, source: 'LOCAL_REGISTRY' },
  { label: 'Akola (PDKV), Maharashtra', village: 'Krishi Nagar', taluka: 'Akola', district: 'Akola', state: 'Maharashtra', lat: 20.7002, lon: 77.0082, source: 'LOCAL_REGISTRY' },
  { label: 'Solapur, Maharashtra', village: 'Solapur Rural', taluka: 'Solapur North', district: 'Solapur', state: 'Maharashtra', lat: 17.6599, lon: 75.9064, source: 'LOCAL_REGISTRY' },
  { label: 'Ludhiana (PAU), Punjab', village: 'Samrala', taluka: 'Ludhiana', district: 'Ludhiana', state: 'Punjab', lat: 30.901, lon: 75.8573, source: 'LOCAL_REGISTRY' },
  { label: 'Indore, Madhya Pradesh', village: 'Kasturbagram', taluka: 'Indore', district: 'Indore', state: 'Madhya Pradesh', lat: 22.7196, lon: 75.8577, source: 'LOCAL_REGISTRY' },
];

export function searchLocalLocations(query: string): LocationSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return KNOWN_AGRICULTURAL_LOCATIONS.slice(0, 6);
  return KNOWN_AGRICULTURAL_LOCATIONS.filter(
    (loc) =>
      loc.label.toLowerCase().includes(q) ||
      loc.village.toLowerCase().includes(q) ||
      loc.taluka.toLowerCase().includes(q) ||
      loc.district.toLowerCase().includes(q) ||
      loc.state.toLowerCase().includes(q)
  );
}

import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { ReverseGeocodeResult } from '../../shared/types';

export interface SpatialGridInfo {
  gpmGridId: string;
  gpmCenterLat: number;
  gpmCenterLon: number;
  gpmDistanceM: number;
  smapEaseGridId: string;
  smapCenterLat: number;
  smapCenterLon: number;
  smapDistanceM: number;
  powerGridId: string;
  powerCenterLat: number;
  powerCenterLon: number;
  powerDistanceM: number;
}

/**
 * Computes deterministic WGS84 source grid cell identifiers and center distances
 * for GPM IMERG (0.1°), SMAP L4 (9 km EASE-Grid 2.0 cylindrical approximation),
 * and NASA POWER MERRA-2 (0.5° × 0.625°).
 */
export function computeSpatialGridIds(lat: number, lon: number): SpatialGridInfo {
  const gpmCenterLat = Number((Math.floor(lat * 10) * 0.1 + 0.05).toFixed(2));
  const gpmCenterLon = Number((Math.floor(lon * 10) * 0.1 + 0.05).toFixed(2));
  const gpmDistanceM = Math.round(haversineDistanceKm({ lat, lon }, { lat: gpmCenterLat, lon: gpmCenterLon }) * 1000);
  const gpmGridId = `GPM_01DEG_${gpmCenterLat >= 0 ? 'N' : 'S'}${Math.abs(gpmCenterLat).toFixed(2)}_${
    gpmCenterLon >= 0 ? 'E' : 'W'
  }${Math.abs(gpmCenterLon).toFixed(2)}`;

  // EASE-Grid 2.0 Global ~9 km (3856 cols × 1624 rows; cylindrical projection at ±85.0445°)
  const smapCol = Math.max(0, Math.min(3855, Math.floor(((lon + 180) / 360) * 3856)));
  const sinLat = Math.sin(toRadians(Math.max(-85, Math.min(85, lat))));
  const smapRow = Math.max(0, Math.min(1623, Math.floor(((1 - sinLat) / 2) * 1624)));
  const smapCenterLon = Number((((smapCol + 0.5) / 3856) * 360 - 180).toFixed(4));
  const centerSinLat = 1 - ((smapRow + 0.5) / 1624) * 2;
  const smapCenterLat = Number(((Math.asin(Math.max(-1, Math.min(1, centerSinLat))) * 180) / Math.PI).toFixed(4));
  const smapDistanceM = Math.round(
    haversineDistanceKm({ lat, lon }, { lat: smapCenterLat, lon: smapCenterLon }) * 1000
  );
  const smapEaseGridId = `SMAP_EASE2_9KM_R${String(smapRow).padStart(4, '0')}_C${String(smapCol).padStart(4, '0')}`;

  // NASA POWER / MERRA-2 0.5° lat × 0.625° lon
  const powerCenterLat = Number((Math.round(lat / 0.5) * 0.5).toFixed(3));
  const powerCenterLon = Number((Math.round(lon / 0.625) * 0.625).toFixed(3));
  const powerDistanceM = Math.round(
    haversineDistanceKm({ lat, lon }, { lat: powerCenterLat, lon: powerCenterLon }) * 1000
  );
  const powerGridId = `POWER_05X0625_${powerCenterLat.toFixed(2)}_${powerCenterLon.toFixed(3)}`;

  return {
    gpmGridId,
    gpmCenterLat,
    gpmCenterLon,
    gpmDistanceM,
    smapEaseGridId,
    smapCenterLat,
    smapCenterLon,
    smapDistanceM,
    powerGridId,
    powerCenterLat,
    powerCenterLon,
    powerDistanceM,
  };
}

/**
 * Reverse geocodes WGS84 coordinates into structured administrative fields using
 * OpenStreetMap Nominatim (+ optional timezone check). Never fabricates missing
 * village/taluka/district values: keeps null whenever resolution is incomplete.
 */
export async function reverseGeocodeCoordinates(
  db: Database.Database,
  input: {
    latitude: number;
    longitude: number;
    accuracy_meters?: number | null;
    captured_at?: string | null;
  }
): Promise<ReverseGeocodeResult> {
  const lat = Number(input.latitude.toFixed(5));
  const lon = Number(input.longitude.toFixed(5));
  const capturedAt = input.captured_at || new Date().toISOString();
  const accuracy = input.accuracy_meters ?? null;

  // Check cached reverse geocode within ~50m (0.0005 deg)
  const cached = db
    .prepare(
      `SELECT village, taluka, district, state, country, timezone, resolved_address, resolution_source
       FROM location_resolution_records
       WHERE ABS(latitude - ?) < 0.0005 AND ABS(longitude - ?) < 0.0005
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(lat, lon) as
    | {
        village: string | null;
        taluka: string | null;
        district: string | null;
        state: string | null;
        country: string | null;
        timezone: string | null;
        resolved_address: string | null;
        resolution_source: string | null;
      }
    | undefined;

  if (cached && cached.resolution_source) {
    return {
      latitude: lat,
      longitude: lon,
      accuracy_meters: accuracy,
      captured_at: capturedAt,
      village: cached.village,
      taluka: cached.taluka,
      district: cached.district,
      state: cached.state,
      country: cached.country,
      timezone: cached.timezone,
      resolved_address: cached.resolved_address,
      resolution_source: cached.resolution_source,
    };
  }

  let village: string | null = null;
  let taluka: string | null = null;
  let district: string | null = null;
  let state: string | null = null;
  let country: string | null = null;
  let timezone: string | null = null;
  let resolvedAddress: string | null = null;
  let resolutionSource: string | null = null;

  // 1. Live Nominatim Reverse Geocode + Open-Meteo IANA timezone in parallel
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const [nomRes, tzRes] = await Promise.all([
      fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&addressdetails=1&zoom=14`,
        {
          headers: { 'User-Agent': 'KhetPatch/1.0 (Agricultural Intelligence)' },
          signal: controller.signal,
        }
      ).catch(() => null),
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto&forecast_days=1`,
        {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        }
      ).catch(() => null),
    ]);
    clearTimeout(timer);

    if (tzRes && tzRes.ok) {
      const tzJson = (await tzRes.json()) as { timezone?: string };
      if (tzJson?.timezone) timezone = tzJson.timezone;
    }

    if (nomRes && nomRes.ok) {
      const nomJson = (await nomRes.json()) as {
        display_name?: string;
        error?: string;
        address?: {
          village?: string;
          hamlet?: string;
          suburb?: string;
          town?: string;
          city?: string;
          municipality?: string;
          county?: string;
          state_district?: string;
          state?: string;
          country?: string;
        };
      };
      if (!nomJson.error && nomJson.address) {
        const addr = nomJson.address;
        village = addr.village || addr.hamlet || addr.suburb || addr.town || addr.city || null;
        taluka = addr.county || addr.municipality || addr.town || null;
        district = addr.state_district ? addr.state_district.replace(/\s+District$/i, '').trim() : addr.city || null;
        state = addr.state || null;
        country = addr.country || null;
        resolvedAddress = nomJson.display_name || null;
        resolutionSource = 'OPENSTREETMAP_NOMINATIM';
      }
    }
  } catch {
    // Keep null fields cleanly when upstream reverse geocoding fails
  }

  // 2. Fallback to Google Maps Geocoding API if configured and Nominatim returned nothing
  const gmapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!resolutionSource && gmapsKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const gmRes = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${encodeURIComponent(gmapsKey)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (gmRes.ok) {
        const gmJson = (await gmRes.json()) as {
          results?: Array<{
            formatted_address?: string;
            address_components?: Array<{ long_name: string; types: string[] }>;
          }>;
        };
        const first = gmJson.results?.[0];
        if (first) {
          resolvedAddress = first.formatted_address || null;
          for (const comp of first.address_components || []) {
            if (comp.types.includes('sublocality') || comp.types.includes('locality')) {
              if (!village) village = comp.long_name;
            }
            if (comp.types.includes('administrative_area_level_3')) {
              taluka = comp.long_name;
            }
            if (comp.types.includes('administrative_area_level_2')) {
              district = comp.long_name.replace(/\s+District$/i, '').trim();
            }
            if (comp.types.includes('administrative_area_level_1')) {
              state = comp.long_name;
            }
            if (comp.types.includes('country')) {
              country = comp.long_name;
            }
          }
          resolutionSource = 'GOOGLE_MAPS_GEOCODE';
        }
      }
    } catch {
      // Retain original coordinates cleanly
    }
  }

  db.prepare(`
    INSERT INTO location_resolution_records (
      id, latitude, longitude, accuracy_meters, village, taluka, district, state,
      country, timezone, resolved_address, resolution_source, captured_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    lat,
    lon,
    accuracy,
    village,
    taluka,
    district,
    state,
    country,
    timezone,
    resolvedAddress,
    resolutionSource,
    capturedAt,
    new Date().toISOString()
  );

  return {
    latitude: lat,
    longitude: lon,
    accuracy_meters: accuracy,
    captured_at: capturedAt,
    village,
    taluka,
    district,
    state,
    country,
    timezone,
    resolved_address: resolvedAddress,
    resolution_source: resolutionSource,
  };
}

