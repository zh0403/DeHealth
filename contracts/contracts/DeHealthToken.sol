// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title DeHealthToken
 * @notice Standard utility ERC-20 token ($DHT) for the DeHealth Protocol.
 * @dev Minting is restricted to the contract owner or explicitly authorized minter gates.
 */
contract DeHealthToken is ERC20, Ownable {
    error UnauthorizedMinter(address caller);
    error ZeroAddressNotAllowed();

    event MinterAuthorizationChanged(address indexed minter, bool indexed allowed);

    mapping(address => bool) public authorizedMinters;

    constructor(address initialOwner) ERC20("DeHealth Token", "DHT") Ownable(initialOwner) {}

    /**
     * @notice Grants or revokes minting permission for a reward gate contract.
     * @param minter Address of the minter contract.
     * @param allowed True to authorize, false to revoke.
     */
    function setAuthorizedMinter(address minter, bool allowed) external onlyOwner {
        if (minter == address(0)) revert ZeroAddressNotAllowed();
        authorizedMinters[minter] = allowed;
        emit MinterAuthorizationChanged(minter, allowed);
    }

    /**
     * @notice Mints $DHT utility tokens to a recipient.
     * @param to Recipient address.
     * @param amount Token amount in wei (18 decimals).
     */
    function mint(address to, uint256 amount) external {
        if (msg.sender != owner() && !authorizedMinters[msg.sender]) {
            revert UnauthorizedMinter(msg.sender);
        }
        _mint(to, amount);
    }
}

