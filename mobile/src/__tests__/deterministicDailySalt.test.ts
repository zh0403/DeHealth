import { Bytes32, TelemetryData } from "@dehealth/shared";
import { describe, expect, it } from "vitest";
import {
  deriveDeterministicDailySalt,
  generateTelemetrySalt,
  hashTelemetry
} from "../services/cryptoService";
import {
  InMemoryKeyStore,
  getVaultSecret,
  provisionVaultSecret
} from "../storage/vaultKeyProvider";

describe("Milestone 1 NEW-01: Deterministic Daily Salt (HMAC-SHA256)", () => {
  const mockVaultSecret1 = "0x" + "a1".repeat(32);
  const mockVaultSecret2 = "0x" + "b2".repeat(32);
  const cycleA = "cycle_2026_spring_01";
  const cycleB = "cycle_2026_summer_02";

  const sampleTelemetry: TelemetryData = {
    timestampMs: 1_700_000_000_000,
    stepCount: 8_500,
    activeMinutes: 45,
    avgHeartRateBpm: 132.5,
    caloriesBurnedKcal: 420.75,
    profileSnapshot: {
      age: 29,
      gender: "female",
      bodyFatPct: 21.4,
      muscleMassKg: 31.2
    }
  };

  it("produces 100% byte-identical Bytes32 salt across multiple calls with same inputs", () => {
    const salt1 = deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 0);
    const salt2 = deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 0);

    expect(salt1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(salt1).toBe(salt2);
  });

  it("produces distinct salts when dayIndex varies (day 0 vs day 1 vs day 13)", () => {
    const saltDay0 = deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 0);
    const saltDay1 = deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 1);
    const saltDay13 = deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 13);

    expect(saltDay0).not.toBe(saltDay1);
    expect(saltDay1).not.toBe(saltDay13);
    expect(saltDay0).not.toBe(saltDay13);
  });

  it("produces distinct salts when cycleId varies with same secret and day", () => {
    const saltCycleA = deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 0);
    const saltCycleB = deriveDeterministicDailySalt(mockVaultSecret1, cycleB, 0);

    expect(saltCycleA).not.toBe(saltCycleB);
  });

  it("produces completely uncorrelated salts across different devices/vault secrets", () => {
    const saltDevice1 = deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 0);
    const saltDevice2 = deriveDeterministicDailySalt(mockVaultSecret2, cycleA, 0);

    expect(saltDevice1).not.toBe(saltDevice2);
  });

  it("enforces on-chain replay protection: retries for same cycle/day produce identical telemetryHash", () => {
    const dailySalt1 = deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 3);
    const dailySalt2 = deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 3);

    const commitment1 = hashTelemetry(sampleTelemetry, dailySalt1);
    const commitment2 = hashTelemetry(sampleTelemetry, dailySalt2);

    expect(commitment1.telemetryHash).toBe(commitment2.telemetryHash);
    expect(commitment1.salt).toBe(commitment2.salt);
  });

  it("generates different telemetryHash on ephemeral salts but identical on deterministic salt", () => {
    const randomSalt1 = generateTelemetrySalt();
    const randomSalt2 = generateTelemetrySalt();
    const ephemeral1 = hashTelemetry(sampleTelemetry, randomSalt1);
    const ephemeral2 = hashTelemetry(sampleTelemetry, randomSalt2);
    expect(ephemeral1.telemetryHash).not.toBe(ephemeral2.telemetryHash);

    const detSalt = deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 5);
    const retry1 = hashTelemetry(sampleTelemetry, detSalt);
    const retry2 = hashTelemetry(sampleTelemetry, detSalt);
    expect(retry1.telemetryHash).toBe(retry2.telemetryHash);
  });

  it("rejects invalid vaultSecretHex with Zod Bytes32 schema error", () => {
    expect(() => deriveDeterministicDailySalt("0x1234", cycleA, 0)).toThrow();
    expect(() => deriveDeterministicDailySalt("not-a-hex", cycleA, 0)).toThrow();
    expect(() => deriveDeterministicDailySalt("0x" + "zz".repeat(32), cycleA, 0)).toThrow();
  });

  it("rejects empty or whitespace-only cycleId", () => {
    expect(() => deriveDeterministicDailySalt(mockVaultSecret1, "", 0)).toThrow(
      "cycleId must be a non-empty string"
    );
    expect(() => deriveDeterministicDailySalt(mockVaultSecret1, "   ", 0)).toThrow(
      "cycleId must be a non-empty string"
    );
  });

  it("rejects negative dayIndex or non-integer values", () => {
    expect(() => deriveDeterministicDailySalt(mockVaultSecret1, cycleA, -1)).toThrow(
      "dayIndex must be a non-negative integer"
    );
    expect(() => deriveDeterministicDailySalt(mockVaultSecret1, cycleA, 2.5)).toThrow(
      "dayIndex must be a non-negative integer"
    );
    expect(() => deriveDeterministicDailySalt(mockVaultSecret1, cycleA, NaN)).toThrow(
      "dayIndex must be a non-negative integer"
    );
  });

  it("integrates seamlessly with getVaultSecret() and provisionVaultSecret()", async () => {
    const keyStore = new InMemoryKeyStore();
    const secret = await provisionVaultSecret(keyStore);
    const retrievedSecret = await getVaultSecret(keyStore);

    expect(retrievedSecret).toBe(secret);
    const salt = deriveDeterministicDailySalt(retrievedSecret, cycleA, 2);
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
