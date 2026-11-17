import { ethers } from "hardhat";
import { DeHealthRewardGate, DeHealthToken } from "../typechain-types";

export interface DeployContractsResult {
  readonly token: DeHealthToken;
  readonly gate: DeHealthRewardGate;
  readonly tokenAddress: string;
  readonly gateAddress: string;
  readonly deployerAddress: string;
  readonly rpcUrl: string;
}

/**
 * Deploys DeHealthToken and DeHealthRewardGate smart contracts,
 * configures minter authorization, and returns deployment artifacts.
 */
export async function deployContracts(): Promise<DeployContractsResult> {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error("No deployer signer available for deployment");
  }

  const deployerAddress = await deployer.getAddress();
  console.log(`[Deploy] Deploying contracts with deployer: ${deployerAddress}`);

  const TokenFactory = await ethers.getContractFactory("DeHealthToken", deployer);
  const token = (await TokenFactory.deploy(deployerAddress)) as DeHealthToken;
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`[Deploy] DeHealthToken deployed at: ${tokenAddress}`);

  const GateFactory = await ethers.getContractFactory("DeHealthRewardGate", deployer);
  const gate = (await GateFactory.deploy(tokenAddress, deployerAddress)) as DeHealthRewardGate;
  await gate.waitForDeployment();
  const gateAddress = await gate.getAddress();
  console.log(`[Deploy] DeHealthRewardGate deployed at: ${gateAddress}`);

  console.log(`[Deploy] Authorizing DeHealthRewardGate as minter on DeHealthToken...`);
  const authTx = await token.setAuthorizedMinter(gateAddress, true);
  await authTx.wait();
  console.log(`[Deploy] Minter authorized successfully.`);

  const rpcUrl =
    process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";

  console.log("\n========================================================");
  console.log("Arbitrum Sepolia Deployment Successful! Ready-to-copy mobile/.env:");
  console.log("========================================================");
  console.log(`EXPO_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL=${rpcUrl}`);
  console.log(`EXPO_PUBLIC_DHT_TOKEN_ADDRESS=${tokenAddress}`);
  console.log(`EXPO_PUBLIC_REWARD_GATE_ADDRESS=${gateAddress}`);
  console.log("========================================================\n");

  return {
    token,
    gate,
    tokenAddress,
    gateAddress,
    deployerAddress,
    rpcUrl
  };
}

export async function main(): Promise<void> {
  await deployContracts();
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
