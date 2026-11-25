import React, { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { generateQrMatrix, QrMatrix } from "../utils/qrMatrix";
import { copyWalletAddressToClipboard } from "./ErrorNoticeModal";

export interface WalletConnectQrModalProps {
  readonly visible: boolean;
  readonly uri: string | null;
  readonly onClose: () => void;
  readonly title?: string;
  readonly subtitle?: string;
}

const DEFAULT_TITLE = "Connect Wallet via WalletConnect";
const DEFAULT_SUBTITLE =
  "Scan this QR code with MetaMask Mobile, Rainbow, or Trust Wallet, or copy the pairing URI below.";

export const WalletConnectQrModal: React.FC<WalletConnectQrModalProps> = ({
  visible,
  uri,
  onClose,
  title = DEFAULT_TITLE,
  subtitle = DEFAULT_SUBTITLE
}) => {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const normalizedUri = useMemo(() => {
    if (!uri) {
      return null;
    }
    const trimmed = uri.trim();
    return trimmed.length > 0 ? trimmed : null;
  }, [uri]);

  useEffect(() => {
    setCopyFeedback(null);
  }, [visible, normalizedUri]);

  const qrMatrix = useMemo<QrMatrix | null>(() => {
    if (!normalizedUri) {
      return null;
    }
    try {
      return generateQrMatrix(normalizedUri);
    } catch {
      return null;
    }
  }, [normalizedUri]);

  if (!visible || !normalizedUri) {
    return null;
  }

  const cellSize = qrMatrix ? Math.max(2, Math.floor(220 / qrMatrix.size)) : 4;

  const handleCopyUri = async (): Promise<void> => {
    const copied = await copyWalletAddressToClipboard(normalizedUri);
    setCopyFeedback(
      copied
        ? "Pairing URI copied!"
        : "Unable to copy automatically — select the URI above."
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop} testID="wc-qr-modal">
        <View style={styles.modalContainer}>
          <Text style={styles.tag}>WALLETCONNECT V2</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>

          {qrMatrix ? (
            <View style={styles.qrWrapper}>
              <View style={styles.qrQuietZone} testID="wc-qr-matrix">
                {qrMatrix.modules.map((row, rIdx) => (
                  <View key={rIdx} style={styles.qrRow}>
                    {row.map((isDark, cIdx) => (
                      <View
                        key={cIdx}
                        style={[
                          styles.qrCell,
                          { width: cellSize, height: cellSize },
                          isDark ? styles.qrDark : styles.qrLight
                        ]}
                      />
                    ))}
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          <View style={styles.uriCard}>
            <Text style={styles.uriLabel}>Pairing URI</Text>
            <Text
              testID="wc-pairing-uri-text"
              selectable
              style={styles.uriText}
              numberOfLines={3}
              ellipsizeMode="middle"
            >
              {normalizedUri}
            </Text>
          </View>

          <Pressable
            testID="wc-copy-uri-button"
            accessibilityRole="button"
            accessibilityLabel="Copy Pairing URI"
            style={({ pressed }) => [
              styles.copyBtn,
              pressed ? styles.btnPressed : null
            ]}
            onPress={() => {
              void handleCopyUri();
            }}
          >
            <Text style={styles.copyBtnText}>Copy Pairing URI</Text>
          </Pressable>

          {copyFeedback ? (
            <Text testID="wc-copy-feedback" style={styles.copyFeedbackText}>
              {copyFeedback}
            </Text>
          ) : null}

          <Pressable
            testID="wc-qr-close-button"
            accessibilityRole="button"
            accessibilityLabel="Cancel WalletConnect Pairing"
            style={({ pressed }) => [
              styles.closeBtn,
              pressed ? styles.btnPressed : null
            ]}
            onPress={onClose}
          >
            <Text style={styles.closeBtnText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.88)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20
  },
  modalContainer: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: "#0F172A",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#334155",
    padding: 20
  },
  tag: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    color: "#38BDF8",
    marginBottom: 4
  },
  title: {
    fontSize: 18,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 6
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 17,
    color: "#94A3B8",
    marginBottom: 14
  },
  qrWrapper: {
    alignItems: "center",
    marginBottom: 14
  },
  qrQuietZone: {
    backgroundColor: "#FFFFFF",
    padding: 12,
    borderRadius: 12
  },
  qrRow: {
    flexDirection: "row"
  },
  qrCell: {},
  qrDark: {
    backgroundColor: "#0F172A"
  },
  qrLight: {
    backgroundColor: "#FFFFFF"
  },
  uriCard: {
    backgroundColor: "#0A101D",
    borderWidth: 1,
    borderColor: "#1E293B",
    borderRadius: 10,
    padding: 10,
    marginBottom: 12
  },
  uriLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#94A3B8",
    textTransform: "uppercase",
    marginBottom: 4
  },
  uriText: {
    fontSize: 11,
    fontFamily: "monospace",
    color: "#38BDF8"
  },
  copyBtn: {
    backgroundColor: "#0284C7",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
    marginBottom: 8
  },
  copyBtnText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#FFFFFF"
  },
  copyFeedbackText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#34D399",
    marginBottom: 8,
    textAlign: "center"
  },
  closeBtn: {
    backgroundColor: "#334155",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center"
  },
  closeBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  btnPressed: {
    opacity: 0.78
  }
});
