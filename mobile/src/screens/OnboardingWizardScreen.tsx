import {
  ActivityLevel,
  AdaptivePlanCycle,
  DEFAULT_BASELINE_BIOMETRICS,
  FitnessGoal,
  GenderType,
  UserBiometrics,
  UserBiometricsSchema
} from "@dehealth/shared";
import React, { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import {
  calculateBmr,
  calculateMacroSplit,
  calculateTargetCalories,
  calculateTdee,
  generate14DayPlan
} from "../services/adaptivePlanEngine";
import {
  saveActivePlanCycle,
  saveUserBiometrics
} from "../storage/adaptiveStorage";

export type WizardStep = 1 | 2 | 3;

export interface OnboardingFormInputs {
  goal: FitnessGoal;
  gender: GenderType;
  ageStr: string;
  weightStr: string;
  heightStr: string;
  bodyFatStr?: string;
  weeklyWorkoutFrequency: number;
}

export interface ValidationResult {
  isValid: boolean;
  error: string | null;
  biometrics?: UserBiometrics;
}

const GENDER_OPTIONS: readonly GenderType[] = ["male", "female", "other"];
const FREQUENCY_OPTIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * Step navigation helpers for the 3-step wizard.
 */
export function getWizardNextStep(current: WizardStep): WizardStep {
  if (current >= 3) return 3;
  return (current + 1) as WizardStep;
}

export function getWizardPrevStep(current: WizardStep): WizardStep {
  if (current <= 1) return 1;
  return (current - 1) as WizardStep;
}

/**
 * Validates onboarding form inputs against physiology domain boundaries.
 */
export function validateOnboardingInputs(
  inputs: Partial<OnboardingFormInputs>
): ValidationResult {
  const ageStr = inputs.ageStr?.trim() ?? "";
  const weightStr = inputs.weightStr?.trim() ?? "";
  const heightStr = inputs.heightStr?.trim() ?? "";

  const age = Number(ageStr);
  const weightKg = Number(weightStr);
  const heightCm = Number(heightStr);

  if (
    ageStr === "" ||
    weightStr === "" ||
    heightStr === "" ||
    Number.isNaN(age) ||
    Number.isNaN(weightKg) ||
    Number.isNaN(heightCm)
  ) {
    return {
      isValid: false,
      error: "Please enter valid numbers for age, weight, and height."
    };
  }

  if (!Number.isInteger(age) || age < 13 || age > 120) {
    return {
      isValid: false,
      error: "Age must be between 13 and 120 years."
    };
  }

  if (weightKg < 30 || weightKg > 300) {
    return {
      isValid: false,
      error: "Weight must be between 30 and 300 kg."
    };
  }

  if (heightCm < 100 || heightCm > 250) {
    return {
      isValid: false,
      error: "Height must be between 100 and 250 cm."
    };
  }

  let bodyFatPct: number | undefined;
  if (inputs.bodyFatStr !== undefined && inputs.bodyFatStr.trim() !== "") {
    const parsedBf = Number(inputs.bodyFatStr.trim());
    if (Number.isNaN(parsedBf) || parsedBf < 2 || parsedBf > 75) {
      return {
        isValid: false,
        error: "Body fat % must be between 2% and 75%."
      };
    }
    bodyFatPct = parsedBf;
  }

  const weeklyWorkoutFrequency = inputs.weeklyWorkoutFrequency ?? 3;
  if (
    !Number.isInteger(weeklyWorkoutFrequency) ||
    weeklyWorkoutFrequency < 1 ||
    weeklyWorkoutFrequency > 7
  ) {
    return {
      isValid: false,
      error: "Workout frequency must be between 1 and 7 days per week."
    };
  }

  const activityLevel: ActivityLevel =
    weeklyWorkoutFrequency <= 2
      ? "light"
      : weeklyWorkoutFrequency <= 4
        ? "moderate"
        : weeklyWorkoutFrequency <= 6
          ? "heavy"
          : "very_active";

  const goal: FitnessGoal = inputs.goal ?? "maintain";
  const gender: GenderType = inputs.gender ?? "male";

  const candidate = {
    age,
    gender,
    weightKg,
    heightCm,
    bodyFatPct,
    weeklyWorkoutFrequency,
    goal,
    activityLevel,
    updatedAtMs: Date.now()
  };

  const parsed = UserBiometricsSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      isValid: false,
      error: parsed.error.issues[0]?.message ?? "Invalid biometrics data."
    };
  }

  return {
    isValid: true,
    error: null,
    biometrics: parsed.data
  };
}

export interface OnboardingWizardScreenProps {
  readonly onOnboardingComplete: (
    biometrics: UserBiometrics,
    plan: AdaptivePlanCycle
  ) => void | Promise<void>;
  readonly initialBiometrics?: UserBiometrics | null;
  /** Optional storage injection for testing and isolation */
  readonly storage?: {
    readonly saveUserBiometrics: (biometrics: UserBiometrics) => Promise<void>;
    readonly saveActivePlanCycle: (cycle: AdaptivePlanCycle) => Promise<void>;
  };
}

export const OnboardingWizardScreen: React.FC<OnboardingWizardScreenProps> = ({
  onOnboardingComplete,
  initialBiometrics,
  storage
}) => {
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);
  const [goal, setGoal] = useState<FitnessGoal>(
    initialBiometrics?.goal ?? "maintain"
  );
  const [gender, setGender] = useState<GenderType>(
    initialBiometrics?.gender ?? "male"
  );
  const [ageStr, setAgeStr] = useState<string>(
    initialBiometrics ? String(initialBiometrics.age) : "28"
  );
  const [weightStr, setWeightStr] = useState<string>(
    initialBiometrics ? String(initialBiometrics.weightKg) : "70.0"
  );
  const [heightStr, setHeightStr] = useState<string>(
    initialBiometrics ? String(initialBiometrics.heightCm) : "175.0"
  );
  const [bodyFatStr, setBodyFatStr] = useState<string>(
    initialBiometrics?.bodyFatPct !== undefined
      ? String(initialBiometrics.bodyFatPct)
      : ""
  );
  const [weeklyWorkoutFrequency, setWeeklyWorkoutFrequency] = useState<number>(
    initialBiometrics?.weeklyWorkoutFrequency ?? 3
  );

  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Live physiology preview on Step 3
  const previewValues = useMemo(() => {
    const validation = validateOnboardingInputs({
      goal,
      gender,
      ageStr,
      weightStr,
      heightStr,
      bodyFatStr,
      weeklyWorkoutFrequency
    });
    const bio = validation.biometrics ?? DEFAULT_BASELINE_BIOMETRICS;
    const bmr = calculateBmr(bio);
    const tdee = calculateTdee(bmr, bio.weeklyWorkoutFrequency, bio.activityLevel);
    const calories = calculateTargetCalories(tdee, bio.goal);
    const macros = calculateMacroSplit(calories, bio.goal);
    return { bmr, tdee, calories, macros };
  }, [goal, gender, ageStr, weightStr, heightStr, bodyFatStr, weeklyWorkoutFrequency]);

  /**
   * "Skip for Now" bypass action handler: initializes baseline metrics,
   * generates 14-day cycle, saves to encrypted storage, and calls onOnboardingComplete.
   */
  const handleSkip = async (): Promise<void> => {
    setIsSubmitting(true);
    setValidationError(null);
    try {
      const bio = DEFAULT_BASELINE_BIOMETRICS;
      const plan = generate14DayPlan(bio, Date.now(), null);
      const storageService = storage ?? {
        saveUserBiometrics,
        saveActivePlanCycle
      };
      await storageService.saveUserBiometrics(bio);
      await storageService.saveActivePlanCycle(plan);
      await onOnboardingComplete(bio, plan);
    } catch (err) {
      setValidationError(
        err instanceof Error ? err.message : "Failed to save baseline biometrics"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Completes the onboarding flow with the user-provided inputs.
   */
  const handleComplete = async (): Promise<void> => {
    const result = validateOnboardingInputs({
      goal,
      gender,
      ageStr,
      weightStr,
      heightStr,
      bodyFatStr,
      weeklyWorkoutFrequency
    });

    if (!result.isValid || !result.biometrics) {
      setValidationError(result.error ?? "Please check your inputs.");
      return;
    }

    setIsSubmitting(true);
    setValidationError(null);
    try {
      const bio = result.biometrics;
      const plan = generate14DayPlan(bio, Date.now(), null);
      const storageService = storage ?? {
        saveUserBiometrics,
        saveActivePlanCycle
      };
      await storageService.saveUserBiometrics(bio);
      await storageService.saveActivePlanCycle(plan);
      await onOnboardingComplete(bio, plan);
    } catch (err) {
      setValidationError(
        err instanceof Error ? err.message : "Failed to generate adaptive plan"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Next step action handler with per-step validation.
   */
  const handleNext = async (): Promise<void> => {
    if (currentStep === 1) {
      setValidationError(null);
      setCurrentStep(2);
      return;
    }

    if (currentStep === 2) {
      const validation = validateOnboardingInputs({
        goal,
        gender,
        ageStr,
        weightStr,
        heightStr,
        bodyFatStr,
        weeklyWorkoutFrequency
      });
      if (!validation.isValid) {
        setValidationError(validation.error);
        return;
      }
      setValidationError(null);
      setCurrentStep(3);
      return;
    }

    if (currentStep === 3) {
      await handleComplete();
    }
  };

  const handleBack = (): void => {
    setValidationError(null);
    setCurrentStep(getWizardPrevStep(currentStep));
  };

  return (
    <ScrollView
      testID="onboarding-wizard-screen"
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header with Title and Prominent Skip for Now button */}
      <View style={styles.header}>
        <View style={styles.headerTextGroup}>
          <Text testID="wizard-step-title" style={styles.title}>
            {currentStep === 1 && "Select Your Fitness Goal"}
            {currentStep === 2 && "Enter Your Biometrics"}
            {currentStep === 3 && "Training Schedule & Nutrition"}
          </Text>
          <Text testID="wizard-step-indicator" style={styles.stepSubtitle}>
            Step {currentStep} of 3
          </Text>
        </View>

        <Pressable
          testID="skip-button"
          onPress={handleSkip}
          disabled={isSubmitting}
          style={({ pressed }) => [
            styles.skipButton,
            pressed ? styles.buttonPressed : null
          ]}
        >
          <Text style={styles.skipButtonText}>Skip for Now</Text>
        </Pressable>
      </View>

      {/* Progress Dots */}
      <View style={styles.progressBar}>
        <View
          style={[
            styles.progressDot,
            currentStep >= 1 ? styles.progressDotActive : null
          ]}
        />
        <View
          style={[
            styles.progressDot,
            currentStep >= 2 ? styles.progressDotActive : null
          ]}
        />
        <View
          style={[
            styles.progressDot,
            currentStep >= 3 ? styles.progressDotActive : null
          ]}
        />
      </View>

      {/* Validation Error Banner */}
      {validationError ? (
        <View style={styles.errorBanner}>
          <Text testID="validation-error" style={styles.errorText}>
            {validationError}
          </Text>
        </View>
      ) : null}

      {/* Step 1: Goal Selection */}
      {currentStep === 1 ? (
        <View testID="step-1-goals" style={styles.stepContainer}>
          <Text style={styles.sectionHeading}>What is your primary focus?</Text>

          <Pressable
            testID="goal-cut"
            onPress={() => setGoal("cut")}
            style={({ pressed }) => [
              styles.optionCard,
              goal === "cut" ? styles.optionCardActive : null,
              pressed ? styles.buttonPressed : null
            ]}
          >
            <View style={styles.optionHeader}>
              <Text style={styles.optionEmoji}>🔥</Text>
              <Text style={styles.optionTitle}>Fat Loss / Cut</Text>
            </View>
            <Text style={styles.optionDescription}>
              Caloric deficit (-500 kcal/day) with high-protein target to maximize fat loss while preserving lean muscle mass.
            </Text>
          </Pressable>

          <Pressable
            testID="goal-maintain"
            onPress={() => setGoal("maintain")}
            style={({ pressed }) => [
              styles.optionCard,
              goal === "maintain" ? styles.optionCardActive : null,
              pressed ? styles.buttonPressed : null
            ]}
          >
            <View style={styles.optionHeader}>
              <Text style={styles.optionEmoji}>⚖️</Text>
              <Text style={styles.optionTitle}>Maintenance</Text>
            </View>
            <Text style={styles.optionDescription}>
              Caloric equilibrium with balanced macronutrients to sustain current weight, athletic conditioning, and performance.
            </Text>
          </Pressable>

          <Pressable
            testID="goal-bulk"
            onPress={() => setGoal("bulk")}
            style={({ pressed }) => [
              styles.optionCard,
              goal === "bulk" ? styles.optionCardActive : null,
              pressed ? styles.buttonPressed : null
            ]}
          >
            <View style={styles.optionHeader}>
              <Text style={styles.optionEmoji}>💪</Text>
              <Text style={styles.optionTitle}>Muscle Gain / Bulk</Text>
            </View>
            <Text style={styles.optionDescription}>
              Caloric surplus (+350 kcal/day) designed to support hypertrophy, strength progression, and muscular recovery.
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Step 2: Biometrics Form */}
      {currentStep === 2 ? (
        <View testID="step-2-biometrics" style={styles.stepContainer}>
          <Text style={styles.sectionHeading}>Biological Parameters</Text>

          {/* Gender Selector */}
          <Text style={styles.inputLabel}>Biological Gender</Text>
          <View style={styles.pillRow}>
            {GENDER_OPTIONS.map((g) => (
              <Pressable
                key={g}
                testID={`gender-${g}`}
                onPress={() => setGender(g)}
                style={({ pressed }) => [
                  styles.pillButton,
                  gender === g ? styles.pillButtonActive : null,
                  pressed ? styles.buttonPressed : null
                ]}
              >
                <Text
                  style={[
                    styles.pillButtonText,
                    gender === g ? styles.pillButtonTextActive : null
                  ]}
                >
                  {g === "male" ? "Male" : g === "female" ? "Female" : "Other"}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Age Input */}
          <Text style={styles.inputLabel}>Age (years)</Text>
          <TextInput
            testID="input-age"
            keyboardType="number-pad"
            value={ageStr}
            onChangeText={setAgeStr}
            placeholder="e.g. 28"
            placeholderTextColor="#64748B"
            style={styles.textInput}
          />

          {/* Weight Input */}
          <Text style={styles.inputLabel}>Weight (kg)</Text>
          <TextInput
            testID="input-weight"
            keyboardType="decimal-pad"
            value={weightStr}
            onChangeText={setWeightStr}
            placeholder="e.g. 70.0"
            placeholderTextColor="#64748B"
            style={styles.textInput}
          />

          {/* Height Input */}
          <Text style={styles.inputLabel}>Height (cm)</Text>
          <TextInput
            testID="input-height"
            keyboardType="decimal-pad"
            value={heightStr}
            onChangeText={setHeightStr}
            placeholder="e.g. 175.0"
            placeholderTextColor="#64748B"
            style={styles.textInput}
          />

          {/* Body Fat % (Optional) */}
          <Text style={styles.inputLabel}>Body Fat % (Optional)</Text>
          <TextInput
            testID="input-bodyfat"
            keyboardType="decimal-pad"
            value={bodyFatStr}
            onChangeText={setBodyFatStr}
            placeholder="e.g. 15.0"
            placeholderTextColor="#64748B"
            style={styles.textInput}
          />
        </View>
      ) : null}

      {/* Step 3: Frequency & Summary */}
      {currentStep === 3 ? (
        <View testID="step-3-frequency" style={styles.stepContainer}>
          <Text style={styles.sectionHeading}>Weekly Workout Frequency</Text>
          <Text style={styles.inputDescription}>
            How many days per week do you plan to train?
          </Text>

          {/* Frequency 1-7 Pill Selector */}
          <View style={styles.frequencyRow}>
            {FREQUENCY_OPTIONS.map((num) => (
              <Pressable
                key={num}
                testID={`frequency-option-${num}`}
                onPress={() => setWeeklyWorkoutFrequency(num)}
                style={({ pressed }) => [
                  styles.frequencyPill,
                  weeklyWorkoutFrequency === num
                    ? styles.frequencyPillActive
                    : null,
                  pressed ? styles.buttonPressed : null
                ]}
              >
                <Text
                  style={[
                    styles.frequencyPillText,
                    weeklyWorkoutFrequency === num
                      ? styles.frequencyPillTextActive
                      : null
                  ]}
                >
                  {num}d
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Live Physiology Preview Card */}
          <View
            testID="onboarding-summary-card"
            style={styles.summaryCard}
          >
            <Text style={styles.summaryHeading}>Physiology Blueprint Preview</Text>

            <View style={styles.summaryGrid}>
              <View style={styles.summaryGridItem}>
                <Text style={styles.summaryLabel}>BMR</Text>
                <Text style={styles.summaryValue}>{previewValues.bmr} kcal</Text>
              </View>
              <View style={styles.summaryGridItem}>
                <Text style={styles.summaryLabel}>TDEE</Text>
                <Text style={styles.summaryValue}>{previewValues.tdee} kcal</Text>
              </View>
              <View style={styles.summaryGridItem}>
                <Text style={styles.summaryLabel}>Target Calories</Text>
                <Text style={[styles.summaryValue, styles.highlightValue]}>
                  {previewValues.calories} kcal/d
                </Text>
              </View>
            </View>

            <View style={styles.macroSplitRow}>
              <View style={styles.macroItem}>
                <Text style={styles.macroLabel}>Protein</Text>
                <Text style={styles.macroValue}>
                  {previewValues.macros.proteinGrams}g
                </Text>
              </View>
              <View style={styles.macroItem}>
                <Text style={styles.macroLabel}>Carbs</Text>
                <Text style={styles.macroValue}>
                  {previewValues.macros.carbsGrams}g
                </Text>
              </View>
              <View style={styles.macroItem}>
                <Text style={styles.macroLabel}>Fat</Text>
                <Text style={styles.macroValue}>
                  {previewValues.macros.fatGrams}g
                </Text>
              </View>
            </View>

            <Text style={styles.sovereigntyNote}>
              🔒 100% Data Sovereignty: All biometrics and nutrition targets remain encrypted locally on this device.
            </Text>
          </View>
        </View>
      ) : null}

      {/* Navigation Footer */}
      <View style={styles.footer}>
        {currentStep > 1 ? (
          <Pressable
            testID="back-button"
            onPress={handleBack}
            disabled={isSubmitting}
            style={({ pressed }) => [
              styles.backButton,
              pressed ? styles.buttonPressed : null
            ]}
          >
            <Text style={styles.backButtonText}>Back</Text>
          </Pressable>
        ) : null}

        <Pressable
          testID="next-button"
          onPress={handleNext}
          disabled={isSubmitting}
          style={({ pressed }) => [
            styles.nextButton,
            currentStep === 1 ? styles.nextButtonFull : null,
            pressed ? styles.buttonPressed : null
          ]}
        >
          <Text style={styles.nextButtonText}>
            {isSubmitting
              ? "Generating Plan..."
              : currentStep === 3
                ? "Complete & Generate Plan"
                : "Continue"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0F17"
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16
  },
  headerTextGroup: {
    flex: 1,
    marginRight: 12
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#F8FAFC",
    marginBottom: 4
  },
  stepSubtitle: {
    fontSize: 13,
    color: "#94A3B8"
  },
  skipButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "rgba(56, 189, 248, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(56, 189, 248, 0.3)"
  },
  skipButtonText: {
    color: "#38BDF8",
    fontSize: 13,
    fontWeight: "600"
  },
  progressBar: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 20
  },
  progressDot: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#1E293B"
  },
  progressDotActive: {
    backgroundColor: "#38BDF8"
  },
  errorBanner: {
    backgroundColor: "rgba(244, 63, 94, 0.15)",
    borderColor: "#F43F5E",
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16
  },
  errorText: {
    color: "#F87171",
    fontSize: 13,
    fontWeight: "500"
  },
  stepContainer: {
    marginBottom: 24
  },
  sectionHeading: {
    fontSize: 16,
    fontWeight: "600",
    color: "#E2E8F0",
    marginBottom: 14
  },
  optionCard: {
    backgroundColor: "#0F172A",
    borderColor: "#1E293B",
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12
  },
  optionCardActive: {
    borderColor: "#38BDF8",
    backgroundColor: "#161F30"
  },
  optionHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6
  },
  optionEmoji: {
    fontSize: 20,
    marginRight: 10
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#F8FAFC"
  },
  optionDescription: {
    fontSize: 13,
    color: "#94A3B8",
    lineHeight: 18
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: "500",
    color: "#CBD5E1",
    marginBottom: 6,
    marginTop: 8
  },
  inputDescription: {
    fontSize: 13,
    color: "#94A3B8",
    marginBottom: 12
  },
  textInput: {
    backgroundColor: "#0F172A",
    borderColor: "#1E293B",
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    color: "#F8FAFC",
    fontSize: 15,
    marginBottom: 10
  },
  pillRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12
  },
  pillButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1E293B",
    alignItems: "center"
  },
  pillButtonActive: {
    borderColor: "#38BDF8",
    backgroundColor: "rgba(56, 189, 248, 0.15)"
  },
  pillButtonText: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "600"
  },
  pillButtonTextActive: {
    color: "#38BDF8"
  },
  frequencyRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 16
  },
  frequencyPill: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1E293B",
    alignItems: "center"
  },
  frequencyPillActive: {
    borderColor: "#38BDF8",
    backgroundColor: "rgba(56, 189, 248, 0.15)"
  },
  frequencyPillText: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "600"
  },
  frequencyPillTextActive: {
    color: "#38BDF8"
  },
  summaryCard: {
    backgroundColor: "#0F172A",
    borderColor: "#1E293B",
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginTop: 8
  },
  summaryHeading: {
    fontSize: 14,
    fontWeight: "600",
    color: "#E2E8F0",
    marginBottom: 12
  },
  summaryGrid: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B"
  },
  summaryGridItem: {
    flex: 1,
    alignItems: "center"
  },
  summaryLabel: {
    fontSize: 11,
    color: "#94A3B8",
    marginBottom: 4,
    textTransform: "uppercase"
  },
  summaryValue: {
    fontSize: 14,
    fontWeight: "600",
    color: "#F8FAFC"
  },
  highlightValue: {
    color: "#38BDF8"
  },
  macroSplitRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: "#161F30",
    borderRadius: 10,
    padding: 10,
    marginBottom: 12
  },
  macroItem: {
    alignItems: "center"
  },
  macroLabel: {
    fontSize: 11,
    color: "#94A3B8",
    marginBottom: 2
  },
  macroValue: {
    fontSize: 14,
    fontWeight: "700",
    color: "#34D399"
  },
  sovereigntyNote: {
    fontSize: 11,
    color: "#64748B",
    lineHeight: 16,
    fontStyle: "italic",
    textAlign: "center"
  },
  footer: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8
  },
  backButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    backgroundColor: "#1E293B",
    alignItems: "center",
    justifyContent: "center"
  },
  backButtonText: {
    color: "#E2E8F0",
    fontSize: 15,
    fontWeight: "600"
  },
  nextButton: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    backgroundColor: "#38BDF8",
    alignItems: "center",
    justifyContent: "center"
  },
  nextButtonFull: {
    flex: 1
  },
  nextButtonText: {
    color: "#0B0F17",
    fontSize: 15,
    fontWeight: "700"
  },
  buttonPressed: {
    opacity: 0.75
  }
});
