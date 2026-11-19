import React, { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import {
  DEFAULT_INSUFFICIENT_GAS_MESSAGE,
  InsufficientGasError
} from "../services/l2ContractService";

export interface ErrorNoticePayload {
  readonly title: string;
  readonly message: string;
  readonly isInsufficientGas: boolean;
  readonly walletAddress: string | null;
}

export interface ErrorNoticeModalProps {
  readonly visible: boolean;
  readonly notice: ErrorNoticePayload | null;
  readonly onDismiss: () => void;
  readonly onCopyWalletAddress?: (address: string) => Promise<void> | void;
}

const DEFAULT_ERROR_MESSAGE = "An unexpected error occurred. Please try again.";

function normalizeNonEmpty(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toErrorNoticePayload(
  error: unknown,
  fallbackTitle: string = "Action Failed",
  walletAddress: string | null = null
): ErrorNoticePayload {
  const normalizedFallbackAddress = normalizeNonEmpty(walletAddress);
  const isNonArrayObject =
    typeof error === "object" && error !== null && !Array.isArray(error);

  const isInsufficientGas =
    error instanceof InsufficientGasError ||
    (isNonArrayObject &&
      "name" in error &&
      error.name === "InsufficientGasError");

  if (isInsufficientGas) {
    const rawMessage =
      isNonArrayObject &&
      "message" in error &&
      typeof error.message === "string"
        ? normalizeNonEmpty(error.message)
        : null;
    const signerAddress =
      isNonArrayObject &&
      "signerAddress" in error &&
      typeof error.signerAddress === "string"
        ? normalizeNonEmpty(error.signerAddress)
        : null;

    return {
      title: "Insufficient Arbitrum Sepolia Gas",
      message: rawMessage ?? DEFAULT_INSUFFICIENT_GAS_MESSAGE,
      isInsufficientGas: true,
      walletAddress: signerAddress ?? normalizedFallbackAddress
    };
  }

  let message = DEFAULT_ERROR_MESSAGE;
  if (error instanceof Error) {
    message = normalizeNonEmpty(error.message) ?? DEFAULT_ERROR_MESSAGE;
  } else if (
    isNonArrayObject &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    message = normalizeNonEmpty(error.message) ?? DEFAULT_ERROR_MESSAGE;
  } else if (typeof error === "string") {
    message = normalizeNonEmpty(error) ?? DEFAULT_ERROR_MESSAGE;
  }

  return {
    title: fallbackTitle,
    message,
    isInsufficientGas: false,
    walletAddress: normalizedFallbackAddress
  };
}

export async function copyWalletAddressToClipboard(
  address: string
): Promise<boolean> {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    return false;
  }

  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.clipboard?.writeText === "function"
    ) {
      await navigator.clipboard.writeText(trimmed);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export const ErrorNoticeModal: React.FC<ErrorNoticeModalProps> = ({
  visible,
  notice,
  onDismiss,
  onCopyWalletAddress
}) => {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  useEffect(() => {
    setCopyFeedback(null);
  }, [visible, notice?.title, notice?.message, notice?.walletAddress]);

  if (!visible || !notice) {
    return null;
  }

  const handleCopyPress = async (): Promise<void> => {
    if (!notice.walletAddress) {
      return;
    }

    const clipboardCopied = await copyWalletAddressToClipboard(
      notice.walletAddress
    );
    let customCopied = false;
    if (onCopyWalletAddress) {
      try {
        await Promise.resolve(onCopyWalletAddress(notice.walletAddress));
        customCopied = true;
      } catch {
        customCopied = false;
      }
    }

    setCopyFeedback(
      clipboardCopied || customCopied
        ? "Wallet address copied to clipboard!"
        : "Wallet address selected. Copy via keyboard or long press."
    );
  };

  const showCopyGasShortcut = Boolean(
    notice.isInsufficientGas && notice.walletAddress
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={styles.backdrop}>
        <View style={styles.modalContainer}>
          <Text style={styles.tag}>
            {notice.isInsufficientGas
              ? "ARBITRUM SEPOLIA GAS REQUIRED"
              : "ACTION ERROR"}
          </Text>
          <Text style={styles.title}>{notice.title}</Text>

          <View style={styles.errorBox}>
            <Text style={styles.messageText}>{notice.message}</Text>
          </View>

          {showCopyGasShortcut && notice.walletAddress ? (
            <View style={styles.gasShortcutSection}>
              <View style={styles.addressCard}>
                <Text style={styles.addressLabel}>Embedded Wallet Address</Text>
                <Text
                  selectable
                  accessibilityLabel="Insufficient Gas Wallet Address"
                  style={styles.walletAddressText}
                >
                  {notice.walletAddress}
                </Text>
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Copy Wallet Address"
                style={({ pressed }) => [
                  styles.copyBtn,
                  pressed ? styles.btnPressed : null
                ]}
                onPress={() => {
                  void handleCopyPress();
                }}
              >
                <Text style={styles.copyBtnText}>Copy Wallet Address</Text>
              </Pressable>

              {copyFeedback ? (
                <Text style={styles.copyFeedbackText}>{copyFeedback}</Text>
              ) : null}
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss Error Notice"
            style={({ pressed }) => [
              styles.dismissBtn,
              pressed ? styles.btnPressed : null
            ]}
            onPress={onDismiss}
          >
            <Text style={styles.dismissBtnText}>Dismiss</Text>
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
    color: "#F87171",
    marginBottom: 4
  },
  title: {
    fontSize: 18,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 12
  },
  errorBox: {
    backgroundColor: "#2A1215",
    borderWidth: 1,
    borderColor: "#7F1D1D",
    borderRadius: 12,
    padding: 12,
    marginBottom: 14
  },
  messageText: {
    fontSize: 13,
    lineHeight: 19,
    color: "#FCA5A5",
    fontWeight: "600"
  },
  gasShortcutSection: {
    marginBottom: 14
  },
  addressCard: {
    backgroundColor: "#0A101D",
    borderWidth: 1,
    borderColor: "#1E293B",
    borderRadius: 10,
    padding: 10,
    marginBottom: 10
  },
  addressLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#94A3B8",
    textTransform: "uppercase",
    marginBottom: 4
  },
  walletAddressText: {
    fontSize: 12,
    fontFamily: "monospace",
    color: "#38BDF8"
  },
  copyBtn: {
    backgroundColor: "#0284C7",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center"
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
    marginTop: 8,
    textAlign: "center"
  },
  dismissBtn: {
    backgroundColor: "#334155",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center"
  },
  dismissBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#F8FAFC"
  },
  btnPressed: {
    opacity: 0.78
  }
});
