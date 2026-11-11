import { Address, SignedWorkoutClaimPayload, TelemetryData, WorkoutProof } from "@dehealth/shared";
import { Signer } from "ethers";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { hashTelemetry, signWorkoutProof } from "../services/cryptoService";

export interface MicroCheckInScreenProps {
  readonly userAddress: Address;
  readonly verifyingContract: Address;
  readonly currentStreak: number;
  readonly currentNonce: bigint;
  readonly signer: Signer;
  readonly collectTelemetry: () => TelemetryData;
  readonly onDispatchSignedClaim: (payload: SignedWorkoutClaimPayload) => Promise<void>;
}

export const MicroCheckInScreen: React.FC<MicroCheckInScreenProps> = ({
  userAddress,
  verifyingContract,
  currentStreak,
  currentNonce,
  signer,
  collectTelemetry,
  onDispatchSignedClaim
}) => {
  const [statusMessage, setStatusMessage] = useState<string>("Ready for 1-Tap Check-In");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const handleOneTapCheckIn = async (): Promise<void> => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      setStatusMessage("1/3 Hashing local biometric telemetry (Keccak-256)...");
      const telemetry = collectTelemetry();
      const telemetryHash = hashTelemetry(telemetry);

      setStatusMessage("2/3 Signing EIP-712 WorkoutProof...");
      const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const proof: WorkoutProof = {
        user: userAddress,
        telemetryHash,
        streakCount: BigInt(currentStreak + 1),
        nonce: currentNonce,
        deadline: deadlineSeconds
      };

      const signedPayload = await signWorkoutProof(signer, proof, verifyingContract);

      setStatusMessage("3/3 Dispatching proof to DeHealthRewardGate...");
      await onDispatchSignedClaim(signedPayload);
      setStatusMessage(`Verified! Proof ${telemetryHash.slice(0, 10)}... dispatched.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown signing error";
      setStatusMessage(`Check-in failed: ${message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Micro Habit Check-In</Text>
      <Text style={styles.subtitle}>
        Raw biometrics stay on-device. Only your 32-byte Keccak-256 digest and EIP-712 signature leave the phone.
      </Text>

      <Pressable
        style={[styles.button, isSubmitting ? styles.buttonDisabled : null]}
        onPress={() => {
          void handleOneTapCheckIn();
        }}
        disabled={isSubmitting}
      >
        <Text style={styles.buttonText}>
          {isSubmitting ? "Signing Proof..." : "1-Tap Habit Check-In"}
        </Text>
      </Pressable>

      <Text style={styles.status}>{statusMessage}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0F17",
    padding: 20,
    justifyContent: "center"
  },
  heading: {
    fontSize: 22,
    fontWeight: "700",
    color: "#F8FAFC",
    marginBottom: 8
  },
  subtitle: {
    fontSize: 14,
    color: "#94A3B8",
    marginBottom: 24
  },
  button: {
    backgroundColor: "#10B981",
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center"
  },
  buttonDisabled: {
    opacity: 0.5
  },
  buttonText: {
    color: "#052E16",
    fontSize: 16,
    fontWeight: "700"
  },
  status: {
    marginTop: 16,
    fontSize: 13,
    color: "#E2E8F0",
    textAlign: "center"
  }
});
