import { AnonymizedFeedRecord } from "@dehealth/shared";
import React, { useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";

export interface AnonymizedFeedScreenProps {
  readonly items: readonly AnonymizedFeedRecord[];
  readonly cheerCountsByFeedId?: Readonly<Record<string, number>>;
  readonly onCheer?: (feedId: string) => void;
}

const AVATAR_PALETTE = [
  { bg: "#0284C7", icon: "⚡" },
  { bg: "#EA580C", icon: "🔥" },
  { bg: "#059669", icon: "🏃" },
  { bg: "#7C3AED", icon: "💎" },
  { bg: "#DB2777", icon: "🦾" },
  { bg: "#D97706", icon: "🏋️" }
];

export const AnonymizedFeedScreen: React.FC<AnonymizedFeedScreenProps> = ({
  items,
  cheerCountsByFeedId = {},
  onCheer
}) => {
  const [cheeredMap, setCheeredMap] = useState<Readonly<Record<string, boolean>>>({});

  const handleCheerPress = (feedId: string) => {
    setCheeredMap((prev) => ({
      ...prev,
      [feedId]: true
    }));
    onCheer?.(feedId);
  };

  const getAvatarMeta = (pseudonym: string) => {
    let hash = 0;
    for (let i = 0; i < pseudonym.length; i++) {
      hash = (hash << 5) - hash + pseudonym.charCodeAt(i);
      hash |= 0;
    }
    const index = Math.abs(hash) % AVATAR_PALETTE.length;
    return AVATAR_PALETTE[index] ?? AVATAR_PALETTE[0]!;
  };

  return (
    <View style={styles.container}>
      {/* Screen Header */}
      <View style={styles.screenHeader}>
        <View>
          <Text style={styles.header}>Community Habit Feed</Text>
          <Text style={styles.subHeader}>
            Zero-knowledge social verification • Peer cheers validate daily habits
          </Text>
        </View>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>🛡️</Text>
            <Text style={styles.emptyTitle}>No Proofs Yet</Text>
            <Text style={styles.emptyText}>
              Be the first athlete to publish an on-chain habit commitment today!
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const cheerCount = cheerCountsByFeedId[item.id] ?? 0;
          const isCheered = cheeredMap[item.id] ?? false;
          const avatar = getAvatarMeta(item.user_pseudonym);

          return (
            <View style={styles.socialCard}>
              {/* Header: Avatar, Pseudonym & Milestone Tag */}
              <View style={styles.cardHeader}>
                <View
                  style={[
                    styles.avatarCircle,
                    { backgroundColor: avatar.bg }
                  ]}
                >
                  <Text style={styles.avatarIcon}>{avatar.icon}</Text>
                </View>

                <View style={styles.authorMeta}>
                  <Text style={styles.pseudonym}>@{item.user_pseudonym}</Text>
                  <Text style={styles.timestamp}>
                    {new Date(item.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                  </Text>
                </View>

                {/* Milestone Tag */}
                <View style={styles.milestoneTag}>
                  <Text style={styles.milestoneText}>
                    Hit {item.streak_count}-Day Streak! 🔥
                  </Text>
                </View>
              </View>

              {/* Verified Proof Badge & Cryptographic Commitment */}
              <View style={styles.proofBadgeRow}>
                <View style={styles.verifiedPill}>
                  <Text style={styles.verifiedIcon}>✓</Text>
                  <Text style={styles.verifiedText}>
                    Proof Verified On-Chain
                  </Text>
                </View>
                <Text style={styles.arbitrumTag}>Arbitrum Sepolia L2</Text>
              </View>

              <View style={styles.hashContainer}>
                <Text style={styles.hashLabel}>Keccak-256 Telemetry Hash:</Text>
                <Text
                  style={styles.proofHash}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {item.proof_hash}
                </Text>
              </View>

              {/* Footer: Interactive Cheer Button with Instant Feedback */}
              <View style={styles.cardFooter}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Cheer for @${item.user_pseudonym}`}
                  style={({ pressed }) => [
                    styles.cheerButton,
                    isCheered ? styles.cheerButtonActive : null,
                    pressed ? styles.buttonPressed : null
                  ]}
                  onPress={() => handleCheerPress(item.id)}
                >
                  <Text style={styles.cheerEmoji}>
                    {isCheered ? "🎉" : "👏"}
                  </Text>
                  <Text
                    style={[
                      styles.cheerButtonText,
                      isCheered ? styles.cheerTextActive : null
                    ]}
                  >
                    {isCheered ? "Cheered!" : "Cheer"} ({cheerCount})
                  </Text>
                </Pressable>

                <Text style={styles.zkAudit}>
                  Zero Biometric Disclosure Guaranteed
                </Text>
              </View>
            </View>
          );
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0F17"
  },
  screenHeader: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 10
  },
  header: {
    fontSize: 20,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 2
  },
  subHeader: {
    fontSize: 11,
    color: "#94A3B8",
    lineHeight: 15
  },
  listContent: {
    padding: 16,
    paddingTop: 6,
    paddingBottom: 24,
    gap: 12
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: 8
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#F8FAFC",
    marginBottom: 4
  },
  emptyText: {
    color: "#64748B",
    fontSize: 12,
    textAlign: "center",
    maxWidth: 240
  },
  socialCard: {
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10
  },
  avatarCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10
  },
  avatarIcon: {
    fontSize: 18
  },
  authorMeta: {
    flex: 1
  },
  pseudonym: {
    color: "#F8FAFC",
    fontWeight: "700",
    fontSize: 14
  },
  timestamp: {
    color: "#64748B",
    fontSize: 10
  },
  milestoneTag: {
    backgroundColor: "rgba(249, 115, 22, 0.15)",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#F97316"
  },
  milestoneText: {
    color: "#F97316",
    fontSize: 11,
    fontWeight: "800"
  },
  proofBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8
  },
  verifiedPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.4)",
    gap: 4
  },
  verifiedIcon: {
    color: "#10B981",
    fontSize: 11,
    fontWeight: "900"
  },
  verifiedText: {
    color: "#34D399",
    fontSize: 10,
    fontWeight: "700"
  },
  arbitrumTag: {
    fontSize: 10,
    color: "#64748B",
    fontFamily: "monospace"
  },
  hashContainer: {
    backgroundColor: "#0B0F17",
    padding: 8,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  hashLabel: {
    fontSize: 9,
    color: "#94A3B8",
    textTransform: "uppercase",
    marginBottom: 2
  },
  proofHash: {
    color: "#38BDF8",
    fontFamily: "monospace",
    fontSize: 11
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 4
  },
  cheerButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1E293B",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 6
  },
  cheerButtonActive: {
    backgroundColor: "rgba(56, 189, 248, 0.15)",
    borderColor: "#38BDF8"
  },
  buttonPressed: {
    opacity: 0.75
  },
  cheerEmoji: {
    fontSize: 13
  },
  cheerButtonText: {
    color: "#94A3B8",
    fontSize: 12,
    fontWeight: "700"
  },
  cheerTextActive: {
    color: "#38BDF8"
  },
  zkAudit: {
    fontSize: 9,
    color: "#64748B"
  }
});
