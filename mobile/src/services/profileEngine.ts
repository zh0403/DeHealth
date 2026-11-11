import { UserProfile, UserProfileSchema } from "@dehealth/shared";

export const FATIGUE_GAP_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours in milliseconds
export const FATIGUE_DECREMENT_RATIO = 0.3; // 30% reduction on >48h inactivity gap
export const FATIGUE_SCALING_MULTIPLIER = 1 - FATIGUE_DECREMENT_RATIO; // 0.70

export type FitnessTier = "metabolic-rebuild" | "balanced-conditioning" | "high-output";

export interface DailyTargetAssessment {
  readonly fitnessTier: FitnessTier;
  readonly baselineSteps: number;
  readonly baselineActiveMinutes: number;
  readonly adjustedSteps: number;
  readonly adjustedActiveMinutes: number;
  readonly isFatigueScaled: boolean;
  readonly hoursSinceLastLog: number | null;
  readonly scalingFactorApplied: number;
}

export type DailyTargetEvaluation = DailyTargetAssessment;

/**
 * Classifies a user's fitness tier and calculates baseline daily targets
 * from their biometric profile (age, gender, bodyFatPct, muscleMassKg).
 */
export function calculateBaselineTarget(profile: UserProfile): {
  readonly fitnessTier: FitnessTier;
  readonly baselineSteps: number;
  readonly baselineActiveMinutes: number;
} {
  const validated = UserProfileSchema.parse(profile);
  const muscleToFatRatio = validated.muscleMassKg / Math.max(validated.bodyFatPct, 5);
  const ageAdjustment = validated.age > 50 ? -1000 : validated.age < 30 ? 500 : 0;

  if (muscleToFatRatio >= 2.5 && validated.bodyFatPct <= 22) {
    return {
      fitnessTier: "high-output",
      baselineSteps: 10_000 + ageAdjustment,
      baselineActiveMinutes: 45
    };
  }

  if (validated.bodyFatPct >= 30 || muscleToFatRatio < 1.4) {
    return {
      fitnessTier: "metabolic-rebuild",
      baselineSteps: Math.max(5_000, 6_500 + ageAdjustment),
      baselineActiveMinutes: 25
    };
  }

  return {
    fitnessTier: "balanced-conditioning",
    baselineSteps: 8_000 + ageAdjustment,
    baselineActiveMinutes: 35
  };
}

/**
 * Applies the 48-hour inactivity fatigue rule:
 * If the gap since `lastLogTimestampMs` strictly exceeds 48 hours,
 * auto-decrements the daily target threshold by 30% to prevent user churn.
 */
export function scaleTargetForInactivityGap(
  baselineTarget: number,
  lastLogTimestampMs: number | null,
  currentTimestampMs: number
): {
  readonly adjustedTarget: number;
  readonly isFatigueScaled: boolean;
  readonly hoursSinceLastLog: number | null;
  readonly scalingFactorApplied: number;
} {
  if (baselineTarget <= 0) {
    throw new Error("Baseline target must be a positive number");
  }

  if (lastLogTimestampMs === null) {
    return {
      adjustedTarget: baselineTarget,
      isFatigueScaled: false,
      hoursSinceLastLog: null,
      scalingFactorApplied: 1.0
    };
  }

  if (currentTimestampMs < lastLogTimestampMs) {
    throw new Error("currentTimestampMs cannot precede lastLogTimestampMs");
  }

  const elapsedMs = currentTimestampMs - lastLogTimestampMs;
  const hoursSinceLastLog = Number((elapsedMs / (60 * 60 * 1000)).toFixed(2));

  if (elapsedMs > FATIGUE_GAP_THRESHOLD_MS) {
    return {
      adjustedTarget: Math.round(baselineTarget * FATIGUE_SCALING_MULTIPLIER),
      isFatigueScaled: true,
      hoursSinceLastLog,
      scalingFactorApplied: FATIGUE_SCALING_MULTIPLIER
    };
  }

  return {
    adjustedTarget: baselineTarget,
    isFatigueScaled: false,
    hoursSinceLastLog,
    scalingFactorApplied: 1.0
  };
}

/**
 * Full profile-sorting and fatigue-scaling pipeline combining biometric
 * baseline calculation and >48h churn-prevention target scaling.
 */
export function evaluateDailyTarget(
  profile: UserProfile,
  lastLogTimestampMs: number | null,
  currentTimestampMs: number
): DailyTargetAssessment {
  const baseline = calculateBaselineTarget(profile);
  const scaledSteps = scaleTargetForInactivityGap(
    baseline.baselineSteps,
    lastLogTimestampMs,
    currentTimestampMs
  );
  const scaledMinutes = scaleTargetForInactivityGap(
    baseline.baselineActiveMinutes,
    lastLogTimestampMs,
    currentTimestampMs
  );

  return {
    fitnessTier: baseline.fitnessTier,
    baselineSteps: baseline.baselineSteps,
    baselineActiveMinutes: baseline.baselineActiveMinutes,
    adjustedSteps: scaledSteps.adjustedTarget,
    adjustedActiveMinutes: scaledMinutes.adjustedTarget,
    isFatigueScaled: scaledSteps.isFatigueScaled,
    hoursSinceLastLog: scaledSteps.hoursSinceLastLog,
    scalingFactorApplied: scaledSteps.scalingFactorApplied
  };
}
