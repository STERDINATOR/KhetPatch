import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db/schema';
import { seedPlatformData } from '../db/seed';
import {
  calculatePolygonStats,
  computeSpatialGridIds,
  createSquareFieldGeoJson,
  haversineDistanceKm,
  reverseGeocodeCoordinates,
  resolveGeographicContext,
} from '../intelligence/geoService';
import { generateThreeRotationStrategies } from '../intelligence/cropRotationEngine';
import {
  activateFollowupsForApprovedPlan,
  buildFarmDecisionContext,
  loadCropCatalogue,
  markPlansForReassessment,
  processOverdueTasks,
  runAndPersistRotationAnalysis,
} from '../intelligence/contextAndFollowup';
import {
  authenticateCredentials,
  canAccessFarm,
  completePasswordReset,
  createPasswordResetToken,
  registerFarmerAccount,
  resolveUserWorkspace,
} from '../auth/authService';
import type { FarmDecisionContext } from '../../shared/types';

test('geoService calculates polygon area and resolves agroclimatic zone accurately', () => {
  const geoJson = JSON.parse(createSquareFieldGeoJson(19.8825, 74.4789, 2.5));
  const stats = calculatePolygonStats(geoJson.coordinates[0]);
  assert.equal(stats.valid, true);
  assert.ok(Math.abs(stats.areaAcres - 2.5) < 0.05, `Expected ~2.5 acres, got ${stats.areaAcres}`);

  const mhZone = resolveGeographicContext({ lat: 19.8825, lon: 74.4789, district: 'Ahilyanagar', state: 'Maharashtra' });
  assert.ok(mhZone.universityReference.includes('MPKV'));

  const pbZone = resolveGeographicContext({ lat: 30.9, lon: 75.85, district: 'Ludhiana', state: 'Punjab' });
  assert.ok(pbZone.universityReference.includes('PAU'));

  const dist = haversineDistanceKm({ lat: 19.88, lon: 74.47 }, { lat: 20.07, lon: 74.11 });
  assert.ok(dist > 35 && dist < 50);
});

test('cropRotationEngine responds deterministically to budget, water, crop history, targetPlantingDate, and populates costBreakdown', () => {
  const db = getDb(':memory:');
  seedPlatformData(db);
  const catalogue = loadCropCatalogue(db);

  const baseContext: FarmDecisionContext = {
    contextVersion: 'test-1',
    contextId: 'ctx-1',
    generatedAt: new Date().toISOString(),
    farmerId: 'u1',
    farmId: 'f1',
    fieldId: 'fl1',
    planningSeason: 'Rabi',
    geography: {
      latitude: 19.8825,
      longitude: 74.4789,
      locationConfirmed: true,
      village: 'Kopargaon',
      taluka: 'Kopargaon',
      district: 'Ahilyanagar',
      state: 'Maharashtra',
      country: 'India',
      agroclimaticZone: 'Maharashtra Scarcity Zone',
      universityReference: 'MPKV Rahuri',
      nearestKvk: 'KVK Babhaleshwar',
      nearestMarkets: ['Kopargaon APMC'],
      fieldAreaAcres: 2.5,
      fieldAreaHectares: 1.012,
    },
    farmerRequirements: {
      maxBudgetInr: 45000,
      budgetPerAcreInr: 18000,
      waterAvailability: 'Irrigated',
      irrigationType: 'Drip',
      riskTolerance: 'Moderate',
      preferredCrops: ['Rabi Onion'],
      avoidCrops: [],
      priorityFocus: 'Balanced',
      laborAvailability: 'Available',
      machineryAccess: 'Rented',
      targetPlantingDate: '2026-11-10',
    },
    fieldHistory: {
      currentCrop: 'Soybean',
      previousCrops: [
        { cropName: 'Soybean', cropFamily: 'Fabaceae (Legume)', season: 'Kharif', year: 2026, plantingDate: null, harvestDate: null },
      ],
      acceptedPlansCount: 0,
    },
    soilProfile: {
      soilType: 'Medium Black',
      ph: 7.2,
      organicCarbonPct: 0.55,
      nitrogenKgHa: 210,
      phosphorusKgHa: 16,
      potassiumKgHa: 280,
      ecDsM: 0.3,
      sourceLabel: 'Lab Measured',
      sampleDate: '2026-05-10',
      labName: 'Test Lab',
    },
    weatherContext: {
      recent7dRainfallMm: 12,
      recent30dRainfallMm: 44,
      forecast7dRainfallMm: 4,
      meanTempC: 24.5,
      maxTempC: 31,
      consecutiveDryDays: 4,
      et0MeanMmDay: 4.1,
      sourceProvider: 'NASA POWER',
      observationTimestamp: '2026-11-10T00:00:00Z',
      imdWarningStatus: 'Awaiting credentials',
    },
    nasaObservations: {
      powerAvailable: true,
      gpmGranuleId: null,
      smapGranuleId: null,
      landsatSceneId: null,
      soilMoistureSurface: 0.26,
      ndviLatest: null,
      dataGaps: [],
    },
    marketContext: { availablePrices: [] },
    missingInformation: [],
    evidenceReferences: ['MPKV Rahuri'],
  };

  // High budget + irrigated + November planting date -> feasible strategies include costBreakdown
  const richResult = generateThreeRotationStrategies(baseContext, catalogue);
  assert.equal(richResult.strategies.length, 3);
  const minimalRich = richResult.strategies.find((s) => s.strategyType === 'MINIMAL_CHANGE')!;
  assert.equal(minimalRich.feasible, true);
  assert.ok(minimalRich.costBreakdown);
  const breakdownSum =
    minimalRich.costBreakdown.seeds +
    minimalRich.costBreakdown.landPrep +
    minimalRich.costBreakdown.fertilizer +
    minimalRich.costBreakdown.irrigation +
    minimalRich.costBreakdown.laborAndHarvest;
  assert.ok(minimalRich.estimatedCostPerAcreInr !== null);
  assert.ok(Math.abs(breakdownSum - minimalRich.estimatedCostPerAcreInr!) <= 10);

  // Out-of-window targetPlantingDate (April for Rabi crops) -> violates hard sowing window constraint
  const offSeasonContext: FarmDecisionContext = {
    ...baseContext,
    farmerRequirements: {
      ...baseContext.farmerRequirements,
      targetPlantingDate: '2026-04-15',
    },
  };
  const offSeasonResult = generateThreeRotationStrategies(offSeasonContext, catalogue);
  assert.equal(
    offSeasonResult.strategies.some((s) => s.feasible),
    false,
    'Expected all Rabi strategies to fail hard sowing window constraint for April planting date'
  );

  // Tight budget (₹25,000 for 2.5 ac = ₹10,000/ac) & Rainfed -> Expensive/high-water crops MUST become infeasible!
  const constrainedContext: FarmDecisionContext = {
    ...baseContext,
    farmerRequirements: {
      ...baseContext.farmerRequirements,
      maxBudgetInr: 25000,
      waterAvailability: 'Rainfed',
      preferredCrops: ['Rabi Onion'],
      targetPlantingDate: '2026-10-15',
    },
  };
  const tightResult = generateThreeRotationStrategies(constrainedContext, catalogue);
  const anyOnionFeasible = tightResult.strategies.some(
    (s) => s.proposedCrop === 'Rabi Onion' && s.feasible
  );
  assert.equal(anyOnionFeasible, false);
  const minimalTight = tightResult.strategies.find((s) => s.strategyType === 'MINIMAL_CHANGE')!;
  assert.equal(minimalTight.feasible, true);
  assert.equal(minimalTight.proposedCrop, 'Rabi Sorghum (Jowar)');
});

test('Auth, RBAC, tenant isolation, and follow-up activation work end-to-end in DB', () => {
  const db = getDb(':memory:');
  seedPlatformData(db);

  // 1. Demo identity has all 5 roles
  const demoLogin = authenticateCredentials(db, 'demo@khetpatch.org', 'KhetPatch@Demo2026', 'FARMER');
  assert.equal(demoLogin.ok, true);
  if (demoLogin.ok) {
    assert.equal(demoLogin.auth.availableRoles.length, 5);
  }

  // 2. Public signup grants ONLY FARMER role and cannot elevate to PLATFORM_ADMIN
  const signup = registerFarmerAccount(db, {
    email: 'anita@example.com',
    password: 'StrongPassword123',
    fullName: 'Anita Shinde',
  });
  assert.equal(signup.ok, true);
  if (!signup.ok) return;

  const adminAttempt = resolveUserWorkspace(db, signup.auth.userId, 'PLATFORM_ADMIN');
  assert.equal(adminAttempt.allowed, false);

  // 3. Tenant isolation: Anita cannot access the demo Kopargaon farm
  assert.equal(canAccessFarm(db, signup.auth, 'farm-demo-kopargaon'), false);

  // 4. Demo user CAN analyze rotation & approve plan -> activates crop-specific tasks idempotently
  if (demoLogin.ok) {
    const ctx = buildFarmDecisionContext(
      db,
      demoLogin.auth.userId,
      'farm-demo-kopargaon',
      'field-demo-north',
      'Rabi'
    );
    assert.equal(ctx.geography.district, 'Ahilyanagar');

    const analysisRun = runAndPersistRotationAnalysis(
      db,
      demoLogin.auth.userId,
      'farm-demo-kopargaon',
      'field-demo-north',
      'Rabi'
    );
    const minimal = analysisRun.analysis.strategies.find((s) => s.strategyType === 'MINIMAL_CHANGE')!;
    assert.equal(minimal.feasible, true);

    db.prepare(
      `UPDATE rotation_plans SET selected_strategy_type = 'MINIMAL_CHANGE', selected_crop = ?, status = 'APPROVED' WHERE id = ?`
    ).run(minimal.proposedCrop, analysisRun.planId);

    const firstActivation = activateFollowupsForApprovedPlan(db, analysisRun.planId, demoLogin.auth.userId);
    assert.ok(firstActivation > 0);
    // Second invocation must be idempotent (0 duplicate tasks created)
    const secondActivation = activateFollowupsForApprovedPlan(db, analysisRun.planId, demoLogin.auth.userId);
    assert.equal(secondActivation, 0);

    // 5. markPlansForReassessment flags approved/draft plans cleanly
    markPlansForReassessment(db, 'field-demo-north', 'Farmer updated budget requirements');
    const flagged = db
      .prepare('SELECT reassessment_needed, reassessment_reason FROM rotation_plans WHERE id = ?')
      .get(analysisRun.planId) as { reassessment_needed: number; reassessment_reason: string };
    assert.equal(flagged.reassessment_needed, 1);
    assert.ok(flagged.reassessment_reason.includes('budget'));
  }
});

test('cropRotationEngine respects avoidCrops and PLATFORM_ADMIN cannot read unowned private farms', () => {
  const db = getDb(':memory:');
  seedPlatformData(db);
  const catalogue = loadCropCatalogue(db);

  // Avoid Chickpea (Gram) & Wheat -> engine must not pick them as feasible alternatives
  const ctx = buildFarmDecisionContext(
    db,
    'user-demo-codex',
    'farm-demo-kopargaon',
    'field-demo-north',
    'Rabi'
  );
  ctx.farmerRequirements.avoidCrops = ['Chickpea (Gram)', 'Wheat'];
  ctx.soilProfile = {
    soilType: 'Medium Black',
    ph: null,
    organicCarbonPct: null,
    nitrogenKgHa: null,
    phosphorusKgHa: null,
    potassiumKgHa: null,
    ecDsM: null,
    sourceLabel: 'Missing',
    sampleDate: null,
    labName: null,
  };

  const res = generateThreeRotationStrategies(ctx, catalogue);
  for (const s of res.strategies) {
    if (s.feasible && s.proposedCrop) {
      assert.notEqual(s.proposedCrop, 'Chickpea (Gram)');
      assert.notEqual(s.proposedCrop, 'Wheat');
    }
    assert.ok(s.missingInformation.some((m) => m.toLowerCase().includes('soil')));
  }

  // PLATFORM_ADMIN role isolation: cannot access private farm owned by another user
  const signup = registerFarmerAccount(db, {
    email: 'privatefarmer@example.com',
    password: 'StrongPassword123',
    fullName: 'Private Farmer',
  });
  assert.equal(signup.ok, true);
  if (!signup.ok) return;

  db.prepare(`
    INSERT INTO farms (id, owner_user_id, organization_id, name, village, taluka, district, state, country, latitude, longitude, location_confirmed, agroclimatic_zone, university_reference, nearest_kvk, total_area_acres, is_demo, created_at, updated_at)
    VALUES ('farm-private-1', ?, NULL, 'Private Plot', 'Rahata', 'Rahata', 'Ahilyanagar', 'Maharashtra', 'India', 19.71, 74.48, 1, 'Maharashtra Scarcity Zone', 'MPKV Rahuri', 'KVK Babhaleshwar', 1.5, 0, datetime('now'), datetime('now'))
  `).run(signup.auth.userId);

  const platformAdminLogin = authenticateCredentials(
    db,
    'demo@khetpatch.org',
    'KhetPatch@Demo2026',
    'PLATFORM_ADMIN'
  );
  assert.equal(platformAdminLogin.ok, true);
  if (platformAdminLogin.ok) {
    assert.equal(canAccessFarm(db, platformAdminLogin.auth, 'farm-private-1'), false);
  }
});

test('processOverdueTasks marks past-due UPCOMING tasks OVERDUE idempotently and password reset updates non-demo password', () => {
  const db = getDb(':memory:');
  seedPlatformData(db);

  const demoFarm = db
    .prepare("SELECT owner_user_id FROM farms WHERE id = 'farm-demo-kopargaon'")
    .get() as { owner_user_id: string };

  // Create past-due UPCOMING task
  db.prepare(`
    INSERT INTO tasks (
      id, farm_id, field_id, assigned_user_id, crop_name, category, title, reason,
      rule_reference, due_date, priority, status, trigger_event, idempotency_key, created_at, updated_at
    ) VALUES ('task-past-due-1', 'farm-demo-kopargaon', 'field-demo-north', ?, 'Soybean', 'Irrigation', 'Past due irrigation check', 'Test reason', 'Test rule', '2020-01-01', 'High', 'UPCOMING', 'TEST', 'test-past-due-1', datetime('now'), datetime('now'))
  `).run(demoFarm.owner_user_id);

  const count1 = processOverdueTasks(db);
  assert.ok(count1 >= 1);
  const taskAfter = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-past-due-1') as { status: string };
  assert.equal(taskAfter.status, 'OVERDUE');

  // Second run must be idempotent
  const count2 = processOverdueTasks(db);
  assert.equal(count2, 0);

  // Notification created once
  const notifCount = db
    .prepare(`SELECT COUNT(*) as c FROM notifications WHERE idempotency_key = 'notif-overdue-task-past-due-1'`)
    .get() as { c: number };
  assert.equal(notifCount.c, 1);

  // Password reset protects demo user
  const demoReset = createPasswordResetToken(db, 'demo@khetpatch.org');
  assert.equal(demoReset.isDemo, true);
  assert.equal(demoReset.resetToken, null);

  // Password reset works end-to-end for regular registered farmer
  const signup = registerFarmerAccount(db, {
    email: 'resetfarmer@example.com',
    password: 'OldPassword123',
    fullName: 'Reset Farmer',
  });
  assert.equal(signup.ok, true);

  const reqToken = createPasswordResetToken(db, 'resetfarmer@example.com');
  assert.equal(reqToken.isDemo, false);
  assert.ok(reqToken.resetToken && reqToken.resetToken.length >= 16);

  const resetRes = completePasswordReset(db, reqToken.resetToken!, 'NewStrongPass456');
  assert.equal(resetRes.ok, true);

  // Old password rejected, new password accepted
  const oldAuth = authenticateCredentials(db, 'resetfarmer@example.com', 'OldPassword123', 'FARMER');
  assert.equal(oldAuth.ok, false);
  const newAuth = authenticateCredentials(db, 'resetfarmer@example.com', 'NewStrongPass456', 'FARMER');
  assert.equal(newAuth.ok, true);

  // Reusing same token fails
  const reuseRes = completePasswordReset(db, reqToken.resetToken!, 'AnotherPass789');
  assert.equal(reuseRes.ok, false);
});

import {
  getHeroMetricSummaries,
  getObservationDetailsForLocation,
} from '../intelligence/nasaConnectors';

test('getHeroMetricSummaries persists snapshots/timeseries and keeps NDVI null without GeoTIFF pixel extraction', () => {
  const db = getDb(':memory:');
  seedPlatformData(db);

  // Without location selected -> all values null (no fabricated defaults)
  const emptySummary = getHeroMetricSummaries(db);
  assert.equal(emptySummary.hasLocation, false);
  for (const m of emptySummary.metrics) {
    assert.equal(m.value, null);
  }

  // Insert real-shaped NASA POWER + Open-Meteo + Landsat scene records for Ludhiana (30.901, 75.857)
  const rLat = 30.901;
  const rLon = 75.857;
  const now = new Date().toISOString();
  const insObs = db.prepare(`
    INSERT INTO environmental_observations (
      id, latitude, longitude, source_id, dataset, product_version, variable, value, unit,
      spatial_resolution, observation_start, observation_end, retrieval_time, quality_status,
      quality_flags, granule_or_scene_id, source_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let d = 1; d <= 5; d++) {
    insObs.run(
      `rain-${d}`, rLat, rLon, 'NASA_POWER', 'POWER Daily', '2.0', 'PRECTOTCORR', d * 1.5, 'mm/day',
      '0.5 deg', `2026-11-0${d}T00:00:00Z`, `2026-11-0${d}T23:59:59Z`, now, 'AVAILABLE', 'VALID', null, 'https://power.larc.nasa.gov'
    );
    insObs.run(
      `temp-${d}`, rLat, rLon, 'NASA_POWER', 'POWER Daily', '2.0', 'T2M', 21.0 + d * 0.5, '°C',
      '0.5 deg', `2026-11-0${d}T00:00:00Z`, `2026-11-0${d}T23:59:59Z`, now, 'AVAILABLE', 'VALID', null, 'https://power.larc.nasa.gov'
    );
  }
  insObs.run(
    'soil-1', rLat, rLon, 'OPEN_METEO', 'ECMWF Surface', 'v1', 'SOIL_MOISTURE_0_1CM', 0.215, 'm³/m³',
    '9 km', '2026-11-05T06:00:00Z', '2026-11-05T06:00:00Z', now, 'AVAILABLE', 'MODEL_SOIL_SURFACE', null, 'https://api.open-meteo.com'
  );
  insObs.run(
    'ls-1', rLat, rLon, 'LANDSAT_C2', 'Landsat C2L2 SR', 'Collection 2', 'SCENE_DISCOVERY', null, 'scene',
    '30 m', '2026-11-02T05:10:00Z', '2026-11-02T05:10:00Z', now, 'SCENE_DISCOVERED', 'LANDSAT_8 cloudCover=1.2%', 'LC08_L2SP_148039_20261102', 'https://landsatlook.usgs.gov'
  );

  const populated = getHeroMetricSummaries(db, rLat, rLon);
  assert.equal(populated.hasLocation, true);

  const rain = populated.metrics.find((m) => m.metricKey === 'rainfall')!;
  const soil = populated.metrics.find((m) => m.metricKey === 'soil_moisture')!;
  const ndvi = populated.metrics.find((m) => m.metricKey === 'ndvi')!;
  const temp = populated.metrics.find((m) => m.metricKey === 'temperature')!;

  assert.equal(rain.value, 22.5);
  assert.equal(rain.series?.length, 5);
  assert.equal(soil.value, 0.215);
  assert.equal(temp.value, 23.5);
  assert.equal(ndvi.value, null);
  assert.equal(ndvi.granuleOrSceneId, 'LC08_L2SP_148039_20261102');

  const snapRows = db
    .prepare('SELECT metric_key, value FROM environmental_metric_snapshots WHERE latitude = ? AND longitude = ?')
    .all(rLat, rLon) as Array<{ metric_key: string; value: number | null }>;
  assert.equal(snapRows.length, 4);

  const details = getObservationDetailsForLocation(db, rLat, rLon);
  assert.ok(details.observations.length >= 12);
});

test('computeSpatialGridIds produces distinct deterministic grid cells across regions and prevents cross-location contamination', async () => {
  const db = getDb(':memory:');
  seedPlatformData(db);

  const kopGrid = computeSpatialGridIds(19.8825, 74.4789);
  const shirdiGrid = computeSpatialGridIds(19.7645, 74.4762);
  const ludhianaGrid = computeSpatialGridIds(30.901, 75.8573);

  assert.notEqual(kopGrid.gpmGridId, shirdiGrid.gpmGridId);
  assert.notEqual(kopGrid.gpmGridId, ludhianaGrid.gpmGridId);
  assert.notEqual(kopGrid.smapEaseGridId, ludhianaGrid.smapEaseGridId);
  assert.notEqual(kopGrid.powerGridId, ludhianaGrid.powerGridId);
  assert.ok(kopGrid.gpmDistanceM >= 0 && kopGrid.gpmDistanceM < 8500);
  assert.ok(kopGrid.smapDistanceM >= 0 && kopGrid.smapDistanceM < 7500);

  // Insert observations strictly for Kopargaon (19.8825, 74.4789)
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO environmental_observations (
      id, latitude, longitude, source_id, dataset, product_version, variable, value, unit,
      spatial_resolution, observation_start, observation_end, retrieval_time, quality_status,
      quality_flags, granule_or_scene_id, source_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'kop-temp-1', 19.883, 74.479, 'NASA_POWER', 'POWER Daily', '2.0', 'T2M', 28.4, '°C',
    '0.5 deg', '2026-11-05T00:00:00Z', '2026-11-05T23:59:59Z', now, 'AVAILABLE', 'VALID', null, 'https://power.larc.nasa.gov'
  );

  // Query Kopargaon with metadata -> returns value + gridCellId + pixelDistanceM
  const kopSummary = getHeroMetricSummaries(db, 19.8825, 74.4789, { locationType: 'FARM', farmId: 'farm-demo-kopargaon', fieldId: 'field-demo-north' });
  const kopTemp = kopSummary.metrics.find((m) => m.metricKey === 'temperature')!;
  assert.equal(kopTemp.value, 28.4);
  assert.equal(kopTemp.gridCellId, kopGrid.powerGridId);
  assert.equal(kopTemp.extractionMethod, 'POLYGON_BOUNDARY_AGGREGATE');

  // Verify nasa_observation_locations and metric_snapshots persisted cleanly
  const obsLocCount = db
    .prepare('SELECT COUNT(*) as c FROM nasa_observation_locations WHERE power_grid_id = ?')
    .get(kopGrid.powerGridId) as { c: number };
  assert.ok(obsLocCount.c >= 1);

  const metricSnapRows = db
    .prepare('SELECT metric_key FROM metric_snapshots WHERE location_type = ?')
    .all('FARM') as Array<{ metric_key: string }>;
  assert.equal(metricSnapRows.length, 4);

  // Query Shirdi (~13 km away, outside 0.015 deg tolerance) -> MUST NOT reuse Kopargaon temperature!
  const shirdiSummary = getHeroMetricSummaries(db, 19.7645, 74.4762, { locationType: 'DEVICE_LOCATION' });
  const shirdiTemp = shirdiSummary.metrics.find((m) => m.metricKey === 'temperature')!;
  assert.equal(shirdiTemp.value, null);
  assert.equal(shirdiTemp.extractionMethod, 'POINT_CELL_INTERSECT');

  // Reverse geocode null-preservation when upstream is unavailable/stubbed off
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('Simulated offline network');
  }) as unknown as typeof fetch;
  try {
    const rev = await reverseGeocodeCoordinates(db, {
      latitude: 19.7645,
      longitude: 74.4762,
      accuracy_meters: 18,
      captured_at: now,
    });
    assert.equal(rev.latitude, 19.7645);
    assert.equal(rev.longitude, 74.4762);
    assert.equal(rev.accuracy_meters, 18);
    assert.equal(rev.village, null);
    assert.equal(rev.taluka, null);
    assert.equal(rev.district, null);
    assert.equal(rev.resolved_address, null);
  } finally {
    globalThis.fetch = origFetch;
  }
});



