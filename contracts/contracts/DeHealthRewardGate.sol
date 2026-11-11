// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DeHealthToken} from "./DeHealthToken.sol";

/**
 * @title DeHealthRewardGate
 * @notice Verifies off-chain EIP-712 WorkoutProofs and mints fixed $DHT streak rewards.
 */
contract DeHealthRewardGate is EIP712, Ownable {
    struct WorkoutProof {
        address user;
        bytes32 telemetryHash;
        uint256 streakCount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant WORKOUT_PROOF_TYPEHASH =
        keccak256(
            "WorkoutProof(address user,bytes32 telemetryHash,uint256 streakCount,uint256 nonce,uint256 deadline)"
        );

    uint256 public constant FIXED_STREAK_REWARD = 10 * 10 ** 18;

    DeHealthToken public immutable rewardToken;

    mapping(address => uint256) public nonces;
    mapping(bytes32 => bool) public executedHashes;

    error ZeroAddressNotAllowed();
    error InvalidStreakCount();
    error ExpiredDeadline(uint256 deadline, uint256 currentTimestamp);
    error SignatureReplay(bytes32 digest, bytes32 telemetryHash);
    error InvalidNonce(uint256 expectedNonce, uint256 providedNonce);
    error InvalidSigner(address expectedUser, address recoveredSigner);

    event StreakRewardClaimed(
        address indexed user,
        bytes32 indexed telemetryHash,
        uint256 streakCount,
        uint256 nonce,
        uint256 rewardAmount,
        bytes32 digest
    );

    constructor(
        address tokenAddress,
        address initialOwner
    ) EIP712("DeHealthProtocol", "1") Ownable(initialOwner) {
        if (tokenAddress == address(0)) revert ZeroAddressNotAllowed();
        rewardToken = DeHealthToken(tokenAddress);
    }

    /**
     * @notice Computes the EIP-712 typed data digest for a given WorkoutProof.
     * @param proof The WorkoutProof struct payload.
     * @return digest The 32-byte EIP-712 message digest.
     */
    function hashWorkoutProof(WorkoutProof calldata proof) public view returns (bytes32 digest) {
        bytes32 structHash = keccak256(
            abi.encode(
                WORKOUT_PROOF_TYPEHASH,
                proof.user,
                proof.telemetryHash,
                proof.streakCount,
                proof.nonce,
                proof.deadline
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /**
     * @notice Verifies an EIP-712 signed WorkoutProof and mints the fixed $DHT reward.
     * @param proof The structured workout proof metadata.
     * @param signature The 65-byte ECDSA signature over the EIP-712 typed data hash.
     */
    function claimStreakReward(
        WorkoutProof calldata proof,
        bytes calldata signature
    ) external {
        if (proof.user == address(0)) revert ZeroAddressNotAllowed();
        if (proof.streakCount == 0) revert InvalidStreakCount();
        if (block.timestamp > proof.deadline) {
            revert ExpiredDeadline(proof.deadline, block.timestamp);
        }

        bytes32 digest = hashWorkoutProof(proof);

        if (executedHashes[digest] || executedHashes[proof.telemetryHash]) {
            revert SignatureReplay(digest, proof.telemetryHash);
        }

        uint256 currentNonce = nonces[proof.user];
        if (proof.nonce != currentNonce) {
            revert InvalidNonce(currentNonce, proof.nonce);
        }

        address signer = ECDSA.recover(digest, signature);
        if (signer != proof.user) {
            revert InvalidSigner(proof.user, signer);
        }

        executedHashes[digest] = true;
        executedHashes[proof.telemetryHash] = true;
        unchecked {
            nonces[proof.user] = currentNonce + 1;
        }

        rewardToken.mint(proof.user, FIXED_STREAK_REWARD);

        emit StreakRewardClaimed(
            proof.user,
            proof.telemetryHash,
            proof.streakCount,
            proof.nonce,
            FIXED_STREAK_REWARD,
            digest
        );
    }
}

