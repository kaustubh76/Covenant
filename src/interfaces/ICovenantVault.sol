// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Terms, Range, Cut, Leg, VaultConfig} from "../types/CovenantTypes.sol";

/// @title ICovenantVault
/// @notice Owns a launch's liquidity and enforces its covenant.
///
///         Locked for holders: the issuer's principal cannot leave the pool before it vests, and a reshape can only
///         move value between price ranges.
///         Managed for the market: a curator reshapes freely within the rules.
///
///         Every state change except an exit requires the spot price to be within G of the TWAP. After any curator
///         action at least S of the vault's quote must sit as bids between the reference price and B below it.
///         The vault never places a bid above the Anchor, a reference that follows the TWAP down at once but climbs
///         at most B per epoch, so a price pushed up through empty ticks cannot pull the vault's quote up behind it.
interface ICovenantVault {
    // ------------------------------------------------------------------------------------------------ events
    event Adopted(uint256[] tokenIds, uint256 rangesAfter, uint256 fees0, uint256 fees1);
    event Reshaped(address indexed curator, uint256 movedFraction, uint256 rangesAfter, uint256 supportBps);
    event Restored(
        address indexed keeper, uint256 quoteMoved, uint256 bounty, uint256 supportBefore, uint256 supportAfter
    );
    event Deposited(address indexed owner, uint256 shares, uint256 amount0, uint256 amount1);
    event Withdrawn(address indexed owner, uint256 shares, uint256 amount0, uint256 amount1);
    event PrincipalWithdrawn(uint256 shares, uint256 amount0, uint256 amount1);
    event CuratorProposed(address indexed curator, uint64 readyAt);
    event CuratorProposalCancelled(address indexed curator);
    event CuratorChanged(address indexed previous, address indexed current);
    event IssuerTransferStarted(address indexed previous, address indexed next);
    event IssuerTransferred(address indexed previous, address indexed current);
    event FeesCollected(uint256 toTreasury0, uint256 toTreasury1, uint256 toBountyPool);
    event FeesClaimed(address indexed account, uint256 amount0, uint256 amount1);
    event CuratorFeesClaimed(address indexed curator, uint256 amount0, uint256 amount1);
    event BountyFunded(address indexed from, uint256 amount);

    // ------------------------------------------------------------------------------------------------ errors
    error NotFactory();
    error AlreadyInitialized();
    error NotIssuer();
    error NotPendingIssuer();
    error NotCurator();
    error Expired(uint256 deadline);
    error PoolNotLive();
    error NotAdopted();
    error AlreadyHasOutsideShares();
    error NotOwnedByVault(uint256 tokenId);
    error WrongPool(uint256 tokenId);
    error SetupEpoch(uint256 endsAt);
    /// @dev Guard: spot and TWAP disagree by more than G.
    error PriceGuard(int24 spotTick, int24 twapTick);
    /// @dev Pace: the curator asked to move more of the vault than the allowance holds (units of 1e9 = 100%).
    error PaceExceeded(uint256 requested, uint256 available);
    /// @dev Support: too little of the vault's quote sits in the band after the change.
    error SupportBroken(uint256 haveBps, uint256 needBps);
    /// @dev Bid ceiling: a new range would bid above the Anchor plus G.
    error BidAboveCeiling(int24 bidTopPriceTick, int24 ceilingPriceTick);
    error TooManyRanges(uint256 count, uint256 max);
    error IdleTooLarge(uint256 idle0, uint256 idle1);
    error InvalidCut(uint256 index);
    error InvalidLeg(uint256 index);
    error SharesExceedWhole();
    error SinkStraddlesPrice(uint256 index);
    error NothingToRestore(uint256 haveBps, uint256 needBps);
    error RestoreInsufficient(uint256 haveBps, uint256 needBps);
    error NoQuoteToRestore(uint256 index);
    /// @dev Restore has nowhere to put quote: the band lies above every price the vault already spans.
    error RestoreBandEmpty(int24 bottomPriceTick, int24 topPriceTick);
    error Locked(uint256 withdrawable, uint256 requested);
    error InsufficientShares(uint256 have, uint256 requested);
    error ZeroShares();
    error Slippage(uint256 amount0, uint256 amount1);
    error InsufficientPayment(uint256 owed, uint256 paid);
    error NoCuratorProposal();
    error TimelockActive(uint64 readyAt);
    error UnexpectedSender();
    error NotUnlocked();

    // ------------------------------------------------------------------------------------------------ setup
    function initialize(PoolKey calldata key, VaultConfig calldata config) external;

    /// @notice Take over LP positions the launcher minted to this vault and hold them directly in the PoolManager.
    ///         The first adoption mints the issuer's principal shares and starts the setup epoch, during which Pace
    ///         does not apply. Permissionless. Allowed until outside LPs have joined.
    function adopt(uint256[] calldata tokenIds) external;

    // ------------------------------------------------------------------------------------------------ curator
    /// @notice Remove liquidity from existing ranges and add new ranges, atomically. New ranges are sized inside the
    ///         unlock from what the cuts freed, so a price move before inclusion cannot make conservation fail.
    function reshape(Cut[] calldata cuts, Leg[] calldata legs, uint256 deadline) external;

    // ------------------------------------------------------------------------------------------------ anyone
    /// @notice When Support has lapsed, move the quote of the listed ranges into the band and pay a bounty.
    ///         Tokens stay at their prices or move higher, never lower. Quote never goes above the highest price the
    ///         vault already spans, so restore can never make the vault bid where it has not first offered tokens.
    function restore(uint256[] calldata indices, uint256 deadline) external;

    /// @notice Mint `shares` by adding the same fraction of liquidity to every range, paying in kind.
    function deposit(uint256 shares, uint256 max0, uint256 max1, uint256 deadline)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    /// @notice Burn `shares` for the same fraction of every range, paid in kind. Never blocked by the Guard:
    ///         a proportional exit leaves the vault's shape, and everyone else's share of it, unchanged.
    function withdraw(uint256 shares, uint256 min0, uint256 min1, uint256 deadline)
        external
        returns (uint256 amount0, uint256 amount1);

    function fundBounty(uint256 amount) external payable;

    /// @notice Sync the Anchor. Allowance accrues for at most W seconds between syncs, so the Anchor climbs at its full
    ///         B-per-epoch rate only while something syncs it at least that often: every vault action does, and
    ///         keepers can call this.
    function poke() external returns (int24 anchorTick);

    /// @notice Realize fees on every range, then pay the issuer principal's share of them: the bounty pool is topped
    ///         up to three bounties first, the rest goes to the treasury. Permissionless; funds only go to those two.
    function collectFees() external;

    /// @notice Pay the caller the fees their LP shares have earned. Fees accrue pro rata to every share after the
    ///         curator's share (`terms.curatorFeeBps`) is set aside.
    function claimFees() external returns (uint256 amount0, uint256 amount1);

    /// @notice Pay the caller their curator fee share, earned while they were the curator.
    function claimCuratorFees() external returns (uint256 amount0, uint256 amount1);

    /// @notice Fees `account` could claim now, including what has accrued since its last accrual. Fees still
    ///         sitting unrealized in the pool's positions are not included until something touches the ranges.
    function feesOwed(address account) external view returns (uint256 amount0, uint256 amount1);

    function acceptCurator() external;

    // ------------------------------------------------------------------------------------------------ issuer
    function withdrawPrincipal(uint256 shares, uint256 min0, uint256 min1, uint256 deadline)
        external
        returns (uint256 amount0, uint256 amount1);
    function proposeCurator(address next) external;
    function cancelCuratorProposal() external;
    function transferIssuer(address next) external;
    function acceptIssuer() external;

    // ------------------------------------------------------------------------------------------------ views
    function poolKey() external view returns (PoolKey memory);
    function terms() external view returns (Terms memory);
    function rangeCount() external view returns (uint256);
    function rangeAt(uint256 index) external view returns (Range memory);
    function ranges() external view returns (Range[] memory);
    /// @notice Support now, with the Anchor as it would be after a sync.
    function support() external view returns (uint256 haveBps, uint256 needBps);
    /// @notice The Anchor (price tick) as it would be after a sync now.
    function anchor() external view returns (int24);
    /// @notice Curator allowance available now, in units of 1e9 = whole vault. Unlimited during the setup epoch.
    function paceAvailable() external view returns (uint256);
    /// @notice Principal shares the issuer may withdraw now.
    function principalWithdrawable() external view returns (uint256);
    /// @notice Vault value at the TWAP, in quote. Positions only, at TWAP; idle balances included.
    function totalValue() external view returns (uint256);
}
