export type AppRole =
  | 'FARMER'
  | 'AGRONOMIST'
  | 'FPO_MANAGER'
  | 'ORGANIZATION_ADMIN'
  | 'PLATFORM_ADMIN';

export const ROLE_WORKSPACES: Record<AppRole, string> = {
  FARMER: '/farmer/home',
  AGRONOMIST: '/workspace/dashboard',
  FPO_MANAGER: '/organization/overview',
  ORGANIZATION_ADMIN: '/organization/admin',
  PLATFORM_ADMIN: '/platform/admin',
};

export const ROLE_META: Record<
  AppRole,
  { label: string; layoutName: string; description: string; route: string }
> = {
  FARMER: {
    label: 'Farmer Workspace',
    layoutName: 'FarmerLayout',
    description:
      'Manage farms, field boundaries, crop history, budgets, NASA observations, rotation plans, and tasks.',
    route: '/farmer/home',
  },
  AGRONOMIST: {
    label: 'Agronomist Workspace',
    layoutName: 'EnterpriseLayout',
    description:
      'Inspect farmer fields, validate environmental evidence, manage crop rules, and approve rotation plans.',
    route: '/workspace/dashboard',
  },
  FPO_MANAGER: {
    label: 'FPO Manager Workspace',
    layoutName: 'OrganizationLayout',
    description:
      'Oversee FPO farmer members, aggregate crop activities, follow-up compliance, and regional reports.',
    route: '/organization/overview',
  },
  ORGANIZATION_ADMIN: {
    label: 'Organization Admin Workspace',
    layoutName: 'OrganizationAdminLayout',
    description:
      'Manage organization users, invitations, permitted role assignments, and audit history.',
    route: '/organization/admin',
  },
  PLATFORM_ADMIN: {
    label: 'Platform Admin Workspace',
    layoutName: 'PlatformAdminLayout',
    description:
      'Monitor NASA/weather provider health, ingestion job pipelines, database status, and system audit logs.',
    route: '/platform/admin',
  },
};

export type SeasonType = 'Kharif' | 'Rabi' | 'Zaid' | 'Annual';
export type WaterAvailability = 'Rainfed' | 'Limited' | 'Irrigated';

export type DataFreshnessStatus =
  | 'Latest available'
  | 'Near real-time'
  | 'Recently updated'
  | 'Delayed source'
  | 'Cached observation'
  | 'Stale observation'
  | 'No suitable observation'
  | 'Provider unavailable'
  | 'Awaiting credentials';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface CropCatalogueItem {
  id: string;
  name: string;
  localNameMr: string;
  localNameHi: string;
  scientificName: string;
  cropFamily: string;
  suitableSeasons: SeasonType[];
  sowingWindow: string;
  durationDaysMin: number;
  durationDaysMax: number;
  waterNeedLevel: 'Low' | 'Moderate' | 'High';
  waterNeedMm: number;
  idealPhMin: number;
  idealPhMax: number;
  soilTypes: string[];
  rootDepth: 'Shallow' | 'Medium' | 'Deep';
  nitrogenFixer: boolean;
  rotationBreakSeasons: number;
  estimatedCostPerAcreInr: number | null;
  costBreakdownJson: string | null;
  referenceYieldQPerAcre: number | null;
  sourceReference: string;
  sourceYear: number;
  agroclimaticZones: string[];
  verifiedByExpert: boolean;
  typicalOperations: Array<{
    dayOffset: number;
    category: string;
    title: string;
    description: string;
    priority: 'Low' | 'Medium' | 'High';
  }>;
}

export interface EnvironmentalMetricSummary {
  metricKey: 'rainfall' | 'soil_moisture' | 'ndvi' | 'temperature';
  label: string;
  value: number | null;
  unit: string;
  provider: string;
  dataset: string;
  productVersion: string;
  spatialResolution: string;
  observationStart: string | null;
  observationEnd: string | null;
  retrievalTime: string | null;
  freshnessStatus: DataFreshnessStatus;
  qualityNote: string;
  sourceUrl: string;
  granuleOrSceneId?: string | null;
  requiresCredentials?: string | null;
  series?: Array<{ date: string; value: number }>;
  gridCellId?: string | null;
  extractionMethod?: string | null;
  pixelDistanceM?: number | null;
  sensor?: string | null;
  ageHours?: number | null;
  wrsPathRow?: string | null;
}

export interface ReverseGeocodeResult {
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
  captured_at: string;
  village: string | null;
  taluka: string | null;
  district: string | null;
  state: string | null;
  country: string | null;
  timezone: string | null;
  resolved_address: string | null;
  resolution_source: string | null;
}

export type SelectedLocationType = 'DEVICE_LOCATION' | 'FARM' | 'FIELD' | 'MANUAL' | 'SHOWCASE' | 'NONE';

export interface ActiveLocationContext {
  selected: boolean;
  locationType: SelectedLocationType;
  label: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters?: number | null;
  captured_at?: string | null;
  farmId?: string | null;
  farmName?: string | null;
  fieldId?: string | null;
  fieldName?: string | null;
  village?: string | null;
  taluka?: string | null;
  district?: string | null;
  state?: string | null;
  country?: string | null;
  timezone?: string | null;
  resolved_address?: string | null;
  resolution_source?: string | null;
  isShowcase?: boolean;
}

export interface FarmDecisionContext {
  contextVersion: string;
  contextId: string;
  generatedAt: string;
  farmerId: string;
  farmId: string;
  fieldId: string;
  planningSeason: SeasonType;
  geography: {
    latitude: number;
    longitude: number;
    locationConfirmed: boolean;
    village: string;
    taluka: string;
    district: string;
    state: string;
    country: string;
    agroclimaticZone: string;
    universityReference: string;
    nearestKvk: string;
    nearestMarkets: string[];
    fieldAreaAcres: number;
    fieldAreaHectares: number;
  };
  farmerRequirements: {
    maxBudgetInr: number | null;
    budgetPerAcreInr: number | null;
    waterAvailability: WaterAvailability;
    irrigationType: string;
    riskTolerance: 'Low' | 'Moderate' | 'High';
    preferredCrops: string[];
    avoidCrops: string[];
    priorityFocus: 'Lower Cost' | 'Soil Health' | 'Balanced' | 'Water Saving';
    laborAvailability: string;
    machineryAccess: string;
    targetPlantingDate?: string | null;
  };
  fieldHistory: {
    currentCrop: string | null;
    previousCrops: Array<{
      cropName: string;
      cropFamily: string;
      season: string;
      year: number;
      plantingDate: string | null;
      harvestDate: string | null;
    }>;
    acceptedPlansCount: number;
  };
  soilProfile: {
    soilType: string | null;
    ph: number | null;
    organicCarbonPct: number | null;
    nitrogenKgHa: number | null;
    phosphorusKgHa: number | null;
    potassiumKgHa: number | null;
    ecDsM: number | null;
    sourceLabel: 'Lab Measured' | 'Farmer Entered' | 'Missing';
    sampleDate: string | null;
    labName: string | null;
  };
  weatherContext: {
    recent7dRainfallMm: number | null;
    recent30dRainfallMm: number | null;
    forecast7dRainfallMm: number | null;
    meanTempC: number | null;
    maxTempC: number | null;
    consecutiveDryDays: number | null;
    et0MeanMmDay: number | null;
    sourceProvider: string;
    observationTimestamp: string | null;
    imdWarningStatus: string;
  };
  nasaObservations: {
    powerAvailable: boolean;
    gpmGranuleId: string | null;
    smapGranuleId: string | null;
    landsatSceneId: string | null;
    soilMoistureSurface: number | null;
    ndviLatest: number | null;
    dataGaps: string[];
  };
  marketContext: {
    availablePrices: Array<{
      commodity: string;
      market: string;
      district: string;
      modalPriceInrPerQuintal: number;
      arrivalDate: string;
      sourceType: 'AGMARKNET' | 'FARMER_QUOTE' | 'DEMO_DATA';
    }>;
  };
  missingInformation: string[];
  evidenceReferences: string[];
}

export interface StrategyEvaluation {
  strategyType: 'EXISTING' | 'MINIMAL_CHANGE' | 'ALTERNATIVE';
  title: string;
  feasible: boolean;
  proposedCrop: string | null;
  cropFamily: string | null;
  sowingWindow: string | null;
  durationDays: string | null;
  estimatedTotalCostInr: number | null;
  estimatedCostPerAcreInr: number | null;
  costBreakdown?: {
    seeds: number;
    landPrep: number;
    fertilizer: number;
    irrigation: number;
    laborAndHarvest: number;
  } | null;
  budgetFits: boolean | null;
  remainingBudgetInr: number | null;
  indicativeGrossRevenueInr: number | null;
  indicativeMarginInr: number | null;
  waterCompatibility: string;
  soilStewardshipNote: string;
  hardConstraintsPassed: string[];
  hardConstraintsFailed: string[];
  softTradeOffs: string[];
  missingInformation: string[];
  evidenceUsed: string[];
  rationale: string;
  unavailableReason: string | null;
}

export interface RotationAnalysisResult {
  analysisId: string;
  contextId: string;
  contextVersion: string;
  algorithmVersion: string;
  generatedAt: string;
  planningSeason: SeasonType;
  strategies: StrategyEvaluation[];
}
