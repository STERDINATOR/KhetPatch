import type Database from 'better-sqlite3';
import {
  evaluateWeatherRisksForField,
  processOverdueTasks,
} from './contextAndFollowup';
import { refreshAllProvidersForLocation } from './nasaConnectors';

let workerTimer: NodeJS.Timeout | null = null;
let lastWeatherRefreshAt = 0;

const OVERDUE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
const WEATHER_REFRESH_COOLDOWN_MS = 60 * 60 * 1000; // once per hour per active farm

export async function runBackgroundFollowupTick(db: Database.Database): Promise<{
  overdueUpdated: number;
  farmsRefreshed: number;
}> {
  const overdueUpdated = processOverdueTasks(db);
  let farmsRefreshed = 0;

  const nowMs = Date.now();
  if (nowMs - lastWeatherRefreshAt >= WEATHER_REFRESH_COOLDOWN_MS) {
    lastWeatherRefreshAt = nowMs;
    const activeFarms = db
      .prepare('SELECT id, owner_user_id, latitude, longitude, state, district FROM farms WHERE archived = 0 LIMIT 5')
      .all() as Array<{
      id: string;
      owner_user_id: string;
      latitude: number;
      longitude: number;
      state: string;
      district: string;
    }>;

    for (const farm of activeFarms) {
      try {
        await refreshAllProvidersForLocation(db, {
          lat: farm.latitude,
          lon: farm.longitude,
          state: farm.state,
          district: farm.district,
          farmId: farm.id,
        });
        const fields = db
          .prepare('SELECT id FROM fields WHERE farm_id = ?')
          .all(farm.id) as Array<{ id: string }>;
        for (const fl of fields) {
          evaluateWeatherRisksForField(db, farm.id, fl.id, farm.owner_user_id);
        }
        farmsRefreshed++;
      } catch {
        // Non-fatal background refresh error; logged in provider_health / data_ingestion_runs
      }
    }
  }

  return { overdueUpdated, farmsRefreshed };
}

export function startBackgroundWorker(db: Database.Database): void {
  if (workerTimer || process.env.NODE_ENV === 'test') return;

  // Initial overdue check shortly after boot (non-blocking)
  setTimeout(() => {
    try {
      processOverdueTasks(db);
    } catch {
      // ignore boot check failure
    }
  }, 5000);

  workerTimer = setInterval(() => {
    void runBackgroundFollowupTick(db);
  }, OVERDUE_CHECK_INTERVAL_MS);

  workerTimer.unref();
}
