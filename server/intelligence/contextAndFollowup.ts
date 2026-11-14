import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type {
  CropCatalogueItem,
  FarmDecisionContext,
  RotationAnalysisResult,
  SeasonType,
  WaterAvailability,
} from '../../shared/types';
import { generateThreeRotationStrategies } from './cropRotationEngine';
import { resolveGeographicContext } from './geoService';

export function loadCropCatalogue(db: Database.Database): CropCatalogueItem[] {
  const rows = db.prepare('SELECT * FROM crop_catalogue ORDER BY name ASC').all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    localNameMr: String(r.local_name_mr),
    localNameHi: String(r.local_name_hi),
    scientificName: String(r.scientific_name),
    cropFamily: String(r.crop_family),
    suitableSeasons: JSON.parse(String(r.suitable_seasons_json)),
    sowingWindow: String(r.sowing_window),
    durationDaysMin: Number(r.duration_days_min),
    durationDaysMax: Number(r.duration_days_max),
    waterNeedLevel: r.water_need_level as 'Low' | 'Moderate' | 'High',
    waterNeedMm: Number(r.water_need_mm),
    idealPhMin: Number(r.ideal_ph_min),
    idealPhMax: Number(r.ideal_ph_max),
    soilTypes: JSON.parse(String(r.soil_types_json)),
    rootDepth: r.root_depth as 'Shallow' | 'Medium' | 'Deep',
    nitrogenFixer: Boolean(r.nitrogen_fixer),
    rotationBreakSeasons: Number(r.rotation_break_seasons),
    estimatedCostPerAcreInr: r.estimated_cost_per_acre_inr !== null ? Number(r.estimated_cost_per_acre_inr) : null,
    costBreakdownJson: r.cost_breakdown_json ? String(r.cost_breakdown_json) : null,
    referenceYieldQPerAcre: r.reference_yield_q_per_acre !== null ? Number(r.reference_yield_q_per_acre) : null,
    sourceReference: String(r.source_reference),
    sourceYear: Number(r.source_year),
    agroclimaticZones: JSON.parse(String(r.agroclimatic_zones_json)),
    verifiedByExpert: Boolean(r.verified_by_expert),
    typicalOperations: JSON.parse(String(r.typical_operations_json)),
  }));
}

export function buildFarmDecisionContext(
  db: Database.Database,
  farmerId: string,
  farmId: string,
  fieldId: string,
  planningSeason: SeasonType
): FarmDecisionContext {
  const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(farmId) as Record<string, unknown> | undefined;
  const field = db.prepare('SELECT * FROM fields WHERE id = ? AND farm_id = ?').get(fieldId, farmId) as
    | Record<string, unknown>
    | undefined;

  if (!farm || !field) {
    throw new Error('Farm or field record not found.');
  }

  const req = db
    .prepare('SELECT * FROM farmer_requirements WHERE field_id = ?')
    .get(fieldId) as Record<string, unknown> | undefined;

  const historyRows = db
    .prepare('SELECT * FROM crop_history WHERE field_id = ? ORDER BY year DESC, created_at DESC LIMIT 6')
    .all(fieldId) as Array<Record<string, unknown>>;

  const soilRow = db
    .prepare('SELECT * FROM soil_tests WHERE field_id = ? ORDER BY sample_date DESC, created_at DESC LIMIT 1')
    .get(fieldId) as Record<string, unknown> | undefined;

  const acceptedCountRow = db
    .prepare(`SELECT COUNT(*) as cnt FROM rotation_plans WHERE field_id = ? AND status = 'APPROVED'`)
    .get(fieldId) as { cnt: number };

  const lat = Number(field.centroid_lat || farm.latitude);
  const lon = Number(field.centroid_lon || farm.longitude);

  // Weather & NASA observations near field coordinates
  const powerRain = db
    .prepare(
      `SELECT value, observation_start FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05
         AND source_id = 'NASA_POWER' AND variable = 'PRECTOTCORR' AND value IS NOT NULL
       ORDER BY observation_start DESC LIMIT 30`
    )
    .all(lat, lon) as Array<{ value: number; observation_start: string }>;

  const powerTemp = db
    .prepare(
      `SELECT value, observation_start FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05
         AND source_id = 'NASA_POWER' AND variable = 'T2M' AND value IS NOT NULL
       ORDER BY observation_start DESC LIMIT 14`
    )
    .all(lat, lon) as Array<{ value: number; observation_start: string }>;

  const powerTmax = db
    .prepare(
      `SELECT value FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05
         AND source_id = 'NASA_POWER' AND variable = 'T2M_MAX' AND value IS NOT NULL
       ORDER BY observation_start DESC LIMIT 7`
    )
    .all(lat, lon) as Array<{ value: number }>;

  const forecastRain = db
    .prepare(
      `SELECT value FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05
         AND source_id = 'OPEN_METEO' AND variable = 'FORECAST_PRECIP_MM' AND value IS NOT NULL
       ORDER BY observation_start ASC LIMIT 7`
    )
    .all(lat, lon) as Array<{ value: number }>;

  const et0Rows = db
    .prepare(
      `SELECT value FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05
         AND source_id = 'OPEN_METEO' AND variable = 'ET0_MM_DAY' AND value IS NOT NULL
       ORDER BY observation_start DESC LIMIT 7`
    )
    .all(lat, lon) as Array<{ value: number }>;

  const soilMoistureRow = db
    .prepare(
      `SELECT value FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05
         AND source_id = 'OPEN_METEO' AND variable = 'SOIL_MOISTURE_0_1CM' AND value IS NOT NULL
       ORDER BY retrieval_time DESC LIMIT 1`
    )
    .get(lat, lon) as { value: number } | undefined;

  const gpmRow = db
    .prepare(
      `SELECT granule_or_scene_id FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05 AND source_id = 'NASA_GPM_IMERG'
       ORDER BY observation_start DESC LIMIT 1`
    )
    .get(lat, lon) as { granule_or_scene_id: string | null } | undefined;

  const smapRow = db
    .prepare(
      `SELECT granule_or_scene_id FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05 AND source_id = 'NASA_SMAP_L4'
       ORDER BY observation_start DESC LIMIT 1`
    )
    .get(lat, lon) as { granule_or_scene_id: string | null } | undefined;

  const landsatRow = db
    .prepare(
      `SELECT granule_or_scene_id FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05 AND source_id = 'LANDSAT_C2'
       ORDER BY observation_start DESC LIMIT 1`
    )
    .get(lat, lon) as { granule_or_scene_id: string | null } | undefined;

  const marketRows = db
    .prepare(
      `SELECT commodity, market, district, modal_price, arrival_date, source_type
       FROM market_prices
       WHERE state = ? OR is_demo = 1
       ORDER BY is_demo ASC, arrival_date DESC LIMIT 20`
    )
    .all(String(farm.state)) as Array<{
    commodity: string;
    market: string;
    district: string;
    modal_price: number;
    arrival_date: string;
    source_type: 'AGMARKNET' | 'FARMER_QUOTE' | 'DEMO_DATA';
  }>;

  const geo = resolveGeographicContext({
    lat,
    lon,
    district: String(farm.district),
    state: String(farm.state),
  });

  const recent7dRain =
    powerRain.length > 0 ? Number(powerRain.slice(0, 7).reduce((s, r) => s + r.value, 0).toFixed(1)) : null;
  const recent30dRain =
    powerRain.length > 0 ? Number(powerRain.reduce((s, r) => s + r.value, 0).toFixed(1)) : null;
  const forecast7dRain =
    forecastRain.length > 0 ? Number(forecastRain.reduce((s, r) => s + r.value, 0).toFixed(1)) : null;
  const meanTemp =
    powerTemp.length > 0
      ? Number((powerTemp.reduce((s, r) => s + r.value, 0) / powerTemp.length).toFixed(1))
      : null;
  const maxTemp =
    powerTmax.length > 0 ? Math.max(...powerTmax.map((r) => r.value)) : null;
  const et0Mean =
    et0Rows.length > 0
      ? Number((et0Rows.reduce((s, r) => s + r.value, 0) / et0Rows.length).toFixed(2))
      : null;

  let consecutiveDryDays: number | null = null;
  if (powerRain.length > 0) {
    consecutiveDryDays = 0;
    for (const r of powerRain) {
      if (r.value < 1.0) consecutiveDryDays++;
      else break;
    }
  }

  const missingInformation: string[] = [];
  if (!soilRow) missingInformation.push('Laboratory soil test (pH, Organic Carbon, NPK) missing.');
  if (powerRain.length === 0) missingInformation.push('NASA POWER environmental observations not yet fetched for field coordinates.');
  if (!req || req.max_budget_inr === null) missingInformation.push('Cultivation budget cap not specified.');
  if (!process.env.EARTHDATA_TOKEN) missingInformation.push('EARTHDATA_TOKEN not set for SMAP/Landsat raster pixel extraction (granule discovery active).');
  if (!process.env.IMD_API_KEY) missingInformation.push('IMD_API_KEY not set for official IMD district warning bulletins.');
  if (!process.env.DATA_GOV_API_KEY) missingInformation.push('DATA_GOV_API_KEY not set for live AGMARKNET mandi arrivals (showing labeled DEMO DATA where available).');

  const evidenceReferences: string[] = [
    `Geo Zone: ${geo.agroclimaticZone} (${geo.universityReference})`,
  ];
  if (powerRain.length > 0) {
    evidenceReferences.push(`NASA POWER Daily (${powerRain[0].observation_start.slice(0, 10)} latest)`);
  }
  if (gpmRow?.granule_or_scene_id) evidenceReferences.push(`GPM Granule: ${gpmRow.granule_or_scene_id}`);
  if (smapRow?.granule_or_scene_id) evidenceReferences.push(`SMAP Granule: ${smapRow.granule_or_scene_id}`);
  if (landsatRow?.granule_or_scene_id) evidenceReferences.push(`Landsat/HLS Scene: ${landsatRow.granule_or_scene_id}`);
  if (soilRow) evidenceReferences.push(`Soil Record (${String(soilRow.source_label)}, ${String(soilRow.sample_date || 'undated')})`);

  const contextId = crypto.randomUUID();
  const generatedAt = new Date().toISOString();
  const contextVersion = `ctx-${Date.now()}`;

  const context: FarmDecisionContext = {
    contextVersion,
    contextId,
    generatedAt,
    farmerId,
    farmId,
    fieldId,
    planningSeason,
    geography: {
      latitude: lat,
      longitude: lon,
      locationConfirmed: Boolean(farm.location_confirmed),
      village: String(farm.village),
      taluka: String(farm.taluka),
      district: String(farm.district),
      state: String(farm.state),
      country: String(farm.country),
      agroclimaticZone: String(farm.agroclimatic_zone || geo.agroclimaticZone),
      universityReference: String(farm.university_reference || geo.universityReference),
      nearestKvk: String(farm.nearest_kvk || geo.nearestKvk),
      nearestMarkets: geo.nearestMarkets,
      fieldAreaAcres: Number(field.area_acres),
      fieldAreaHectares: Number(field.area_hectares),
    },
    farmerRequirements: {
      maxBudgetInr: req && req.max_budget_inr !== null ? Number(req.max_budget_inr) : null,
      budgetPerAcreInr: req && req.budget_per_acre_inr !== null ? Number(req.budget_per_acre_inr) : null,
      waterAvailability: (req?.water_availability || field.water_availability || farm.water_availability || 'Limited') as WaterAvailability,
      irrigationType: String(field.irrigation_method || farm.irrigation_source || 'Limited'),
      riskTolerance: (req?.risk_tolerance || 'Moderate') as 'Low' | 'Moderate' | 'High',
      preferredCrops: req ? JSON.parse(String(req.preferred_crops_json || '[]')) : [],
      avoidCrops: req ? JSON.parse(String(req.avoid_crops_json || '[]')) : [],
      priorityFocus: (req?.priority_focus || 'Balanced') as 'Lower Cost' | 'Soil Health' | 'Balanced' | 'Water Saving',
      laborAvailability: String(req?.labor_availability || 'Family + Seasonal Hired'),
      machineryAccess: String(req?.machinery_access || 'Rented Tractor'),
      targetPlantingDate: req?.target_planting_date ? String(req.target_planting_date) : null,
    },
    fieldHistory: {
      currentCrop: field.current_crop ? String(field.current_crop) : null,
      previousCrops: historyRows.map((h) => ({
        cropName: String(h.crop_name),
        cropFamily: String(h.crop_family),
        season: String(h.season),
        year: Number(h.year),
        plantingDate: h.planting_date ? String(h.planting_date) : null,
        harvestDate: h.harvest_date ? String(h.harvest_date) : null,
      })),
      acceptedPlansCount: acceptedCountRow.cnt,
    },
    soilProfile: {
      soilType: field.soil_type ? String(field.soil_type) : null,
      ph: soilRow && soilRow.ph !== null ? Number(soilRow.ph) : null,
      organicCarbonPct: soilRow && soilRow.organic_carbon_pct !== null ? Number(soilRow.organic_carbon_pct) : null,
      nitrogenKgHa: soilRow && soilRow.nitrogen_kg_ha !== null ? Number(soilRow.nitrogen_kg_ha) : null,
      phosphorusKgHa: soilRow && soilRow.phosphorus_kg_ha !== null ? Number(soilRow.phosphorus_kg_ha) : null,
      potassiumKgHa: soilRow && soilRow.potassium_kg_ha !== null ? Number(soilRow.potassium_kg_ha) : null,
      ecDsM: soilRow && soilRow.ec_ds_m !== null ? Number(soilRow.ec_ds_m) : null,
      sourceLabel: soilRow ? (String(soilRow.source_label) as 'Lab Measured' | 'Farmer Entered') : 'Missing',
      sampleDate: soilRow?.sample_date ? String(soilRow.sample_date) : null,
      labName: soilRow?.lab_name ? String(soilRow.lab_name) : null,
    },
    weatherContext: {
      recent7dRainfallMm: recent7dRain,
      recent30dRainfallMm: recent30dRain,
      forecast7dRainfallMm: forecast7dRain,
      meanTempC: meanTemp,
      maxTempC: maxTemp,
      consecutiveDryDays,
      et0MeanMmDay: et0Mean,
      sourceProvider: powerRain.length > 0 ? 'NASA POWER + Open-Meteo' : 'Not yet retrieved',
      observationTimestamp: powerRain[0]?.observation_start || null,
      imdWarningStatus: process.env.IMD_API_KEY ? 'Connected' : 'Awaiting IMD_API_KEY credentials',
    },
    nasaObservations: {
      powerAvailable: powerRain.length > 0,
      gpmGranuleId: gpmRow?.granule_or_scene_id || null,
      smapGranuleId: smapRow?.granule_or_scene_id || null,
      landsatSceneId: landsatRow?.granule_or_scene_id || null,
      soilMoistureSurface: soilMoistureRow ? soilMoistureRow.value : null,
      ndviLatest: null,
      dataGaps: missingInformation,
    },
    marketContext: {
      availablePrices: marketRows.map((m) => ({
        commodity: m.commodity,
        market: m.market,
        district: m.district,
        modalPriceInrPerQuintal: m.modal_price,
        arrivalDate: m.arrival_date,
        sourceType: m.source_type,
      })),
    },
    missingInformation,
    evidenceReferences,
  };

  db.prepare(`
    INSERT INTO decision_contexts (id, version, farmer_id, farm_id, field_id, planning_season, context_json, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(contextId, contextVersion, farmerId, farmId, fieldId, planningSeason, JSON.stringify(context), generatedAt);

  return context;
}

export function runAndPersistRotationAnalysis(
  db: Database.Database,
  farmerId: string,
  farmId: string,
  fieldId: string,
  planningSeason: SeasonType
): { context: FarmDecisionContext; analysis: RotationAnalysisResult; planId: string } {
  const context = buildFarmDecisionContext(db, farmerId, farmId, fieldId, planningSeason);
  const catalogue = loadCropCatalogue(db);
  const analysis = generateThreeRotationStrategies(context, catalogue);
  const planId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO rotation_plans (
      id, context_id, farmer_id, farm_id, field_id, planning_season,
      algorithm_version, status, expert_review_status, strategies_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', 'NOT_REQUESTED', ?, ?, ?)
  `).run(
    planId,
    context.contextId,
    farmerId,
    farmId,
    fieldId,
    planningSeason,
    analysis.algorithmVersion,
    JSON.stringify(analysis.strategies),
    now,
    now
  );

  db.prepare(`
    INSERT INTO timeline_events (id, farm_id, field_id, event_type, title, description, actor_user_id, metadata_json, created_at)
    VALUES (?, ?, ?, 'ROTATION_ANALYZED', ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    farmId,
    fieldId,
    `Rotation Strategies Evaluated (${planningSeason})`,
    `Generated Existing, Minimal Change, and Alternative strategies using Context ${context.contextVersion}.`,
    farmerId,
    JSON.stringify({ planId, contextId: context.contextId }),
    now
  );

  return { context, analysis, planId };
}

/**
 * Generates crop-specific operational tasks upon plan approval, preventing duplicates via idempotency keys.
 */
export function activateFollowupsForApprovedPlan(
  db: Database.Database,
  planId: string,
  actorUserId: string
): number {
  const plan = db.prepare('SELECT * FROM rotation_plans WHERE id = ?').get(planId) as
    | Record<string, unknown>
    | undefined;
  if (!plan || !plan.selected_crop) return 0;

  const cropName = String(plan.selected_crop);
  const cropRow = db.prepare('SELECT * FROM crop_catalogue WHERE name = ?').get(cropName) as
    | Record<string, unknown>
    | undefined;

  const operations: Array<{
    dayOffset: number;
    category: string;
    title: string;
    description: string;
    priority: string;
  }> = cropRow
    ? JSON.parse(String(cropRow.typical_operations_json))
    : [
        {
          dayOffset: 0,
          category: 'Sowing',
          title: `Prepare field & sow ${cropName}`,
          description: 'Confirm seed germination & soil moisture prior to sowing.',
          priority: 'High',
        },
        {
          dayOffset: 30,
          category: 'Field Inspection',
          title: `${cropName} crop establishment inspection`,
          description: 'Check stand uniformity, weeds, and moisture stress.',
          priority: 'Medium',
        },
      ];

  const baseDate = new Date();
  const now = new Date().toISOString();
  let created = 0;

  const insertTask = db.prepare(`
    INSERT OR IGNORE INTO tasks (
      id, farm_id, field_id, plan_id, assigned_user_id, crop_name, category,
      title, reason, rule_reference, due_date, priority, status, trigger_event,
      evidence_json, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPCOMING', 'PLAN_APPROVED', ?, ?, ?, ?)
  `);

  for (const op of operations) {
    const due = new Date(baseDate);
    due.setUTCDate(due.getUTCDate() + op.dayOffset);
    const dueStr = due.toISOString().slice(0, 10);
    const idemKey = `plan-${planId}-op-${op.dayOffset}-${op.category}`;

    const info = insertTask.run(
      crypto.randomUUID(),
      String(plan.farm_id),
      String(plan.field_id),
      planId,
      String(plan.farmer_id),
      cropName,
      op.category,
      op.title,
      op.description,
      cropRow ? String(cropRow.source_reference) : 'Approved Crop Plan',
      dueStr,
      op.priority,
      JSON.stringify({ planId, contextId: plan.context_id, cropName }),
      idemKey,
      now,
      now
    );
    if (info.changes > 0) created++;
  }

  db.prepare(`
    INSERT OR IGNORE INTO notifications (id, user_id, farm_id, field_id, title, message, priority, category, evidence_ref, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'High', 'PLAN_APPROVED', ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    String(plan.farmer_id),
    String(plan.farm_id),
    String(plan.field_id),
    `Crop Plan Approved: ${cropName}`,
    `${created} crop-specific follow-up tasks generated for ${cropName} (${String(plan.planning_season)}).`,
    planId,
    `notif-plan-approved-${planId}`,
    now
  );

  db.prepare(`
    INSERT INTO timeline_events (id, farm_id, field_id, event_type, title, description, actor_user_id, metadata_json, created_at)
    VALUES (?, ?, ?, 'PLAN_APPROVED', ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    String(plan.farm_id),
    String(plan.field_id),
    `Plan Approved: ${cropName}`,
    `Farmer approved ${String(plan.selected_strategy_type)} strategy (${cropName}); ${created} scheduled tasks activated.`,
    actorUserId,
    JSON.stringify({ planId, createdTasks: created }),
    now
  );

  return created;
}

/**
 * Weather Risk Engine: Evaluates real persisted weather/NASA data for a field and creates traceable alerts/tasks only when thresholds trigger.
 */
export function evaluateWeatherRisksForField(
  db: Database.Database,
  farmId: string,
  fieldId: string,
  userId: string
): { triggered: number; alerts: string[] } {
  const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId) as
    | Record<string, unknown>
    | undefined;
  if (!field) return { triggered: 0, alerts: [] };

  const lat = Number(field.centroid_lat);
  const lon = Number(field.centroid_lon);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const alerts: string[] = [];
  let triggered = 0;

  const forecastRainRows = db
    .prepare(
      `SELECT value, observation_start FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05
         AND source_id = 'OPEN_METEO' AND variable = 'FORECAST_PRECIP_MM' AND value IS NOT NULL
       ORDER BY observation_start ASC LIMIT 5`
    )
    .all(lat, lon) as Array<{ value: number; observation_start: string }>;

  const heavyDay = forecastRainRows.find((r) => r.value >= 35);
  if (heavyDay) {
    const dayStr = heavyDay.observation_start.slice(0, 10);
    const msg = `Forecast rainfall of ${heavyDay.value} mm on ${dayStr} (Open-Meteo). Review sowing, spraying, or field drainage tasks.`;
    const info = db
      .prepare(`
        INSERT OR IGNORE INTO tasks (
          id, farm_id, field_id, assigned_user_id, crop_name, category, title, reason,
          rule_reference, due_date, priority, status, trigger_event, evidence_json, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'Weather Review', 'Review field drainage & operations before heavy rain', ?, 'Weather Risk Threshold >= 35 mm/day', ?, 'High', 'WEATHER_TRIGGERED', 'FORECAST_HEAVY_RAIN', ?, ?, ?, ?)
      `)
      .run(
        crypto.randomUUID(),
        farmId,
        fieldId,
        userId,
        field.current_crop ? String(field.current_crop) : null,
        msg,
        dayStr,
        JSON.stringify({ source: 'OPEN_METEO', forecastDate: dayStr, mm: heavyDay.value }),
        `weather-rain-${fieldId}-${dayStr}`,
        now,
        now
      );

    if (info.changes > 0) {
      triggered++;
      alerts.push(msg);
      db.prepare(`
        INSERT OR IGNORE INTO notifications (id, user_id, farm_id, field_id, title, message, priority, category, evidence_ref, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, 'Weather-Triggered Field Review', ?, 'High', 'WEATHER_RISK', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        userId,
        farmId,
        fieldId,
        msg,
        `OPEN_METEO:${dayStr}`,
        `notif-rain-${fieldId}-${dayStr}`,
        now
      );
    }
  }

  const forecastMaxTemp = db
    .prepare(
      `SELECT value, observation_start FROM environmental_observations
       WHERE ABS(latitude - ?) < 0.05 AND ABS(longitude - ?) < 0.05
         AND source_id = 'OPEN_METEO' AND variable = 'FORECAST_TMAX_C' AND value >= 39
       ORDER BY observation_start ASC LIMIT 1`
    )
    .get(lat, lon) as { value: number; observation_start: string } | undefined;

  if (forecastMaxTemp) {
    const dayStr = forecastMaxTemp.observation_start.slice(0, 10);
    const msg = `High forecast daytime temperature (${forecastMaxTemp.value}°C on ${dayStr}). Inspect crop moisture and avoid mid-day foliar sprays.`;
    const info = db
      .prepare(`
        INSERT OR IGNORE INTO tasks (
          id, farm_id, field_id, assigned_user_id, crop_name, category, title, reason,
          rule_reference, due_date, priority, status, trigger_event, evidence_json, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'Weather Review', 'Heat-stress inspection & irrigation review', ?, 'Heat Stress Threshold >= 39°C', ?, 'High', 'WEATHER_TRIGGERED', 'FORECAST_HEAT', ?, ?, ?, ?)
      `)
      .run(
        crypto.randomUUID(),
        farmId,
        fieldId,
        userId,
        field.current_crop ? String(field.current_crop) : null,
        msg,
        today,
        JSON.stringify({ source: 'OPEN_METEO', date: dayStr, tmaxC: forecastMaxTemp.value }),
        `weather-heat-${fieldId}-${dayStr}`,
        now,
        now
      );
    if (info.changes > 0) {
      triggered++;
      alerts.push(msg);
    }
  }

  if (triggered > 0) {
    markPlansForReassessment(
      db,
      fieldId,
      `Weather alert triggered (${alerts.length} risk event${alerts.length > 1 ? 's' : ''}) — review sowing & field operations`
    );
  }

  return { triggered, alerts };
}

export function processOverdueTasks(db: Database.Database): number {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const overdueRows = db
    .prepare(
      `SELECT id, farm_id, field_id, assigned_user_id, title, due_date
       FROM tasks
       WHERE status = 'UPCOMING' AND due_date < ?`
    )
    .all(today) as Array<{
    id: string;
    farm_id: string;
    field_id: string;
    assigned_user_id: string;
    title: string;
    due_date: string;
  }>;

  let processed = 0;
  for (const row of overdueRows) {
    const info = db
      .prepare(`UPDATE tasks SET status = 'OVERDUE', updated_at = ? WHERE id = ? AND status = 'UPCOMING'`)
      .run(now, row.id);
    if (info.changes > 0) {
      processed++;
      db.prepare(`
        INSERT OR IGNORE INTO notifications (
          id, user_id, farm_id, field_id, title, message, priority, category, evidence_ref, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'High', 'TASK_OVERDUE', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        row.assigned_user_id,
        row.farm_id,
        row.field_id,
        `Overdue Task: ${row.title}`,
        `Task "${row.title}" was due on ${row.due_date}. Complete with field feedback or postpone with reason.`,
        row.id,
        `notif-overdue-${row.id}`,
        now
      );
    }
  }
  return processed;
}

export function markPlansForReassessment(
  db: Database.Database,
  fieldId: string,
  reason: string
): void {
  db.prepare(`
    UPDATE rotation_plans
    SET reassessment_needed = 1, reassessment_reason = ?, updated_at = ?
    WHERE field_id = ? AND status IN ('DRAFT', 'APPROVED')
  `).run(reason, new Date().toISOString(), fieldId);
}

export function writeAuditLog(
  db: Database.Database,
  actorUserId: string | null,
  actorRole: string | null,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details?: Record<string, unknown>
): void {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, actor_role, action, resource_type, resource_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    actorUserId,
    actorRole,
    action,
    resourceType,
    resourceId,
    details ? JSON.stringify(details) : null,
    new Date().toISOString()
  );
}
