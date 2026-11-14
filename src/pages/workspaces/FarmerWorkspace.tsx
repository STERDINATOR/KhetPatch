import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Calendar,
  CheckCircle2,
  CloudRain,
  Compass,
  FlaskConical,
  IndianRupee,
  Layers,
  LayoutDashboard,
  MapPin,
  Plus,
  RefreshCw,
  Satellite,
  Send,
  Sprout,
  Wallet,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { WorkspaceShell, type WorkspaceNavItem } from '../../components/WorkspaceShell';
import { FieldMap } from '../../components/FieldMap';
import { apiFetch } from '../../lib/api';
import { useLocationContext } from '../../context/LocationContext';
import {
  subscribeFirebaseAuth,
  syncFarmRecordToFirestore,
  syncFieldRecordToFirestore,
  syncRotationPlanToFirestore,
  syncTaskToFirestore,
} from '../../lib/firebase';
import type { AuthenticatedContext } from '../../../server/auth/authService';
import type {
  AppRole,
  EnvironmentalMetricSummary,
  FarmDecisionContext,
  RotationAnalysisResult,
  SeasonType,
  StrategyEvaluation,
  WaterAvailability,
} from '../../../shared/types';

interface FieldRecord {
  id: string;
  farm_id: string;
  name: string;
  geometry_geojson: string;
  centroid_lat: number;
  centroid_lon: number;
  area_acres: number;
  area_hectares: number;
  soil_type: string | null;
  current_crop: string | null;
  previous_crop: string | null;
  water_availability: WaterAvailability;
  notes: string | null;
}

interface FarmRecord {
  id: string;
  name: string;
  village: string;
  taluka: string;
  district: string;
  state: string;
  latitude: number;
  longitude: number;
  agroclimatic_zone: string;
  university_reference: string;
  nearest_kvk: string;
  total_area_acres: number;
  water_availability: WaterAvailability;
  is_demo: number;
  fields: FieldRecord[];
}

interface FieldDetailsResponse {
  farm: FarmRecord;
  field: FieldRecord;
  history: Array<{
    id: string;
    crop_name: string;
    crop_family: string;
    season: string;
    year: number;
    planting_date: string | null;
    harvest_date: string | null;
    pest_disease_notes: string | null;
  }>;
  soilTests: Array<{
    id: string;
    source_label: string;
    lab_name: string | null;
    sample_date: string | null;
    ph: number | null;
    organic_carbon_pct: number | null;
    nitrogen_kg_ha: number | null;
    phosphorus_kg_ha: number | null;
    potassium_kg_ha: number | null;
  }>;
  requirements: {
    max_budget_inr: number | null;
    water_availability: WaterAvailability;
    risk_tolerance: 'Low' | 'Moderate' | 'High';
    priority_focus: 'Lower Cost' | 'Soil Health' | 'Balanced' | 'Water Saving';
    preferred_crops_json: string;
    avoid_crops_json: string;
    target_planting_date?: string | null;
  } | null;
  plans: Array<{
    id: string;
    planning_season: SeasonType;
    status: string;
    selected_strategy_type: string | null;
    selected_crop: string | null;
    expert_review_status: string;
    expert_notes: string | null;
    strategies_json: string;
    reassessment_needed: number;
    reassessment_reason: string | null;
    created_at: string;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    category: string;
    reason: string;
    due_date: string;
    priority: string;
    status: string;
    trigger_event: string;
    farmer_feedback: string | null;
  }>;
  timeline: Array<{
    id: string;
    event_type: string;
    title: string;
    description: string;
    created_at: string;
  }>;
}

export function FarmerWorkspace({
  user,
  lang = 'en',
  onChangeLang,
  onSwitchRole,
  onNavigateHome,
  onLogout,
}: {
  user: AuthenticatedContext;
  lang?: 'en' | 'hi' | 'mr';
  onChangeLang?: (lang: 'en' | 'hi' | 'mr') => void;
  onSwitchRole: (role: AppRole) => Promise<void>;
  onNavigateHome: () => void;
  onLogout: () => void;
}) {
  const {
    context: globalLocation,
    detected: globalDetected,
    selectFarmOrField,
    switchToDeviceLocation,
  } = useLocationContext();

  const [activeTab, setActiveTab] = useState('overview');
  const [farms, setFarms] = useState<FarmRecord[]>([]);
  const [selectedFarmId, setSelectedFarmId] = useState<string>('');
  const [selectedFieldId, setSelectedFieldId] = useState<string>('');
  const [fieldDetails, setFieldDetails] = useState<FieldDetailsResponse | null>(null);
  const [obsData, setObsData] = useState<{
    metrics: EnvironmentalMetricSummary[];
    observations: Array<{ variable: string; value: number | null; observation_start: string; source_id: string }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBanner, setActionBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Farm creation & location edit state
  const [showNewFarm, setShowNewFarm] = useState(false);
  const [showEditFarm, setShowEditFarm] = useState(false);
  const [farmSearchQuery, setFarmSearchQuery] = useState('');
  const [farmSearchResults, setFarmSearchResults] = useState<
    Array<{ label: string; village: string; taluka: string; district: string; state: string; lat: number; lon: number }>
  >([]);
  const [farmForm, setFarmForm] = useState({
    name: '',
    village: '',
    taluka: '',
    district: 'Ahilyanagar',
    state: 'Maharashtra',
    latitude: 19.8825,
    longitude: 74.4789,
    locationMethod: 'MAP_PIN' as 'GEOLOCATION' | 'MAP_PIN' | 'SEARCH' | 'MANUAL_COORDS',
    locationConfirmed: false,
    totalAreaAcres: 2.0,
    waterAvailability: 'Limited' as WaterAvailability,
  });
  const [editFarmForm, setEditFarmForm] = useState({
    village: '',
    district: '',
    state: '',
    latitude: 19.8825,
    longitude: 74.4789,
    waterAvailability: 'Limited' as WaterAvailability,
    locationMethod: 'MAP_PIN' as 'GEOLOCATION' | 'MAP_PIN' | 'SEARCH' | 'MANUAL_COORDS',
    locationConfirmed: false,
  });

  // Field creation & polygon drawing state
  const [showNewField, setShowNewField] = useState(false);
  const [drawnPolygon, setDrawnPolygon] = useState<Array<[number, number]>>([]);
  const [fieldForm, setFieldForm] = useState({
    name: '',
    targetAcres: 2.0,
    soilType: 'Medium Black',
    currentCrop: 'Soybean',
    previousCrop: 'Wheat',
    waterAvailability: 'Limited' as WaterAvailability,
  });

  // History & Soil forms
  const [histForm, setHistForm] = useState({
    cropName: 'Soybean',
    cropFamily: 'Fabaceae (Legume)',
    season: 'Kharif' as SeasonType,
    year: 2026,
    pestDiseaseNotes: '',
    setAsCurrent: true,
  });
  const [soilForm, setSoilForm] = useState({
    sourceLabel: 'Lab Measured' as 'Lab Measured' | 'Farmer Entered',
    labName: '',
    sampleDate: new Date().toISOString().slice(0, 10),
    ph: '7.1',
    organicCarbonPct: '0.58',
    nitrogenKgHa: '220',
    phosphorusKgHa: '18',
    potassiumKgHa: '290',
  });

  // Requirements & Budget form
  const [reqForm, setReqForm] = useState({
    maxBudgetInr: '42000',
    waterAvailability: 'Limited' as WaterAvailability,
    riskTolerance: 'Moderate' as 'Low' | 'Moderate' | 'High',
    priorityFocus: 'Balanced' as 'Lower Cost' | 'Soil Health' | 'Balanced' | 'Water Saving',
    preferredCropsText: 'Chickpea (Gram), Wheat',
    avoidCropsText: '',
    targetPlantingDate: '',
  });

  // Rotation planner state
  const [planningSeason, setPlanningSeason] = useState<SeasonType>('Rabi');
  const [runningPlanner, setRunningPlanner] = useState(false);
  const [latestRun, setLatestRun] = useState<{
    context: FarmDecisionContext;
    analysis: RotationAnalysisResult;
    planId: string;
  } | null>(null);

  // Tasks feedback & postpone state
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [taskFeedback, setTaskFeedback] = useState('');
  const [postponingTaskId, setPostponingTaskId] = useState<string | null>(null);
  const [postponeDate, setPostponeDate] = useState(
    new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
  );
  const [postponeReason, setPostponeReason] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDue, setNewTaskDue] = useState(new Date().toISOString().slice(0, 10));

  // AI Assistant state
  const [chatHistory, setChatHistory] = useState<
    Array<{ id: string; role: 'user' | 'assistant'; content: string; evidence_json?: string; created_at: string }>
  >([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  // NASA Refresh loading
  const [refreshingNasa, setRefreshingNasa] = useState(false);
  const [firebaseSignedIn, setFirebaseSignedIn] = useState(false);

  useEffect(() => {
    const unsub = subscribeFirebaseAuth((fbUser) => {
      setFirebaseSignedIn(Boolean(fbUser && fbUser.emailVerified));
    });
    return () => unsub();
  }, []);

  const navItems: WorkspaceNavItem[] = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'farms', label: 'My Farms & Fields', icon: MapPin },
    { id: 'history', label: 'Crop History & Soil', icon: FlaskConical },
    { id: 'budget', label: 'Budget & Priorities', icon: Wallet },
    { id: 'planner', label: 'Rotation Planner', icon: Sprout },
    { id: 'environment', label: 'NASA & Weather', icon: Satellite },
    { id: 'followups', label: 'Tasks & Timeline', icon: Calendar },
    { id: 'assistant', label: 'AI Farm Assistant', icon: Bot },
  ];

  const loadFarms = async (preferFarmId?: string, preferFieldId?: string) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ farms: FarmRecord[] }>('/farms');
      setFarms(res.farms);
      const targetFarm =
        res.farms.find((f) => f.id === (preferFarmId || selectedFarmId)) || res.farms[0];
      if (targetFarm) {
        setSelectedFarmId(targetFarm.id);
        const targetField =
          targetFarm.fields.find((fl) => fl.id === (preferFieldId || selectedFieldId)) ||
          targetFarm.fields[0];
        setSelectedFieldId(targetField ? targetField.id : '');
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Unable to load farms.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFarms();
  }, []);

  const loadFieldContext = async (farmId: string, fieldId: string) => {
    if (!farmId || !fieldId) {
      setFieldDetails(null);
      return;
    }
    try {
      const [details, obs, chat] = await Promise.all([
        apiFetch<FieldDetailsResponse>(`/fields/${fieldId}/details`),
        apiFetch<{
          metrics: EnvironmentalMetricSummary[];
          observations: Array<{ variable: string; value: number | null; observation_start: string; source_id: string }>;
        }>(`/nasa/observations?farmId=${farmId}&fieldId=${fieldId}`),
        apiFetch<{
          messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; evidence_json?: string; created_at: string }>;
        }>(`/assistant/history?fieldId=${fieldId}`),
      ]);
      setFieldDetails(details);
      setObsData(obs);
      setChatHistory(chat.messages);

      if (details.requirements) {
        setReqForm({
          maxBudgetInr: details.requirements.max_budget_inr ? String(details.requirements.max_budget_inr) : '',
          waterAvailability: details.requirements.water_availability,
          riskTolerance: details.requirements.risk_tolerance,
          priorityFocus: details.requirements.priority_focus,
          preferredCropsText: JSON.parse(details.requirements.preferred_crops_json || '[]').join(', '),
          avoidCropsText: JSON.parse(details.requirements.avoid_crops_json || '[]').join(', '),
          targetPlantingDate: details.requirements.target_planting_date || '',
        });
      }
      if (details.farm) {
        setEditFarmForm({
          village: details.farm.village,
          district: details.farm.district,
          state: details.farm.state,
          latitude: details.farm.latitude,
          longitude: details.farm.longitude,
          waterAvailability: details.farm.water_availability,
          locationMethod: 'MAP_PIN',
          locationConfirmed: true,
        });
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Unable to load field details.');
    }
  };

  useEffect(() => {
    if (selectedFarmId && selectedFieldId) {
      loadFieldContext(selectedFarmId, selectedFieldId);
    }
  }, [selectedFarmId, selectedFieldId]);

  const currentFarm = farms.find((f) => f.id === selectedFarmId) || null;
  const currentField = currentFarm?.fields.find((fl) => fl.id === selectedFieldId) || null;

  const handleUseDeviceGps = () => {
    if (!navigator.geolocation) {
      setErrorBanner('Geolocation unavailable in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setFarmForm((prev) => ({
          ...prev,
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
          locationMethod: 'GEOLOCATION',
        }));
        setActionBanner(
          `Captured device GPS (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(
            4
          )}). Please verify this represents your farm and tick confirmation.`
        );
      },
      () => setErrorBanner('Location permission declined. Click on the map or enter coordinates manually.')
    );
  };

  const handleSearchFarmLocation = async () => {
    if (!farmSearchQuery.trim()) return;
    setErrorBanner(null);
    try {
      const res = await apiFetch<{
        results: Array<{ label: string; village: string; taluka: string; district: string; state: string; lat: number; lon: number }>;
      }>(`/location/search?q=${encodeURIComponent(farmSearchQuery.trim())}`);
      setFarmSearchResults(res.results || []);
      if (!res.results || res.results.length === 0) {
        setErrorBanner('No matching village or district found. Try clicking the map or entering Lat/Lon directly.');
      }
    } catch {
      setErrorBanner('Location search failed.');
    }
  };

  const handleCreateFarm = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner(null);
    setActionBanner(null);
    try {
      const res = await apiFetch<{ farm: FarmRecord }>('/farms', {
        method: 'POST',
        body: JSON.stringify(farmForm),
      });
      if (firebaseSignedIn) {
        void syncFarmRecordToFirestore({
          id: res.farm.id,
          name: res.farm.name,
          village: res.farm.village,
          district: res.farm.district,
          state: res.farm.state,
          latitude: res.farm.latitude,
          longitude: res.farm.longitude,
          agroclimaticZone: res.farm.agroclimatic_zone,
          totalAreaAcres: res.farm.total_area_acres,
          waterAvailability: res.farm.water_availability,
        }).catch(() => {});
      }
      setShowNewFarm(false);
      setActionBanner(`Farm "${res.farm.name}" registered and agroclimatic zone resolved.`);
      await loadFarms(res.farm.id);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to create farm.');
    }
  };

  const handleUpdateFarmLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentFarm) return;
    setErrorBanner(null);
    try {
      const res = await apiFetch<{ farm: FarmRecord }>(`/farms/${currentFarm.id}`, {
        method: 'PATCH',
        body: JSON.stringify(editFarmForm),
      });
      if (firebaseSignedIn) {
        void syncFarmRecordToFirestore({
          id: res.farm.id,
          name: res.farm.name,
          village: res.farm.village,
          district: res.farm.district,
          state: res.farm.state,
          latitude: res.farm.latitude,
          longitude: res.farm.longitude,
          agroclimaticZone: res.farm.agroclimatic_zone,
          totalAreaAcres: res.farm.total_area_acres,
          waterAvailability: res.farm.water_availability,
        }).catch(() => {});
      }
      setShowEditFarm(false);
      setActionBanner(`Farm location & agroclimatic zone updated. Existing plans marked for reassessment.`);
      await loadFarms(currentFarm.id, selectedFieldId);
      if (selectedFieldId) await loadFieldContext(currentFarm.id, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to update farm.');
    }
  };

  const handleCreateField = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFarmId) return;
    setErrorBanner(null);
    try {
      const res = await apiFetch<{ field: FieldRecord }>('/fields', {
        method: 'POST',
        body: JSON.stringify({
          farmId: selectedFarmId,
          name: fieldForm.name,
          polygonCoordinates: drawnPolygon.length >= 3 ? drawnPolygon : undefined,
          targetAcres: Number(fieldForm.targetAcres),
          soilType: fieldForm.soilType,
          currentCrop: fieldForm.currentCrop,
          previousCrop: fieldForm.previousCrop,
          waterAvailability: fieldForm.waterAvailability,
        }),
      });
      if (firebaseSignedIn) {
        void syncFieldRecordToFirestore({
          id: res.field.id,
          farmId: res.field.farm_id,
          name: res.field.name,
          areaAcres: res.field.area_acres,
          soilType: res.field.soil_type,
          currentCrop: res.field.current_crop,
          previousCrop: res.field.previous_crop,
          waterAvailability: res.field.water_availability,
          centroidLat: res.field.centroid_lat,
          centroidLon: res.field.centroid_lon,
        }).catch(() => {});
      }
      setShowNewField(false);
      setDrawnPolygon([]);
      setActionBanner(`Field "${res.field.name}" saved (${res.field.area_acres} acres).`);
      await loadFarms(selectedFarmId, res.field.id);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to create field.');
    }
  };

  const handleAddHistory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFieldId) return;
    setErrorBanner(null);
    try {
      await apiFetch('/crop-history', {
        method: 'POST',
        body: JSON.stringify({
          fieldId: selectedFieldId,
          ...histForm,
          year: Number(histForm.year),
        }),
      });
      setActionBanner(`Recorded ${histForm.cropName} (${histForm.season} ${histForm.year}) in crop history.`);
      await loadFieldContext(selectedFarmId, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to save crop history.');
    }
  };

  const handleSaveSoil = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFieldId) return;
    setErrorBanner(null);
    try {
      await apiFetch(`/soil/${selectedFieldId}`, {
        method: 'POST',
        body: JSON.stringify({
          sourceLabel: soilForm.sourceLabel,
          labName: soilForm.labName || undefined,
          sampleDate: soilForm.sampleDate,
          ph: soilForm.ph ? Number(soilForm.ph) : undefined,
          organicCarbonPct: soilForm.organicCarbonPct ? Number(soilForm.organicCarbonPct) : undefined,
          nitrogenKgHa: soilForm.nitrogenKgHa ? Number(soilForm.nitrogenKgHa) : undefined,
          phosphorusKgHa: soilForm.phosphorusKgHa ? Number(soilForm.phosphorusKgHa) : undefined,
          potassiumKgHa: soilForm.potassiumKgHa ? Number(soilForm.potassiumKgHa) : undefined,
        }),
      });
      setActionBanner('Soil test record persisted.');
      await loadFieldContext(selectedFarmId, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to save soil test.');
    }
  };

  const handleSaveRequirements = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFarmId || !selectedFieldId) return;
    setErrorBanner(null);
    try {
      await apiFetch('/farmer-requirements', {
        method: 'POST',
        body: JSON.stringify({
          farmId: selectedFarmId,
          fieldId: selectedFieldId,
          maxBudgetInr: reqForm.maxBudgetInr ? Number(reqForm.maxBudgetInr) : null,
          waterAvailability: reqForm.waterAvailability,
          riskTolerance: reqForm.riskTolerance,
          priorityFocus: reqForm.priorityFocus,
          preferredCrops: reqForm.preferredCropsText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          avoidCrops: reqForm.avoidCropsText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          targetPlantingDate: reqForm.targetPlantingDate || null,
        }),
      });
      setActionBanner('Budget, planting window & priorities saved. Rotation plans flagged for reassessment if changed.');
      await loadFieldContext(selectedFarmId, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to save requirements.');
    }
  };

  const handleRefreshNasa = async () => {
    if (!selectedFarmId) return;
    setRefreshingNasa(true);
    setErrorBanner(null);
    try {
      const res = await apiFetch<{
        weatherRisks: { triggered: number; alerts: string[] };
      }>('/nasa/refresh', {
        method: 'POST',
        body: JSON.stringify({ farmId: selectedFarmId, fieldId: selectedFieldId || undefined }),
      });
      setActionBanner(
        `Live NASA POWER, CMR Granule Discovery & Open-Meteo data refreshed.${
          res.weatherRisks.triggered > 0
            ? ` ${res.weatherRisks.triggered} weather-triggered review task(s) created.`
            : ''
        }`
      );
      if (selectedFieldId) await loadFieldContext(selectedFarmId, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'NASA refresh failed.');
    } finally {
      setRefreshingNasa(false);
    }
  };

  const handleRunRotationPlanner = async () => {
    if (!selectedFarmId || !selectedFieldId) return;
    setRunningPlanner(true);
    setErrorBanner(null);
    try {
      const res = await apiFetch<{
        context: FarmDecisionContext;
        analysis: RotationAnalysisResult;
        planId: string;
      }>('/rotation/analyze', {
        method: 'POST',
        body: JSON.stringify({
          farmId: selectedFarmId,
          fieldId: selectedFieldId,
          planningSeason,
        }),
      });
      setLatestRun(res);
      setActionBanner(`Rotation strategies generated using Context ${res.context.contextVersion}.`);
      await loadFieldContext(selectedFarmId, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Rotation analysis failed.');
    } finally {
      setRunningPlanner(false);
    }
  };

  const handleApproveStrategy = async (
    planId: string,
    strategyType: 'EXISTING' | 'MINIMAL_CHANGE' | 'ALTERNATIVE',
    requestExpertReview: boolean
  ) => {
    setErrorBanner(null);
    try {
      const res = await apiFetch<{ selectedCrop: string; tasksCreated: number }>(
        `/rotation/${planId}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({ strategyType, requestExpertReview }),
        }
      );
      if (firebaseSignedIn && selectedFarmId && selectedFieldId) {
        void syncRotationPlanToFirestore({
          id: planId,
          farmId: selectedFarmId,
          fieldId: selectedFieldId,
          planningSeason,
          selectedStrategyType: strategyType,
          selectedCrop: res.selectedCrop,
          status: 'APPROVED',
          summaryNote: `Approved ${strategyType} (${res.selectedCrop}) with ${res.tasksCreated} tasks`,
        }).catch(() => {});
      }
      setActionBanner(
        `Plan approved for ${res.selectedCrop}! Activated ${res.tasksCreated} crop-specific follow-up tasks.`
      );
      await loadFieldContext(selectedFarmId, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to approve plan.');
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    if (!taskFeedback.trim()) return;
    try {
      await apiFetch(`/followups/${taskId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ feedback: taskFeedback }),
      });
      const target = fieldDetails?.tasks.find((t) => t.id === taskId);
      if (firebaseSignedIn && target && selectedFarmId && selectedFieldId) {
        void syncTaskToFirestore({
          id: target.id,
          farmId: selectedFarmId,
          fieldId: selectedFieldId,
          title: target.title,
          category: target.category,
          dueDate: target.due_date,
          priority: target.priority,
          status: 'COMPLETED',
          farmerFeedback: taskFeedback,
        }).catch(() => {});
      }
      setCompletingTaskId(null);
      setTaskFeedback('');
      setActionBanner('Task marked completed and persisted to field timeline.');
      await loadFieldContext(selectedFarmId, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to complete task.');
    }
  };

  const handlePostponeTask = async (taskId: string) => {
    if (!postponeReason.trim() || !postponeDate) return;
    try {
      await apiFetch(`/followups/${taskId}/postpone`, {
        method: 'POST',
        body: JSON.stringify({ newDueDate: postponeDate, reason: postponeReason }),
      });
      const target = fieldDetails?.tasks.find((t) => t.id === taskId);
      if (firebaseSignedIn && target && selectedFarmId && selectedFieldId) {
        void syncTaskToFirestore({
          id: target.id,
          farmId: selectedFarmId,
          fieldId: selectedFieldId,
          title: target.title,
          category: target.category,
          dueDate: postponeDate,
          priority: target.priority,
          status: 'POSTPONED',
          farmerFeedback: `Postponed: ${postponeReason}`,
        }).catch(() => {});
      }
      setPostponingTaskId(null);
      setPostponeReason('');
      setActionBanner(`Task rescheduled to ${postponeDate} and logged to field timeline.`);
      await loadFieldContext(selectedFarmId, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to postpone task.');
    }
  };

  const handleCreateManualTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFarmId || !selectedFieldId || !newTaskTitle.trim()) return;
    try {
      const res = await apiFetch<{ id: string }>('/followups', {
        method: 'POST',
        body: JSON.stringify({
          farmId: selectedFarmId,
          fieldId: selectedFieldId,
          title: newTaskTitle,
          dueDate: newTaskDue,
        }),
      });
      if (firebaseSignedIn && res?.id) {
        void syncTaskToFirestore({
          id: res.id,
          farmId: selectedFarmId,
          fieldId: selectedFieldId,
          title: newTaskTitle,
          category: 'Field Activity',
          dueDate: newTaskDue,
          priority: 'Medium',
          status: 'UPCOMING',
        }).catch(() => {});
      }
      setNewTaskTitle('');
      setActionBanner('Custom field task added.');
      await loadFieldContext(selectedFarmId, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to add task.');
    }
  };

  const handleAskAssistant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFarmId || !selectedFieldId || !chatInput.trim()) return;
    const q = chatInput.trim();
    setChatInput('');
    setChatLoading(true);
    try {
      await apiFetch('/assistant/ask', {
        method: 'POST',
        body: JSON.stringify({
          farmId: selectedFarmId,
          fieldId: selectedFieldId,
          question: q,
          language: lang,
          planningSeason,
        }),
      });
      await loadFieldContext(selectedFarmId, selectedFieldId);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Assistant error.');
    } finally {
      setChatLoading(false);
    }
  };

  const powerRainChart =
    obsData?.observations
      .filter((o) => o.source_id === 'NASA_POWER' && o.variable === 'PRECTOTCORR' && o.value !== null)
      .slice(0, 14)
      .reverse()
      .map((o) => ({ date: o.observation_start.slice(5, 10), rainMm: o.value })) || [];

  const powerTempChart =
    obsData?.observations
      .filter((o) => o.source_id === 'NASA_POWER' && o.variable === 'T2M' && o.value !== null)
      .slice(0, 14)
      .reverse()
      .map((o) => ({ date: o.observation_start.slice(5, 10), tempC: o.value })) || [];

  const activeStrategies: StrategyEvaluation[] | null = latestRun
    ? latestRun.analysis.strategies
    : fieldDetails?.plans?.[0]
    ? JSON.parse(fieldDetails.plans[0].strategies_json)
    : null;

  const activePlanId = latestRun?.planId || fieldDetails?.plans?.[0]?.id || null;

  return (
    <WorkspaceShell
      user={user}
      lang={lang}
      onChangeLang={onChangeLang}
      navItems={navItems}
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      onSwitchRole={onSwitchRole}
      onNavigateHome={onNavigateHome}
      onLogout={onLogout}
    >
      <div className="space-y-5">
        {/* Top Context Bar: Farm & Field Switcher + Device Context Isolation */}
        <div className="bg-white rounded-2xl border border-[#DCE8DC] p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display font-extrabold text-xl text-[#10251D]">
                Namaste, {user.fullName}
              </h1>
              <span
                className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full border ${
                  globalLocation.locationType === 'DEVICE_LOCATION'
                    ? 'bg-amber-50 text-amber-900 border-amber-300'
                    : 'bg-emerald-50 text-emerald-900 border-emerald-300'
                }`}
              >
                {globalLocation.locationType === 'DEVICE_LOCATION'
                  ? 'Viewing Device Location'
                  : 'Selected Farm / Field Priority'}
              </span>
            </div>
            <p className="text-xs text-[#52635C]">
              {currentFarm
                ? `${currentFarm.village}, ${currentFarm.district} · ${currentFarm.agroclimatic_zone}`
                : 'Register your first farm to begin.'}
              {globalDetected &&
                ` · Device GPS: ${globalDetected.village || globalDetected.district || `${globalDetected.latitude.toFixed(3)}, ${globalDetected.longitude.toFixed(3)}`}`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {farms.length > 0 && (
              <select
                aria-label="Select Farm"
                value={selectedFarmId}
                onChange={(e) => {
                  const f = farms.find((x) => x.id === e.target.value);
                  const nextFieldId = f?.fields?.[0]?.id || '';
                  setSelectedFarmId(e.target.value);
                  setSelectedFieldId(nextFieldId);
                  setLatestRun(null);
                  void selectFarmOrField(e.target.value, nextFieldId || null);
                }}
                className="px-3 py-2 rounded-lg border border-[#DCE8DC] text-xs font-semibold bg-[#F8FBF6]"
              >
                {farms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}

            {currentFarm && currentFarm.fields.length > 0 && (
              <select
                aria-label="Select Field"
                value={selectedFieldId}
                onChange={(e) => {
                  setSelectedFieldId(e.target.value);
                  setLatestRun(null);
                  if (selectedFarmId) {
                    void selectFarmOrField(selectedFarmId, e.target.value);
                  }
                }}
                className="px-3 py-2 rounded-lg border border-[#DCE8DC] text-xs font-semibold bg-[#F8FBF6]"
              >
                {currentFarm.fields.map((fl) => (
                  <option key={fl.id} value={fl.id}>
                    {fl.name} ({fl.area_acres} ac)
                  </option>
                ))}
              </select>
            )}

            {currentFarm && (
              <button
                type="button"
                onClick={() => {
                  if (globalLocation.locationType === 'DEVICE_LOCATION') {
                    void selectFarmOrField(currentFarm.id, selectedFieldId || null);
                  } else {
                    void switchToDeviceLocation();
                  }
                }}
                className="px-3 py-2 rounded-lg border border-[#DCE8DC] bg-[#F8FBF6] hover:bg-[#E9F7E4] text-[#063D2A] text-xs font-semibold"
              >
                {globalLocation.locationType === 'DEVICE_LOCATION'
                  ? 'Use Saved Farm Context'
                  : 'Compare Device GPS'}
              </button>
            )}

            <button
              type="button"
              disabled={refreshingNasa || !selectedFarmId}
              onClick={handleRefreshNasa}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#063D2A] hover:bg-[#075A36] text-white text-xs font-semibold disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshingNasa ? 'animate-spin' : ''}`} />
              {refreshingNasa ? 'Syncing NASA...' : 'Fetch Live NASA & Weather'}
            </button>
          </div>
        </div>

        {actionBanner && (
          <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2">
            <span>{actionBanner}</span>
            <button type="button" onClick={() => setActionBanner(null)} className="font-bold">
              ✕
            </button>
          </div>
        )}
        {errorBanner && (
          <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900 flex items-center justify-between gap-2">
            <span>{errorBanner}</span>
            <button type="button" onClick={() => setErrorBanner(null)} className="font-bold">
              ✕
            </button>
          </div>
        )}

        {loading ? (
          <div className="p-8 bg-white rounded-2xl border border-[#DCE8DC] text-sm text-[#52635C]">
            Loading farm records...
          </div>
        ) : (
          <>
            {/* ===============================================================
                TAB: OVERVIEW
            =============================================================== */}
            {activeTab === 'overview' && (
              <div className="space-y-6">
                {!currentField ? (
                  <div className="p-8 bg-white rounded-2xl border border-[#DCE8DC] text-center space-y-3">
                    <h2 className="font-display font-bold text-lg">No Field Selected Yet</h2>
                    <p className="text-sm text-[#52635C]">
                      Create a farm and field boundary to unlock NASA observations and crop-rotation
                      recommendations.
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('farms')}
                      className="px-5 py-2.5 rounded-lg bg-[#A7F33C] text-[#03152B] font-bold text-xs"
                    >
                      Register Farm &amp; Field →
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Summary KPI Row */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="p-4 rounded-xl bg-white border border-[#DCE8DC]">
                        <div className="text-xs text-[#52635C]">Current / Previous Crop</div>
                        <div className="font-display font-bold text-base mt-1">
                          {currentField.current_crop || 'Unset'}{' '}
                          <span className="text-xs font-normal text-[#52635C]">
                            (prev: {currentField.previous_crop || '—'})
                          </span>
                        </div>
                      </div>
                      <div className="p-4 rounded-xl bg-white border border-[#DCE8DC]">
                        <div className="text-xs text-[#52635C]">Field Area &amp; Water</div>
                        <div className="font-mono-tabular font-bold text-base mt-1">
                          {currentField.area_acres} ac · {currentField.water_availability}
                        </div>
                      </div>
                      <div className="p-4 rounded-xl bg-white border border-[#DCE8DC]">
                        <div className="text-xs text-[#52635C]">Cultivation Budget</div>
                        <div className="font-mono-tabular font-bold text-base mt-1">
                          {fieldDetails?.requirements?.max_budget_inr
                            ? `₹${fieldDetails.requirements.max_budget_inr.toLocaleString('en-IN')}`
                            : 'Not set'}
                        </div>
                      </div>
                      <div className="p-4 rounded-xl bg-white border border-[#DCE8DC]">
                        <div className="text-xs text-[#52635C]">Pending Follow-Up Tasks</div>
                        <div className="font-mono-tabular font-bold text-base mt-1">
                          {fieldDetails?.tasks.filter((t) => t.status !== 'COMPLETED').length || 0} open
                        </div>
                      </div>
                    </div>

                    {/* Persisted NASA Metrics Row */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      {(obsData?.metrics || []).map((m) => (
                        <div key={m.metricKey} className="p-4 rounded-xl bg-[#03152B] text-white border border-[#27D7ED]/30 space-y-1">
                          <div className="text-xs text-[#6BEAFF]">{m.label}</div>
                          <div className="text-2xl font-bold font-mono-tabular">
                            {m.value !== null ? `${m.value} ${m.unit}` : 'Unavailable'}
                          </div>
                          <div className="text-[11px] text-slate-300">{m.freshnessStatus} · {m.provider}</div>
                          {m.gridCellId && (
                            <div className="text-[10px] font-mono-tabular text-slate-400 truncate">
                              {m.gridCellId} {m.pixelDistanceM != null ? `(${m.pixelDistanceM} m)` : ''}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Quick Actions */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <div className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-3">
                        <div className="flex items-center justify-between">
                          <h2 className="font-display font-bold text-base">Field Boundary Map</h2>
                          <button
                            type="button"
                            onClick={() => setActiveTab('farms')}
                            className="text-xs font-semibold text-[#075A36] hover:underline"
                          >
                            Edit Boundary →
                          </button>
                        </div>
                        <FieldMap
                          centerLat={currentField.centroid_lat}
                          centerLon={currentField.centroid_lon}
                          polygonGeoJson={currentField.geometry_geojson}
                          heightClass="h-60"
                        />
                      </div>

                      <div className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-3">
                        <div className="flex items-center justify-between">
                          <h2 className="font-display font-bold text-base">Latest Rotation &amp; Tasks</h2>
                          <button
                            type="button"
                            onClick={() => setActiveTab('planner')}
                            className="text-xs font-semibold text-[#075A36] hover:underline"
                          >
                            Open Planner →
                          </button>
                        </div>

                        {fieldDetails?.plans?.[0] ? (
                          <div className="p-3.5 rounded-xl bg-[#F8FBF6] border border-[#DCE8DC] text-xs space-y-1">
                            <div className="font-bold text-[#063D2A]">
                              {fieldDetails.plans[0].planning_season} Plan: {fieldDetails.plans[0].selected_crop || 'Draft Analysis'} ({fieldDetails.plans[0].status})
                            </div>
                            <div className="text-[#52635C]">
                              Expert review: {fieldDetails.plans[0].expert_review_status}
                            </div>
                            {fieldDetails.plans[0].reassessment_needed === 1 && (
                              <div className="text-amber-800 font-semibold">
                                Reassessment needed: {fieldDetails.plans[0].reassessment_reason}
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-[#52635C]">
                            No crop-rotation analysis generated yet for this field.
                          </p>
                        )}

                        <div className="space-y-2 pt-1">
                          {(fieldDetails?.tasks || []).slice(0, 4).map((t) => (
                            <div
                              key={t.id}
                              className="p-2.5 rounded-lg border border-[#DCE8DC] flex items-center justify-between gap-2 text-xs"
                            >
                              <div>
                                <div className="font-semibold">{t.title}</div>
                                <div className="text-[#52635C] font-mono-tabular">
                                  Due {t.due_date} · {t.status}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => setActiveTab('followups')}
                                className="text-[#075A36] font-semibold"
                              >
                                Manage
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ===============================================================
                TAB: MY FARMS & FIELDS
            =============================================================== */}
            {activeTab === 'farms' && (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="font-display font-bold text-lg">Farms &amp; Field Geometries</h2>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setShowNewFarm(!showNewFarm)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add Farm
                    </button>
                    {currentFarm && (
                      <button
                        type="button"
                        onClick={() => setShowEditFarm(!showEditFarm)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#DCE8DC] bg-white text-[#10251D] text-xs font-semibold"
                      >
                        <MapPin className="w-3.5 h-3.5" /> Edit Farm Location
                      </button>
                    )}
                    {selectedFarmId && (
                      <button
                        type="button"
                        onClick={() => setShowNewField(!showNewField)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#A7F33C] text-[#03152B] text-xs font-bold"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Field Polygon
                      </button>
                    )}
                  </div>
                </div>

                {showEditFarm && currentFarm && (
                  <form
                    onSubmit={handleUpdateFarmLocation}
                    className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-4"
                  >
                    <h3 className="font-display font-bold text-base">
                      Update Location &amp; Water Profile: {currentFarm.name}
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                      <div>
                        <label className="block font-semibold mb-1">Village</label>
                        <input
                          required
                          value={editFarmForm.village}
                          onChange={(e) => setEditFarmForm({ ...editFarmForm, village: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold mb-1">District</label>
                        <input
                          required
                          value={editFarmForm.district}
                          onChange={(e) => setEditFarmForm({ ...editFarmForm, district: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold mb-1">Water Availability</label>
                        <select
                          value={editFarmForm.waterAvailability}
                          onChange={(e) =>
                            setEditFarmForm({ ...editFarmForm, waterAvailability: e.target.value as WaterAvailability })
                          }
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm bg-white"
                        >
                          <option value="Rainfed">Rainfed</option>
                          <option value="Limited">Limited</option>
                          <option value="Irrigated">Irrigated</option>
                        </select>
                      </div>
                      <div>
                        <label className="block font-semibold mb-1">Latitude (EPSG:4326)</label>
                        <input
                          type="number"
                          step="0.00001"
                          value={editFarmForm.latitude}
                          onChange={(e) =>
                            setEditFarmForm({
                              ...editFarmForm,
                              latitude: Number(e.target.value),
                              locationMethod: 'MANUAL_COORDS',
                            })
                          }
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm font-mono-tabular"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold mb-1">Longitude (EPSG:4326)</label>
                        <input
                          type="number"
                          step="0.00001"
                          value={editFarmForm.longitude}
                          onChange={(e) =>
                            setEditFarmForm({
                              ...editFarmForm,
                              longitude: Number(e.target.value),
                              locationMethod: 'MANUAL_COORDS',
                            })
                          }
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm font-mono-tabular"
                        />
                      </div>
                    </div>
                    <FieldMap
                      centerLat={editFarmForm.latitude}
                      centerLon={editFarmForm.longitude}
                      mode="pick_point"
                      onPickPoint={(lat, lon) =>
                        setEditFarmForm((prev) => ({
                          ...prev,
                          latitude: lat,
                          longitude: lon,
                          locationMethod: 'MAP_PIN',
                        }))
                      }
                      heightClass="h-48"
                    />
                    <label className="flex items-center gap-2 text-xs font-medium">
                      <input
                        type="checkbox"
                        checked={editFarmForm.locationConfirmed}
                        onChange={(e) => setEditFarmForm({ ...editFarmForm, locationConfirmed: e.target.checked })}
                      />
                      Confirm updated farm coordinates (triggers plan reassessment).
                    </label>
                    <button
                      type="submit"
                      className="px-5 py-2 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
                    >
                      Save Location Update
                    </button>
                  </form>
                )}

                {showNewFarm && (
                  <form
                    onSubmit={handleCreateFarm}
                    className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-4"
                  >
                    <h3 className="font-display font-bold text-base">Register New Farm</h3>

                    <div className="p-3 rounded-xl bg-[#F8FBF6] border border-[#DCE8DC] space-y-2">
                      <div className="text-xs font-semibold text-[#075A36]">
                        Search Village / Taluka / District (auto-fills coordinates)
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={farmSearchQuery}
                          onChange={(e) => setFarmSearchQuery(e.target.value)}
                          placeholder="e.g., Nashik, Niphad, Rahata, Pune..."
                          className="flex-1 px-3 py-2 rounded-lg border border-[#DCE8DC] text-xs bg-white"
                        />
                        <button
                          type="button"
                          onClick={handleSearchFarmLocation}
                          className="px-3.5 py-2 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
                        >
                          Search Location
                        </button>
                      </div>
                      {farmSearchResults.length > 0 && (
                        <div className="max-h-32 overflow-y-auto bg-white border border-[#DCE8DC] rounded-lg divide-y divide-[#DCE8DC]">
                          {farmSearchResults.map((loc, idx) => (
                            <button
                              key={`${loc.lat}-${loc.lon}-${idx}`}
                              type="button"
                              onClick={() => {
                                setFarmForm((prev) => ({
                                  ...prev,
                                  village: loc.village,
                                  taluka: loc.taluka,
                                  district: loc.district,
                                  state: loc.state,
                                  latitude: loc.lat,
                                  longitude: loc.lon,
                                  locationMethod: 'SEARCH',
                                }));
                                setFarmSearchResults([]);
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs hover:bg-[#F8FBF6] flex justify-between"
                            >
                              <span>{loc.label}</span>
                              <span className="font-mono-tabular text-[#075A36]">
                                {loc.lat}, {loc.lon}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-semibold mb-1">Farm Name</label>
                        <input
                          required
                          value={farmForm.name}
                          onChange={(e) => setFarmForm({ ...farmForm, name: e.target.value })}
                          placeholder="e.g., Shirdi Road Farm"
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Village</label>
                        <input
                          required
                          value={farmForm.village}
                          onChange={(e) => setFarmForm({ ...farmForm, village: e.target.value })}
                          placeholder="Kopargaon"
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Taluka</label>
                        <input
                          required
                          value={farmForm.taluka}
                          onChange={(e) => setFarmForm({ ...farmForm, taluka: e.target.value })}
                          placeholder="Kopargaon"
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">District</label>
                        <input
                          required
                          value={farmForm.district}
                          onChange={(e) => setFarmForm({ ...farmForm, district: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">State</label>
                        <input
                          required
                          value={farmForm.state}
                          onChange={(e) => setFarmForm({ ...farmForm, state: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Total Area (Acres)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0.1"
                          required
                          value={farmForm.totalAreaAcres}
                          onChange={(e) => setFarmForm({ ...farmForm, totalAreaAcres: Number(e.target.value) })}
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Latitude (EPSG:4326)</label>
                        <input
                          type="number"
                          step="0.00001"
                          required
                          value={farmForm.latitude}
                          onChange={(e) =>
                            setFarmForm({
                              ...farmForm,
                              latitude: Number(e.target.value),
                              locationMethod: 'MANUAL_COORDS',
                            })
                          }
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm font-mono-tabular"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Longitude (EPSG:4326)</label>
                        <input
                          type="number"
                          step="0.00001"
                          required
                          value={farmForm.longitude}
                          onChange={(e) =>
                            setFarmForm({
                              ...farmForm,
                              longitude: Number(e.target.value),
                              locationMethod: 'MANUAL_COORDS',
                            })
                          }
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm font-mono-tabular"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Water Availability</label>
                        <select
                          value={farmForm.waterAvailability}
                          onChange={(e) =>
                            setFarmForm({ ...farmForm, waterAvailability: e.target.value as WaterAvailability })
                          }
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm bg-white"
                        >
                          <option value="Rainfed">Rainfed</option>
                          <option value="Limited">Limited</option>
                          <option value="Irrigated">Irrigated</option>
                        </select>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold">
                          Click Map to Pin Exact Farm Location ({farmForm.latitude}, {farmForm.longitude} · Method: {farmForm.locationMethod})
                        </span>
                        <button
                          type="button"
                          onClick={handleUseDeviceGps}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#DCE8DC] text-xs font-semibold hover:bg-[#F8FBF6]"
                        >
                          <Compass className="w-3.5 h-3.5" /> Use Device GPS
                        </button>
                      </div>
                      <FieldMap
                        centerLat={farmForm.latitude}
                        centerLon={farmForm.longitude}
                        mode="pick_point"
                        onPickPoint={(lat, lon) =>
                          setFarmForm((prev) => ({ ...prev, latitude: lat, longitude: lon, locationMethod: 'MAP_PIN' }))
                        }
                        heightClass="h-56"
                      />
                    </div>

                    <label className="flex items-center gap-2 text-xs font-medium">
                      <input
                        type="checkbox"
                        checked={farmForm.locationConfirmed}
                        onChange={(e) => setFarmForm({ ...farmForm, locationConfirmed: e.target.checked })}
                      />
                      I confirm these coordinates represent the actual agricultural farm location (separate from my device location).
                    </label>

                    <button
                      type="submit"
                      className="px-5 py-2.5 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
                    >
                      Save Farm &amp; Resolve Agroclimatic Zone
                    </button>
                  </form>
                )}

                {showNewField && currentFarm && (
                  <form
                    onSubmit={handleCreateField}
                    className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-4"
                  >
                    <h3 className="font-display font-bold text-base">
                      Add Field to {currentFarm.name}
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-semibold mb-1">Field Name</label>
                        <input
                          required
                          value={fieldForm.name}
                          onChange={(e) => setFieldForm({ ...fieldForm, name: e.target.value })}
                          placeholder="e.g., East Drip Plot"
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Estimated Acres (if not drawing polygon)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0.1"
                          value={fieldForm.targetAcres}
                          onChange={(e) => setFieldForm({ ...fieldForm, targetAcres: Number(e.target.value) })}
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Soil Type</label>
                        <select
                          value={fieldForm.soilType}
                          onChange={(e) => setFieldForm({ ...fieldForm, soilType: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm bg-white"
                        >
                          <option>Medium Black</option>
                          <option>Deep Black</option>
                          <option>Loamy</option>
                          <option>Sandy Loam</option>
                          <option>Shallow</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Current Crop</label>
                        <input
                          value={fieldForm.currentCrop}
                          onChange={(e) => setFieldForm({ ...fieldForm, currentCrop: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Previous Crop</label>
                        <input
                          value={fieldForm.previousCrop}
                          onChange={(e) => setFieldForm({ ...fieldForm, previousCrop: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold mb-1">Water Availability</label>
                        <select
                          value={fieldForm.waterAvailability}
                          onChange={(e) =>
                            setFieldForm({ ...fieldForm, waterAvailability: e.target.value as WaterAvailability })
                          }
                          className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm bg-white"
                        >
                          <option value="Rainfed">Rainfed</option>
                          <option value="Limited">Limited</option>
                          <option value="Irrigated">Irrigated</option>
                        </select>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span>
                          Click on map to draw field boundary vertices ({drawnPolygon.length} points selected)
                        </span>
                        {drawnPolygon.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setDrawnPolygon([])}
                            className="text-red-700 font-semibold"
                          >
                            Clear Polygon
                          </button>
                        )}
                      </div>
                      <FieldMap
                        centerLat={currentFarm.latitude}
                        centerLon={currentFarm.longitude}
                        mode="draw_polygon"
                        drawnPoints={drawnPolygon}
                        onAddPolygonVertex={(lon, lat) => setDrawnPolygon((prev) => [...prev, [lon, lat]])}
                        heightClass="h-60"
                      />
                    </div>

                    <button
                      type="submit"
                      className="px-5 py-2.5 rounded-lg bg-[#A7F33C] text-[#03152B] font-bold text-xs"
                    >
                      Save Field Boundary
                    </button>
                  </form>
                )}

                {currentField && (
                  <div className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="font-display font-bold text-base">{currentField.name}</h3>
                        <p className="text-xs text-[#52635C]">
                          Area: {currentField.area_acres} acres ({currentField.area_hectares} ha) · Centroid:{' '}
                          {currentField.centroid_lat.toFixed(5)}, {currentField.centroid_lon.toFixed(5)}
                        </p>
                      </div>
                    </div>
                    <FieldMap
                      centerLat={currentField.centroid_lat}
                      centerLon={currentField.centroid_lon}
                      polygonGeoJson={currentField.geometry_geojson}
                      heightClass="h-72"
                    />
                  </div>
                )}
              </div>
            )}

            {/* ===============================================================
                TAB: CROP HISTORY & SOIL TESTS
            =============================================================== */}
            {activeTab === 'history' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-4">
                  <h2 className="font-display font-bold text-base">Chronological Crop History</h2>
                  <form onSubmit={handleAddHistory} className="grid grid-cols-2 gap-3 text-xs">
                    <input
                      required
                      value={histForm.cropName}
                      onChange={(e) => setHistForm({ ...histForm, cropName: e.target.value })}
                      placeholder="Crop name"
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <input
                      required
                      value={histForm.cropFamily}
                      onChange={(e) => setHistForm({ ...histForm, cropFamily: e.target.value })}
                      placeholder="Crop family (e.g., Fabaceae)"
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <select
                      value={histForm.season}
                      onChange={(e) => setHistForm({ ...histForm, season: e.target.value as SeasonType })}
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC] bg-white"
                    >
                      <option>Kharif</option>
                      <option>Rabi</option>
                      <option>Zaid</option>
                    </select>
                    <input
                      type="number"
                      value={histForm.year}
                      onChange={(e) => setHistForm({ ...histForm, year: Number(e.target.value) })}
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <input
                      value={histForm.pestDiseaseNotes}
                      onChange={(e) => setHistForm({ ...histForm, pestDiseaseNotes: e.target.value })}
                      placeholder="Pest/disease notes (optional)"
                      className="col-span-2 px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <label className="col-span-2 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={histForm.setAsCurrent}
                        onChange={(e) => setHistForm({ ...histForm, setAsCurrent: e.target.checked })}
                      />
                      Set as current standing/latest crop
                    </label>
                    <button
                      type="submit"
                      className="col-span-2 py-2 rounded-lg bg-[#063D2A] text-white font-semibold"
                    >
                      Record Crop History
                    </button>
                  </form>

                  <div className="space-y-2 pt-2 border-t border-[#DCE8DC]">
                    {(fieldDetails?.history || []).map((h) => (
                      <div key={h.id} className="p-3 rounded-lg bg-[#F8FBF6] border border-[#DCE8DC] text-xs">
                        <div className="font-bold">
                          {h.crop_name} · {h.season} {h.year}
                        </div>
                        <div className="text-[#52635C]">Family: {h.crop_family}</div>
                        {h.pest_disease_notes && <div className="text-[#52635C] mt-0.5">{h.pest_disease_notes}</div>}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-4">
                  <h2 className="font-display font-bold text-base">Soil Health Records</h2>
                  <p className="text-xs text-[#52635C]">
                    We never fabricate soil nutrient values. Record actual laboratory Soil Health Card
                    numbers or farmer observations.
                  </p>
                  <form onSubmit={handleSaveSoil} className="grid grid-cols-2 gap-3 text-xs">
                    <select
                      value={soilForm.sourceLabel}
                      onChange={(e) =>
                        setSoilForm({ ...soilForm, sourceLabel: e.target.value as 'Lab Measured' | 'Farmer Entered' })
                      }
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC] bg-white"
                    >
                      <option value="Lab Measured">Lab Measured</option>
                      <option value="Farmer Entered">Farmer Entered</option>
                    </select>
                    <input
                      value={soilForm.labName}
                      onChange={(e) => setSoilForm({ ...soilForm, labName: e.target.value })}
                      placeholder="Lab name"
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <input
                      type="number"
                      step="0.1"
                      value={soilForm.ph}
                      onChange={(e) => setSoilForm({ ...soilForm, ph: e.target.value })}
                      placeholder="pH (e.g., 7.2)"
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={soilForm.organicCarbonPct}
                      onChange={(e) => setSoilForm({ ...soilForm, organicCarbonPct: e.target.value })}
                      placeholder="Org. Carbon %"
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <input
                      type="number"
                      value={soilForm.nitrogenKgHa}
                      onChange={(e) => setSoilForm({ ...soilForm, nitrogenKgHa: e.target.value })}
                      placeholder="Nitrogen (kg/ha)"
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <input
                      type="number"
                      value={soilForm.phosphorusKgHa}
                      onChange={(e) => setSoilForm({ ...soilForm, phosphorusKgHa: e.target.value })}
                      placeholder="Phosphorus (kg/ha)"
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <button
                      type="submit"
                      className="col-span-2 py-2 rounded-lg bg-[#063D2A] text-white font-semibold"
                    >
                      Save Soil Test
                    </button>
                  </form>

                  <div className="space-y-2 pt-2 border-t border-[#DCE8DC]">
                    {(fieldDetails?.soilTests || []).map((st) => (
                      <div key={st.id} className="p-3 rounded-lg bg-[#F8FBF6] border border-[#DCE8DC] text-xs">
                        <div className="font-bold">
                          {st.source_label} · {st.sample_date || 'Undated'}
                        </div>
                        <div className="font-mono-tabular text-[#52635C] mt-0.5">
                          pH: {st.ph ?? '—'} · OC: {st.organic_carbon_pct ?? '—'}% · N: {st.nitrogen_kg_ha ?? '—'} · P:{' '}
                          {st.phosphorus_kg_ha ?? '—'} · K: {st.potassium_kg_ha ?? '—'} kg/ha
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ===============================================================
                TAB: BUDGET & REQUIREMENTS
            =============================================================== */}
            {activeTab === 'budget' && (
              <form
                onSubmit={handleSaveRequirements}
                className="bg-white rounded-2xl border border-[#DCE8DC] p-6 max-w-2xl space-y-4"
              >
                <div className="flex items-center gap-2">
                  <IndianRupee className="w-5 h-5 text-[#075A36]" />
                  <h2 className="font-display font-bold text-lg">
                    Cultivation Budget &amp; Farmer Priorities
                  </h2>
                </div>
                <p className="text-xs text-[#52635C]">
                  The deterministic crop-rotation solver enforces your budget ceiling and water
                  capability as hard constraints.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div>
                    <label htmlFor="req-budget" className="block font-semibold mb-1">
                      Maximum Cultivation Budget (₹ INR)
                    </label>
                    <input
                      id="req-budget"
                      type="number"
                      min="1000"
                      value={reqForm.maxBudgetInr}
                      onChange={(e) => setReqForm({ ...reqForm, maxBudgetInr: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm font-mono-tabular"
                    />
                  </div>
                  <div>
                    <label htmlFor="req-water" className="block font-semibold mb-1">
                      Water Availability
                    </label>
                    <select
                      id="req-water"
                      value={reqForm.waterAvailability}
                      onChange={(e) =>
                        setReqForm({ ...reqForm, waterAvailability: e.target.value as WaterAvailability })
                      }
                      className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm bg-white"
                    >
                      <option value="Rainfed">Rainfed</option>
                      <option value="Limited">Limited (1–2 protective irrigations)</option>
                      <option value="Irrigated">Irrigated (Drip / Canal / Borewell)</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="req-priority" className="block font-semibold mb-1">
                      Primary Planning Priority
                    </label>
                    <select
                      id="req-priority"
                      value={reqForm.priorityFocus}
                      onChange={(e) =>
                        setReqForm({
                          ...reqForm,
                          priorityFocus: e.target.value as 'Lower Cost' | 'Soil Health' | 'Balanced' | 'Water Saving',
                        })
                      }
                      className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm bg-white"
                    >
                      <option value="Balanced">Balanced</option>
                      <option value="Lower Cost">Lower Upfront Cost</option>
                      <option value="Soil Health">Soil Health &amp; Nitrogen Fixation</option>
                      <option value="Water Saving">Water Saving</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="req-risk" className="block font-semibold mb-1">
                      Risk Tolerance
                    </label>
                    <select
                      id="req-risk"
                      value={reqForm.riskTolerance}
                      onChange={(e) =>
                        setReqForm({ ...reqForm, riskTolerance: e.target.value as 'Low' | 'Moderate' | 'High' })
                      }
                      className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm bg-white"
                    >
                      <option value="Low">Low Risk</option>
                      <option value="Moderate">Moderate</option>
                      <option value="High">High</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="req-planting-date" className="block font-semibold mb-1">
                      Target Planting Date (Optional)
                    </label>
                    <input
                      id="req-planting-date"
                      type="date"
                      value={reqForm.targetPlantingDate}
                      onChange={(e) => setReqForm({ ...reqForm, targetPlantingDate: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm bg-white"
                    />
                  </div>
                  <div>
                    <label htmlFor="req-pref" className="block font-semibold mb-1">
                      Preferred Crops (comma separated)
                    </label>
                    <input
                      id="req-pref"
                      value={reqForm.preferredCropsText}
                      onChange={(e) => setReqForm({ ...reqForm, preferredCropsText: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor="req-avoid" className="block font-semibold mb-1">
                      Crops to Avoid (comma separated)
                    </label>
                    <input
                      id="req-avoid"
                      value={reqForm.avoidCropsText}
                      onChange={(e) => setReqForm({ ...reqForm, avoidCropsText: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-[#DCE8DC] text-sm"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-lg bg-[#A7F33C] text-[#03152B] font-bold text-xs"
                >
                  Save Requirements &amp; Sync Context
                </button>
              </form>
            )}

            {/* ===============================================================
                TAB: CROP ROTATION PLANNER
            =============================================================== */}
            {activeTab === 'planner' && (
              <div className="space-y-6">
                <div className="bg-white rounded-2xl border border-[#DCE8DC] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h2 className="font-display font-bold text-lg">
                      Deterministic Crop-Rotation Decision Engine
                    </h2>
                    <p className="text-xs text-[#52635C]">
                      Evaluates your field history, ₹ budget, water availability, soil test, and
                      persisted NASA/weather context.
                    </p>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <select
                      aria-label="Planning Season"
                      value={planningSeason}
                      onChange={(e) => setPlanningSeason(e.target.value as SeasonType)}
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC] text-xs font-semibold bg-[#F8FBF6]"
                    >
                      <option value="Rabi">Rabi Season</option>
                      <option value="Kharif">Kharif Season</option>
                      <option value="Zaid">Zaid Season</option>
                    </select>
                    <button
                      type="button"
                      disabled={runningPlanner || !selectedFieldId}
                      onClick={handleRunRotationPlanner}
                      className="px-4 py-2 rounded-lg bg-[#A7F33C] hover:bg-[#C4FF63] text-[#03152B] font-bold text-xs disabled:opacity-50"
                    >
                      {runningPlanner ? 'Evaluating Constraints...' : 'Analyze 3 Rotation Strategies'}
                    </button>
                  </div>
                </div>

                {activeStrategies ? (
                  <div className="space-y-5">
                    {/* Side-by-Side 3-Strategy Comparison Table */}
                    <div className="bg-white rounded-2xl border border-[#DCE8DC] overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#F8FBF6] border-b border-[#DCE8DC] text-[#52635C]">
                          <tr>
                            <th className="p-3">Strategy</th>
                            <th className="p-3">Proposed Crop</th>
                            <th className="p-3">Est. Cost / Acre</th>
                            <th className="p-3">Total Cost</th>
                            <th className="p-3">Budget Fit</th>
                            <th className="p-3">Water Demand</th>
                            <th className="p-3">Sowing Window</th>
                            <th className="p-3">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#DCE8DC]">
                          {activeStrategies.map((s) => (
                            <tr key={`cmp-${s.strategyType}`}>
                              <td className="p-3 font-semibold text-[#075A36]">{s.title}</td>
                              <td className="p-3 font-bold text-[#10251D]">{s.proposedCrop || 'No Feasible Crop'}</td>
                              <td className="p-3 font-mono-tabular">
                                {s.estimatedCostPerAcreInr !== null
                                  ? `₹${s.estimatedCostPerAcreInr.toLocaleString('en-IN')}`
                                  : '—'}
                              </td>
                              <td className="p-3 font-mono-tabular font-semibold">
                                {s.estimatedTotalCostInr !== null
                                  ? `₹${s.estimatedTotalCostInr.toLocaleString('en-IN')}`
                                  : '—'}
                              </td>
                              <td className="p-3">
                                {s.budgetFits === true ? 'Within Budget' : s.budgetFits === false ? 'Exceeds Cap' : 'Unverified'}
                              </td>
                              <td className="p-3">{s.waterCompatibility || '—'}</td>
                              <td className="p-3">{s.sowingWindow || '—'}</td>
                              <td className="p-3">
                                <span
                                  className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                                    s.feasible ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
                                  }`}
                                >
                                  {s.feasible ? 'FEASIBLE' : 'INFEASIBLE'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                      {activeStrategies.map((s) => (
                        <div
                          key={s.strategyType}
                          className={`rounded-2xl border p-5 flex flex-col justify-between gap-4 bg-white ${
                            s.feasible ? 'border-[#C6E6BD]' : 'border-red-200'
                          }`}
                        >
                          <div className="space-y-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-bold text-[#075A36]">{s.title}</span>
                              <span
                                className={`text-[11px] font-bold px-2 py-0.5 rounded ${
                                  s.feasible ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
                                }`}
                              >
                                {s.feasible ? 'FEASIBLE' : 'INFEASIBLE'}
                              </span>
                            </div>

                            <div>
                              <div className="font-display font-extrabold text-xl text-[#10251D]">
                                {s.proposedCrop || 'No Feasible Crop'}
                              </div>
                              <div className="text-xs text-[#52635C]">
                                {s.cropFamily || '—'} · {s.durationDays || '—'}
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-[#F8FBF6] border border-[#DCE8DC] text-xs">
                              <div>
                                <div className="text-[#52635C]">Est. Total Cost</div>
                                <div className="font-mono-tabular font-bold">
                                  {s.estimatedTotalCostInr !== null
                                    ? `₹${s.estimatedTotalCostInr.toLocaleString('en-IN')}`
                                    : '—'}
                                </div>
                              </div>
                              <div>
                                <div className="text-[#52635C]">Budget Check</div>
                                <div className="font-semibold">
                                  {s.budgetFits === true
                                    ? 'Within Budget'
                                    : s.budgetFits === false
                                    ? 'Exceeds Cap'
                                    : 'Unverified'}
                                </div>
                              </div>
                              <div className="col-span-2">
                                <div className="text-[#52635C]">Indicative Market Revenue</div>
                                <div className="font-mono-tabular font-semibold">
                                  {s.indicativeGrossRevenueInr !== null
                                    ? `₹${s.indicativeGrossRevenueInr.toLocaleString('en-IN')} (Margin: ₹${(
                                        s.indicativeMarginInr ?? 0
                                      ).toLocaleString('en-IN')})`
                                    : 'Omitted (live price/yield missing)'}
                                </div>
                              </div>
                            </div>

                            {s.costBreakdown && (
                              <div className="p-2.5 rounded-lg bg-[#F8FBF6] border border-[#DCE8DC] text-[11px] space-y-1">
                                <div className="font-semibold text-[#075A36]">Stage Cost Breakdown / Acre</div>
                                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono-tabular text-[#52635C]">
                                  <span>Seeds: ₹{s.costBreakdown.seeds.toLocaleString('en-IN')}</span>
                                  <span>Prep: ₹{s.costBreakdown.landPrep.toLocaleString('en-IN')}</span>
                                  <span>Fert: ₹{s.costBreakdown.fertilizer.toLocaleString('en-IN')}</span>
                                  <span>Irrig: ₹{s.costBreakdown.irrigation.toLocaleString('en-IN')}</span>
                                  <span className="col-span-2">
                                    Labor &amp; Harvest: ₹{s.costBreakdown.laborAndHarvest.toLocaleString('en-IN')}
                                  </span>
                                </div>
                              </div>
                            )}

                            <p className="text-xs text-[#10251D] leading-relaxed">{s.rationale}</p>

                            {s.hardConstraintsPassed.length > 0 && (
                              <div>
                                <div className="text-[11px] font-bold text-[#1D7F3C] mb-1">
                                  Constraints Satisfied
                                </div>
                                <ul className="space-y-1 text-[11px] text-[#52635C] list-disc pl-4">
                                  {s.hardConstraintsPassed.map((c, idx) => (
                                    <li key={idx}>{c}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {s.hardConstraintsFailed.length > 0 && (
                              <div>
                                <div className="text-[11px] font-bold text-red-700 mb-1">
                                  Constraints Failed
                                </div>
                                <ul className="space-y-1 text-[11px] text-red-700 list-disc pl-4">
                                  {s.hardConstraintsFailed.map((c, idx) => (
                                    <li key={idx}>{c}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {s.missingInformation.length > 0 && (
                              <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                                Missing: {s.missingInformation[0]}
                              </div>
                            )}
                          </div>

                          {activePlanId && s.proposedCrop && s.feasible && (
                            <div className="pt-3 border-t border-[#DCE8DC] flex flex-col gap-2">
                              <button
                                type="button"
                                onClick={() => handleApproveStrategy(activePlanId, s.strategyType, true)}
                                className="w-full py-2 px-3 rounded-lg bg-[#063D2A] hover:bg-[#075A36] text-white text-xs font-semibold"
                              >
                                Approve Plan &amp; Request Agronomist Review
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="p-8 bg-white rounded-2xl border border-[#DCE8DC] text-center text-sm text-[#52635C]">
                    Click "Analyze 3 Rotation Strategies" above to evaluate Existing, Minimal Change,
                    and Alternative options for this field.
                  </div>
                )}
              </div>
            )}

            {/* ===============================================================
                TAB: NASA & WEATHER ENVIRONMENT
            =============================================================== */}
            {activeTab === 'environment' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-3">
                    <h3 className="font-display font-bold text-base">
                      NASA POWER Precipitation (mm/day)
                    </h3>
                    {powerRainChart.length === 0 ? (
                      <p className="text-xs text-[#52635C]">
                        No persisted rainfall observations yet. Click "Fetch Live NASA &amp; Weather" above.
                      </p>
                    ) : (
                      <div className="h-56">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={powerRainChart}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E5EFE5" />
                            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                            <YAxis tick={{ fontSize: 11 }} />
                            <Tooltip />
                            <Bar dataKey="rainMm" fill="#27D7ED" radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>

                  <div className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-3">
                    <h3 className="font-display font-bold text-base">
                      NASA POWER Air Temperature (°C)
                    </h3>
                    {powerTempChart.length === 0 ? (
                      <p className="text-xs text-[#52635C]">
                        No persisted temperature observations yet. Click "Fetch Live NASA &amp; Weather" above.
                      </p>
                    ) : (
                      <div className="h-56">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={powerTempChart}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E5EFE5" />
                            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                            <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                            <Tooltip />
                            <Line type="monotone" dataKey="tempC" stroke="#075A36" strokeWidth={2.5} dot={{ r: 3 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ===============================================================
                TAB: FOLLOW-UPS & TIMELINE
            =============================================================== */}
            {activeTab === 'followups' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-4">
                  <h2 className="font-display font-bold text-base">Field Tasks &amp; Weather Follow-Ups</h2>

                  <form onSubmit={handleCreateManualTask} className="flex flex-wrap gap-2 text-xs">
                    <input
                      required
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      placeholder="Add custom task (e.g., Inspect drip laterals)"
                      className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <input
                      type="date"
                      value={newTaskDue}
                      onChange={(e) => setNewTaskDue(e.target.value)}
                      className="px-3 py-2 rounded-lg border border-[#DCE8DC]"
                    />
                    <button
                      type="submit"
                      className="px-4 py-2 rounded-lg bg-[#063D2A] text-white font-semibold"
                    >
                      Add Task
                    </button>
                  </form>

                  <div className="space-y-3">
                    {(fieldDetails?.tasks || []).length === 0 ? (
                      <p className="text-xs text-[#52635C]">
                        No tasks scheduled yet. Approve a rotation plan or add a custom task.
                      </p>
                    ) : (
                      fieldDetails!.tasks.map((t) => (
                        <div key={t.id} className="p-4 rounded-xl border border-[#DCE8DC] bg-[#F8FBF6]/60 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-xs font-mono-tabular text-[#075A36]">
                                {t.category} · Due {t.due_date} · {t.status}
                              </div>
                              <div className="font-bold text-sm">{t.title}</div>
                              <p className="text-xs text-[#52635C] mt-0.5">{t.reason}</p>
                            </div>
                            {t.status !== 'COMPLETED' && (
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPostponingTaskId(null);
                                    setCompletingTaskId(completingTaskId === t.id ? null : t.id);
                                  }}
                                  className="px-3 py-1.5 rounded-lg bg-[#A7F33C] text-[#03152B] font-bold text-xs"
                                >
                                  Complete
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCompletingTaskId(null);
                                    setPostponingTaskId(postponingTaskId === t.id ? null : t.id);
                                  }}
                                  className="px-2.5 py-1.5 rounded-lg border border-[#DCE8DC] bg-white text-[#10251D] font-semibold text-xs hover:bg-[#F8FBF6]"
                                >
                                  Postpone
                                </button>
                              </div>
                            )}
                          </div>

                          {t.farmer_feedback && (
                            <div className="text-xs text-[#063D2A] bg-emerald-50 border border-emerald-200 rounded-lg p-2">
                              Recorded Feedback: {t.farmer_feedback}
                            </div>
                          )}

                          {completingTaskId === t.id && (
                            <div className="flex gap-2 pt-1">
                              <input
                                value={taskFeedback}
                                onChange={(e) => setTaskFeedback(e.target.value)}
                                placeholder="What was observed in the field?"
                                className="flex-1 px-3 py-1.5 rounded-lg border border-[#DCE8DC] text-xs bg-white"
                              />
                              <button
                                type="button"
                                onClick={() => handleCompleteTask(t.id)}
                                className="px-3 py-1.5 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
                              >
                                Save
                              </button>
                            </div>
                          )}

                          {postponingTaskId === t.id && (
                            <div className="flex flex-wrap gap-2 pt-1">
                              <input
                                type="date"
                                value={postponeDate}
                                onChange={(e) => setPostponeDate(e.target.value)}
                                className="px-2.5 py-1.5 rounded-lg border border-[#DCE8DC] text-xs bg-white"
                              />
                              <input
                                value={postponeReason}
                                onChange={(e) => setPostponeReason(e.target.value)}
                                placeholder="Reason for postponing (e.g., rain delay)"
                                className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg border border-[#DCE8DC] text-xs bg-white"
                              />
                              <button
                                type="button"
                                onClick={() => handlePostponeTask(t.id)}
                                className="px-3 py-1.5 rounded-lg bg-[#063D2A] text-white text-xs font-semibold"
                              >
                                Reschedule
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="lg:col-span-5 bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-3">
                  <h2 className="font-display font-bold text-base">Persistent Field Timeline</h2>
                  <div className="space-y-3 max-h-[520px] overflow-y-auto">
                    {(fieldDetails?.timeline || []).map((ev) => (
                      <div key={ev.id} className="p-3 rounded-xl bg-[#F8FBF6] border border-[#DCE8DC] text-xs">
                        <div className="font-mono-tabular text-[11px] text-[#52635C]">
                          {ev.created_at.slice(0, 16)} · {ev.event_type}
                        </div>
                        <div className="font-bold text-[#10251D] mt-0.5">{ev.title}</div>
                        <p className="text-[#52635C] mt-0.5">{ev.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ===============================================================
                TAB: AI FARM ASSISTANT
            =============================================================== */}
            {activeTab === 'assistant' && (
              <div className="bg-white rounded-2xl border border-[#DCE8DC] p-5 space-y-4 max-w-3xl">
                <div>
                  <h2 className="font-display font-bold text-lg">Evidence-Grounded AI Farm Assistant</h2>
                  <p className="text-xs text-[#52635C]">
                    Retrieves your actual field history, NASA observations, and solver outputs before
                    answering. Distinguishes measured facts from model explanations.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {[
                    'What crop did I grow previously and why was this Rabi option suggested?',
                    'What NASA environmental data and missing inputs exist for this field?',
                    'What tasks are due next?',
                  ].map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setChatInput(q)}
                      className="px-3 py-1.5 rounded-lg bg-[#F8FBF6] hover:bg-[#E9F7E4] border border-[#DCE8DC] text-xs text-left"
                    >
                      {q}
                    </button>
                  ))}
                </div>

                <div className="space-y-3 max-h-96 overflow-y-auto p-3 rounded-xl bg-[#F8FBF6] border border-[#DCE8DC]">
                  {chatHistory.length === 0 ? (
                    <p className="text-xs text-[#52635C]">
                      Ask a question about {currentField?.name || 'your field'} below.
                    </p>
                  ) : (
                    chatHistory.map((m) => {
                      const ev = m.evidence_json ? JSON.parse(m.evidence_json) : null;
                      return (
                        <div
                          key={m.id}
                          className={`p-3.5 rounded-xl text-xs whitespace-pre-wrap ${
                            m.role === 'user'
                              ? 'bg-[#063D2A] text-white ml-8'
                              : 'bg-white border border-[#DCE8DC] text-[#10251D] mr-4'
                          }`}
                        >
                          <div>{m.content}</div>
                          {ev?.citations && (
                            <div className="mt-2 pt-2 border-t border-[#DCE8DC] text-[10px] text-[#52635C]">
                              Mode: {ev.mode} · Citations: {ev.citations.join(' | ')}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                <form onSubmit={handleAskAssistant} className="flex gap-2">
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Ask about your field rotation, budget, soil, or NASA observations..."
                    className="flex-1 px-3.5 py-2.5 rounded-lg border border-[#DCE8DC] text-sm"
                  />
                  <button
                    type="submit"
                    disabled={chatLoading || !selectedFieldId}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#063D2A] text-white text-xs font-semibold disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {chatLoading ? 'Thinking...' : 'Ask'}
                  </button>
                </form>
              </div>
            )}
          </>
        )}
      </div>
    </WorkspaceShell>
  );
}
