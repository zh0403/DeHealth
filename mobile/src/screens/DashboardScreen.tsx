import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Bytes32 } from "@dehealth/shared";
import { DailyTargetAssessment } from "../services/profileEngine";

export interface DashboardScreenProps {
  readonly streakCount: number;
  readonly tokenBalanceDht: string;
  readonly lastProofHash: Bytes32 | null;
  readonly targetAssessment: DailyTargetAssessment;
}

export const DashboardScreen: React.FC<DashboardScreenProps> = ({
  streakCount,
  tokenBalanceDht,
  lastProofHash,
  targetAssessment
}) => {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>DeHealth Athlete Vault</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Active Streak</Text>
        <Text style={styles.metricValue}>{streakCount} Days</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Local $DHT Balance</Text>
        <Text style={styles.metricValue}>{tokenBalanceDht} DHT</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>
          Daily Target ({targetAssessment.fitnessTier})
        </Text>
        <Text style={styles.metricValue}>
          {targetAssessment.adjustedSteps} steps / {targetAssessment.adjustedActiveMinutes} min
        </Text>
        {targetAssessment.isFatigueScaled ? (
          <Text style={styles.fatigueBadge}>
            Recovery Mode Active (-30% threshold after &gt;48h gap)
          </Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Last EIP-712 Telemetry Hash</Text>
        <Text
          style={styles.hashText}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {lastProofHash ?? "No proof recorded yet"}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0F17",
    padding: 20
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#F8FAFC",
    marginBottom: 16
  },
  card: {
    backgroundColor: "#161F30",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12
  },
  label: {
    fontSize: 12,
    color: "#94A3B8",
    textTransform: "uppercase",
    marginBottom: 4
  },
  metricValue: {
    fontSize: 20,
    fontWeight: "600",
    color: "#38BDF8"
  },
  fatigueBadge: {
    marginTop: 6,
    fontSize: 12,
    color: "#FBBF24"
  },
  hashText: {
    fontSize: 13,
    fontFamily: "monospace",
    color: "#E2E8F0"
  }
});
