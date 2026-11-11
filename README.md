# DeHealth

**Decentralized Proof-of-Workout Protocol with Client-Side Cryptographic Data Sovereignty and Layer-2 ($DHT) Micro-Incentives.**

DeHealth is a privacy-preserving fitness incentive protocol. Users prove physical activity through client-side cryptographic attestations and earn on-chain `$DHT` utility tokens — **without ever transmitting raw biometric data to any server or chain**. Telemetry is hashed locally with Keccak-256, signed with an EIP-712 typed-data signature, and verified on a Layer-2 reward gate that mints a fixed streak reward. The cloud layer stores only anonymized, non-reversible proof hashes.

---

## Key Architectural Invariants

| Invariant | Description |
|-----------|-------------|
| **EIP-712 Structured Signing** | Workout proofs are signed as typed structured data (`WorkoutProof`) bound to a domain (`DeHealthProtocol` / v`1` / Arbitrum Sepolia `421614`) and `verifyingContract`, preventing cross-contract and cross-chain signature reuse. |
| **Local Keccak-256 Telemetry Hashing** | Raw biometrics are canonicalized to deterministic JSON and hashed on-device. Only the resulting `bytes32` telemetry hash ever leaves the device. |
| **Off-Chain 48h Fatigue Scaling Engine** | An adaptive profile engine classifies a fitness tier from biometrics and auto-reduces daily targets by 30% after >48h inactivity to prevent user churn — entirely client-side. |
| **Zero-Raw-Telemetry Database** | The Supabase schema persists only pseudonyms, `bytes32` proof hashes, and streak counts. No age, heart rate, body composition, or any PII/biometric column exists. |
| **Dual Replay Defense** | The reward gate rejects replays on **both** the EIP-712 digest **and** the underlying telemetry hash, and enforces strictly monotonic per-user nonces. |

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         MOBILE CLIENT (React Native / Expo)                │
│                                                                            │
│   Biometric Telemetry ──► Keccak-256 Hash (on-device)                      │
│                           │                                                │
│                           ▼                                                │
│   Profile/Fatigue Engine  WorkoutProof struct ──► EIP-712 Typed Signature  │
│   (48h adaptive scaling)  │                       (ethers v6 signTypedData)│
│                           │                                                │
│   Encrypted Local Storage │ (Keccak keystream + HMAC-SHA256 integrity)     │
└───────────────────────────┼────────────────────────────────────────────────┘
                            │ bytes32 hash + signature only
                            │ (NO raw biometrics transmitted)
            ┌───────────────┴───────────────┐
            ▼                               ▼
┌───────────────────────────┐   ┌────────────────────────────────────────┐
│  LAYER 2 (Arbitrum Sepolia │   │  STATELESS CLOUD (Supabase / Postgres)   │
│  / Hardhat local)          │   │                                          │
│                            │   │  anonymized_feed:                        │
│  DeHealthRewardGate        │   │    pseudonym, proof_hash(bytes32),       │
│   • EIP-712 verify         │   │    streak_count                          │
│   • ECDSA.recover          │   │  peer_cheers: pseudonym, feed_id (FK)    │
│   • dual replay guard      │   │                                          │
│   • monotonic nonce        │   │  Row Level Security on all tables        │
│          │                 │   │  (public read, constrained insert)       │
│          ▼                 │   │                                          │
│  DeHealthToken ($DHT ERC20)│   │  Stores NO raw telemetry / NO PII        │
│   • gated mint (10 DHT)    │   │                                          │
└───────────────────────────┘   └────────────────────────────────────────┘
```

---

## Project Structure

```
dehealth-monorepo/
├── package.json                 # npm workspaces root + orchestration scripts
├── tsconfig.json                # shared base TypeScript config
├── shared/                      # @dehealth/shared — cross-cutting domain layer
│   └── src/
│       ├── eip712.ts            # EIP-712 domain, types, WorkoutProof spec
│       ├── profile.ts           # UserProfile / TelemetryData / feed types
│       ├── schemas.ts           # Zod validation schemas (address, bytes32, uint256)
│       └── __tests__/           # schema unit tests
├── contracts/                   # @dehealth/contracts — Hardhat + Solidity 0.8.24
│   ├── contracts/
│   │   ├── DeHealthToken.sol    # ERC-20 $DHT with gated minting
│   │   └── DeHealthRewardGate.sol  # EIP-712 proof verifier + dual replay defense
│   ├── test/
│   │   ├── DeHealthRewardGate.test.ts   # unit + security suite
│   │   └── e2e/                 # 4-tier end-to-end lifecycle harness
│   └── hardhat.config.ts
├── mobile/                      # @dehealth/mobile — React Native / Expo client
│   └── src/
│       ├── services/
│       │   ├── cryptoService.ts    # local Keccak-256 + EIP-712 signer
│       │   └── profileEngine.ts    # adaptive 48h fatigue scaling engine
│       ├── storage/
│       │   └── encryptedStorageAdapter.ts  # encrypted local persistence
│       ├── screens/             # dashboard, 1-tap check-in, anonymized feed
│       └── __tests__/
└── supabase/
    └── migrations/
        └── 001_initial_schema.sql   # anonymized feed + peer cheers + RLS
```

---

## Prerequisites

- **Node.js** `v20+`
- **npm** `v10+` (uses native npm workspaces)

---

## Setup

```bash
# Clone and enter the repository
git clone <repository-url>
cd dehealth-monorepo

# Install all workspace dependencies from the root
npm install
```

---

## Quick Start Guide

All commands are run from the repository root and orchestrate the npm workspaces.

```bash
# 1. Build every workspace (shared → contracts → mobile)
npm run build

# 2. Run the smart contract security + unit suite (with coverage)
npm run test:contracts

# 3. Run the shared + mobile unit test suites
npm run test:unit

# 4. Run the 4-tier end-to-end lifecycle test harness
npm run test:e2e

# 5. Run the full verification pipeline (contracts + unit + e2e)
npm run test

# 6. Launch the Expo mobile development server
npm run start --workspace=@dehealth/mobile
```

---

## Academic Context

This project is submitted in partial fulfilment of the requirements for the
**B.Sc. (Hons) in Software Engineering** at **Asia Pacific University of Technology & Innovation (APU)**.

It maps directly to **UN Sustainable Development Goal 3 — Good Health and Well-being**,
promoting sustained physical activity through privacy-preserving, cryptographically
verifiable incentives that keep sensitive health data under sole user custody.

---

## License

MIT
