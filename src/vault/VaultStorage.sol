// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Terms, Range} from "../types/CovenantTypes.sol";

/// @title VaultStorage
/// @notice The one storage layout shared by CovenantVault and VaultOps.
/// @dev VaultOps runs by DELEGATECALL from a vault, so both contracts must see identical slots. Both inherit this
///      contract and declare no storage of their own. Append only.
abstract contract VaultStorage {
    uint256 internal constant MAX_RANGES = 16;
    /// @dev Reshape stops two short of MAX_RANGES so a curator can never leave restore without room to work.
    uint256 internal constant RESHAPE_MAX_RANGES = 14;
    uint256 internal constant PRINCIPAL_SHARES = 1e18;
    /// @dev Leg share meaning "everything of this currency left after the other legs".
    uint16 internal constant SINK = type(uint16).max;

    enum Op {
        Adopt,
        Reshape,
        Restore,
        Deposit,
        Withdraw,
        Harvest
    }

    PoolKey internal _key;
    PoolId public poolId;
    bool public quoteIsCurrency0;
    Terms internal _terms;

    address public issuer;
    address public pendingIssuer;
    address public treasury;
    address public curator;
    address public pendingCurator;
    /// @dev Zero when no curator change is pending.
    uint64 public curatorReadyAt;

    /// @dev Zero until the first adoption.
    uint64 public adoptedAt;
    int24 internal _anchor;
    uint64 internal _anchorUpdatedAt;
    uint64 internal _paceBudget;
    uint64 internal _paceUpdatedAt;

    Range[] internal _ranges;

    uint256 public totalShares;
    /// @dev The issuer's shares not yet withdrawn. Part of totalShares.
    uint256 public principalShares;
    uint256 public principalWithdrawn;
    mapping(address account => uint256) public sharesOf;

    /// @dev Principal held by the vault outside the pool (rounding and unplaced remainders).
    uint256 public idle0;
    uint256 public idle1;
    /// @dev Trading fees held by the vault, kept apart from principal: owed to shareholders and curators, plus
    ///      rounding remainders of the per-share split.
    uint256 public feePot0;
    uint256 public feePot1;
    /// @dev Quote reserved for restore bounties.
    uint256 public bountyPool;

    bool internal _initialized;

    /// @dev Fees accrue to shares through per-share accumulators (Q128), the same scheme v4 uses for positions.
    ///      `PRINCIPAL_ACCOUNT` holds the issuer's principal shares; its fees go to the treasury.
    struct FeeAccount {
        uint256 growth0; // feeGrowth0 at the last accrual
        uint256 growth1;
        uint256 owed0; // accrued, not yet paid
        uint256 owed1;
    }

    address internal constant PRINCIPAL_ACCOUNT = address(0);

    uint256 public feeGrowth0;
    uint256 public feeGrowth1;
    mapping(address account => FeeAccount) internal _fees;
    /// @dev Curator fee share, by the curator that was in office when the fees were realized.
    mapping(address curator => uint256) public curatorFees0;
    mapping(address curator => uint256) public curatorFees1;
}
