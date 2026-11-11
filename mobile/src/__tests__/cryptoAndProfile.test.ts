import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  createDeHealthDomain,
  TelemetryData,
  UserProfile,
  WorkoutProof
} from "@dehealth/shared";
import { ethers, Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import {
  computeWorkoutProofDigest,
  hashTelemetry,
  signWorkoutProof,
  verifyWorkoutProofSignature
} from "../services/cryptoService";
import {
  calculateBaselineTarget,
  evaluateDailyTarget,
  FATIGUE_GAP_THRESHOLD_MS,
  scaleTargetForInactivityGap
} from "../services/profileEngine";
import {
  EncryptedStorageAdapter,
  KeyValueStorageBackend
} from "../storage/encryptedStorageAdapter";

class InMemoryStorageBackend implements KeyValueStorageBackend {
  private readonly store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  getRaw(key: string): string | undefined {
    return this.store.get(key);
  }

  setRaw(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("Mobile Client Crypto & Profile Unit Test Suite", () => {
  describe("EncryptedStorageAdapter", () => {
    it("successfully encrypts and decrypts complex data with roundtrip parity", async () => {
      const backend = new InMemoryStorageBackend();
      const adapter = new EncryptedStorageAdapter("SuperSecretPassphrase123!", backend);

      const payload = { userId: "user-42", streak: 7, biometrics: { bodyFat: 17.5 } };
      await adapter.setEncryptedItem("session", payload);

      const decrypted = await adapter.getEncryptedItem<typeof payload>("session");
      expect(decrypted).toEqual(payload);
    });

    it("returns null for non-existent key", async () => {
      const backend = new InMemoryStorageBackend();
      const adapter = new EncryptedStorageAdapter("PassphraseValid123!", backend);

      const result = await adapter.getEncryptedItem("missing-key");
      expect(result).toBeNull();
    });

    it("instantiates with default backend parameter", () => {
      const adapter = new EncryptedStorageAdapter("ValidPassphraseDefault123!");
      expect(adapter).toBeInstanceOf(EncryptedStorageAdapter);
    });

    it("detects ciphertext tampering via HMAC verification failure", async () => {
      const backend = new InMemoryStorageBackend();
      const adapter = new EncryptedStorageAdapter("TamperDetectionPassphrase99!", backend);

      await adapter.setEncryptedItem("tamper-test", { secret: "health-data" });
      const raw = backend.getRaw("tamper-test");
      expect(raw).toBeDefined();

      const envelope = JSON.parse(raw!);
      // Tamper ciphertext
      envelope.ciphertext = envelope.ciphertext.slice(0, -2) + "ff";
      backend.setRaw("tamper-test", JSON.stringify(envelope));

      await expect(adapter.getEncryptedItem("tamper-test")).rejects.toThrow(
        "tampering detected"
      );
    });

    it("rejects passphrases shorter than 8 characters", () => {
      expect(() => new EncryptedStorageAdapter("short")).toThrow(
        "at least 8 characters"
      );
    });

    it("removes encrypted items cleanly", async () => {
      const backend = new InMemoryStorageBackend();
      const adapter = new EncryptedStorageAdapter("PassphraseCleanRemoval123!", backend);

      await adapter.setEncryptedItem("to-delete", { foo: "bar" });
      await adapter.removeEncryptedItem("to-delete");

      const result = await adapter.getEncryptedItem("to-delete");
      expect(result).toBeNull();
    });

    it("detects corrupted envelope structure", async () => {
      const backend = new InMemoryStorageBackend();
      const adapter = new EncryptedStorageAdapter("PassphraseCorrupt123!", backend);

      backend.setRaw("corrupt-key", JSON.stringify({ invalid: true }));
      await expect(adapter.getEncryptedItem("corrupt-key")).rejects.toThrow(
        "Corrupted encrypted storage envelope"
      );
    });
  });

  describe("CryptoService", () => {
    const validTelemetry: TelemetryData = {
      timestampMs: 1731320000000,
      stepCount: 10500,
      activeMinutes: 45,
      avgHeartRateBpm: 142.25,
      caloriesBurnedKcal: 520.5,
      profileSnapshot: {
        age: 29,
        gender: "Male",
        bodyFatPct: 18.5,
        muscleMassKg: 62.0
      }
    };

    it("deterministically computes Keccak-256 hash matching regex format", () => {
      const hash1 = hashTelemetry(validTelemetry);
      const hash2 = hashTelemetry(validTelemetry);

      expect(hash1).toEqual(hash2);
      expect(hash1).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("normalizes float precision and gender casing in telemetry hashing", () => {
      const telA: TelemetryData = {
        ...validTelemetry,
        profileSnapshot: { ...validTelemetry.profileSnapshot, gender: "MALE", bodyFatPct: 18.500 }
      };
      const telB: TelemetryData = {
        ...validTelemetry,
        profileSnapshot: { ...validTelemetry.profileSnapshot, gender: "male", bodyFatPct: 18.5 }
      };

      expect(hashTelemetry(telA)).toEqual(hashTelemetry(telB));
    });

    it("computes EIP-712 typed data digest matching TypedDataEncoder", () => {
      const dummyGate = "0x1111111111111111111111111111111111111111";
      const proof: WorkoutProof = {
        user: "0x2222222222222222222222222222222222222222",
        telemetryHash: hashTelemetry(validTelemetry),
        streakCount: 5n,
        nonce: 1n,
        deadline: 1893456000n
      };

      const digest = computeWorkoutProofDigest(proof, dummyGate, ARBITRUM_SEPOLIA_CHAIN_ID);
      expect(digest).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("signs WorkoutProof and verifies signature roundtrip", async () => {
      const wallet = Wallet.createRandom();
      const dummyGate = "0x1111111111111111111111111111111111111111";
      const proof: WorkoutProof = {
        user: wallet.address as `0x${string}`,
        telemetryHash: hashTelemetry(validTelemetry),
        streakCount: 1n,
        nonce: 0n,
        deadline: 1893456000n
      };

      const signedPayload = await signWorkoutProof(wallet, proof, dummyGate, 31337);
      expect(signedPayload.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);

      const isValid = verifyWorkoutProofSignature(signedPayload, dummyGate, 31337);
      expect(isValid).toBe(true);
    });

    it("rejects signature verification when signed by different wallet", async () => {
      const realUser = Wallet.createRandom();
      const attacker = Wallet.createRandom();
      const dummyGate = "0x1111111111111111111111111111111111111111";

      const proof: WorkoutProof = {
        user: realUser.address as `0x${string}`,
        telemetryHash: hashTelemetry(validTelemetry),
        streakCount: 1n,
        nonce: 0n,
        deadline: 1893456000n
      };

      // Attacker signs proof where proof.user = realUser
      const signedPayload = await signWorkoutProof(attacker, proof, dummyGate, 31337);
      const isValid = verifyWorkoutProofSignature(signedPayload, dummyGate, 31337);
      expect(isValid).toBe(false);
    });
  });

  describe("ProfileEngine", () => {
    it("classifies athletic profile as high-output with age bonus", () => {
      const profile: UserProfile = { age: 25, gender: "female", bodyFatPct: 16, muscleMassKg: 55 };
      const target = calculateBaselineTarget(profile);

      expect(target.fitnessTier).toBe("high-output");
      expect(target.baselineSteps).toBe(10500); // 10000 + 500
      expect(target.baselineActiveMinutes).toBe(45);
    });

    it("classifies high body fat profile as metabolic-rebuild", () => {
      const profile: UserProfile = { age: 40, gender: "male", bodyFatPct: 32, muscleMassKg: 40 };
      const target = calculateBaselineTarget(profile);

      expect(target.fitnessTier).toBe("metabolic-rebuild");
      expect(target.baselineSteps).toBe(6500);
      expect(target.baselineActiveMinutes).toBe(25);
    });

    it("applies age deduction for athletes over 50", () => {
      const profile: UserProfile = { age: 55, gender: "male", bodyFatPct: 22, muscleMassKg: 50 };
      const target = calculateBaselineTarget(profile);

      expect(target.baselineSteps).toBe(7000); // 8000 - 1000
    });

    it("does NOT scale target when inactivity gap is exactly 48 hours", () => {
      const T0 = 1000000000;
      const T1 = T0 + FATIGUE_GAP_THRESHOLD_MS; // exactly 48h

      const res = scaleTargetForInactivityGap(8000, T0, T1);
      expect(res.isFatigueScaled).toBe(false);
      expect(res.adjustedTarget).toBe(8000);
    });

    it("decrements target by 30% when inactivity gap strictly exceeds 48 hours", () => {
      const T0 = 1000000000;
      const T1 = T0 + FATIGUE_GAP_THRESHOLD_MS + 1000; // 48h + 1s

      const res = scaleTargetForInactivityGap(8000, T0, T1);
      expect(res.isFatigueScaled).toBe(true);
      expect(res.adjustedTarget).toBe(5600); // 8000 * 0.70
      expect(res.scalingFactorApplied).toBe(0.7);
    });

    it("retains baseline target for first-time user (lastLog null)", () => {
      const res = scaleTargetForInactivityGap(8000, null, 1731320000000);
      expect(res.isFatigueScaled).toBe(false);
      expect(res.adjustedTarget).toBe(8000);
    });

    it("throws when currentTimestampMs precedes lastLogTimestampMs", () => {
      expect(() => scaleTargetForInactivityGap(8000, 2000, 1000)).toThrow(
        "cannot precede lastLogTimestampMs"
      );
    });

    it("throws when baseline target is not positive", () => {
      expect(() => scaleTargetForInactivityGap(0, null, 1000)).toThrow(
        "must be a positive number"
      );
    });

    it("evaluates complete daily target combining baseline and fatigue scaling", () => {
      const profile: UserProfile = { age: 28, gender: "male", bodyFatPct: 15, muscleMassKg: 65 };
      const T0 = 1731320000000;
      const T1 = T0 + 72 * 3600 * 1000; // 72 hours later

      const evaluation = evaluateDailyTarget(profile, T0, T1);
      expect(evaluation.fitnessTier).toBe("high-output");
      expect(evaluation.isFatigueScaled).toBe(true);
      expect(evaluation.adjustedSteps).toBe(7350); // Math.round(10500 * 0.7)
      expect(evaluation.adjustedActiveMinutes).toBe(31); // Math.round(45 * 0.70) in IEEE 754 is 31
    });
  });
});
