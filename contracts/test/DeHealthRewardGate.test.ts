import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("DeHealthRewardGate & DeHealthToken Suite", function () {
  async function deployContractsFixture() {
    const [owner, user, attacker, other] = await ethers.getSigners();

    const TokenFactory = await ethers.getContractFactory("DeHealthToken");
    const token = await TokenFactory.deploy(owner.address);
    await token.waitForDeployment();

    const GateFactory = await ethers.getContractFactory("DeHealthRewardGate");
    const gate = await GateFactory.deploy(await token.getAddress(), owner.address);
    await gate.waitForDeployment();

    await token.connect(owner).setAuthorizedMinter(await gate.getAddress(), true);

    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "DeHealthProtocol",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await gate.getAddress(),
    };

    const types = {
      WorkoutProof: [
        { name: "user", type: "address" },
        { name: "telemetryHash", type: "bytes32" },
        { name: "streakCount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    return { token, gate, owner, user, attacker, other, domain, types, network };
  }

  describe("Deployment & Authorization", function () {
    it("initializes token and gate with correct owner and minter status", async function () {
      const { token, gate, owner } = await loadFixture(deployContractsFixture);
      expect(await token.owner()).to.equal(owner.address);
      expect(await gate.owner()).to.equal(owner.address);
      expect(await token.authorizedMinters(await gate.getAddress())).to.be.true;
      expect(await gate.rewardToken()).to.equal(await token.getAddress());
    });

    it("reverts deployment of gate if token address is zero", async function () {
      const [owner] = await ethers.getSigners();
      const GateFactory = await ethers.getContractFactory("DeHealthRewardGate");
      await expect(
        GateFactory.deploy(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(GateFactory, "ZeroAddressNotAllowed");
    });
  });

  describe("Reward Claiming via EIP-712 Verification", function () {
    it("successfully claims streak reward with valid signature and mints 10 DHT", async function () {
      const { token, gate, user, domain, types } = await loadFixture(deployContractsFixture);

      const latestTime = await time.latest();
      const proof = {
        user: user.address,
        telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-day-1")),
        streakCount: 3n,
        nonce: 0n,
        deadline: BigInt(latestTime + 3600),
      };

      const signature = await user.signTypedData(domain, types, proof);
      const digest = await gate.hashWorkoutProof(proof);

      await expect(gate.connect(user).claimStreakReward(proof, signature))
        .to.emit(gate, "StreakRewardClaimed")
        .withArgs(
          user.address,
          proof.telemetryHash,
          proof.streakCount,
          proof.nonce,
          ethers.parseEther("10"),
          digest
        );

      expect(await token.balanceOf(user.address)).to.equal(ethers.parseEther("10"));
      expect(await gate.nonces(user.address)).to.equal(1n);
      expect(await gate.executedHashes(digest)).to.be.true;
      expect(await gate.executedHashes(proof.telemetryHash)).to.be.true;
    });

    it("rejects claim when signature is produced by an invalid signer", async function () {
      const { gate, user, attacker, domain, types } = await loadFixture(deployContractsFixture);

      const latestTime = await time.latest();
      const proof = {
        user: user.address,
        telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-day-1")),
        streakCount: 3n,
        nonce: 0n,
        deadline: BigInt(latestTime + 3600),
      };

      const forgedSignature = await attacker.signTypedData(domain, types, proof);

      await expect(gate.claimStreakReward(proof, forgedSignature))
        .to.be.revertedWithCustomError(gate, "InvalidSigner")
        .withArgs(user.address, attacker.address);
    });

    it("rejects claim when deadline has expired", async function () {
      const { gate, user, domain, types } = await loadFixture(deployContractsFixture);

      const latestTime = await time.latest();
      const proof = {
        user: user.address,
        telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-day-1")),
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(latestTime - 10),
      };

      const signature = await user.signTypedData(domain, types, proof);

      await expect(gate.claimStreakReward(proof, signature)).to.be.revertedWithCustomError(
        gate,
        "ExpiredDeadline"
      );
    });

    it("rejects double-spend / replay attack with exact same proof", async function () {
      const { gate, user, domain, types } = await loadFixture(deployContractsFixture);

      const latestTime = await time.latest();
      const proof = {
        user: user.address,
        telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-day-1")),
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(latestTime + 3600),
      };

      const signature = await user.signTypedData(domain, types, proof);
      await gate.claimStreakReward(proof, signature);

      // Replay exact proof
      await expect(gate.claimStreakReward(proof, signature)).to.be.revertedWithCustomError(
        gate,
        "SignatureReplay"
      );
    });

    it("rejects replay attack re-using same telemetryHash with incremented nonce", async function () {
      const { gate, user, domain, types } = await loadFixture(deployContractsFixture);

      const latestTime = await time.latest();
      const telemetryHash = ethers.keccak256(ethers.toUtf8Bytes("telemetry-day-1"));

      const proof1 = {
        user: user.address,
        telemetryHash: telemetryHash,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(latestTime + 3600),
      };
      const sig1 = await user.signTypedData(domain, types, proof1);
      await gate.claimStreakReward(proof1, sig1);

      // Attempt second claim with new nonce but identical physical telemetry
      const proof2 = {
        user: user.address,
        telemetryHash: telemetryHash,
        streakCount: 2n,
        nonce: 1n,
        deadline: BigInt(latestTime + 7200),
      };
      const sig2 = await user.signTypedData(domain, types, proof2);

      await expect(gate.claimStreakReward(proof2, sig2)).to.be.revertedWithCustomError(
        gate,
        "SignatureReplay"
      );
    });

    it("rejects claim when nonce does not match contract state", async function () {
      const { gate, user, domain, types } = await loadFixture(deployContractsFixture);

      const latestTime = await time.latest();
      const proof = {
        user: user.address,
        telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-day-1")),
        streakCount: 1n,
        nonce: 5n, // expected 0
        deadline: BigInt(latestTime + 3600),
      };

      const signature = await user.signTypedData(domain, types, proof);

      await expect(gate.claimStreakReward(proof, signature))
        .to.be.revertedWithCustomError(gate, "InvalidNonce")
        .withArgs(0n, 5n);
    });

    it("rejects zero streak count and zero user address", async function () {
      const { gate, user, domain, types } = await loadFixture(deployContractsFixture);

      const latestTime = await time.latest();
      const zeroStreakProof = {
        user: user.address,
        telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-zero")),
        streakCount: 0n,
        nonce: 0n,
        deadline: BigInt(latestTime + 3600),
      };
      const sig0 = await user.signTypedData(domain, types, zeroStreakProof);
      await expect(gate.claimStreakReward(zeroStreakProof, sig0)).to.be.revertedWithCustomError(
        gate,
        "InvalidStreakCount"
      );

      const zeroUserProof = {
        user: ethers.ZeroAddress,
        telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-zero")),
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(latestTime + 3600),
      };
      await expect(gate.claimStreakReward(zeroUserProof, sig0)).to.be.revertedWithCustomError(
        gate,
        "ZeroAddressNotAllowed"
      );
    });
  });

  describe("DeHealthToken Access Control", function () {
    it("rejects unauthorized caller attempting to mint", async function () {
      const { token, attacker } = await loadFixture(deployContractsFixture);
      await expect(
        token.connect(attacker).mint(attacker.address, ethers.parseEther("100"))
      )
        .to.be.revertedWithCustomError(token, "UnauthorizedMinter")
        .withArgs(attacker.address);
    });

    it("allows owner to set authorized minter and revoke", async function () {
      const { token, owner, other } = await loadFixture(deployContractsFixture);
      await expect(token.connect(owner).setAuthorizedMinter(other.address, true))
        .to.emit(token, "MinterAuthorizationChanged")
        .withArgs(other.address, true);

      expect(await token.authorizedMinters(other.address)).to.be.true;

      await expect(
        token.connect(other).setAuthorizedMinter(other.address, false)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });
  });
});
