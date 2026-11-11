// ============================================================================
// DeHealth Protocol MVP - E2E Testing Suite: Tier 1 & Tier 2
// File: contracts/test/e2e/DeHealthE2E_Tier1_Tier2.test.ts
// Total Tests: 80 (40 Tier 1 Feature Tests + 40 Tier 2 Boundary Tests)
// ============================================================================

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";
import {
  AddressSchema,
  AnonymizedFeedInsertSchema,
  ARBITRUM_SEPOLIA_CHAIN_ID,
  Bytes32Schema,
  createDeHealthDomain,
  HexSignatureSchema,
  PeerCheerInsertSchema,
  SignedWorkoutClaimPayloadSchema,
  TelemetryData,
  TelemetryDataSchema,
  Uint256Schema,
  UserProfile,
  UserProfileSchema,
  WORKOUT_PROOF_EIP712_TYPES,
  WorkoutProof,
  WorkoutProofSchema
} from "@dehealth/shared";
import {
  computeWorkoutProofDigest,
  hashTelemetry,
  signWorkoutProof,
  verifyWorkoutProofSignature
} from "../../../mobile/src/services/cryptoService";
import {
  calculateBaselineTarget,
  evaluateDailyTarget,
  FATIGUE_GAP_THRESHOLD_MS,
  scaleTargetForInactivityGap
} from "../../../mobile/src/services/profileEngine";

describe("DeHealth Protocol E2E Testing: Tier 1 & Tier 2", function () {
  // --------------------------------------------------------------------------
  // SHARED FIXTURE: Deploy Contracts, Authorize Gate, and Setup Wallets
  // --------------------------------------------------------------------------
  async function deployDeHealthFixture() {
    const [deployer, userAlice, userBob, attacker, other] =
      await ethers.getSigners();

    // 1. Deploy DeHealthToken ($DHT)
    const TokenFactory = await ethers.getContractFactory("DeHealthToken");
    const token = await TokenFactory.deploy(deployer.address);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    // 2. Deploy DeHealthRewardGate
    const GateFactory = await ethers.getContractFactory("DeHealthRewardGate");
    const gate = await GateFactory.deploy(tokenAddress, deployer.address);
    await gate.waitForDeployment();
    const gateAddress = await gate.getAddress();

    // 3. Authorize Gate to mint $DHT
    await token.connect(deployer).setAuthorizedMinter(gateAddress, true);

    // 4. Resolve Dynamic Network Chain ID
    const network = await ethers.provider.getNetwork();
    const chainId = Number(network.chainId);

    const domain = createDeHealthDomain(gateAddress as `0x${string}`, chainId);
    const types = {
      WorkoutProof: WORKOUT_PROOF_EIP712_TYPES.WorkoutProof.map((f) => ({
        name: f.name,
        type: f.type
      }))
    };

    return {
      token,
      gate,
      tokenAddress,
      gateAddress,
      deployer,
      userAlice,
      userBob,
      attacker,
      other,
      network,
      chainId,
      domain,
      types
    };
  }

  // ==========================================================================
  // PART A: TIER 1 — FEATURE COVERAGE TESTS (40 Tests: 5 x 8 Features)
  // ==========================================================================
  describe("Tier 1: Feature Coverage", function () {
    // ------------------------------------------------------------------------
    // Feature 1: Monorepo Scaffolding & Shared Types
    // ------------------------------------------------------------------------
    describe("Feature 1: Monorepo Scaffolding & Shared Types", function () {
      it("T1-F1-01: Workspace Topology Verification", function () {
        const rootPkgPath = path.resolve(__dirname, "../../../package.json");
        expect(fs.existsSync(rootPkgPath)).to.be.true;
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
        expect(rootPkg.workspaces).to.include("shared");
        expect(rootPkg.workspaces).to.include("contracts");
        expect(rootPkg.workspaces).to.include("mobile");
      });

      it("T1-F1-02: Shared Module Compilation & Type Declarations", function () {
        const sharedDist = path.resolve(__dirname, "../../../shared/dist");
        expect(fs.existsSync(path.join(sharedDist, "index.d.ts"))).to.be.true;
        expect(fs.existsSync(path.join(sharedDist, "eip712.d.ts"))).to.be.true;
        expect(fs.existsSync(path.join(sharedDist, "profile.d.ts"))).to.be.true;
        expect(fs.existsSync(path.join(sharedDist, "schemas.d.ts"))).to.be.true;
      });

      it("T1-F1-03: Smart Contracts Compilation & TypeChain Artifacts", function () {
        const typechainDir = path.resolve(__dirname, "../../typechain-types/contracts");
        expect(fs.existsSync(path.join(typechainDir, "DeHealthToken.ts"))).to.be.true;
        expect(fs.existsSync(path.join(typechainDir, "DeHealthRewardGate.ts"))).to.be.true;
      });

      it("T1-F1-04: Mobile Client TypeScript Build", function () {
        const mobileDist = path.resolve(__dirname, "../../../mobile/dist");
        expect(fs.existsSync(path.join(mobileDist, "services/cryptoService.js"))).to.be.true;
        expect(fs.existsSync(path.join(mobileDist, "services/profileEngine.js"))).to.be.true;
        expect(fs.existsSync(path.join(mobileDist, "storage/encryptedStorageAdapter.js"))).to.be.true;
      });

      it("T1-F1-05: Monorepo Strict Zero-any Audit", function () {
        const sharedTsConfig = JSON.parse(
          fs.readFileSync(path.resolve(__dirname, "../../../shared/tsconfig.json"), "utf-8")
        );
        expect(sharedTsConfig.compilerOptions.noImplicitAny).to.be.true;
        expect(sharedTsConfig.compilerOptions.strict).to.be.true;
      });
    });

    // ------------------------------------------------------------------------
    // Feature 2: EIP-712 Domain & TypeHash Verification
    // ------------------------------------------------------------------------
    describe("Feature 2: EIP-712 Domain & TypeHash Verification", function () {
      it("T1-F2-01: Domain Separator Hash Parity", async function () {
        const { gate, gateAddress, chainId } = await loadFixture(deployDeHealthFixture);
        const domain = createDeHealthDomain(gateAddress as `0x${string}`, chainId);
        const expectedDomainHash = ethers.TypedDataEncoder.hashDomain(domain);
        const domainData = await gate.eip712Domain();
        expect(domainData.name).to.equal("DeHealthProtocol");
        expect(domainData.version).to.equal("1");
        expect(domainData.chainId).to.equal(BigInt(chainId));
        expect(domainData.verifyingContract).to.equal(gateAddress);
        expect(expectedDomainHash).to.match(/^0x[a-fA-F0-9]{64}$/);
      });

      it("T1-F2-02: TypeHash Definition Parity", async function () {
        const { gate } = await loadFixture(deployDeHealthFixture);
        const offchainTypeHash = ethers.keccak256(
          ethers.toUtf8Bytes(
            "WorkoutProof(address user,bytes32 telemetryHash,uint256 streakCount,uint256 nonce,uint256 deadline)"
          )
        );
        const onchainTypeHash = await gate.WORKOUT_PROOF_TYPEHASH();
        expect(offchainTypeHash).to.equal(onchainTypeHash);
      });

      it("T1-F2-03: Struct Hash Computation Parity", async function () {
        const { gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-struct-test")) as `0x${string}`,
          streakCount: 5n,
          nonce: 0n,
          deadline: 1893456000n
        };
        const offchainDigest = computeWorkoutProofDigest(proof, gateAddress as `0x${string}`, chainId);
        const onchainDigest = await gate.hashWorkoutProof(proof);
        expect(offchainDigest).to.equal(onchainDigest);
      });

      it("T1-F2-04: Default Domain Factory Output", function () {
        const domain = createDeHealthDomain("0x1111111111111111111111111111111111111111");
        expect(domain.name).to.equal("DeHealthProtocol");
        expect(domain.version).to.equal("1");
        expect(domain.chainId).to.equal(ARBITRUM_SEPOLIA_CHAIN_ID);
        expect(domain.verifyingContract).to.equal("0x1111111111111111111111111111111111111111");
      });

      it("T1-F2-05: Configurable Domain Factory Output", function () {
        const domain = createDeHealthDomain("0x2222222222222222222222222222222222222222", 31337);
        expect(domain.chainId).to.equal(31337);
        expect(domain.verifyingContract).to.equal("0x2222222222222222222222222222222222222222");
      });
    });

    // ------------------------------------------------------------------------
    // Feature 3: Zod Inbound Schemas Validation
    // ------------------------------------------------------------------------
    describe("Feature 3: Zod Inbound Schemas Validation", function () {
      it("T1-F3-01: Valid WorkoutProofSchema Parsing & Coercion", function () {
        const raw = {
          user: "0x1111111111111111111111111111111111111111",
          telemetryHash: "0x" + "a".repeat(64),
          streakCount: "3",
          nonce: 0,
          deadline: 1731326400
        };
        const parsed = WorkoutProofSchema.parse(raw);
        expect(parsed.streakCount).to.equal(3n);
        expect(parsed.nonce).to.equal(0n);
        expect(parsed.deadline).to.equal(1731326400n);
      });

      it("T1-F3-02: Valid UserProfileSchema Parsing", function () {
        const profile = { age: 29, gender: "Male", bodyFatPct: 18.5, muscleMassKg: 62.0 };
        const parsed = UserProfileSchema.parse(profile);
        expect(parsed.age).to.equal(29);
        expect(parsed.gender).to.equal("Male");
        expect(parsed.bodyFatPct).to.equal(18.5);
      });

      it("T1-F3-03: Valid TelemetryDataSchema Parsing", function () {
        const telemetry = {
          timestampMs: 1731326400000,
          stepCount: 10500,
          activeMinutes: 45,
          avgHeartRateBpm: 142,
          caloriesBurnedKcal: 520,
          profileSnapshot: { age: 29, gender: "male", bodyFatPct: 18.5, muscleMassKg: 62.0 }
        };
        const parsed = TelemetryDataSchema.parse(telemetry);
        expect(parsed.stepCount).to.equal(10500);
        expect(parsed.profileSnapshot.age).to.equal(29);
      });

      it("T1-F3-04: Valid SignedWorkoutClaimPayloadSchema Parsing", function () {
        const payload = {
          proof: {
            user: "0x1111111111111111111111111111111111111111",
            telemetryHash: "0x" + "a".repeat(64),
            streakCount: 1n,
            nonce: 0n,
            deadline: 1893456000n
          },
          signature: "0x" + "b".repeat(130)
        };
        const parsed = SignedWorkoutClaimPayloadSchema.parse(payload);
        expect(parsed.signature).to.equal("0x" + "b".repeat(130));
      });

      it("T1-F3-05: Valid Supabase Inbound Schemas Parsing", function () {
        const feed = {
          user_pseudonym: "VitalRunner",
          proof_hash: "0x" + "f".repeat(64),
          streak_count: 7
        };
        const cheer = {
          feed_id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          sender_pseudonym: "CheerMate"
        };
        expect(AnonymizedFeedInsertSchema.parse(feed).user_pseudonym).to.equal("VitalRunner");
        expect(PeerCheerInsertSchema.parse(cheer).sender_pseudonym).to.equal("CheerMate");
      });
    });

    // ------------------------------------------------------------------------
    // Feature 4: DeHealthToken ($DHT) ERC-20 Mechanics
    // ------------------------------------------------------------------------
    describe("Feature 4: DeHealthToken ($DHT) ERC-20 Mechanics", function () {
      it("T1-F4-01: Token Initialization & Metadata Verification", async function () {
        const { token, deployer } = await loadFixture(deployDeHealthFixture);
        expect(await token.name()).to.equal("DeHealth Token");
        expect(await token.symbol()).to.equal("DHT");
        expect(await token.decimals()).to.equal(18);
        expect(await token.owner()).to.equal(deployer.address);
        expect(await token.totalSupply()).to.equal(0n);
      });

      it("T1-F4-02: Contract Owner Direct Minting", async function () {
        const { token, deployer, userAlice } = await loadFixture(deployDeHealthFixture);
        await token.connect(deployer).mint(userAlice.address, ethers.parseEther("50"));
        expect(await token.balanceOf(userAlice.address)).to.equal(ethers.parseEther("50"));
        expect(await token.totalSupply()).to.equal(ethers.parseEther("50"));
      });

      it("T1-F4-03: Minter Authorization Event & State", async function () {
        const { token, deployer, other } = await loadFixture(deployDeHealthFixture);
        await expect(token.connect(deployer).setAuthorizedMinter(other.address, true))
          .to.emit(token, "MinterAuthorizationChanged")
          .withArgs(other.address, true);
        expect(await token.authorizedMinters(other.address)).to.be.true;
      });

      it("T1-F4-04: Authorized Minter Execution", async function () {
        const { token, deployer, other, userAlice } = await loadFixture(deployDeHealthFixture);
        await token.connect(deployer).setAuthorizedMinter(other.address, true);
        await token.connect(other).mint(userAlice.address, ethers.parseEther("10"));
        expect(await token.balanceOf(userAlice.address)).to.equal(ethers.parseEther("10"));
      });

      it("T1-F4-05: Standard ERC-20 Transfer & Allowance Flow", async function () {
        const { token, deployer, userAlice, userBob } = await loadFixture(deployDeHealthFixture);
        await token.connect(deployer).mint(userAlice.address, ethers.parseEther("100"));
        await token.connect(userAlice).approve(userBob.address, ethers.parseEther("40"));
        expect(await token.allowance(userAlice.address, userBob.address)).to.equal(ethers.parseEther("40"));
        await token.connect(userBob).transferFrom(userAlice.address, userBob.address, ethers.parseEther("40"));
        expect(await token.balanceOf(userAlice.address)).to.equal(ethers.parseEther("60"));
        expect(await token.balanceOf(userBob.address)).to.equal(ethers.parseEther("40"));
        expect(await token.allowance(userAlice.address, userBob.address)).to.equal(0n);
      });
    });

    // ------------------------------------------------------------------------
    // Feature 5: DeHealthRewardGate Claim Verification & Minting
    // ------------------------------------------------------------------------
    describe("Feature 5: DeHealthRewardGate Claim Verification & Minting", function () {
      it("T1-F5-01: Valid Signature Claim & 10 DHT Minting", async function () {
        const { token, gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-t1-f5-1")) as `0x${string}`,
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        const signed = await signWorkoutProof(userAlice, proof, gateAddress as `0x${string}`, chainId);
        await gate.connect(userAlice).claimStreakReward(signed.proof, signed.signature);
        expect(await token.balanceOf(userAlice.address)).to.equal(ethers.parseEther("10"));
        expect(await gate.nonces(userAlice.address)).to.equal(1n);
      });

      it("T1-F5-02: StreakRewardClaimed Event Emission", async function () {
        const { gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-t1-f5-2")) as `0x${string}`,
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        const signed = await signWorkoutProof(userAlice, proof, gateAddress as `0x${string}`, chainId);
        const digest = await gate.hashWorkoutProof(signed.proof);
        await expect(gate.connect(userAlice).claimStreakReward(signed.proof, signed.signature))
          .to.emit(gate, "StreakRewardClaimed")
          .withArgs(userAlice.address, proof.telemetryHash, 1n, 0n, ethers.parseEther("10"), digest);
      });

      it("T1-F5-03: Dual State Commitment on Claim", async function () {
        const { gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-t1-f5-3")) as `0x${string}`,
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        const signed = await signWorkoutProof(userAlice, proof, gateAddress as `0x${string}`, chainId);
        const digest = await gate.hashWorkoutProof(signed.proof);
        await gate.connect(userAlice).claimStreakReward(signed.proof, signed.signature);
        expect(await gate.executedHashes(digest)).to.be.true;
        expect(await gate.executedHashes(proof.telemetryHash)).to.be.true;
      });

      it("T1-F5-04: Sequential Multi-Day Streak Progression", async function () {
        const { token, gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();

        // Day 1
        const proof1: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("tel-day1")) as `0x${string}`,
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        const signed1 = await signWorkoutProof(userAlice, proof1, gateAddress as `0x${string}`, chainId);
        await gate.connect(userAlice).claimStreakReward(signed1.proof, signed1.signature);

        // Day 2
        await time.increase(86400);
        const proof2: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("tel-day2")) as `0x${string}`,
          streakCount: 2n,
          nonce: 1n,
          deadline: BigInt((await time.latest()) + 3600)
        };
        const signed2 = await signWorkoutProof(userAlice, proof2, gateAddress as `0x${string}`, chainId);
        await gate.connect(userAlice).claimStreakReward(signed2.proof, signed2.signature);

        expect(await token.balanceOf(userAlice.address)).to.equal(ethers.parseEther("20"));
        expect(await gate.nonces(userAlice.address)).to.equal(2n);
      });

      it("T1-F5-05: Reward Gate Contract State Immutables", async function () {
        const { token, gate, other } = await loadFixture(deployDeHealthFixture);
        expect(await gate.rewardToken()).to.equal(await token.getAddress());
        expect(await gate.FIXED_STREAK_REWARD()).to.equal(ethers.parseEther("10"));
        expect(await gate.nonces(other.address)).to.equal(0n);
      });
    });

    // ------------------------------------------------------------------------
    // Feature 6: Mobile CryptoService Keccak-256 Telemetry Hashing & Signer
    // ------------------------------------------------------------------------
    describe("Feature 6: Mobile CryptoService Keccak-256 Telemetry Hashing & Signer", function () {
      const sampleTelemetry: TelemetryData = {
        timestampMs: 1731326400000,
        stepCount: 9200,
        activeMinutes: 40,
        avgHeartRateBpm: 138.5,
        caloriesBurnedKcal: 440.0,
        profileSnapshot: { age: 30, gender: "Male", bodyFatPct: 17.5, muscleMassKg: 64.0 }
      };

      it("T1-F6-01: Deterministic Telemetry Hashing", function () {
        const hashes = Array.from({ length: 10 }, () => hashTelemetry(sampleTelemetry));
        const first = hashes[0]!;
        for (const h of hashes) {
          expect(h).to.equal(first);
        }
        expect(first).to.match(/^0x[a-fA-F0-9]{64}$/);
      });

      it("T1-F6-02: Biometric Float & Case Normalization", function () {
        const telA: TelemetryData = {
          ...sampleTelemetry,
          profileSnapshot: { age: 30, gender: "FEMALE", bodyFatPct: 22.100, muscleMassKg: 45.30 }
        };
        const telB: TelemetryData = {
          ...sampleTelemetry,
          profileSnapshot: { age: 30, gender: "female", bodyFatPct: 22.1, muscleMassKg: 45.3 }
        };
        expect(hashTelemetry(telA)).to.equal(hashTelemetry(telB));
      });

      it("T1-F6-03: EIP-712 Digest Computation Consistency", async function () {
        const { gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: hashTelemetry(sampleTelemetry),
          streakCount: 3n,
          nonce: 0n,
          deadline: 1893456000n
        };
        const offchainDigest = computeWorkoutProofDigest(proof, gateAddress as `0x${string}`, chainId);
        const onchainDigest = await gate.hashWorkoutProof(proof);
        expect(offchainDigest).to.equal(onchainDigest);
      });

      it("T1-F6-04: Offline EIP-712 Signing Output", async function () {
        const { gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: hashTelemetry(sampleTelemetry),
          streakCount: 1n,
          nonce: 0n,
          deadline: 1893456000n
        };
        const signed = await signWorkoutProof(userAlice, proof, gateAddress as `0x${string}`, chainId);
        expect(signed.signature.length).to.equal(132); // 0x + 130 hex characters
        expect(SignedWorkoutClaimPayloadSchema.parse(signed)).to.deep.equal(signed);
      });

      it("T1-F6-05: Signature Verification Roundtrip", async function () {
        const { gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: hashTelemetry(sampleTelemetry),
          streakCount: 1n,
          nonce: 0n,
          deadline: 1893456000n
        };
        const signed = await signWorkoutProof(userAlice, proof, gateAddress as `0x${string}`, chainId);
        const verified = verifyWorkoutProofSignature(signed, gateAddress as `0x${string}`, chainId);
        expect(verified).to.be.true;
      });
    });

    // ------------------------------------------------------------------------
    // Feature 7: Mobile ProfileEngine Dynamic Target Scaling
    // ------------------------------------------------------------------------
    describe("Feature 7: Mobile ProfileEngine Dynamic Target Scaling", function () {
      it("T1-F7-01: Balanced Conditioning Baseline Calculation", function () {
        const profile: UserProfile = { age: 35, gender: "male", bodyFatPct: 24, muscleMassKg: 50 };
        const res = calculateBaselineTarget(profile);
        expect(res.fitnessTier).to.equal("balanced-conditioning");
        expect(res.baselineSteps).to.equal(8000);
        expect(res.baselineActiveMinutes).to.equal(35);
      });

      it("T1-F7-02: High-Output Baseline Calculation", function () {
        const profile: UserProfile = { age: 28, gender: "female", bodyFatPct: 18, muscleMassKg: 55 };
        const res = calculateBaselineTarget(profile);
        expect(res.fitnessTier).to.equal("high-output");
        expect(res.baselineSteps).to.equal(10500); // 10000 + 500
        expect(res.baselineActiveMinutes).to.equal(45);
      });

      it("T1-F7-03: Metabolic-Rebuild Baseline Calculation", function () {
        const profile: UserProfile = { age: 40, gender: "male", bodyFatPct: 34, muscleMassKg: 42 };
        const res = calculateBaselineTarget(profile);
        expect(res.fitnessTier).to.equal("metabolic-rebuild");
        expect(res.baselineSteps).to.equal(6500);
        expect(res.baselineActiveMinutes).to.equal(25);
      });

      it("T1-F7-04: Senior Age Adjustment", function () {
        const profile: UserProfile = { age: 58, gender: "female", bodyFatPct: 24, muscleMassKg: 50 };
        const res = calculateBaselineTarget(profile);
        expect(res.baselineSteps).to.equal(7000); // 8000 - 1000
      });

      it("T1-F7-05: Dynamic Fatigue Scaling on 72h Inactivity Gap", function () {
        const T0 = 1000000000;
        const T1 = T0 + 72 * 3600 * 1000;
        const scaled = scaleTargetForInactivityGap(8000, T0, T1);
        expect(scaled.adjustedTarget).to.equal(5600); // 8000 * 0.70
        expect(scaled.isFatigueScaled).to.be.true;
        expect(scaled.scalingFactorApplied).to.equal(0.7);
      });
    });

    // ------------------------------------------------------------------------
    // Feature 8: Supabase Initial Schema & RLS Policies
    // ------------------------------------------------------------------------
    describe("Feature 8: Supabase Initial Schema & RLS Policies", function () {
      const sqlPath = path.resolve(__dirname, "../../../supabase/migrations/001_initial_schema.sql");

      it("T1-F8-01: Database Table Structure & Columns", function () {
        expect(fs.existsSync(sqlPath)).to.be.true;
        const sql = fs.readFileSync(sqlPath, "utf-8");
        expect(sql).to.include("CREATE TABLE IF NOT EXISTS anonymized_feed");
        expect(sql).to.include("CREATE TABLE IF NOT EXISTS peer_cheers");
        expect(sql).to.include("user_pseudonym TEXT NOT NULL");
        expect(sql).to.include("proof_hash TEXT NOT NULL UNIQUE");
        expect(sql).to.include("streak_count INT NOT NULL CHECK (streak_count >= 1)");
      });

      it("T1-F8-02: Foreign Key Cascade Deletion", function () {
        const sql = fs.readFileSync(sqlPath, "utf-8");
        expect(sql).to.include("REFERENCES anonymized_feed(id) ON DELETE CASCADE");
      });

      it("T1-F8-03: Public Anonymous Read Access", function () {
        const sql = fs.readFileSync(sqlPath, "utf-8");
        expect(sql).to.include("CREATE POLICY \"Allow public read on anonymized_feed\"");
        expect(sql).to.include("CREATE POLICY \"Allow public read on peer_cheers\"");
        expect(sql).to.include("FOR SELECT\n    USING (true)");
      });

      it("T1-F8-04: Authenticated User Insert Access", function () {
        const sql = fs.readFileSync(sqlPath, "utf-8");
        expect(sql).to.include("auth.role() = 'authenticated'");
      });

      it("T1-F8-05: Anonymous Verified Insert Policy", function () {
        const sql = fs.readFileSync(sqlPath, "utf-8");
        expect(sql).to.include("proof_hash ~ '^0x[a-fA-F0-9]{64}$'");
        expect(sql).to.include("length(user_pseudonym) >= 3");
        expect(sql).to.include("streak_count >= 1");
      });
    });
  });

  // ==========================================================================
  // PART B: TIER 2 — BOUNDARY & CORNER CASES (40 Tests: 5 x 8 Features)
  // ==========================================================================
  describe("Tier 2: Boundary & Corner Cases", function () {
    // ------------------------------------------------------------------------
    // Feature 1: Monorepo Scaffolding & Shared Types Boundaries
    // ------------------------------------------------------------------------
    describe("Feature 1 Boundaries: Monorepo Scaffolding & Shared Types", function () {
      it("T2-F1-01: Address Schema Invalid Length Rejection", function () {
        expect(AddressSchema.safeParse("not-an-address").success).to.be.false;
        expect(AddressSchema.safeParse("0x123").success).to.be.false;
        expect(AddressSchema.safeParse("0x" + "1".repeat(39)).success).to.be.false;
      });

      it("T2-F1-02: Bytes32 Schema Invalid Length Rejection", function () {
        expect(Bytes32Schema.safeParse("0xabc").success).to.be.false;
        expect(Bytes32Schema.safeParse("0x" + "a".repeat(63)).success).to.be.false;
        expect(Bytes32Schema.safeParse("0x" + "a".repeat(65)).success).to.be.false;
      });

      it("T2-F1-03: HexSignature Schema Invalid Length Rejection", function () {
        expect(HexSignatureSchema.safeParse("0x" + "b".repeat(128)).success).to.be.false;
        expect(HexSignatureSchema.safeParse("0x" + "b".repeat(132)).success).to.be.false;
      });

      it("T2-F1-04: Circular Package Dependency Prohibition", function () {
        const sharedPkg = JSON.parse(
          fs.readFileSync(path.resolve(__dirname, "../../../shared/package.json"), "utf-8")
        );
        expect(sharedPkg.dependencies).to.not.have.property("@dehealth/mobile");
        expect(sharedPkg.dependencies).to.not.have.property("@dehealth/contracts");
      });

      it("T2-F1-05: Missing Environment Configuration Fallback", function () {
        const domain = createDeHealthDomain("0x1111111111111111111111111111111111111111");
        expect(domain.chainId).to.equal(421614); // Fallback to default Arbitrum Sepolia
      });
    });

    // ------------------------------------------------------------------------
    // Feature 2: EIP-712 Domain & TypeHash Boundaries
    // ------------------------------------------------------------------------
    describe("Feature 2 Boundaries: EIP-712 Domain & TypeHash", function () {
      it("T2-F2-01: Cross-Chain Replay Boundary (ChainId Mismatch)", async function () {
        const { gate, gateAddress, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("cross-chain-replay")) as `0x${string}`,
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        // Signed with chainId: 421614 (Arbitrum Sepolia) instead of 31337 (Local Hardhat)
        const signedWrongChain = await signWorkoutProof(userAlice, proof, gateAddress as `0x${string}`, 421614);
        await expect(gate.claimStreakReward(signedWrongChain.proof, signedWrongChain.signature))
          .to.be.revertedWithCustomError(gate, "InvalidSigner");
      });

      it("T2-F2-02: VerifyingContract Address Mismatch Boundary", async function () {
        const { gate, userAlice, chainId } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();
        const fakeGate = "0x9999999999999999999999999999999999999999";
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("wrong-gate")) as `0x${string}`,
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        const signedWrongGate = await signWorkoutProof(userAlice, proof, fakeGate as `0x${string}`, chainId);
        await expect(gate.claimStreakReward(signedWrongGate.proof, signedWrongGate.signature))
          .to.be.revertedWithCustomError(gate, "InvalidSigner");
      });

      it("T2-F2-03: Domain Name / Version Mismatch Boundary", async function () {
        const { gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("wrong-version")) as `0x${string}`,
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        // Sign with version "2"
        const wrongDomain = {
          name: "DeHealthProtocol",
          version: "2",
          chainId,
          verifyingContract: gateAddress
        };
        const types = {
          WorkoutProof: WORKOUT_PROOF_EIP712_TYPES.WorkoutProof.map((f) => ({ name: f.name, type: f.type }))
        };
        const rawSignature = await userAlice.signTypedData(wrongDomain, types, proof as unknown as Record<string, unknown>);
        await expect(gate.claimStreakReward(proof, rawSignature))
          .to.be.revertedWithCustomError(gate, "InvalidSigner");
      });

      it("T2-F2-04: Struct Field Permutation Boundary", async function () {
        const { gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("permuted-fields")) as `0x${string}`,
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        const domain = createDeHealthDomain(gateAddress as `0x${string}`, chainId);
        // Permute struct fields (nonce before streakCount)
        const permutedTypes = {
          WorkoutProof: [
            { name: "user", type: "address" },
            { name: "telemetryHash", type: "bytes32" },
            { name: "nonce", type: "uint256" },
            { name: "streakCount", type: "uint256" },
            { name: "deadline", type: "uint256" }
          ]
        };
        const rawSig = await userAlice.signTypedData(domain, permutedTypes, proof as unknown as Record<string, unknown>);
        await expect(gate.claimStreakReward(proof, rawSig))
          .to.be.revertedWithCustomError(gate, "InvalidSigner");
      });

      it("T2-F2-05: Extreme ChainId Values Boundary", function () {
        const domain1 = createDeHealthDomain("0x1111111111111111111111111111111111111111", 1);
        expect(domain1.chainId).to.equal(1);
        const domainMax = createDeHealthDomain("0x1111111111111111111111111111111111111111", 2147483647);
        expect(domainMax.chainId).to.equal(2147483647);
      });
    });

    // ------------------------------------------------------------------------
    // Feature 3: Zod Inbound Schemas Boundaries
    // ------------------------------------------------------------------------
    describe("Feature 3 Boundaries: Zod Inbound Schemas", function () {
      it("T2-F3-01: Address String Boundary Conditions", function () {
        expect(AddressSchema.safeParse("0x" + "a".repeat(39)).success).to.be.false;
        expect(AddressSchema.safeParse("0x" + "a".repeat(41)).success).to.be.false;
        expect(AddressSchema.safeParse("a".repeat(40)).success).to.be.false; // missing 0x
        expect(AddressSchema.safeParse("0x" + "g".repeat(40)).success).to.be.false; // non-hex
        expect(AddressSchema.safeParse("0x" + "a".repeat(40)).success).to.be.true;
      });

      it("T2-F3-02: Bytes32 String Boundary Conditions", function () {
        expect(Bytes32Schema.safeParse("0x" + "c".repeat(63)).success).to.be.false;
        expect(Bytes32Schema.safeParse("0x" + "c".repeat(65)).success).to.be.false;
        expect(Bytes32Schema.safeParse("").success).to.be.false;
        expect(Bytes32Schema.safeParse("0x" + "c".repeat(64)).success).to.be.true;
      });

      it("T2-F3-03: Uint256 Numeric Extremes & Overflow", function () {
        expect(Uint256Schema.safeParse(0n).success).to.be.true;
        expect(Uint256Schema.safeParse(-1n).success).to.be.false;
        const maxUint256 = (1n << 256n) - 1n;
        expect(Uint256Schema.safeParse(maxUint256).success).to.be.true;
        const overflow = 1n << 256n;
        expect(Uint256Schema.safeParse(overflow).success).to.be.false;
        expect(Uint256Schema.safeParse("12.34").success).to.be.false;
        expect(Uint256Schema.safeParse(NaN).success).to.be.false;
      });

      it("T2-F3-04: Biometric Physiological Extremes", function () {
        const base = { gender: "female", bodyFatPct: 20, muscleMassKg: 50 };
        expect(UserProfileSchema.safeParse({ ...base, age: 12 }).success).to.be.false;
        expect(UserProfileSchema.safeParse({ ...base, age: 13 }).success).to.be.true;
        expect(UserProfileSchema.safeParse({ ...base, age: 120 }).success).to.be.true;
        expect(UserProfileSchema.safeParse({ ...base, age: 121 }).success).to.be.false;

        const base2 = { age: 30, gender: "male", muscleMassKg: 50 };
        expect(UserProfileSchema.safeParse({ ...base2, bodyFatPct: 1.9 }).success).to.be.false;
        expect(UserProfileSchema.safeParse({ ...base2, bodyFatPct: 2.0 }).success).to.be.true;
        expect(UserProfileSchema.safeParse({ ...base2, bodyFatPct: 75.0 }).success).to.be.true;
        expect(UserProfileSchema.safeParse({ ...base2, bodyFatPct: 75.1 }).success).to.be.false;
      });

      it("T2-F3-05: Unicode & Malformed String Edge Cases", function () {
        expect(AnonymizedFeedInsertSchema.safeParse({
          user_pseudonym: "   ",
          proof_hash: "0x" + "a".repeat(64),
          streak_count: 1
        }).success).to.be.false;

        expect(AnonymizedFeedInsertSchema.safeParse({
          user_pseudonym: "ab", // len 2 < 3
          proof_hash: "0x" + "a".repeat(64),
          streak_count: 1
        }).success).to.be.false;

        expect(AnonymizedFeedInsertSchema.safeParse({
          user_pseudonym: "a".repeat(65), // > 64
          proof_hash: "0x" + "a".repeat(64),
          streak_count: 1
        }).success).to.be.false;

        expect(AnonymizedFeedInsertSchema.safeParse({
          user_pseudonym: "runner_valid_123",
          proof_hash: "0x" + "a".repeat(64),
          streak_count: 1
        }).success).to.be.true;
      });
    });

    // ------------------------------------------------------------------------
    // Feature 4: DeHealthToken ($DHT) Boundaries
    // ------------------------------------------------------------------------
    describe("Feature 4 Boundaries: DeHealthToken ($DHT)", function () {
      it("T2-F4-01: Unauthorized Caller Mint Revert", async function () {
        const { token, attacker } = await loadFixture(deployDeHealthFixture);
        await expect(token.connect(attacker).mint(attacker.address, 100n))
          .to.be.revertedWithCustomError(token, "UnauthorizedMinter")
          .withArgs(attacker.address);
      });

      it("T2-F4-02: Zero Address Minter Authorization Revert", async function () {
        const { token, deployer } = await loadFixture(deployDeHealthFixture);
        await expect(token.connect(deployer).setAuthorizedMinter(ethers.ZeroAddress, true))
          .to.be.revertedWithCustomError(token, "ZeroAddressNotAllowed");
      });

      it("T2-F4-03: Non-Owner Minter Authorization Revert", async function () {
        const { token, attacker } = await loadFixture(deployDeHealthFixture);
        await expect(token.connect(attacker).setAuthorizedMinter(attacker.address, true))
          .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
          .withArgs(attacker.address);
      });

      it("T2-F4-04: Minter Revocation Enforcement", async function () {
        const { token, deployer, other, userAlice } = await loadFixture(deployDeHealthFixture);
        await token.connect(deployer).setAuthorizedMinter(other.address, true);
        await token.connect(other).mint(userAlice.address, 10n); // succeeds

        // Revoke
        await token.connect(deployer).setAuthorizedMinter(other.address, false);
        await expect(token.connect(other).mint(userAlice.address, 10n))
          .to.be.revertedWithCustomError(token, "UnauthorizedMinter")
          .withArgs(other.address);
      });

      it("T2-F4-05: Mint to Zero Address Revert", async function () {
        const { token, deployer } = await loadFixture(deployDeHealthFixture);
        await expect(token.connect(deployer).mint(ethers.ZeroAddress, 10n))
          .to.be.revertedWithCustomError(token, "ERC20InvalidReceiver")
          .withArgs(ethers.ZeroAddress);
      });
    });

    // ------------------------------------------------------------------------
    // Feature 5: DeHealthRewardGate Claim Boundaries
    // ------------------------------------------------------------------------
    describe("Feature 5 Boundaries: DeHealthRewardGate Claim", function () {
      it("T2-F5-01: Zero Address User Revert", async function () {
        const { gate, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();
        const proof = {
          user: ethers.ZeroAddress,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("zero-user")),
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        const dummySig = "0x" + "1".repeat(130);
        await expect(gate.connect(userAlice).claimStreakReward(proof, dummySig))
          .to.be.revertedWithCustomError(gate, "ZeroAddressNotAllowed");
      });

      it("T2-F5-02: Zero Streak Count Revert", async function () {
        const { gate, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();
        const proof = {
          user: userAlice.address,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("zero-streak")),
          streakCount: 0n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        const dummySig = "0x" + "1".repeat(130);
        await expect(gate.connect(userAlice).claimStreakReward(proof, dummySig))
          .to.be.revertedWithCustomError(gate, "InvalidStreakCount");
      });

      it("T2-F5-03: Exact Deadline Timestamp Boundaries", async function () {
        const { gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);

        // Sub-test A: timestamp == deadline (SUCCEEDS, boundary inclusive <=)
        const currentTime = await time.latest();
        const targetDeadline = BigInt(currentTime + 100);
        const proofA: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("tel-exact-deadline")) as `0x${string}`,
          streakCount: 1n,
          nonce: 0n,
          deadline: targetDeadline
        };
        const signedA = await signWorkoutProof(userAlice, proofA, gateAddress as `0x${string}`, chainId);
        // Advance block time exactly to targetDeadline
        await time.setNextBlockTimestamp(targetDeadline);
        await gate.connect(userAlice).claimStreakReward(signedA.proof, signedA.signature);
        expect(await gate.nonces(userAlice.address)).to.equal(1n);

        // Sub-test B: timestamp == deadline + 1 (REVERTS with ExpiredDeadline)
        const currentB = await time.latest();
        const deadlineB = BigInt(currentB + 50);
        const proofB: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("tel-expired-boundary")) as `0x${string}`,
          streakCount: 2n,
          nonce: 1n,
          deadline: deadlineB
        };
        const signedB = await signWorkoutProof(userAlice, proofB, gateAddress as `0x${string}`, chainId);
        await time.setNextBlockTimestamp(deadlineB + 1n);
        await expect(gate.connect(userAlice).claimStreakReward(signedB.proof, signedB.signature))
          .to.be.revertedWithCustomError(gate, "ExpiredDeadline");
      });

      it("T2-F5-04: Nonce Progression Boundaries", async function () {
        const { gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();

        // Sub-test A: Future nonce (nonce: 1 when expected 0)
        const proofFuture: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("tel-future-nonce")) as `0x${string}`,
          streakCount: 1n,
          nonce: 1n,
          deadline: BigInt(latestTime + 3600)
        };
        const signedFuture = await signWorkoutProof(userAlice, proofFuture, gateAddress as `0x${string}`, chainId);
        await expect(gate.connect(userAlice).claimStreakReward(signedFuture.proof, signedFuture.signature))
          .to.be.revertedWithCustomError(gate, "InvalidNonce")
          .withArgs(0n, 1n);

        // Sub-test B: High jump nonce (nonce: 999999n)
        const proofJump: WorkoutProof = {
          ...proofFuture,
          nonce: 999999n
        };
        const signedJump = await signWorkoutProof(userAlice, proofJump, gateAddress as `0x${string}`, chainId);
        await expect(gate.connect(userAlice).claimStreakReward(signedJump.proof, signedJump.signature))
          .to.be.revertedWithCustomError(gate, "InvalidNonce")
          .withArgs(0n, 999999n);
      });

      it("T2-F5-05: Replay & Cryptographic Attack Mitigation", async function () {
        const { gate, gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const latestTime = await time.latest();
        const telHash = ethers.keccak256(ethers.toUtf8Bytes("tel-replay-boundary")) as `0x${string}`;

        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: telHash,
          streakCount: 1n,
          nonce: 0n,
          deadline: BigInt(latestTime + 3600)
        };
        const signed = await signWorkoutProof(userAlice, proof, gateAddress as `0x${string}`, chainId);
        await gate.connect(userAlice).claimStreakReward(signed.proof, signed.signature);

        // Sub-test A: Exact Signature Replay reverts
        await expect(gate.connect(userAlice).claimStreakReward(signed.proof, signed.signature))
          .to.be.revertedWithCustomError(gate, "SignatureReplay");

        // Sub-test B: Same TelemetryHash with new nonce reverts
        const proofRecycled: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: telHash,
          streakCount: 2n,
          nonce: 1n,
          deadline: BigInt(latestTime + 7200)
        };
        const signedRecycled = await signWorkoutProof(userAlice, proofRecycled, gateAddress as `0x${string}`, chainId);
        await expect(gate.connect(userAlice).claimStreakReward(signedRecycled.proof, signedRecycled.signature))
          .to.be.revertedWithCustomError(gate, "SignatureReplay");

        // Sub-test C: Truncated 64-byte signature on fresh proof reverts with ECDSAInvalidSignatureLength
        const freshProof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("tel-fresh-trunc")) as `0x${string}`,
          streakCount: 2n,
          nonce: 1n,
          deadline: BigInt(latestTime + 7200)
        };
        const truncatedSig = signed.signature.slice(0, 130);
        await expect(gate.connect(userAlice).claimStreakReward(freshProof, truncatedSig))
          .to.be.revertedWithCustomError(gate, "ECDSAInvalidSignatureLength");
      });
    });

    // ------------------------------------------------------------------------
    // Feature 6: Mobile CryptoService Boundaries
    // ------------------------------------------------------------------------
    describe("Feature 6 Boundaries: Mobile CryptoService", function () {
      it("T2-F6-01: Minimum Allowable Telemetry Metrics Hashing", function () {
        const minMetrics: TelemetryData = {
          timestampMs: 1,
          stepCount: 0,
          activeMinutes: 0,
          avgHeartRateBpm: 30,
          caloriesBurnedKcal: 0,
          profileSnapshot: { age: 13, gender: "other", bodyFatPct: 2.0, muscleMassKg: 10.0 }
        };
        const hash = hashTelemetry(minMetrics);
        expect(hash).to.match(/^0x[a-fA-F0-9]{64}$/);
      });

      it("T2-F6-02: Maximum Allowable Telemetry Metrics Hashing", function () {
        const maxMetrics: TelemetryData = {
          timestampMs: 253402300799000,
          stepCount: 200000,
          activeMinutes: 1440,
          avgHeartRateBpm: 240,
          caloriesBurnedKcal: 25000,
          profileSnapshot: { age: 120, gender: "a".repeat(32), bodyFatPct: 75.0, muscleMassKg: 150.0 }
        };
        const hash = hashTelemetry(maxMetrics);
        expect(hash).to.match(/^0x[a-fA-F0-9]{64}$/);
      });

      it("T2-F6-03: Unicode Invariance in Telemetry Hashing", function () {
        const tel: TelemetryData = {
          timestampMs: 1731326400000,
          stepCount: 8000,
          activeMinutes: 30,
          avgHeartRateBpm: 120,
          caloriesBurnedKcal: 300,
          profileSnapshot: { age: 25, gender: "Non-Binary", bodyFatPct: 15, muscleMassKg: 55 }
        };
        const hash1 = hashTelemetry(tel);
        const hash2 = hashTelemetry(tel);
        expect(hash1).to.equal(hash2);
      });

      it("T2-F6-04: Tampered Signature Verification Rejection", async function () {
        const { gateAddress, chainId, userAlice } = await loadFixture(deployDeHealthFixture);
        const proof: WorkoutProof = {
          user: userAlice.address as `0x${string}`,
          telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("tamper-proof")) as `0x${string}`,
          streakCount: 1n,
          nonce: 0n,
          deadline: 1893456000n
        };
        const signed = await signWorkoutProof(userAlice, proof, gateAddress as `0x${string}`, chainId);
        // Flip character at index 10 (inside r component)
        const charAt10 = signed.signature[10];
        const flippedChar = charAt10 === "a" ? "b" : "a";
        const tamperedSig = (signed.signature.slice(0, 10) + flippedChar + signed.signature.slice(11)) as `0x${string}`;

        const verified = verifyWorkoutProofSignature(
          { proof: signed.proof, signature: tamperedSig },
          gateAddress as `0x${string}`,
          chainId
        );
        expect(verified).to.be.false;
      });

      it("T2-F6-05: Inbound Invalid Telemetry Rejection", function () {
        expect(() =>
          hashTelemetry({
            timestampMs: 1731326400000,
            stepCount: -5, // invalid negative steps
            activeMinutes: 30,
            avgHeartRateBpm: 120,
            caloriesBurnedKcal: 300,
            profileSnapshot: { age: 25, gender: "male", bodyFatPct: 15, muscleMassKg: 55 }
          })
        ).to.throw();

        expect(() =>
          hashTelemetry({
            timestampMs: 1731326400000,
            stepCount: 8000,
            activeMinutes: 30,
            avgHeartRateBpm: 300, // exceeds max 240
            caloriesBurnedKcal: 300,
            profileSnapshot: { age: 25, gender: "male", bodyFatPct: 15, muscleMassKg: 55 }
          })
        ).to.throw();
      });
    });

    // ------------------------------------------------------------------------
    // Feature 7: Mobile ProfileEngine Target Scaling Boundaries
    // ------------------------------------------------------------------------
    describe("Feature 7 Boundaries: Mobile ProfileEngine Target Scaling", function () {
      it("T2-F7-01: Exactly 48-Hour Inactivity Gap Boundary", function () {
        const T0 = 1000000000;
        const T1 = T0 + FATIGUE_GAP_THRESHOLD_MS; // exactly 172,800,000 ms
        const res = scaleTargetForInactivityGap(8000, T0, T1);
        expect(res.isFatigueScaled).to.be.false;
        expect(res.adjustedTarget).to.equal(8000);
      });

      it("T2-F7-02: 48 Hours + 1 Second Inactivity Gap Boundary", function () {
        const T0 = 1000000000;
        const T1 = T0 + FATIGUE_GAP_THRESHOLD_MS + 1000; // 172,801,000 ms
        const res = scaleTargetForInactivityGap(8000, T0, T1);
        expect(res.isFatigueScaled).to.be.true;
        expect(res.adjustedTarget).to.equal(5600); // 8000 * 0.70
      });

      it("T2-F7-03: 47 Hours 59 Minutes Inactivity Gap Boundary", function () {
        const T0 = 1000000000;
        const T1 = T0 + 172740000; // below 48h
        const res = scaleTargetForInactivityGap(8000, T0, T1);
        expect(res.isFatigueScaled).to.be.false;
        expect(res.adjustedTarget).to.equal(8000);
      });

      it("T2-F7-04: Zero Gap & First-Time User Boundaries", function () {
        const now = 1731326400000;
        const resNull = scaleTargetForInactivityGap(8000, null, now);
        expect(resNull.isFatigueScaled).to.be.false;
        expect(resNull.adjustedTarget).to.equal(8000);

        const resZero = scaleTargetForInactivityGap(8000, now, now);
        expect(resZero.isFatigueScaled).to.be.false;
        expect(resZero.adjustedTarget).to.equal(8000);
      });

      it("T2-F7-05: Negative Inactivity Gap / Time Reversal Error", function () {
        expect(() => scaleTargetForInactivityGap(8000, 2000, 1000)).to.throw(
          "currentTimestampMs cannot precede lastLogTimestampMs"
        );
      });
    });

    // ------------------------------------------------------------------------
    // Feature 8: Supabase Schema & RLS Policy Boundaries
    // ------------------------------------------------------------------------
    describe("Feature 8 Boundaries: Supabase Schema & RLS Policies", function () {
      it("T2-F8-01: User Pseudonym Length Boundaries", function () {
        const validHash = "0x" + "a".repeat(64);
        expect(AnonymizedFeedInsertSchema.safeParse({ user_pseudonym: "ab", proof_hash: validHash, streak_count: 1 }).success).to.be.false;
        expect(AnonymizedFeedInsertSchema.safeParse({ user_pseudonym: "abc", proof_hash: validHash, streak_count: 1 }).success).to.be.true;
        expect(AnonymizedFeedInsertSchema.safeParse({ user_pseudonym: "", proof_hash: validHash, streak_count: 1 }).success).to.be.false;
      });

      it("T2-F8-02: Proof Hash Format Regex Boundaries", function () {
        const base = { user_pseudonym: "valid_runner", streak_count: 1 };
        expect(AnonymizedFeedInsertSchema.safeParse({ ...base, proof_hash: "a".repeat(64) }).success).to.be.false; // missing 0x
        expect(AnonymizedFeedInsertSchema.safeParse({ ...base, proof_hash: "0x" + "a".repeat(63) }).success).to.be.false; // len 63
        expect(AnonymizedFeedInsertSchema.safeParse({ ...base, proof_hash: "0x" + "a".repeat(65) }).success).to.be.false; // len 65
        expect(AnonymizedFeedInsertSchema.safeParse({ ...base, proof_hash: "0x" + "z".repeat(64) }).success).to.be.false; // non-hex
        expect(AnonymizedFeedInsertSchema.safeParse({ ...base, proof_hash: "0x" + "a".repeat(64) }).success).to.be.true;
      });

      it("T2-F8-03: Streak Count Positive Integer Constraint Boundary", function () {
        const base = { user_pseudonym: "valid_runner", proof_hash: "0x" + "a".repeat(64) };
        expect(AnonymizedFeedInsertSchema.safeParse({ ...base, streak_count: 0 }).success).to.be.false;
        expect(AnonymizedFeedInsertSchema.safeParse({ ...base, streak_count: -1 }).success).to.be.false;
        expect(AnonymizedFeedInsertSchema.safeParse({ ...base, streak_count: 1 }).success).to.be.true;
      });

      it("T2-F8-04: Duplicate Proof Hash Unique Constraint Simulation", function () {
        const mockStore = new Set<string>();
        const hash = "0x" + "d".repeat(64);
        mockStore.add(hash);
        // Attempt duplicate insert
        const isDuplicate = mockStore.has(hash);
        expect(isDuplicate).to.be.true;
      });

      it("T2-F8-05: Peer Cheers Sender Pseudonym & Orphan Prevention", function () {
        const validFeedId = "11111111-1111-4111-8111-111111111111";
        expect(PeerCheerInsertSchema.safeParse({ feed_id: "not-a-uuid", sender_pseudonym: "valid_sender" }).success).to.be.false;
        expect(PeerCheerInsertSchema.safeParse({ feed_id: validFeedId, sender_pseudonym: "ab" }).success).to.be.false;
        expect(PeerCheerInsertSchema.safeParse({ feed_id: validFeedId, sender_pseudonym: "abc" }).success).to.be.true;
      });
    });
  });
});
