import { Address } from "@dehealth/shared";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatShortAddress } from "../services/authService";
import { copyWalletAddressToClipboard } from "./ErrorNoticeModal";

export interface StreakFlameHeaderProps {
  readonly userAddress: Address;
  readonly streakCount: number;
  readonly tokenBalanceDht: string;
  readonly isFatigueScaled: boolean;
  readonly fitnessTier?: string;
  readonly onOpenPerksDrawer?: () => void;
  readonly onCopyWalletAddress?: (address: string) => Promise<void> | void;
}

export const StreakFlameHeader: React.FC<StreakFlameHeaderProps> = ({
  userAddress,
  streakCount,
  tokenBalanceDht,
  isFatigueScaled,
  fitnessTier,
  onOpenPerksDrawer,
  onCopyWalletAddress
}) => {
  const [isAddressCopied, setIsAddressCopied] = useState<boolean>(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef<boolean>(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  const handleCopyWalletAddress = async (): Promise<void> => {
    const copied = await copyWalletAddressToClipboard(userAddress);
    let customCopied = false;
    if (onCopyWalletAddress) {
      try {
        await Promise.resolve(onCopyWalletAddress(userAddress));
        customCopied = true;
      } catch {
        customCopied = false;
      }
    }

    if (!isMountedRef.current) {
      return;
    }

    if (copied || customCopied) {
      setIsAddressCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          setIsAddressCopied(false);
        }
        copyTimerRef.current = null;
      }, 2500);
    } else {
      setIsAddressCopied(false);
    }
  };

  return (
    <View style={styles.headerContainer}>
      {/* Top Bar: Brand, DHT Token Capsule & 1-Tap Copyable Wallet Pill */}
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

          {/* 1-Tap Copyable Wallet Address Pill */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy Wallet Address"
            testID="header-wallet-copy-pill"
            style={({ pressed }) => [
              styles.walletCopyPill,
              isAddressCopied ? styles.walletCopyPillCopied : null,
              pressed ? styles.walletCopyPillPressed : null
            ]}
            onPress={() => {
              void handleCopyWalletAddress();
            }}
          >
            <Text style={styles.walletCopyAddressText}>
              {formatShortAddress(userAddress)}
            </Text>
            <Text
              style={[
                styles.walletCopyBadgeText,
                isAddressCopied ? styles.walletCopyBadgeCopiedText : null
              ]}
            >
              {isAddressCopied ? "Copied ✓" : "Copy"}
            </Text>
          </Pressable>
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
  walletCopyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#161F30",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  walletCopyPillCopied: {
    borderColor: "#10B981",
    backgroundColor: "#052E16"
  },
  walletCopyPillPressed: {
    opacity: 0.78
  },
  walletCopyAddressText: {
    fontSize: 11,
    fontFamily: "monospace",
    fontWeight: "700",
    color: "#38BDF8"
  },
  walletCopyBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#94A3B8"
  },
  walletCopyBadgeCopiedText: {
    color: "#34D399"
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
