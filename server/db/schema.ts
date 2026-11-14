import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let dbInstance: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (dbInstance && !dbPath) return dbInstance;

  const targetPath =
    dbPath || process.env.KHETPATCH_DB_PATH || path.resolve(process.cwd(), 'data', 'khetpatch.db');

  if (targetPath !== ':memory:') {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);

  if (!dbPath) {
    dbInstance = db;
  }
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'FPO',
      district TEXT NOT NULL,
      state TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'India',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT,
      preferred_language TEXT NOT NULL DEFAULT 'en',
      email_verified INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('FARMER','AGRONOMIST','FPO_MANAGER','ORGANIZATION_ADMIN','PLATFORM_ADMIN')),
      organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      is_demo INTEGER NOT NULL DEFAULT 0,
      granted_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, role, organization_id)
    );

    CREATE TABLE IF NOT EXISTS user_invitations (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invited_by TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      active_role TEXT NOT NULL,
      active_org_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS farms (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      village TEXT NOT NULL,
      taluka TEXT NOT NULL,
      district TEXT NOT NULL,
      state TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'India',
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      coordinate_crs TEXT NOT NULL DEFAULT 'EPSG:4326',
      location_accuracy_m REAL,
      location_method TEXT NOT NULL DEFAULT 'MAP_PIN',
      location_confirmed INTEGER NOT NULL DEFAULT 1,
      agroclimatic_zone TEXT NOT NULL,
      university_reference TEXT NOT NULL,
      nearest_kvk TEXT NOT NULL,
      total_area_acres REAL NOT NULL,
      farming_system TEXT NOT NULL DEFAULT 'Mixed Crop',
      irrigation_source TEXT NOT NULL DEFAULT 'Borewell + Rainfed',
      water_availability TEXT NOT NULL DEFAULT 'Limited',
      archived INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fields (
      id TEXT PRIMARY KEY,
      farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      geometry_geojson TEXT NOT NULL,
      centroid_lat REAL NOT NULL,
      centroid_lon REAL NOT NULL,
      area_acres REAL NOT NULL,
      area_hectares REAL NOT NULL,
      soil_type TEXT,
      current_crop TEXT,
      previous_crop TEXT,
      planting_date TEXT,
      expected_harvest_date TEXT,
      irrigation_method TEXT DEFAULT 'Furrow / Drip',
      water_availability TEXT DEFAULT 'Limited',
      notes TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crop_history (
      id TEXT PRIMARY KEY,
      field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
      crop_name TEXT NOT NULL,
      crop_family TEXT NOT NULL,
      season TEXT NOT NULL,
      year INTEGER NOT NULL,
      planting_date TEXT,
      harvest_date TEXT,
      yield_q_per_acre REAL,
      pest_disease_notes TEXT,
      fertilizer_irrigation_notes TEXT,
      farmer_feedback TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS soil_tests (
      id TEXT PRIMARY KEY,
      field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
      source_label TEXT NOT NULL DEFAULT 'Farmer Entered',
      lab_name TEXT,
      sample_date TEXT,
      ph REAL,
      ec_ds_m REAL,
      organic_carbon_pct REAL,
      nitrogen_kg_ha REAL,
      phosphorus_kg_ha REAL,
      potassium_kg_ha REAL,
      zinc_ppm REAL,
      boron_ppm REAL,
      report_filename TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS farmer_requirements (
      id TEXT PRIMARY KEY,
      farmer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
      max_budget_inr REAL,
      budget_per_acre_inr REAL,
      water_availability TEXT NOT NULL DEFAULT 'Limited',
      risk_tolerance TEXT NOT NULL DEFAULT 'Moderate',
      priority_focus TEXT NOT NULL DEFAULT 'Balanced',
      preferred_crops_json TEXT NOT NULL DEFAULT '[]',
      avoid_crops_json TEXT NOT NULL DEFAULT '[]',
      labor_availability TEXT NOT NULL DEFAULT 'Family + Seasonal Hired',
      machinery_access TEXT NOT NULL DEFAULT 'Rented Tractor',
      updated_at TEXT NOT NULL,
      UNIQUE(field_id)
    );

    CREATE TABLE IF NOT EXISTS crop_catalogue (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      local_name_mr TEXT NOT NULL,
      local_name_hi TEXT NOT NULL,
      scientific_name TEXT NOT NULL,
      crop_family TEXT NOT NULL,
      suitable_seasons_json TEXT NOT NULL,
      sowing_window TEXT NOT NULL,
      duration_days_min INTEGER NOT NULL,
      duration_days_max INTEGER NOT NULL,
      water_need_level TEXT NOT NULL,
      water_need_mm INTEGER NOT NULL,
      ideal_ph_min REAL NOT NULL,
      ideal_ph_max REAL NOT NULL,
      soil_types_json TEXT NOT NULL,
      root_depth TEXT NOT NULL,
      nitrogen_fixer INTEGER NOT NULL DEFAULT 0,
      rotation_break_seasons INTEGER NOT NULL DEFAULT 1,
      estimated_cost_per_acre_inr REAL,
      cost_breakdown_json TEXT,
      reference_yield_q_per_acre REAL,
      source_reference TEXT NOT NULL,
      source_year INTEGER NOT NULL,
      agroclimatic_zones_json TEXT NOT NULL,
      verified_by_expert INTEGER NOT NULL DEFAULT 1,
      typical_operations_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS data_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      product_code TEXT NOT NULL,
      spatial_resolution TEXT NOT NULL,
      temporal_cadence TEXT NOT NULL,
      requires_credential TEXT,
      docs_url TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_health (
      source_id TEXT PRIMARY KEY REFERENCES data_sources(id),
      status TEXT NOT NULL,
      last_checked_at TEXT,
      last_success_at TEXT,
      latest_observation_at TEXT,
      records_processed INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      credential_configured INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS data_ingestion_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES data_sources(id),
      farm_id TEXT,
      field_id TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      records_processed INTEGER NOT NULL DEFAULT 0,
      latest_observation_at TEXT,
      error_message TEXT,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS environmental_observations (
      id TEXT PRIMARY KEY,
      farm_id TEXT,
      field_id TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      source_id TEXT NOT NULL REFERENCES data_sources(id),
      dataset TEXT NOT NULL,
      product_version TEXT NOT NULL,
      variable TEXT NOT NULL,
      value REAL,
      unit TEXT NOT NULL,
      spatial_resolution TEXT NOT NULL,
      observation_start TEXT NOT NULL,
      observation_end TEXT NOT NULL,
      publication_time TEXT,
      retrieval_time TEXT NOT NULL,
      quality_status TEXT NOT NULL,
      quality_flags TEXT,
      granule_or_scene_id TEXT,
      source_url TEXT NOT NULL,
      UNIQUE(latitude, longitude, source_id, variable, observation_start, observation_end)
    );

    CREATE TABLE IF NOT EXISTS market_prices (
      id TEXT PRIMARY KEY,
      commodity TEXT NOT NULL,
      variety TEXT,
      state TEXT NOT NULL,
      district TEXT NOT NULL,
      market TEXT NOT NULL,
      arrival_date TEXT NOT NULL,
      min_price REAL NOT NULL,
      max_price REAL NOT NULL,
      modal_price REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'INR/Quintal',
      source_type TEXT NOT NULL,
      retrieval_time TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS decision_contexts (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      farmer_id TEXT NOT NULL,
      farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
      planning_season TEXT NOT NULL,
      context_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rotation_plans (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL REFERENCES decision_contexts(id),
      farmer_id TEXT NOT NULL,
      farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
      planning_season TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      selected_strategy_type TEXT,
      selected_crop TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      expert_review_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
      expert_reviewer_id TEXT,
      expert_notes TEXT,
      reviewed_at TEXT,
      strategies_json TEXT NOT NULL,
      reassessment_needed INTEGER NOT NULL DEFAULT 0,
      reassessment_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
      plan_id TEXT REFERENCES rotation_plans(id) ON DELETE SET NULL,
      assigned_user_id TEXT NOT NULL,
      crop_name TEXT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      reason TEXT NOT NULL,
      rule_reference TEXT NOT NULL,
      due_date TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'Medium',
      status TEXT NOT NULL DEFAULT 'UPCOMING',
      trigger_event TEXT NOT NULL DEFAULT 'PLAN_APPROVED',
      evidence_json TEXT,
      farmer_feedback TEXT,
      completed_at TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
      field_id TEXT REFERENCES fields(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      actor_user_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      farm_id TEXT,
      field_id TEXT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'Normal',
      category TEXT NOT NULL,
      evidence_ref TEXT,
      read_flag INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      farm_id TEXT,
      field_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      context_id TEXT,
      evidence_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS landing_locations (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      location_method TEXT NOT NULL DEFAULT 'SEARCH',
      is_showcase INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS environmental_metric_snapshots (
      id TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      metric_key TEXT NOT NULL,
      value REAL,
      unit TEXT NOT NULL,
      provider TEXT NOT NULL,
      dataset TEXT NOT NULL,
      product_version TEXT NOT NULL,
      spatial_resolution TEXT NOT NULL,
      observation_start TEXT,
      observation_end TEXT,
      retrieval_time TEXT,
      freshness_status TEXT NOT NULL,
      quality_status TEXT NOT NULL,
      quality_note TEXT,
      granule_or_scene_id TEXT,
      source_url TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(latitude, longitude, metric_key)
    );

    CREATE TABLE IF NOT EXISTS environmental_timeseries (
      id TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      metric_key TEXT NOT NULL,
      point_date TEXT NOT NULL,
      value REAL,
      source_id TEXT NOT NULL,
      retrieval_time TEXT NOT NULL,
      UNIQUE(latitude, longitude, metric_key, point_date)
    );

    CREATE TABLE IF NOT EXISTS user_location_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE,
      session_key TEXT UNIQUE,
      allow_auto_detect INTEGER NOT NULL DEFAULT 0,
      preferred_source TEXT NOT NULL DEFAULT 'FARM',
      active_farm_id TEXT,
      active_field_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS detected_locations (
      id TEXT PRIMARY KEY,
      session_key TEXT,
      user_id TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      accuracy_meters REAL,
      captured_at TEXT NOT NULL,
      permission_status TEXT NOT NULL,
      resolved_address TEXT,
      village TEXT,
      taluka TEXT,
      district TEXT,
      state TEXT,
      country TEXT,
      timezone TEXT,
      resolution_source TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS selected_location_contexts (
      id TEXT PRIMARY KEY,
      session_key TEXT UNIQUE,
      user_id TEXT UNIQUE,
      location_type TEXT NOT NULL CHECK(location_type IN ('DEVICE_LOCATION','FARM','FIELD','MANUAL','SHOWCASE')),
      farm_id TEXT,
      field_id TEXT,
      label TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      accuracy_meters REAL,
      captured_at TEXT,
      resolved_address TEXT,
      village TEXT,
      taluka TEXT,
      district TEXT,
      state TEXT,
      country TEXT,
      timezone TEXT,
      resolution_source TEXT,
      is_confirmed_farm INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS location_resolution_records (
      id TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      accuracy_meters REAL,
      village TEXT,
      taluka TEXT,
      district TEXT,
      state TEXT,
      country TEXT,
      timezone TEXT,
      resolved_address TEXT,
      resolution_source TEXT,
      captured_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nasa_observation_locations (
      id TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      location_type TEXT NOT NULL,
      farm_id TEXT,
      field_id TEXT,
      gpm_grid_id TEXT NOT NULL,
      smap_ease_grid_id TEXT NOT NULL,
      power_grid_id TEXT NOT NULL,
      landsat_path_row TEXT,
      last_synced_at TEXT,
      UNIQUE(latitude, longitude, location_type)
    );

    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id TEXT PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      location_type TEXT NOT NULL,
      farm_id TEXT,
      field_id TEXT,
      metric_key TEXT NOT NULL,
      value REAL,
      unit TEXT NOT NULL,
      provider TEXT NOT NULL,
      product_version TEXT NOT NULL,
      grid_cell_id TEXT,
      native_resolution TEXT NOT NULL,
      extraction_method TEXT NOT NULL,
      pixel_distance_m REAL,
      observation_time TEXT,
      retrieval_time TEXT,
      quality_status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(latitude, longitude, location_type, metric_key)
    );

    CREATE INDEX IF NOT EXISTS idx_obs_coords_var ON environmental_observations(latitude, longitude, variable, observation_start);
    CREATE INDEX IF NOT EXISTS idx_farms_owner ON farms(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_fields_farm ON fields(farm_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_field ON tasks(field_id, status);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_flag);
    CREATE INDEX IF NOT EXISTS idx_snapshot_coords ON environmental_metric_snapshots(latitude, longitude);
    CREATE INDEX IF NOT EXISTS idx_loc_res_coords ON location_resolution_records(latitude, longitude);
  `);

  const reqCols = db.prepare('PRAGMA table_info(farmer_requirements)').all() as Array<{ name: string }>;
  if (!reqCols.some((c) => c.name === 'target_planting_date')) {
    db.exec('ALTER TABLE farmer_requirements ADD COLUMN target_planting_date TEXT');
  }
}
