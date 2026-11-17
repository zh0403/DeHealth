import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import hardhatConfig, { loadHardhatEnvironment } from "../hardhat.config";

describe("Hardhat .env Loading (R4 / P3-03)", function () {
  let tempRootDir: string;
  let tempContractsDir: string;

  beforeEach(function () {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "dehealth-hh-env-"));
    tempContractsDir = path.join(tempRootDir, "contracts");
    fs.mkdirSync(tempContractsDir, { recursive: true });
  });

  afterEach(function () {
    fs.rmSync(tempRootDir, { recursive: true, force: true });
  });

  it("loads ARBITRUM_SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY from repository root ../.env", function () {
    fs.writeFileSync(
      path.join(tempRootDir, ".env"),
      [
        'ARBITRUM_SEPOLIA_RPC_URL="https://root-rpc.example.invalid"',
        'DEPLOYER_PRIVATE_KEY="0x1111111111111111111111111111111111111111111111111111111111111111"'
      ].join("\n"),
      "utf8"
    );

    const envBox: Record<string, string | undefined> = {};
    loadHardhatEnvironment(tempContractsDir, envBox);

    expect(envBox.ARBITRUM_SEPOLIA_RPC_URL).to.equal("https://root-rpc.example.invalid");
    expect(envBox.DEPLOYER_PRIVATE_KEY).to.equal(
      "0x1111111111111111111111111111111111111111111111111111111111111111"
    );
  });

  it("prefers contracts/.env over root ../.env while still falling back for missing keys", function () {
    fs.writeFileSync(
      path.join(tempRootDir, ".env"),
      [
        'ARBITRUM_SEPOLIA_RPC_URL="https://root-rpc.example.invalid"',
        'DEPLOYER_PRIVATE_KEY="0x1111111111111111111111111111111111111111111111111111111111111111"'
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tempContractsDir, ".env"),
      'DEPLOYER_PRIVATE_KEY="0x2222222222222222222222222222222222222222222222222222222222222222"\n',
      "utf8"
    );

    const envBox: Record<string, string | undefined> = {};
    loadHardhatEnvironment(tempContractsDir, envBox);

    expect(envBox.ARBITRUM_SEPOLIA_RPC_URL).to.equal("https://root-rpc.example.invalid");
    expect(envBox.DEPLOYER_PRIVATE_KEY).to.equal(
      "0x2222222222222222222222222222222222222222222222222222222222222222"
    );
  });

  it("preserves explicit shell environment variables over .env files", function () {
    fs.writeFileSync(
      path.join(tempRootDir, ".env"),
      'DEPLOYER_PRIVATE_KEY="0x1111111111111111111111111111111111111111111111111111111111111111"\n',
      "utf8"
    );

    const shellKey =
      "0x3333333333333333333333333333333333333333333333333333333333333333";
    const envBox: Record<string, string | undefined> = {
      DEPLOYER_PRIVATE_KEY: shellKey
    };
    loadHardhatEnvironment(tempContractsDir, envBox);

    expect(envBox.DEPLOYER_PRIVATE_KEY).to.equal(shellKey);
  });

  it("configures arbitrumSepolia network with chainId 421614", function () {
    expect(hardhatConfig.networks?.arbitrumSepolia?.chainId).to.equal(421614);
  });
});
