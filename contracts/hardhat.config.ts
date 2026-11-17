import path from "path";
import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import "solidity-coverage";

/**
 * Loads environment variables from `contracts/.env` (higher precedence) and
 * repository root `../.env` (fallback), preserving any explicit shell env vars.
 */
export function loadHardhatEnvironment(
  baseDir: string = __dirname,
  targetEnv: Record<string, string | undefined> = process.env
): dotenv.DotenvConfigOutput {
  const envPaths = [
    path.resolve(baseDir, ".env"),
    path.resolve(baseDir, "../.env")
  ];
  return dotenv.config({
    path: envPaths,
    processEnv: targetEnv as Record<string, string>
  });
}

loadHardhatEnvironment();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  networks: {
    hardhat: {},
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
