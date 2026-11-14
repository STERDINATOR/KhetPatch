import type Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { createSquareFieldGeoJson, resolveGeographicContext } from '../intelligence/geoService';

export function getDemoConfig() {
  const isProd = process.env.APP_ENV === 'production';
  const enabled = !isProd && process.env.DEMO_AUTH_ENABLED !== 'false';
  const email = process.env.DEMO_ACCOUNT_EMAIL || 'demo@khetpatch.org';
  const password = process.env.DEMO_ACCOUNT_PASSWORD || 'KhetPatch@Demo2026';
  return { enabled, isProd, email, password };
}

export function seedPlatformData(db: Database.Database): void {
  const now = new Date().toISOString();

  // 1. Data Sources Registry
  const sources = [
    {
      id: 'NASA_POWER',
      name: 'NASA POWER Agroclimatology API',
      provider: 'NASA Langley Research Center',
      product_code: 'POWER Daily Point v2 (MERRA-2 / CERES)',
      spatial_resolution: '0.5° × 0.625° (~55 km grid)',
      temporal_cadence: 'Daily (2–4 day archive lag)',
      requires_credential: null,
      docs_url: 'https://power.larc.nasa.gov/docs/services/api/',
    },
    {
      id: 'NASA_GPM_IMERG',
      name: 'NASA GPM IMERG Precipitation',
      provider: 'NASA GES DISC / PPS',
      product_code: 'GPM_3IMERGDE V07B (Early Run)',
      spatial_resolution: '0.1° × 0.1° (~10 km grid)',
      temporal_cadence: '30-min / Daily (~4 hr Early Run latency)',
      requires_credential: 'EARTHDATA_TOKEN (for HDF5/NetCDF raster extraction; CMR granule search public)',
      docs_url: 'https://gpm.nasa.gov/data/imerg',
    },
    {
      id: 'NASA_SMAP_L4',
      name: 'NASA SMAP L4 Soil Moisture',
      provider: 'NASA NSIDC DAAC',
      product_code: 'SPL4SMGP v007 (Surface & Root-Zone)',
      spatial_resolution: '9 km EASE-Grid 2.0',
      temporal_cadence: '3-hourly (2–3 day archive latency)',
      requires_credential: 'EARTHDATA_TOKEN (for HDF5 raster extraction; CMR granule search public)',
      docs_url: 'https://nsidc.org/data/smap',
    },
    {
      id: 'LANDSAT_C2',
      name: 'Landsat 8/9 & HLS Surface Reflectance (NDVI)',
      provider: 'USGS / NASA LP DAAC',
      product_code: 'HLSL30 / Landsat Collection 2 Level-2',
      spatial_resolution: '30 m field-scale pixels',
      temporal_cadence: '8–16 day revisit (cloud-screened)',
      requires_credential: 'EARTHDATA_TOKEN (for GeoTIFF band subsetting; CMR scene search public)',
      docs_url: 'https://www.usgs.gov/landsat-missions/landsat-collection-2',
    },
    {
      id: 'OPEN_METEO',
      name: 'Open-Meteo Forecast & Soil Model',
      provider: 'Open-Meteo Weather API',
      product_code: 'ECMWF / GFS Blended Forecast + ET0',
      spatial_resolution: '~9–11 km model grid',
      temporal_cadence: 'Hourly / 7-Day Forecast',
      requires_credential: null,
      docs_url: 'https://open-meteo.com/en/docs',
    },
    {
      id: 'IMD_WEATHER',
      name: 'India Meteorological Department (IMD)',
      provider: 'IMD Agromet & District Warnings',
      product_code: 'District Nowcast, Forecast & Warnings API',
      spatial_resolution: 'District / Station Level',
      temporal_cadence: 'Real-time bulletins & 5-day advisories',
      requires_credential: 'IMD_API_KEY (Official IP/Account Credential)',
      docs_url: 'https://api.imd.gov.in/public/api_reference.html',
    },
    {
      id: 'AGMARKNET',
      name: 'AGMARKNET Daily Mandi Prices',
      provider: 'Govt. of India / data.gov.in',
      product_code: 'Current Daily Commodity Mandi Prices',
      spatial_resolution: 'APMC Market / Yard Level',
      temporal_cadence: 'Daily Market Arrivals',
      requires_credential: 'DATA_GOV_API_KEY',
      docs_url: 'https://data.gov.in/catalog/current-daily-price-various-commodities-various-markets-mandi',
    },
  ];

  const insertSource = db.prepare(`
    INSERT INTO data_sources (id, name, provider, product_code, spatial_resolution, temporal_cadence, requires_credential, docs_url)
    VALUES (@id, @name, @provider, @product_code, @spatial_resolution, @temporal_cadence, @requires_credential, @docs_url)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      product_code=excluded.product_code,
      spatial_resolution=excluded.spatial_resolution,
      requires_credential=excluded.requires_credential
  `);

  const insertHealth = db.prepare(`
    INSERT OR IGNORE INTO provider_health (source_id, status, credential_configured, records_processed)
    VALUES (?, ?, ?, 0)
  `);

  for (const s of sources) {
    insertSource.run(s);
    const credConfigured =
      s.id === 'NASA_POWER' || s.id === 'OPEN_METEO'
        ? 1
        : s.id === 'IMD_WEATHER'
        ? process.env.IMD_API_KEY
          ? 1
          : 0
        : s.id === 'AGMARKNET'
        ? process.env.DATA_GOV_API_KEY
          ? 1
          : 0
        : process.env.EARTHDATA_TOKEN
        ? 1
        : 0;
    insertHealth.run(
      s.id,
      credConfigured ? 'READY' : s.requires_credential ? 'AWAITING_CREDENTIALS' : 'READY',
      credConfigured
    );
  }

  // 2. Authoritative Crop Catalogue (MPKV Rahuri & ICAR Validated Regional Rules)
  const crops = [
    {
      id: 'crop-soybean',
      name: 'Soybean',
      local_name_mr: 'सोयाबीन',
      local_name_hi: 'सोयाबीन',
      scientific_name: 'Glycine max',
      crop_family: 'Fabaceae (Legume)',
      suitable_seasons_json: JSON.stringify(['Kharif']),
      sowing_window: 'June 15 – July 15 (onset of monsoon)',
      duration_days_min: 95,
      duration_days_max: 110,
      water_need_level: 'Moderate',
      water_need_mm: 480,
      ideal_ph_min: 6.0,
      ideal_ph_max: 7.5,
      soil_types_json: JSON.stringify(['Medium Black', 'Deep Black', 'Loamy']),
      root_depth: 'Medium',
      nitrogen_fixer: 1,
      rotation_break_seasons: 1,
      estimated_cost_per_acre_inr: 14500,
      cost_breakdown_json: JSON.stringify({
        seeds: 3200,
        landPrep: 2400,
        fertilizer: 2600,
        labor: 3800,
        protectionAndHarvest: 2500,
      }),
      reference_yield_q_per_acre: 8.5,
      source_reference: 'MPKV Rahuri Kharif Crop Technology Bulletin',
      source_year: 2024,
      agroclimatic_zones_json: JSON.stringify(['Maharashtra Scarcity Zone', 'Central Maharashtra Plateau', 'Malwa Plateau']),
      typical_operations_json: JSON.stringify([
        { dayOffset: 0, category: 'Sowing', title: 'Seed treatment (Rhizobium + PSB) & sowing', description: 'Confirm adequate topsoil moisture (>50 mm cumulative rain) before sowing at 45×5 cm spacing.', priority: 'High' },
        { dayOffset: 20, category: 'Field Inspection', title: 'First inter-cultivation & weed check', description: 'Hoeing and hand weeding at 20–25 DAS to prevent early weed competition.', priority: 'Medium' },
        { dayOffset: 45, category: 'Crop Stage', title: 'Flowering & pod-initiation moisture review', description: 'Verify field moisture during flowering/pod fill; avoid waterlogging.', priority: 'High' },
        { dayOffset: 98, category: 'Harvest', title: 'Physiological maturity & harvest readiness check', description: 'Harvest when 85–90% pods turn golden brown to minimize shattering loss.', priority: 'High' },
      ]),
    },
    {
      id: 'crop-chickpea',
      name: 'Chickpea (Gram)',
      local_name_mr: 'हरभरा',
      local_name_hi: 'चना',
      scientific_name: 'Cicer arietinum',
      crop_family: 'Fabaceae (Legume)',
      suitable_seasons_json: JSON.stringify(['Rabi']),
      sowing_window: 'October 15 – November 20',
      duration_days_min: 105,
      duration_days_max: 120,
      water_need_level: 'Low',
      water_need_mm: 280,
      ideal_ph_min: 6.0,
      ideal_ph_max: 8.0,
      soil_types_json: JSON.stringify(['Medium Black', 'Deep Black', 'Clay Loam']),
      root_depth: 'Deep',
      nitrogen_fixer: 1,
      rotation_break_seasons: 1,
      estimated_cost_per_acre_inr: 11800,
      cost_breakdown_json: JSON.stringify({
        seeds: 2800,
        landPrep: 2000,
        fertilizer: 1900,
        labor: 3100,
        protectionAndHarvest: 2000,
      }),
      reference_yield_q_per_acre: 7.2,
      source_reference: 'MPKV Rahuri Rabi Pulse Advisory (Digvijay / Phule Vikram)',
      source_year: 2024,
      agroclimatic_zones_json: JSON.stringify(['Maharashtra Scarcity Zone', 'Western Maharashtra', 'Central Maharashtra Plateau']),
      typical_operations_json: JSON.stringify([
        { dayOffset: 0, category: 'Sowing', title: 'Trichoderma seed treatment & Rabi sowing', description: 'Sow on conserved soil moisture or light pre-sowing irrigation.', priority: 'High' },
        { dayOffset: 35, category: 'Irrigation Review', title: 'Branching-stage protective irrigation check', description: 'Provide one light irrigation at 35–45 DAS only if soil moisture is depleted.', priority: 'Medium' },
        { dayOffset: 65, category: 'Field Inspection', title: 'Pod-borer scouting & pheromone trap check', description: 'Inspect foliage and developing pods; record pest threshold before intervention.', priority: 'High' },
        { dayOffset: 110, category: 'Harvest', title: 'Pod drying & threshing schedule', description: 'Harvest once leaves senesce and pods dry evenly.', priority: 'Medium' },
      ]),
    },
    {
      id: 'crop-wheat',
      name: 'Wheat',
      local_name_mr: 'गहू',
      local_name_hi: 'गेहूँ',
      scientific_name: 'Triticum aestivum',
      crop_family: 'Poaceae (Cereal)',
      suitable_seasons_json: JSON.stringify(['Rabi']),
      sowing_window: 'November 1 – November 25',
      duration_days_min: 115,
      duration_days_max: 130,
      water_need_level: 'Moderate',
      water_need_mm: 420,
      ideal_ph_min: 6.2,
      ideal_ph_max: 8.2,
      soil_types_json: JSON.stringify(['Medium Black', 'Deep Black', 'Alluvial Loam']),
      root_depth: 'Medium',
      nitrogen_fixer: 0,
      rotation_break_seasons: 1,
      estimated_cost_per_acre_inr: 15800,
      cost_breakdown_json: JSON.stringify({
        seeds: 2400,
        landPrep: 2800,
        fertilizer: 3900,
        irrigation: 2200,
        laborAndHarvest: 4500,
      }),
      reference_yield_q_per_acre: 14.5,
      source_reference: 'MPKV Rahuri & ICAR-IIWBR Wheat Cultivation Guide (Phule Samadhan)',
      source_year: 2024,
      agroclimatic_zones_json: JSON.stringify(['Maharashtra Scarcity Zone', 'Western Maharashtra', 'Trans-Gangetic Plains']),
      typical_operations_json: JSON.stringify([
        { dayOffset: 0, category: 'Sowing', title: 'Timely November sowing & basal fertilization', description: 'Sow at 20 cm row spacing to capture cool winter tillering.', priority: 'High' },
        { dayOffset: 21, category: 'Irrigation Review', title: 'CRI (Crown Root Initiation) irrigation review', description: 'Critical moisture stage at 20–25 DAS; verify forecast rainfall before irrigating.', priority: 'High' },
        { dayOffset: 65, category: 'Crop Stage', title: 'Flowering & grain-fill temperature check', description: 'Monitor terminal heat risk (>34°C) during grain filling.', priority: 'Medium' },
        { dayOffset: 120, category: 'Harvest', title: 'Grain moisture check & combine harvesting', description: 'Harvest at 12–14% grain moisture.', priority: 'High' },
      ]),
    },
    {
      id: 'crop-rabi-sorghum',
      name: 'Rabi Sorghum (Jowar)',
      local_name_mr: 'रब्बी ज्वारी',
      local_name_hi: 'ज्वार',
      scientific_name: 'Sorghum bicolor',
      crop_family: 'Poaceae (Cereal)',
      suitable_seasons_json: JSON.stringify(['Rabi', 'Kharif']),
      sowing_window: 'September 15 – October 20 (Rabi)',
      duration_days_min: 110,
      duration_days_max: 125,
      water_need_level: 'Low',
      water_need_mm: 300,
      ideal_ph_min: 5.8,
      ideal_ph_max: 8.3,
      soil_types_json: JSON.stringify(['Medium Black', 'Shallow', 'Deep Black']),
      root_depth: 'Deep',
      nitrogen_fixer: 0,
      rotation_break_seasons: 1,
      estimated_cost_per_acre_inr: 9800,
      cost_breakdown_json: JSON.stringify({
        seeds: 900,
        landPrep: 2100,
        fertilizer: 2100,
        labor: 2900,
        harvest: 1800,
      }),
      reference_yield_q_per_acre: 9.0,
      source_reference: 'MPKV Rahuri Scarcity Zone Sorghum (Phule Vasudha / Maldandi)',
      source_year: 2024,
      agroclimatic_zones_json: JSON.stringify(['Maharashtra Scarcity Zone', 'Central Maharashtra Plateau']),
      typical_operations_json: JSON.stringify([
        { dayOffset: 0, category: 'Sowing', title: 'Moisture-conservation furrow sowing', description: 'Sow across slope for rainwater retention in scarcity zones.', priority: 'High' },
        { dayOffset: 30, category: 'Field Inspection', title: 'Thinning & shoot-fly inspection', description: 'Maintain optimal plant population and check for dead-hearts.', priority: 'Medium' },
        { dayOffset: 115, category: 'Harvest', title: 'Grain & fodder harvest', description: 'Harvest panicles and preserve nutritious kadbi stover.', priority: 'Medium' },
      ]),
    },
    {
      id: 'crop-onion',
      name: 'Rabi Onion',
      local_name_mr: 'कांदा',
      local_name_hi: 'प्याज',
      scientific_name: 'Allium cepa',
      crop_family: 'Amaryllidaceae',
      suitable_seasons_json: JSON.stringify(['Rabi', 'Kharif']),
      sowing_window: 'November – December transplanting (Rabi)',
      duration_days_min: 110,
      duration_days_max: 135,
      water_need_level: 'High',
      water_need_mm: 580,
      ideal_ph_min: 6.0,
      ideal_ph_max: 7.5,
      soil_types_json: JSON.stringify(['Loamy', 'Medium Black', 'Sandy Loam']),
      root_depth: 'Shallow',
      nitrogen_fixer: 0,
      rotation_break_seasons: 2,
      estimated_cost_per_acre_inr: 34500,
      cost_breakdown_json: JSON.stringify({
        nurseryAndSeedlings: 7500,
        landPrep: 4500,
        fertilizer: 6200,
        irrigationAndDrip: 4800,
        laborAndHarvest: 11500,
      }),
      reference_yield_q_per_acre: 95.0,
      source_reference: 'ICAR-DOGR Rajgurunagar & MPKV Onion Package (N-2-4-1 / Bhima Kiran)',
      source_year: 2024,
      agroclimatic_zones_json: JSON.stringify(['Maharashtra Scarcity Zone', 'Western Maharashtra']),
      typical_operations_json: JSON.stringify([
        { dayOffset: 0, category: 'Sowing', title: 'Raised-bed transplanting of 45-day seedlings', description: 'Transplant healthy seedlings at 15×10 cm on drip-irrigated beds.', priority: 'High' },
        { dayOffset: 30, category: 'Nutrient Review', title: 'Split nitrogen & sulphur top-dressing review', description: 'Apply recommended split dose based on soil test status.', priority: 'Medium' },
        { dayOffset: 65, category: 'Field Inspection', title: 'Thrips & purple blotch scouting after humidity spikes', description: 'Check leaf tips if RH > 75% persists.', priority: 'High' },
        { dayOffset: 115, category: 'Harvest', title: 'Withhold irrigation 12 days before neck-fall harvest', description: 'Cure harvested bulbs in shade for storage resilience.', priority: 'High' },
      ]),
    },
    {
      id: 'crop-moong',
      name: 'Green Gram (Moong)',
      local_name_mr: 'मूग',
      local_name_hi: 'मूंग',
      scientific_name: 'Vigna radiata',
      crop_family: 'Fabaceae (Legume)',
      suitable_seasons_json: JSON.stringify(['Kharif', 'Zaid']),
      sowing_window: 'June 15 – July 10 (Kharif) / March (Zaid)',
      duration_days_min: 62,
      duration_days_max: 72,
      water_need_level: 'Low',
      water_need_mm: 240,
      ideal_ph_min: 6.2,
      ideal_ph_max: 7.8,
      soil_types_json: JSON.stringify(['Loamy', 'Medium Black', 'Sandy Loam']),
      root_depth: 'Shallow',
      nitrogen_fixer: 1,
      rotation_break_seasons: 1,
      estimated_cost_per_acre_inr: 9200,
      cost_breakdown_json: JSON.stringify({
        seeds: 1800,
        landPrep: 1800,
        fertilizer: 1400,
        labor: 2600,
        harvest: 1600,
      }),
      reference_yield_q_per_acre: 4.5,
      source_reference: 'MPKV Rahuri Short-Duration Pulse Guide (Vaibhav / BM-2003-2)',
      source_year: 2024,
      agroclimatic_zones_json: JSON.stringify(['Maharashtra Scarcity Zone', 'Central Maharashtra Plateau', 'Western Maharashtra']),
      typical_operations_json: JSON.stringify([
        { dayOffset: 0, category: 'Sowing', title: 'Short-duration pulse sowing', description: 'Ideal catch crop that releases land early for Rabi sowing.', priority: 'High' },
        { dayOffset: 25, category: 'Field Inspection', title: 'Yellow mosaic & sucking pest inspection', description: 'Early rogueing and field sanitation check.', priority: 'Medium' },
        { dayOffset: 65, category: 'Harvest', title: 'Two-stage pod picking before monsoon showers', description: 'Pick mature black pods promptly to avoid rain damage.', priority: 'High' },
      ]),
    },
    {
      id: 'crop-maize',
      name: 'Maize',
      local_name_mr: 'मका',
      local_name_hi: 'मक्का',
      scientific_name: 'Zea mays',
      crop_family: 'Poaceae (Cereal)',
      suitable_seasons_json: JSON.stringify(['Kharif', 'Rabi']),
      sowing_window: 'June 20 – July 15 (Kharif) / Oct 15 – Nov 15 (Rabi)',
      duration_days_min: 100,
      duration_days_max: 115,
      water_need_level: 'Moderate',
      water_need_mm: 500,
      ideal_ph_min: 5.8,
      ideal_ph_max: 7.8,
      soil_types_json: JSON.stringify(['Loamy', 'Medium Black', 'Alluvial Loam']),
      root_depth: 'Medium',
      nitrogen_fixer: 0,
      rotation_break_seasons: 1,
      estimated_cost_per_acre_inr: 16500,
      cost_breakdown_json: JSON.stringify({
        seeds: 2800,
        landPrep: 2500,
        fertilizer: 4200,
        labor: 4200,
        protectionAndHarvest: 2800,
      }),
      reference_yield_q_per_acre: 22.0,
      source_reference: 'MPKV Rahuri & ICAR-IIMR Maize Production Package (Rajarshi)',
      source_year: 2024,
      agroclimatic_zones_json: JSON.stringify(['Maharashtra Scarcity Zone', 'Western Maharashtra', 'Central Maharashtra Plateau']),
      typical_operations_json: JSON.stringify([
        { dayOffset: 0, category: 'Sowing', title: 'Ridge-and-furrow maize sowing', description: 'Avoid waterlogging during early seedling stage.', priority: 'High' },
        { dayOffset: 25, category: 'Field Inspection', title: 'Fall Armyworm (FAW) whorl scouting', description: 'Inspect leaf whorls weekly between 15–45 DAS.', priority: 'High' },
        { dayOffset: 55, category: 'Irrigation Review', title: 'Tasseling & silking moisture protection', description: 'Ensure no moisture stress during pollination window.', priority: 'High' },
        { dayOffset: 105, category: 'Harvest', title: 'Cob drying & shelling', description: 'Harvest when husk dries and black layer forms at kernel base.', priority: 'Medium' },
      ]),
    },
  ];

  const insertCrop = db.prepare(`
    INSERT INTO crop_catalogue (
      id, name, local_name_mr, local_name_hi, scientific_name, crop_family,
      suitable_seasons_json, sowing_window, duration_days_min, duration_days_max,
      water_need_level, water_need_mm, ideal_ph_min, ideal_ph_max, soil_types_json,
      root_depth, nitrogen_fixer, rotation_break_seasons, estimated_cost_per_acre_inr,
      cost_breakdown_json, reference_yield_q_per_acre, source_reference, source_year,
      agroclimatic_zones_json, verified_by_expert, typical_operations_json
    ) VALUES (
      @id, @name, @local_name_mr, @local_name_hi, @scientific_name, @crop_family,
      @suitable_seasons_json, @sowing_window, @duration_days_min, @duration_days_max,
      @water_need_level, @water_need_mm, @ideal_ph_min, @ideal_ph_max, @soil_types_json,
      @root_depth, @nitrogen_fixer, @rotation_break_seasons, @estimated_cost_per_acre_inr,
      @cost_breakdown_json, @reference_yield_q_per_acre, @source_reference, @source_year,
      @agroclimatic_zones_json, 1, @typical_operations_json
    )
    ON CONFLICT(name) DO UPDATE SET
      estimated_cost_per_acre_inr=excluded.estimated_cost_per_acre_inr,
      reference_yield_q_per_acre=excluded.reference_yield_q_per_acre,
      typical_operations_json=excluded.typical_operations_json
  `);
  for (const crop of crops) insertCrop.run(crop);

  // 3. Demo Provisioning (Development/Demo mode only; atomic & idempotent)
  const demo = getDemoConfig();
  if (!demo.enabled) return;

  const orgId = 'org-demo-sahyadri';
  const demoUserId = 'user-demo-shared';
  const extraFarmerId = 'user-demo-farmer-2';
  const allRoles = ['FARMER', 'AGRONOMIST', 'FPO_MANAGER', 'ORGANIZATION_ADMIN', 'PLATFORM_ADMIN'] as const;

  const runDemoSeed = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO organizations (id, name, type, district, state, country, is_demo, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(orgId, 'Sahyadri Agro FPO (DEMO DATA)', 'FPO', 'Ahilyanagar', 'Maharashtra', 'India', now);

    let existingUser = db
      .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR id = ?')
      .get(demo.email, demoUserId) as { id: string } | undefined;

    if (!existingUser) {
      const hash = bcrypt.hashSync(demo.password, 10);
      db.prepare(`
        INSERT OR IGNORE INTO users (id, email, password_hash, full_name, phone, preferred_language, email_verified, status, is_demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'ACTIVE', 1, ?, ?)
      `).run(demoUserId, demo.email, hash, 'Rajesh Deshmukh (Demo Identity)', '+91-9800000001', 'en', now, now);

      existingUser = db
        .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR id = ?')
        .get(demo.email, demoUserId) as { id: string } | undefined;
    }

    const userIdToUse = existingUser ? existingUser.id : demoUserId;

    const insertRole = db.prepare(`
      INSERT OR IGNORE INTO user_roles (id, user_id, role, organization_id, is_demo, granted_by, created_at)
      VALUES (?, ?, ?, ?, 1, 'DEMO_PROVISIONER', ?)
    `);
    for (const role of allRoles) {
      insertRole.run(`role-demo-${role.toLowerCase()}`, userIdToUse, role, orgId, now);
    }

    // Sample Demo Farm 1: Kopargaon (Sanjivani University region, Maharashtra Scarcity Zone)
    const farm1Id = 'farm-demo-kopargaon';
    const farm1Exists = db.prepare('SELECT id FROM farms WHERE id = ?').get(farm1Id);
    if (!farm1Exists) {
      const geo1 = resolveGeographicContext({ lat: 19.8825, lon: 74.4789, district: 'Ahilyanagar', state: 'Maharashtra' });
      db.prepare(`
        INSERT OR IGNORE INTO farms (
          id, owner_user_id, organization_id, name, village, taluka, district, state, country,
          latitude, longitude, coordinate_crs, location_accuracy_m, location_method, location_confirmed,
          agroclimatic_zone, university_reference, nearest_kvk, total_area_acres, farming_system,
          irrigation_source, water_availability, is_demo, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'India', ?, ?, 'EPSG:4326', 12, 'MAP_PIN', 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        farm1Id,
        userIdToUse,
        orgId,
        'Godavari Valley Plot [DEMO DATA]',
        'Kopargaon',
        'Kopargaon',
        'Ahilyanagar',
        'Maharashtra',
        19.8825,
        74.4789,
        geo1.agroclimaticZone,
        geo1.universityReference,
        geo1.nearestKvk,
        4.5,
        'Mixed Cropping',
        'Canal + Borewell',
        'Limited',
        now,
        now
      );

      const field1Id = 'field-demo-north';
      db.prepare(`
        INSERT OR IGNORE INTO fields (
          id, farm_id, owner_user_id, name, geometry_geojson, centroid_lat, centroid_lon,
          area_acres, area_hectares, soil_type, current_crop, previous_crop,
          planting_date, expected_harvest_date, irrigation_method, water_availability, notes, is_demo, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        field1Id,
        farm1Id,
        userIdToUse,
        'North Black-Soil Block (2.5 ac) [DEMO DATA]',
        createSquareFieldGeoJson(19.8825, 74.4789, 2.5),
        19.8825,
        74.4789,
        2.5,
        1.012,
        'Medium Black',
        'Soybean',
        'Rabi Sorghum (Jowar)',
        '2026-06-24',
        '2026-10-12',
        'Protective Drip + Furrow',
        'Limited',
        'DEMO DATA: Medium black Vertisol soil near Kopargaon; requires Rabi rotation break after Kharif Soybean.',
        now,
        now
      );

      db.prepare(`
        INSERT OR IGNORE INTO crop_history (id, field_id, crop_name, crop_family, season, year, planting_date, harvest_date, yield_q_per_acre, pest_disease_notes, is_demo, created_at)
        VALUES
          ('hist-demo-1', ?, 'Soybean', 'Fabaceae (Legume)', 'Kharif', 2026, '2026-06-24', '2026-10-12', 8.1, 'Mild pod-borer noticed in Sept', 1, ?),
          ('hist-demo-2', ?, 'Rabi Sorghum (Jowar)', 'Poaceae (Cereal)', 'Rabi', 2025, '2025-10-18', '2026-02-14', 8.8, 'Good fodder recovery', 1, ?)
      `).run(field1Id, now, field1Id, now);

      db.prepare(`
        INSERT OR IGNORE INTO soil_tests (id, field_id, source_label, lab_name, sample_date, ph, ec_ds_m, organic_carbon_pct, nitrogen_kg_ha, phosphorus_kg_ha, potassium_kg_ha, notes, created_at)
        VALUES ('soil-demo-1', ?, 'Farmer Entered', 'MPKV District Soil Lab (Demo Record)', '2026-05-18', 7.3, 0.34, 0.56, 218, 16.5, 295, 'DEMO DATA: Slightly alkaline medium black soil; moderate organic carbon.', ?)
      `).run(field1Id, now);

      db.prepare(`
        INSERT OR IGNORE INTO farmer_requirements (id, farmer_id, farm_id, field_id, max_budget_inr, budget_per_acre_inr, water_availability, risk_tolerance, priority_focus, preferred_crops_json, avoid_crops_json, updated_at)
        VALUES ('req-demo-1', ?, ?, ?, 42000, 16800, 'Limited', 'Moderate', 'Balanced', ?, '[]', ?)
      `).run(userIdToUse, farm1Id, field1Id, JSON.stringify(['Chickpea (Gram)', 'Wheat']), now);

      db.prepare(`
        INSERT OR IGNORE INTO timeline_events (id, farm_id, field_id, event_type, title, description, actor_user_id, created_at)
        VALUES ('evt-demo-1', ?, ?, 'FIELD_REGISTERED', 'Demo Field Registered (Kopargaon)', 'Sample 2.5-acre block initialized with Kharif Soybean and Rabi Sorghum history [DEMO DATA].', ?, ?)
      `).run(farm1Id, field1Id, userIdToUse, now);
    }

    // Clearly labeled DEMO DATA reference mandi prices (never presented as live exchange feeds)
    const demoPrices = [
      ['mp-demo-1', 'Soybean', 'Yellow', 'Maharashtra', 'Ahilyanagar', 'Kopargaon APMC (DEMO DATA)', '2026-11-10', 4350, 4720, 4560],
      ['mp-demo-2', 'Chickpea (Gram)', 'Vijay', 'Maharashtra', 'Ahilyanagar', 'Kopargaon APMC (DEMO DATA)', '2026-11-10', 5600, 6150, 5880],
      ['mp-demo-3', 'Wheat', 'Lokwan', 'Maharashtra', 'Ahilyanagar', 'Rahata APMC (DEMO DATA)', '2026-11-10', 2650, 2980, 2810],
      ['mp-demo-4', 'Rabi Sorghum (Jowar)', 'Maldandi', 'Maharashtra', 'Ahilyanagar', 'Shrirampur APMC (DEMO DATA)', '2026-11-10', 3100, 3650, 3380],
      ['mp-demo-5', 'Rabi Onion', 'Red', 'Maharashtra', 'Nashik', 'Lasalgaon APMC (DEMO DATA)', '2026-11-10', 1800, 2650, 2240],
      ['mp-demo-6', 'Maize', 'Yellow', 'Maharashtra', 'Ahilyanagar', 'Kopargaon APMC (DEMO DATA)', '2026-11-10', 2100, 2380, 2240],
      ['mp-demo-7', 'Green Gram (Moong)', 'Local', 'Maharashtra', 'Ahilyanagar', 'Kopargaon APMC (DEMO DATA)', '2026-11-10', 7100, 7850, 7450],
    ];

    const insertPrice = db.prepare(`
      INSERT OR IGNORE INTO market_prices (id, commodity, variety, state, district, market, arrival_date, min_price, max_price, modal_price, source_type, retrieval_time, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DEMO_DATA', ?, 1)
    `);
    for (const p of demoPrices) {
      insertPrice.run(...p, now);
    }

    // Sample Farmer Member for FPO & Agronomist inspection
    const extraExists = db
      .prepare('SELECT id FROM users WHERE id = ? OR LOWER(email) = LOWER(?)')
      .get(extraFarmerId, 'sunita.pawar.demo@khetpatch.org');
    if (!extraExists) {
      const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
      db.prepare(`
        INSERT OR IGNORE INTO users (id, email, password_hash, full_name, phone, preferred_language, email_verified, status, is_demo, created_at, updated_at)
        VALUES (?, 'sunita.pawar.demo@khetpatch.org', ?, 'Sunita Pawar [DEMO DATA]', '+91-9800000002', 'mr', 1, 'ACTIVE', 1, ?, ?)
      `).run(extraFarmerId, hash, now, now);
      db.prepare(`
        INSERT OR IGNORE INTO user_roles (id, user_id, role, organization_id, is_demo, granted_by, created_at)
        VALUES ('role-demo-farmer-2', ?, 'FARMER', ?, 1, 'DEMO_PROVISIONER', ?)
      `).run(extraFarmerId, orgId, now);

      const farm2Id = 'farm-demo-niphad';
      const geo2 = resolveGeographicContext({ lat: 20.0752, lon: 74.1118, district: 'Nashik', state: 'Maharashtra' });
      db.prepare(`
        INSERT OR IGNORE INTO farms (
          id, owner_user_id, organization_id, name, village, taluka, district, state, country,
          latitude, longitude, coordinate_crs, location_accuracy_m, location_method, location_confirmed,
          agroclimatic_zone, university_reference, nearest_kvk, total_area_acres, farming_system,
          irrigation_source, water_availability, is_demo, created_at, updated_at
        ) VALUES (?, ?, ?, 'Niphad Irrigated Block [DEMO DATA]', 'Niphad', 'Niphad', 'Nashik', 'Maharashtra', 'India', 20.0752, 74.1118, 'EPSG:4326', 10, 'MAP_PIN', 1, ?, ?, ?, 3.0, 'Horticulture + Cereal', 'Drip + Well', 'Irrigated', 1, ?, ?)
      `).run(farm2Id, extraFarmerId, orgId, geo2.agroclimaticZone, geo2.universityReference, geo2.nearestKvk, now, now);

      db.prepare(`
        INSERT OR IGNORE INTO fields (
          id, farm_id, owner_user_id, name, geometry_geojson, centroid_lat, centroid_lon,
          area_acres, area_hectares, soil_type, current_crop, previous_crop,
          irrigation_method, water_availability, is_demo, created_at, updated_at
        ) VALUES ('field-demo-niphad-1', ?, ?, 'Drip Plot A [DEMO DATA]', ?, 20.0752, 74.1118, 3.0, 1.214, 'Loamy', 'Rabi Onion', 'Soybean', 'Drip', 'Irrigated', 1, ?, ?)
      `).run(farm2Id, extraFarmerId, createSquareFieldGeoJson(20.0752, 74.1118, 3.0), now, now);
    }
  });

  runDemoSeed();
}
