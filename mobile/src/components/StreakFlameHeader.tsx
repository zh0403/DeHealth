import { Address } from "@dehealth/shared";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

export interface StreakFlameHeaderProps {
  readonly userAddress: Address;
  readonly streakCount: number;
  readonly tokenBalanceDht: string;
  readonly isFatigueScaled: boolean;
  readonly fitnessTier?: string;
  readonly onOpenPerksDrawer?: () => void;
}

export const StreakFlameHeader: React.FC<StreakFlameHeaderProps> = ({
  userAddress,
  streakCount,
  tokenBalanceDht,
  isFatigueScaled,
  fitnessTier,
  onOpenPerksDrawer
}) => {
  return (
    <View style={styles.headerContainer}>
      {/* Top Bar: Brand, DHT Token Capsule & Wallet Chip */}
      <View style={styles.topRow}>
        <View style={styles.brandGroup}>
          <Text style={styles.brandIcon}>⚡</Text>
          <Text style={styles.brandTitle}>DeHealth</Text>
        </View>

        <View style={styles.rightGroup}>
          {/* $DHT Token Capsule with Perk Drawer Trigger */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open Reward Perks Drawer"
            style={({ pressed }) => [
              styles.dhtCapsule,
              pressed ? styles.capsulePressed : null
            ]}
            onPress={onOpenPerksDrawer}
          >
            <Text style={styles.dhtIcon}>💎</Text>
            <Text style={styles.dhtBalance}>{tokenBalanceDht} DHT</Text>
            <Text style={styles.perkArrow}>›</Text>
          </Pressable>

          {/* User Address Chip */}
          <Text style={styles.walletChip} numberOfLines={1} ellipsizeMode="middle">
            {userAddress}
          </Text>
        </View>
      </View>

      {/* Gamification Bar: Active Streak Flame & Adaptive Shield Badge */}
      <View style={styles.gamificationRow}>
        {/* Active Streak Flame */}
        <View style={styles.streakFlameContainer}>
          <Text style={styles.flameIcon}>🔥</Text>
          <View>
            <Text style={styles.streakCountText}>{streakCount} Day Streak</Text>
            <Text style={styles.streakSubtext}>Habit Streak Active</Text>
          </View>
        </View>

        {/* Adaptive Shield Badge */}
        <View
          style={[
            styles.shieldBadge,
            isFatigueScaled ? styles.shieldFatigue : styles.shieldStandard
          ]}
        >
          <Text style={styles.shieldIcon}>{isFatigueScaled ? "🛡️" : "⚔️"}</Text>
          <Text
            style={[
              styles.shieldText,
              isFatigueScaled ? styles.shieldTextFatigue : styles.shieldTextStandard
            ]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {isFatigueScaled
              ? "Adaptive Guard Active: -30% fatigue scaling applied"
              : `Standard Goal${fitnessTier ? ` (${fitnessTier})` : ""}`}
          </Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  headerContainer: {
    backgroundColor: "#0F172A",
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10
  },
  brandGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6
  },
  brandIcon: {
    fontSize: 18,
    color: "#38BDF8"
  },
  brandTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#F8FAFC",
    letterSpacing: 0.3
  },
  rightGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  dhtCapsule: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1E293B",
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#38BDF8",
    gap: 4
  },
  capsulePressed: {
    opacity: 0.75,
    backgroundColor: "#253347"
  },
  dhtIcon: {
    fontSize: 12
  },
  dhtBalance: {
    fontSize: 12,
    fontWeight: "700",
    color: "#38BDF8"
  },
  perkArrow: {
    fontSize: 13,
    color: "#94A3B8",
    fontWeight: "700",
    marginLeft: 1
  },
  walletChip: {
    maxWidth: 96,
    fontSize: 11,
    fontFamily: "monospace",
    color: "#94A3B8",
    backgroundColor: "#161F30",
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden"
  },
  gamificationRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#161F30",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#1E293B",
    gap: 8
  },
  streakFlameContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8
  },
  flameIcon: {
    fontSize: 22
  },
  streakCountText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#F97316"
  },
  streakSubtext: {
    fontSize: 10,
    color: "#94A3B8",
    fontWeight: "500"
  },
  shieldBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    gap: 4,
    flex: 1,
    justifyContent: "flex-end"
  },
  shieldStandard: {
    backgroundColor: "rgba(16, 185, 129, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.3)"
  },
  shieldFatigue: {
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.4)"
  },
  shieldIcon: {
    fontSize: 11
  },
  shieldText: {
    fontSize: 10,
    fontWeight: "700"
  },
  shieldTextStandard: {
    color: "#34D399"
  },
  shieldTextFatigue: {
    color: "#FBBF24"
  }
});
