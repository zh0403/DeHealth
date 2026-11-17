import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContracts } from "../scripts/deploy";

describe("Arbitrum Sepolia Deployment Script Suite", function () {
  it("deploys token, reward gate, and configures minter authorization", async function () {
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const deployerAddress = await deployer.getAddress();

    const result = await deployContracts();

    expect(result.deployerAddress).to.equal(deployerAddress);
    expect(result.tokenAddress).to.be.properAddress;
    expect(result.gateAddress).to.be.properAddress;
    expect(result.tokenAddress).to.not.equal(result.gateAddress);

    // Verify token ownership and configuration
    const tokenOwner = await result.token.owner();
    expect(tokenOwner).to.equal(deployerAddress);

    const tokenName = await result.token.name();
    const tokenSymbol = await result.token.symbol();
    expect(tokenName).to.equal("DeHealth Token");
    expect(tokenSymbol).to.equal("DHT");

    // Verify gate ownership and linked reward token
    const gateOwner = await result.gate.owner();
    expect(gateOwner).to.equal(deployerAddress);

    const linkedToken = await result.gate.rewardToken();
    expect(linkedToken).to.equal(result.tokenAddress);

    // Verify minter authorization
    const isMinterAuthorized = await result.token.authorizedMinters(result.gateAddress);
    expect(isMinterAuthorized).to.be.true;

    // Verify RPC URL fallback/env string
    expect(result.rpcUrl).to.be.a("string");
    expect(result.rpcUrl.length).to.be.greaterThan(0);
  });

  it("prints valid formatted .env block output", async function () {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      const result = await deployContracts();
      const outputText = logs.join("\n");

      expect(outputText).to.include(`EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL=`);
      expect(outputText).to.include(`EXPO_PUBLIC_DHT_TOKEN_ADDRESS=${result.tokenAddress}`);
      expect(outputText).to.include(`EXPO_PUBLIC_REWARD_GATE_ADDRESS=${result.gateAddress}`);
    } finally {
      console.log = originalLog;
    }
  });
});
