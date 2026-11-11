import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  computeHmac,
  getBytes,
  hexlify,
  keccak256,
  randomBytes,
  solidityPackedKeccak256,
  toUtf8Bytes,
  toUtf8String
} from "ethers";

export interface KeyValueStorageBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface EncryptedEnvelope {
  readonly v: 1;
  readonly iv: string;
  readonly ciphertext: string;
  readonly mac: string;
}

/**
 * Derive a deterministic keystream of `length` bytes using Keccak-256 in counter mode
 * and XOR with input bytes.
 */
function xorKeystream(
  input: Uint8Array,
  encryptionKeyHex: string,
  ivHex: string
): Uint8Array {
  const output = new Uint8Array(input.length);
  const blockCount = Math.ceil(input.length / 32);

  for (let counter = 0; counter < blockCount; counter += 1) {
    const blockHash = solidityPackedKeccak256(
      ["bytes32", "bytes16", "uint256"],
      [encryptionKeyHex, ivHex, BigInt(counter)]
    );
    const keyBlock = getBytes(blockHash);
    const offset = counter * 32;
    const limit = Math.min(32, input.length - offset);

    for (let i = 0; i < limit; i += 1) {
      const inputByte = input[offset + i] ?? 0;
      const keyByte = keyBlock[i] ?? 0;
      output[offset + i] = inputByte ^ keyByte;
    }
  }

  return output;
}

export class EncryptedStorageAdapter {
  private readonly encryptionKeyHex: string;
  private readonly macKeyHex: string;
  private readonly backend: KeyValueStorageBackend;

  constructor(
    passphrase: string,
    backend: KeyValueStorageBackend = AsyncStorage as unknown as KeyValueStorageBackend
  ) {
    if (passphrase.trim().length < 8) {
      throw new Error("EncryptedStorageAdapter requires a passphrase of at least 8 characters");
    }

    this.encryptionKeyHex = keccak256(toUtf8Bytes(`dehealth.storage.enc.v1:${passphrase}`));
    this.macKeyHex = keccak256(toUtf8Bytes(`dehealth.storage.mac.v1:${passphrase}`));
    this.backend = backend;
  }

  async setEncryptedItem<T>(key: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value);
    const plaintextBytes = toUtf8Bytes(serialized);
    const ivHex = hexlify(randomBytes(16));
    const cipherBytes = xorKeystream(plaintextBytes, this.encryptionKeyHex, ivHex);
    const ciphertextHex = hexlify(cipherBytes);

    const macPayload = toUtf8Bytes(`${key}:${ivHex}:${ciphertextHex}`);
    const mac = computeHmac("sha256", this.macKeyHex, macPayload);

    const envelope: EncryptedEnvelope = {
      v: 1,
      iv: ivHex,
      ciphertext: ciphertextHex,
      mac
    };

    await this.backend.setItem(key, JSON.stringify(envelope));
  }

  async getEncryptedItem<T>(key: string): Promise<T | null> {
    const raw = await this.backend.getItem(key);
    if (raw === null) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("v" in parsed) ||
      !("iv" in parsed) ||
      !("ciphertext" in parsed) ||
      !("mac" in parsed)
    ) {
      throw new Error("Corrupted encrypted storage envelope");
    }

    const envelope = parsed as EncryptedEnvelope;
    const macPayload = toUtf8Bytes(`${key}:${envelope.iv}:${envelope.ciphertext}`);
    const expectedMac = computeHmac("sha256", this.macKeyHex, macPayload);

    if (expectedMac !== envelope.mac) {
      throw new Error("Encrypted storage MAC verification failed: tampering detected");
    }

    const cipherBytes = getBytes(envelope.ciphertext);
    const plaintextBytes = xorKeystream(cipherBytes, this.encryptionKeyHex, envelope.iv);
    const decodedJson = toUtf8String(plaintextBytes);

    return JSON.parse(decodedJson) as T;
  }

  async removeEncryptedItem(key: string): Promise<void> {
    await this.backend.removeItem(key);
  }
}
