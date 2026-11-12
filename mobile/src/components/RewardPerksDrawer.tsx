import React, { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";

export interface PerkItem {
  readonly id: string;
  readonly title: string;
  readonly costDht: number;
  readonly category: string;
  readonly description: string;
  readonly icon: string;
  readonly codePrefix: string;
}

export const PERK_CATALOG: readonly PerkItem[] = [
  {
    id: "gym-pass",
    title: "Gym Pass Discount",
    costDht: 50,
    category: "Fitness Utility",
    description: "1-Day VIP Pass at Partner Gyms & Fitness Centers",
    icon: "🏋️",
    codePrefix: "GYM-VIP"
  },
  {
    id: "supplement-voucher",
    title: "Supplement Voucher",
    costDht: 25,
    category: "Nutrition",
    description: "$15 Off Whey, Creatine & Electrolyte Packs",
    icon: "🥤",
    codePrefix: "SUPP-VCH"
  },
  {
    id: "l2-wallet-export",
    title: "External L2 Wallet Export",
    costDht: 100,
    category: "Web3 Bridge",
    description: "Bridge $DHT to Arbitrum Sepolia On-Chain Vault",
    icon: "🌐",
    codePrefix: "ARB-L2"
  }
];

export interface RewardPerksDrawerProps {
  readonly visible: boolean;
  readonly tokenBalanceDht: string;
  readonly onClose: () => void;
  readonly onRedeemPerk: (costDht: number, perkTitle: string) => boolean;
}

export const RewardPerksDrawer: React.FC<RewardPerksDrawerProps> = ({
  visible,
  tokenBalanceDht,
  onClose,
  onRedeemPerk
}) => {
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [redeemedCode, setRedeemedCode] = useState<string | null>(null);

  const numericBalance = Number.parseFloat(tokenBalanceDht);

  const handleRedeem = (perk: PerkItem) => {
    if (numericBalance < perk.costDht) {
      setFeedbackMessage(
        `Insufficient $DHT. You need ${perk.costDht} DHT (Current: ${tokenBalanceDht} DHT).`
      );
      setRedeemedCode(null);
      return;
    }

    const success = onRedeemPerk(perk.costDht, perk.title);
    if (success) {
      const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
      const code = `${perk.codePrefix}-${randomSuffix}`;
      setRedeemedCode(code);
      setFeedbackMessage(`Successfully redeemed ${perk.title}!`);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.drawerCard}>
          {/* Header */}
          <View style={styles.drawerHeader}>
            <View>
              <Text style={styles.drawerTitle}>Reward Perks Vault</Text>
              <Text style={styles.drawerSubtitle}>
                Redeem verified on-chain $DHT for real-world utilities
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close Perks Drawer"
              style={styles.closeButton}
              onPress={onClose}
            >
              <Text style={styles.closeButtonText}>✕</Text>
            </Pressable>
          </View>

          {/* Balance Pill */}
          <View style={styles.balanceBar}>
            <Text style={styles.balanceLabel}>Available Balance:</Text>
            <View style={styles.balancePill}>
              <Text style={styles.balanceValue}>💎 {tokenBalanceDht} DHT</Text>
            </View>
          </View>

          {/* Feedback Message */}
          {feedbackMessage ? (
            <View style={redeemedCode ? styles.successBox : styles.alertBox}>
              <Text
                style={redeemedCode ? styles.successText : styles.alertText}
              >
                {feedbackMessage}
              </Text>
              {redeemedCode ? (
                <Text style={styles.voucherCode}>Code: {redeemedCode}</Text>
              ) : null}
            </View>
          ) : null}

          {/* Perks Catalog */}
          <ScrollView
            style={styles.perksList}
            contentContainerStyle={styles.perksListContent}
          >
            {PERK_CATALOG.map((perk) => {
              const canAfford = numericBalance >= perk.costDht;
              return (
                <View key={perk.id} style={styles.perkCard}>
                  <View style={styles.perkHeader}>
                    <Text style={styles.perkIcon}>{perk.icon}</Text>
                    <View style={styles.perkInfo}>
                      <Text style={styles.perkCategory}>{perk.category}</Text>
                      <Text style={styles.perkTitle}>{perk.title}</Text>
                    </View>
                    <View style={styles.costBadge}>
                      <Text style={styles.costText}>{perk.costDht} DHT</Text>
                    </View>
                  </View>

                  <Text style={styles.perkDescription}>{perk.description}</Text>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Redeem ${perk.title}`}
                    style={({ pressed }) => [
                      styles.redeemButton,
                      canAfford ? styles.redeemButtonAffordable : styles.redeemButtonDisabled,
                      pressed && canAfford ? styles.buttonPressed : null
                    ]}
                    onPress={() => handleRedeem(perk)}
                  >
                    <Text
                      style={[
                        styles.redeemButtonText,
                        canAfford ? styles.redeemTextAffordable : styles.redeemTextDisabled
                      ]}
                    >
                      {canAfford
                        ? `Redeem for ${perk.costDht} DHT`
                        : `Need ${(perk.costDht - numericBalance).toFixed(1)} More DHT`}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.75)",
    justifyContent: "flex-end",
    alignItems: "center"
  },
  drawerCard: {
    width: "100%",
    maxWidth: 420,
    maxHeight: "85%",
    backgroundColor: "#0B0F17",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: "#1E293B",
    padding: 20
  },
  drawerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16
  },
  drawerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  drawerSubtitle: {
    fontSize: 12,
    color: "#94A3B8",
    marginTop: 2
  },
  closeButton: {
    backgroundColor: "#161F30",
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  closeButtonText: {
    color: "#94A3B8",
    fontSize: 14,
    fontWeight: "700"
  },
  balanceBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#161F30",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  balanceLabel: {
    fontSize: 13,
    color: "#94A3B8"
  },
  balancePill: {
    backgroundColor: "#0F172A",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#38BDF8"
  },
  balanceValue: {
    fontSize: 13,
    fontWeight: "700",
    color: "#38BDF8"
  },
  successBox: {
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderColor: "rgba(16, 185, 129, 0.4)",
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12
  },
  successText: {
    color: "#34D399",
    fontSize: 12,
    fontWeight: "600"
  },
  voucherCode: {
    color: "#F8FAFC",
    fontSize: 13,
    fontWeight: "800",
    fontFamily: "monospace",
    marginTop: 4
  },
  alertBox: {
    backgroundColor: "rgba(245, 158, 11, 0.15)",
    borderColor: "rgba(245, 158, 11, 0.4)",
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12
  },
  alertText: {
    color: "#FBBF24",
    fontSize: 12,
    fontWeight: "600"
  },
  perksList: {
    maxHeight: 380
  },
  perksListContent: {
    paddingBottom: 20,
    gap: 12
  },
  perkCard: {
    backgroundColor: "#161F30",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#1E293B"
  },
  perkHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8
  },
  perkIcon: {
    fontSize: 24,
    marginRight: 10
  },
  perkInfo: {
    flex: 1
  },
  perkCategory: {
    fontSize: 10,
    color: "#94A3B8",
    textTransform: "uppercase",
    fontWeight: "700"
  },
  perkTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  costBadge: {
    backgroundColor: "#0F172A",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#38BDF8"
  },
  costText: {
    color: "#38BDF8",
    fontSize: 11,
    fontWeight: "700"
  },
  perkDescription: {
    fontSize: 12,
    color: "#94A3B8",
    marginBottom: 12,
    lineHeight: 16
  },
  redeemButton: {
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  redeemButtonAffordable: {
    backgroundColor: "#10B981"
  },
  redeemButtonDisabled: {
    backgroundColor: "#1E293B"
  },
  buttonPressed: {
    opacity: 0.8
  },
  redeemButtonText: {
    fontSize: 13,
    fontWeight: "700"
  },
  redeemTextAffordable: {
    color: "#052E16"
  },
  redeemTextDisabled: {
    color: "#64748B"
  }
});
