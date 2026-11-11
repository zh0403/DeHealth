import { AnonymizedFeedRecord } from "@dehealth/shared";
import React from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";

export interface AnonymizedFeedScreenProps {
  readonly items: readonly AnonymizedFeedRecord[];
  readonly cheerCountsByFeedId?: Readonly<Record<string, number>>;
}

export const AnonymizedFeedScreen: React.FC<AnonymizedFeedScreenProps> = ({
  items,
  cheerCountsByFeedId = {}
}) => {
  return (
    <View style={styles.container}>
      <Text style={styles.header}>Anonymized Proof Feed</Text>

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            No verified workout proofs published yet.
          </Text>
        }
        renderItem={({ item }) => {
          const cheerCount = cheerCountsByFeedId[item.id] ?? 0;
          return (
            <View style={styles.feedRow}>
              <View style={styles.rowHeader}>
                <Text style={styles.pseudonym}>@{item.user_pseudonym}</Text>
                <Text style={styles.streakBadge}>{item.streak_count}d streak</Text>
              </View>
              <Text
                style={styles.proofHash}
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                Proof: {item.proof_hash}
              </Text>
              <View style={styles.rowFooter}>
                <Text style={styles.timestamp}>{item.created_at}</Text>
                <Text style={styles.cheers}>{cheerCount} Peer Cheers</Text>
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
    backgroundColor: "#0B0F17",
    padding: 20
  },
  header: {
    fontSize: 22,
    fontWeight: "700",
    color: "#F8FAFC",
    marginBottom: 14
  },
  emptyText: {
    color: "#64748B",
    fontSize: 14,
    marginTop: 20
  },
  feedRow: {
    backgroundColor: "#161F30",
    borderRadius: 10,
    padding: 14,
    marginBottom: 10
  },
  rowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6
  },
  pseudonym: {
    color: "#F8FAFC",
    fontWeight: "600",
    fontSize: 15
  },
  streakBadge: {
    color: "#34D399",
    fontWeight: "700",
    fontSize: 13
  },
  proofHash: {
    color: "#94A3B8",
    fontFamily: "monospace",
    fontSize: 12,
    marginBottom: 6
  },
  rowFooter: {
    flexDirection: "row",
    justifyContent: "space-between"
  },
  timestamp: {
    color: "#64748B",
    fontSize: 11
  },
  cheers: {
    color: "#38BDF8",
    fontSize: 12,
    fontWeight: "600"
  }
});
