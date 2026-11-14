import crypto from 'node:crypto';
import type {
  CropCatalogueItem,
  FarmDecisionContext,
  RotationAnalysisResult,
  StrategyEvaluation,
} from '../../shared/types';

export const ENGINE_ALGORITHM_VERSION = 'KhetPatch-CSP-1.2.0';

function waterLevelToNumeric(level: 'Low' | 'Moderate' | 'High'): number {
  if (level === 'Low') return 1;
  if (level === 'Moderate') return 2;
  return 3;
}

function farmerWaterToMaxSupported(water: 'Rainfed' | 'Limited' | 'Irrigated'): number {
  if (water === 'Rainfed') return 1;
  if (water === 'Limited') return 2;
  return 3;
}

export interface CropConstraintResult {
  crop: CropCatalogueItem;
  feasible: boolean;
  passed: string[];
  failed: string[];
  softScore: number;
  totalCostInr: number | null;
  costPerAcreInr: number | null;
  budgetFits: boolean | null;
  remainingBudgetInr: number | null;
  indicativeRevenueInr: number | null;
  indicativeMarginInr: number | null;
  marketRefUsed: string | null;
  tradeOffs: string[];
  missingInfo: string[];
}

export function evaluateCropAgainstContext(
  crop: CropCatalogueItem,
  context: FarmDecisionContext
): CropConstraintResult {
  const passed: string[] = [];
  const failed: string[] = [];
  const tradeOffs: string[] = [];
  const missingInfo: string[] = [];
  let softScore = 50;

  // 1. Season compatibility & Target Planting Date (Hard constraint)
  if (crop.suitableSeasons.includes(context.planningSeason)) {
    passed.push(`Season Match: Suitable for ${context.planningSeason} (${crop.sowingWindow})`);
  } else {
    failed.push(
      `Season Mismatch: ${crop.name} grows in ${crop.suitableSeasons.join('/')}, not ${context.planningSeason}`
    );
  }

  const plantingDate = context.farmerRequirements.targetPlantingDate;
  if (plantingDate) {
    const parsedDate = new Date(plantingDate);
    if (!Number.isNaN(parsedDate.getTime())) {
      const month = parsedDate.getUTCMonth() + 1; // 1..12
      const seasonMonths: Record<string, number[]> = {
        Kharif: [5, 6, 7, 8, 9],
        Rabi: [10, 11, 12, 1],
        Zaid: [2, 3, 4, 5],
        Annual: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      };
      const allowedMonths = crop.suitableSeasons.flatMap((s) => seasonMonths[s] || []);
      if (allowedMonths.includes(month)) {
        passed.push(`Planting Date Fit: ${plantingDate} aligns with ${crop.sowingWindow}`);
      } else {
        failed.push(
          `Planting Date Outside Sowing Window: ${plantingDate} (month ${month}) falls outside ${crop.name} window (${crop.sowingWindow})`
        );
      }
    }
  }

  // 2. Farmer explicit avoid list (Hard constraint)
  const avoidLower = context.farmerRequirements.avoidCrops.map((c) => c.trim().toLowerCase());
  if (avoidLower.includes(crop.name.toLowerCase())) {
    failed.push(`Farmer Exclusion: Farmer explicitly excluded ${crop.name}`);
  }

  // 3. Water availability (Hard constraint)
  const cropWaterReq = waterLevelToNumeric(crop.waterNeedLevel);
  const availableWaterCap = farmerWaterToMaxSupported(
    context.farmerRequirements.waterAvailability
  );
  if (cropWaterReq <= availableWaterCap) {
    passed.push(
      `Water Feasibility: ${crop.waterNeedLevel} demand (~${crop.waterNeedMm} mm) fits ${context.farmerRequirements.waterAvailability} water supply`
    );
  } else {
    failed.push(
      `Water Constraint: ${crop.name} requires ${crop.waterNeedLevel} water (~${crop.waterNeedMm} mm), exceeding ${context.farmerRequirements.waterAvailability} capability`
    );
  }

  // 4. Crop-family rotation break rule (Hard constraint for consecutive identical crop / heavy pest family)
  const recentHistory = context.fieldHistory.previousCrops.slice(0, 2);
  const lastCrop = recentHistory[0];
  const currentCrop = context.fieldHistory.currentCrop;

  const sameFamilyLast =
    lastCrop && lastCrop.cropFamily.toLowerCase() === crop.cropFamily.toLowerCase();
  const sameCropCurrent =
    currentCrop && currentCrop.trim().toLowerCase() === crop.name.toLowerCase();

  if (sameCropCurrent && crop.rotationBreakSeasons >= 1) {
    failed.push(
      `Monoculture / Rotation Break Violation: Repeating ${crop.name} immediately after current ${currentCrop} violates ${crop.rotationBreakSeasons}-season break rule (${crop.sourceReference})`
    );
  } else if (sameFamilyLast && crop.rotationBreakSeasons >= 1 && !crop.nitrogenFixer) {
    failed.push(
      `Family Rotation Break: ${crop.cropFamily} family follows recent ${lastCrop.cropName} (${lastCrop.cropFamily}); high pest/disease carry-over risk`
    );
  } else if (sameFamilyLast && crop.nitrogenFixer) {
    tradeOffs.push(
      `Same family (${crop.cropFamily}) as previous ${lastCrop.cropName}; legume-after-legume lowers rotation diversity benefit.`
    );
    softScore -= 12;
  } else {
    passed.push(
      lastCrop
        ? `Rotation Break Satisfied: ${crop.cropFamily} rotates cleanly after ${lastCrop.cropName} (${lastCrop.cropFamily})`
        : 'Rotation Break Satisfied: No conflicting immediate prior crop family recorded'
    );
    if (lastCrop && lastCrop.cropFamily !== crop.cropFamily) {
      softScore += 18;
    }
  }

  // 5. Soil pH check (if measured or entered; never fabricate if missing)
  if (context.soilProfile.ph !== null) {
    const ph = context.soilProfile.ph;
    if (ph >= crop.idealPhMin && ph <= crop.idealPhMax) {
      passed.push(
        `Soil pH Compatible: Field pH ${ph} (${context.soilProfile.sourceLabel}) within ideal ${crop.idealPhMin}–${crop.idealPhMax}`
      );
      softScore += 8;
    } else if (Math.abs(ph - crop.idealPhMin) <= 0.5 || Math.abs(ph - crop.idealPhMax) <= 0.5) {
      tradeOffs.push(
        `Marginal Soil pH (${ph} vs ideal ${crop.idealPhMin}–${crop.idealPhMax}); gypsum/organic amendment review advised.`
      );
      softScore -= 5;
    } else {
      failed.push(
        `Soil pH Incompatible: Field pH ${ph} is outside tolerable range (${crop.idealPhMin}–${crop.idealPhMax})`
      );
    }
  } else {
    missingInfo.push('Laboratory soil test (pH, Organic Carbon, NPK) not yet recorded for this field.');
  }

  // 5b. Soil Type & Agroclimatic Zone Compatibility
  if (context.soilProfile.soilType) {
    const fieldSoilLower = context.soilProfile.soilType.toLowerCase();
    const soilMatch = crop.soilTypes.some(
      (s) => s.toLowerCase().includes(fieldSoilLower) || fieldSoilLower.includes(s.toLowerCase())
    );
    if (soilMatch) {
      passed.push(`Soil Texture Fit: ${context.soilProfile.soilType} matches ${crop.name} preference`);
      softScore += 5;
    } else {
      tradeOffs.push(
        `Soil texture (${context.soilProfile.soilType}) differs from ideal (${crop.soilTypes.join(', ')}); adjust tillage/drainage.`
      );
      softScore -= 6;
    }
  }

  const zoneLower = context.geography.agroclimaticZone.toLowerCase();
  const stateLower = context.geography.state.toLowerCase();
  const zoneMatch = crop.agroclimaticZones.some((z) => {
    const zl = z.toLowerCase();
    return zoneLower.includes(zl) || zl.includes(stateLower) || zl.includes('pan-india') || zl.includes('maharashtra') && stateLower.includes('maharashtra');
  });
  if (zoneMatch) {
    passed.push(`Regional Fit: Validated for ${context.geography.agroclimaticZone}`);
    softScore += 6;
  } else {
    tradeOffs.push(
      `Regional Calibration Caveat: ${crop.name} rule calibrated for ${crop.agroclimaticZones.join(', ')}; verify with local KVK in ${context.geography.district}.`
    );
    softScore -= 8;
  }

  // 6. Budget feasibility (Hard constraint when farmer budget & crop cost are known)
  const acres = Math.max(0.1, context.geography.fieldAreaAcres);
  const costPerAcreInr = crop.estimatedCostPerAcreInr;
  const totalCostInr =
    costPerAcreInr !== null ? Math.round(costPerAcreInr * acres) : null;

  let budgetFits: boolean | null = null;
  let remainingBudgetInr: number | null = null;

  if (totalCostInr !== null && context.farmerRequirements.maxBudgetInr !== null) {
    remainingBudgetInr = Math.round(context.farmerRequirements.maxBudgetInr - totalCostInr);
    if (totalCostInr <= context.farmerRequirements.maxBudgetInr) {
      budgetFits = true;
      passed.push(
        `Budget Feasible: Est. ₹${totalCostInr.toLocaleString('en-IN')} (${acres.toFixed(2)} ac @ ₹${costPerAcreInr?.toLocaleString('en-IN')}/ac) fits ₹${context.farmerRequirements.maxBudgetInr.toLocaleString('en-IN')} cap`
      );
      if (context.farmerRequirements.priorityFocus === 'Lower Cost') {
        softScore += Math.max(0, 20 - Math.round(totalCostInr / 5000));
      }
    } else {
      budgetFits = false;
      failed.push(
        `Budget Exceeded: Est. ₹${totalCostInr.toLocaleString('en-IN')} exceeds farmer budget ₹${context.farmerRequirements.maxBudgetInr.toLocaleString('en-IN')} by ₹${Math.abs(remainingBudgetInr).toLocaleString('en-IN')}`
      );
    }
  } else if (totalCostInr === null) {
    missingInfo.push(`Verified cultivation input cost reference missing for ${crop.name}.`);
  } else {
    missingInfo.push('Farmer cultivation budget cap not set; financial feasibility unverified.');
  }

  // 7. Weather & NASA Environmental alignment (Soft + risk flags)
  if (context.weatherContext.recent7dRainfallMm !== null) {
    if (context.weatherContext.recent7dRainfallMm > 120 && crop.waterNeedLevel === 'Low') {
      tradeOffs.push(
        `High recent rainfall (${context.weatherContext.recent7dRainfallMm} mm/7d): ensure field drainage before sowing ${crop.name}.`
      );
    }
    if (
      context.weatherContext.consecutiveDryDays !== null &&
      context.weatherContext.consecutiveDryDays >= 10 &&
      context.farmerRequirements.waterAvailability === 'Rainfed' &&
      crop.waterNeedLevel !== 'Low'
    ) {
      tradeOffs.push(
        `${context.weatherContext.consecutiveDryDays} consecutive dry days observed; rainfed establishment carries moisture stress risk.`
      );
      softScore -= 10;
    }
  } else {
    missingInfo.push('Live NASA/weather observation not yet fetched for this field location.');
  }

  if (context.weatherContext.maxTempC !== null && context.weatherContext.maxTempC >= 39) {
    tradeOffs.push(
      `High heat observed (${context.weatherContext.maxTempC}°C): heat-sensitive flowering stages require sowing-window care.`
    );
  }

  // 8. Soft agronomic stewardship objectives
  if (crop.nitrogenFixer) {
    softScore += 15;
    if (context.farmerRequirements.priorityFocus === 'Soil Health') softScore += 12;
    tradeOffs.push('Biological nitrogen-fixing legume improves soil nitrogen balance for the subsequent crop.');
  }

  if (crop.waterNeedLevel === 'Low' && context.farmerRequirements.priorityFocus === 'Water Saving') {
    softScore += 16;
  }

  if (
    context.farmerRequirements.preferredCrops
      .map((c) => c.toLowerCase())
      .includes(crop.name.toLowerCase())
  ) {
    softScore += 10;
  }

  // 9. Indicative market revenue (only if BOTH reference yield and market price exist — never invent)
  let indicativeRevenueInr: number | null = null;
  let indicativeMarginInr: number | null = null;
  let marketRefUsed: string | null = null;

  const matchingPrice = context.marketContext.availablePrices.find((p) =>
    p.commodity.toLowerCase().includes(crop.name.toLowerCase()) ||
    crop.name.toLowerCase().includes(p.commodity.toLowerCase())
  );

  if (matchingPrice && crop.referenceYieldQPerAcre !== null) {
    indicativeRevenueInr = Math.round(
      crop.referenceYieldQPerAcre * acres * matchingPrice.modalPriceInrPerQuintal
    );
    if (totalCostInr !== null) {
      indicativeMarginInr = indicativeRevenueInr - totalCostInr;
    }
    marketRefUsed = `${matchingPrice.market} (${matchingPrice.arrivalDate}, ₹${matchingPrice.modalPriceInrPerQuintal}/q, ${matchingPrice.sourceType})`;
  } else {
    missingInfo.push(
      `Live mandi price or validated regional yield reference unavailable for ${crop.name}; gross revenue omitted.`
    );
  }

  return {
    crop,
    feasible: failed.length === 0,
    passed,
    failed,
    softScore,
    totalCostInr,
    costPerAcreInr,
    budgetFits,
    remainingBudgetInr,
    indicativeRevenueInr,
    indicativeMarginInr,
    marketRefUsed,
    tradeOffs,
    missingInfo,
  };
}

function toStrategyEvaluation(
  strategyType: 'EXISTING' | 'MINIMAL_CHANGE' | 'ALTERNATIVE',
  title: string,
  evalResult: CropConstraintResult | null,
  context: FarmDecisionContext,
  unavailableReason: string | null
): StrategyEvaluation {
  if (!evalResult) {
    return {
      strategyType,
      title,
      feasible: false,
      proposedCrop: null,
      cropFamily: null,
      sowingWindow: null,
      durationDays: null,
      estimatedTotalCostInr: null,
      estimatedCostPerAcreInr: null,
      costBreakdown: null,
      budgetFits: null,
      remainingBudgetInr: null,
      indicativeGrossRevenueInr: null,
      indicativeMarginInr: null,
      waterCompatibility: 'Unavailable',
      soilStewardshipNote: 'No candidate satisfied all mandatory agronomic and budget constraints.',
      hardConstraintsPassed: [],
      hardConstraintsFailed: [unavailableReason || 'No feasible option found'],
      softTradeOffs: [],
      missingInformation: context.missingInformation,
      evidenceUsed: context.evidenceReferences,
      rationale:
        unavailableReason ||
        'Insufficient feasible candidates after enforcing season, rotation break, water, and budget constraints.',
      unavailableReason: unavailableReason || 'No feasible option available under current constraints.',
    };
  }

  const c = evalResult.crop;
  let parsedBreakdown: StrategyEvaluation['costBreakdown'] = null;
  if (c.costBreakdownJson) {
    try {
      const raw = JSON.parse(c.costBreakdownJson) as Record<string, unknown>;
      parsedBreakdown = {
        seeds: Number(raw.seeds || 0),
        landPrep: Number(raw.landPrep || 0),
        fertilizer: Number(raw.fertilizer || 0),
        irrigation: Number(raw.irrigation || 0),
        laborAndHarvest: Number(
          raw.laborAndHarvest ?? Number(raw.labor || 0) + Number(raw.protectionAndHarvest || 0)
        ),
      };
    } catch {
      parsedBreakdown = null;
    }
  }

  return {
    strategyType,
    title,
    feasible: evalResult.feasible,
    proposedCrop: c.name,
    cropFamily: c.cropFamily,
    sowingWindow: c.sowingWindow,
    durationDays: `${c.durationDaysMin}–${c.durationDaysMax} days`,
    estimatedTotalCostInr: evalResult.totalCostInr,
    estimatedCostPerAcreInr: evalResult.costPerAcreInr,
    costBreakdown: parsedBreakdown,
    budgetFits: evalResult.budgetFits,
    remainingBudgetInr: evalResult.remainingBudgetInr,
    indicativeGrossRevenueInr: evalResult.indicativeRevenueInr,
    indicativeMarginInr: evalResult.indicativeMarginInr,
    waterCompatibility: `${c.waterNeedLevel} (~${c.waterNeedMm} mm) vs ${context.farmerRequirements.waterAvailability}`,
    soilStewardshipNote: c.nitrogenFixer
      ? `Nitrogen-fixing ${c.cropFamily} (${c.rootDepth} roots) supports soil nitrogen replenishment.`
      : `${c.rootDepth}-rooted ${c.cropFamily} crop; monitor organic carbon & NPK balance.`,
    hardConstraintsPassed: evalResult.passed,
    hardConstraintsFailed: evalResult.failed,
    softTradeOffs: evalResult.tradeOffs,
    missingInformation: [...new Set([...context.missingInformation, ...evalResult.missingInfo])],
    evidenceUsed: [
      ...context.evidenceReferences,
      `Agronomic Rule: ${c.sourceReference} (${c.sourceYear})`,
      ...(evalResult.marketRefUsed ? [`Market Reference: ${evalResult.marketRefUsed}`] : []),
    ],
    rationale: evalResult.feasible
      ? `${c.name} (${c.cropFamily}) satisfies ${context.planningSeason} sowing, rotation break, water, and budget constraints for ${context.geography.district}.`
      : `${c.name} violates ${evalResult.failed.length} hard constraint(s): ${evalResult.failed.join('; ')}`,
    unavailableReason: evalResult.feasible ? null : evalResult.failed.join('; '),
  };
}

export function generateThreeRotationStrategies(
  context: FarmDecisionContext,
  catalogue: CropCatalogueItem[]
): RotationAnalysisResult {
  const evaluated = catalogue.map((crop) => evaluateCropAgainstContext(crop, context));

  // Strategy 1: EXISTING ROTATION — evaluate the farmer's current/baseline crop (or preferred crop if no current crop)
  const baselineName =
    context.fieldHistory.currentCrop ||
    context.farmerRequirements.preferredCrops[0] ||
    context.fieldHistory.previousCrops[0]?.cropName ||
    null;

  const existingEval = baselineName
    ? evaluated.find((e) => e.crop.name.toLowerCase() === baselineName.toLowerCase()) || null
    : null;

  const existingStrategy = toStrategyEvaluation(
    'EXISTING',
    'Existing Rotation',
    existingEval,
    context,
    baselineName
      ? `Baseline crop "${baselineName}" is not yet in the verified regional crop catalogue.`
      : 'No current or previous baseline crop has been recorded for this field.'
  );

  // Filter strictly feasible candidates for Minimal Change and Alternative
  const feasibleCandidates = evaluated
    .filter((e) => e.feasible)
    .sort((a, b) => b.softScore - a.softScore);

  // Strategy 2: MINIMAL CHANGE ROTATION
  // Prefer a feasible crop with lower/moderate cost, familiar water tier, or matching farmer preference,
  // avoiding repeating an unfeasible existing crop.
  const minimalCandidate =
    feasibleCandidates.find(
      (e) =>
        e.crop.name !== existingEval?.crop.name &&
        (context.farmerRequirements.preferredCrops
          .map((p) => p.toLowerCase())
          .includes(e.crop.name.toLowerCase()) ||
          e.crop.waterNeedLevel !== 'High')
    ) ||
    feasibleCandidates.find((e) => e.crop.name !== existingEval?.crop.name) ||
    feasibleCandidates[0] ||
    null;

  const minimalStrategy = toStrategyEvaluation(
    'MINIMAL_CHANGE',
    'Minimal Change Rotation',
    minimalCandidate,
    context,
    minimalCandidate
      ? null
      : `No feasible minimal-change crop passed all hard constraints for ${context.planningSeason} (check budget, water availability, and crop history).`
  );

  // Strategy 3: ALTERNATIVE ROTATION
  // Prefer a distinct crop family from both existing and minimal-change, prioritizing nitrogen fixation & diversity.
  const altCandidate =
    feasibleCandidates
      .filter(
        (e) =>
          e.crop.name !== minimalCandidate?.crop.name &&
          e.crop.cropFamily !== minimalCandidate?.crop.cropFamily
      )
      .sort((a, b) => {
        const aBonus = (a.crop.nitrogenFixer ? 20 : 0) + a.softScore;
        const bBonus = (b.crop.nitrogenFixer ? 20 : 0) + b.softScore;
        return bBonus - aBonus;
      })[0] ||
    feasibleCandidates.find((e) => e.crop.name !== minimalCandidate?.crop.name) ||
    null;

  const altStrategy = toStrategyEvaluation(
    'ALTERNATIVE',
    'Alternative Rotation',
    altCandidate,
    context,
    altCandidate
      ? null
      : 'No second distinct feasible crop family satisfies all seasonal, water, and budget constraints.'
  );

  return {
    analysisId: crypto.randomUUID(),
    contextId: context.contextId,
    contextVersion: context.contextVersion,
    algorithmVersion: ENGINE_ALGORITHM_VERSION,
    generatedAt: new Date().toISOString(),
    planningSeason: context.planningSeason,
    strategies: [existingStrategy, minimalStrategy, altStrategy],
  };
}
