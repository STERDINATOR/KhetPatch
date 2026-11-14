-- KhetPatch Production PostgreSQL + PostGIS Schema Blueprint
-- Compatible with Supabase Managed PostgreSQL

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'FPO',
  district TEXT NOT NULL,
  state TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'India',
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('FARMER','AGRONOMIST','FPO_MANAGER','ORGANIZATION_ADMIN','PLATFORM_ADMIN')),
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  granted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, role, organization_id)
);

CREATE TABLE IF NOT EXISTS farms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  village TEXT NOT NULL,
  taluka TEXT NOT NULL,
  district TEXT NOT NULL,
  state TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'India',
  location GEOGRAPHY(Point, 4326) NOT NULL,
  agroclimatic_zone TEXT NOT NULL,
  university_reference TEXT NOT NULL,
  total_area_acres NUMERIC(10, 3) NOT NULL,
  water_availability TEXT NOT NULL DEFAULT 'Limited',
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fields (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  boundary GEOGRAPHY(Polygon, 4326) NOT NULL,
  area_acres NUMERIC(10, 3) NOT NULL,
  area_hectares NUMERIC(10, 3) NOT NULL,
  soil_type TEXT,
  current_crop TEXT,
  previous_crop TEXT,
  water_availability TEXT DEFAULT 'Limited',
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farms_geo ON farms USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_fields_geo ON fields USING GIST (boundary);

CREATE TABLE IF NOT EXISTS environmental_observations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farm_id UUID REFERENCES farms(id) ON DELETE SET NULL,
  field_id UUID REFERENCES fields(id) ON DELETE SET NULL,
  location GEOGRAPHY(Point, 4326) NOT NULL,
  source_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  product_version TEXT NOT NULL,
  variable TEXT NOT NULL,
  value DOUBLE PRECISION,
  unit TEXT NOT NULL,
  spatial_resolution TEXT NOT NULL,
  observation_start TIMESTAMPTZ NOT NULL,
  observation_end TIMESTAMPTZ NOT NULL,
  retrieval_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  quality_status TEXT NOT NULL,
  granule_or_scene_id TEXT,
  source_url TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_env_obs_time ON environmental_observations(source_id, variable, observation_start DESC);
