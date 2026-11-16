// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {ICovenantVault} from "./interfaces/ICovenantVault.sol";
import {ICovenantHook} from "./interfaces/ICovenantHook.sol";
import {Terms, Range, Cut, Leg, VaultConfig} from "./types/CovenantTypes.sol";
import {Orient} from "./libraries/Orient.sol";
import {PaceLib} from "./libraries/PaceLib.sol";
import {CovenantLogic} from "./libraries/CovenantLogic.sol";
import {VaultStorage} from "./vault/VaultStorage.sol";
import {VaultOps} from "./vault/VaultOps.sol";

/// @title CovenantVault
/// @notice One vault per launch, created by CovenantFactory before the auction and named as the launch's LP position
///         recipient. See ICovenantVault for the rules it enforces.
/// @dev Deployed as minimal-proxy clones of one implementation. Chain-wide addresses are immutables of the
///      implementation; per-launch configuration is storage written once by `initialize`.
///
///      This contract holds the entry points, checks the rules around each PoolManager unlock, and pays out. The work
///      inside an unlock runs in VaultOps by DELEGATECALL, on this vault's storage, so the vault fits under the
///      contract size limit without splitting its custody across addresses.
///
///      Conservation holds by construction rather than by a tolerance check. The vault owns its positions in the
///      PoolManager, pays principal out only for proportional share burns, and sizes every range a reshape adds from
///      what that reshape freed. Whatever is not placed stays in the vault as idle balance, capped at a small fraction
///      of the reshape. Fees are measured by the PoolManager on every touch and booked apart from principal.
contract CovenantVault is VaultStorage, ICovenantVault, IUnlockCallback, ReentrancyGuardTransient {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using PositionInfoLibrary for PositionInfo;

    /// @dev Fees top the bounty pool up to this many bounties before the treasury is paid.
    uint256 internal constant BOUNTY_RESERVE = 3;
    /// @dev A restore pays at most 1% of the quote it moved, so restoring dust cannot farm the pool.
    uint256 internal constant BOUNTY_MAX_BPS = 100;
    uint256 internal constant Q128 = 1 << 128;

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    ICovenantHook public immutable hook;
    VaultOps public immutable ops;
    address public immutable factory;

    /// @dev Prices and terms for one external call, read once.
    struct Ctx {
        bool q0;
        int24 spacing;
        int24 spotTick;
        int24 twapTick;
        int24 twapPrice;
        int24 anchor;
        Terms t;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    modifier beforeDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired(deadline);
        _;
    }

    constructor(IPoolManager poolManager_, IPositionManager positionManager_, ICovenantHook hook_, VaultOps ops_) {
        poolManager = poolManager_;
        positionManager = positionManager_;
        hook = hook_;
        ops = ops_;
        factory = msg.sender;
        _initialized = true; // the implementation itself is never a vault
    }

    /// @dev Native ETH arrives only from the PoolManager and PositionManager. Deposits and bounty funding are payable
    ///      functions, so stray transfers are refused rather than silently absorbed.
    receive() external payable {
        if (msg.sender != address(poolManager) && msg.sender != address(positionManager)) revert UnexpectedSender();
    }

    // =========================================================================================== setup

    /// @inheritdoc ICovenantVault
    function initialize(PoolKey calldata key, VaultConfig calldata config) external {
        if (msg.sender != factory) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _key = key;
        poolId = key.toId();
        quoteIsCurrency0 = config.quoteIsCurrency0;
        _terms = config.terms;
        issuer = config.issuer;
        treasury = config.treasury;
        curator = config.curator;
    }

    /// @inheritdoc ICovenantVault
    function adopt(uint256[] calldata tokenIds) external nonReentrant {
        if (totalShares != principalShares) revert AlreadyHasOutsideShares();
        (bool live, int24 initialTick,) = hook.poolInfo(poolId);
        if (!live) revert PoolNotLive();

        (bytes memory burnPlan, Range[] memory adds, uint256 principal0, uint256 principal1) = _burnPlan(tokenIds);
        (uint256 got0, uint256 got1) = _burnAndReceive(burnPlan);
        // Removal pays principal exactly as RangeMath computes it; anything above that is accrued fees.
        uint256 fees0 = got0 > principal0 ? got0 - principal0 : 0;
        uint256 fees1 = got1 > principal1 ? got1 - principal1 : 0;
        // Fees the launcher's positions earned before adoption belong to whoever owned them: the issuer.
        feePot0 += fees0;
        feePot1 += fees1;
        _fees[PRINCIPAL_ACCOUNT].owed0 += fees0;
        _fees[PRINCIPAL_ACCOUNT].owed1 += fees1;

        poolManager.unlock(abi.encode(Op.Adopt, abi.encode(adds, got0 - fees0, got1 - fees1)));

        if (adoptedAt == 0) _start(initialTick);
        emit Adopted(tokenIds, _ranges.length, fees0, fees1);
    }

    // =========================================================================================== curator

    /// @inheritdoc ICovenantVault
    function reshape(Cut[] calldata cuts, Leg[] calldata legs, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
    {
        if (msg.sender != curator) revert NotCurator();
        if (adoptedAt == 0) revert NotAdopted();
        Ctx memory c = _ctx();
        _guard(c);
        _commitAnchor(c);
        uint256 moved = CovenantLogic.cutFraction(_ranges, cuts, c.q0, c.twapTick, idle0, idle1);
        _spendPace(c.t, moved);
        (uint256 sink0, uint256 sink1) = CovenantLogic.validateLegs(c.spacing, legs);

        int24 ceiling = c.anchor + c.t.guardTicks;
        poolManager.unlock(abi.encode(Op.Reshape, abi.encode(cuts, legs, ceiling, sink0, sink1)));

        if (_ranges.length > RESHAPE_MAX_RANGES) revert TooManyRanges(_ranges.length, RESHAPE_MAX_RANGES);
        uint256 have = _supportBps(c);
        if (have < c.t.supportBps) revert SupportBroken(have, c.t.supportBps);
        emit Reshaped(msg.sender, moved, _ranges.length, have);
    }

    // =========================================================================================== anyone

    /// @inheritdoc ICovenantVault
    function restore(uint256[] calldata indices, uint256 deadline) external nonReentrant beforeDeadline(deadline) {
        if (adoptedAt == 0) revert NotAdopted();
        Ctx memory c = _ctx();
        _guard(c);
        _commitAnchor(c);
        uint256 before = _supportBps(c);
        if (before >= c.t.supportBps) revert NothingToRestore(before, c.t.supportBps);

        (int24 bandLower, int24 bandUpper, int24 askFloor) = CovenantLogic.restoreTargets(
            c.q0, c.spacing, c.spotTick, c.twapPrice, c.anchor, CovenantLogic.spanTop(_ranges, c.q0), c.t
        );
        bytes memory result =
            poolManager.unlock(abi.encode(Op.Restore, abi.encode(indices, bandLower, bandUpper, askFloor)));
        uint256 quoteMoved = abi.decode(result, (uint256));

        if (_ranges.length > MAX_RANGES) revert TooManyRanges(_ranges.length, MAX_RANGES);
        uint256 afterBps = _supportBps(c);
        if (afterBps < c.t.supportBps) revert RestoreInsufficient(afterBps, c.t.supportBps);

        uint256 bounty = _min(_min(c.t.bounty, bountyPool), quoteMoved * BOUNTY_MAX_BPS / 1e4);
        if (bounty > 0) {
            bountyPool -= bounty;
            _quote().transfer(msg.sender, bounty);
        }
        emit Restored(msg.sender, quoteMoved, bounty, before, afterBps);
    }

    /// @inheritdoc ICovenantVault
    function deposit(uint256 shares, uint256 max0, uint256 max1, uint256 deadline)
        external
        payable
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        if (adoptedAt == 0 || totalShares == 0) revert NotAdopted();
        uint256 setupEnds = uint256(adoptedAt) + _terms.epochLength;
        if (block.timestamp < setupEnds) revert SetupEpoch(setupEnds);
        if (shares == 0) revert ZeroShares();
        Ctx memory c = _ctx();
        _guard(c);
        _commitAnchor(c);

        bytes memory result = poolManager.unlock(abi.encode(Op.Deposit, abi.encode(shares, msg.sender, msg.value)));
        (amount0, amount1) = abi.decode(result, (uint256, uint256));
        if (amount0 > max0 || amount1 > max1) revert Slippage(amount0, amount1);

        // Fees realized by this deposit's own touch belong to the shares that existed before it.
        _accrue(msg.sender, sharesOf[msg.sender]);
        sharesOf[msg.sender] += shares;
        totalShares += shares;
        if (msg.value > 0) {
            // Native ETH is always currency0, and VaultOps already checked msg.value covers amount0.
            uint256 refund = _key.currency0.isAddressZero() ? msg.value - amount0 : msg.value;
            if (refund > 0) SafeTransferLib.safeTransferETH(msg.sender, refund);
        }
        emit Deposited(msg.sender, shares, amount0, amount1);
    }

    /// @inheritdoc ICovenantVault
    function withdraw(uint256 shares, uint256 min0, uint256 min1, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 held = sharesOf[msg.sender];
        if (shares == 0) revert ZeroShares();
        if (shares > held) revert InsufficientShares(held, shares);
        (amount0, amount1) = _exit(shares, msg.sender, held, msg.sender, min0, min1);
        emit Withdrawn(msg.sender, shares, amount0, amount1);
    }

    /// @inheritdoc ICovenantVault
    function poke() external nonReentrant returns (int24) {
        if (adoptedAt == 0) revert NotAdopted();
        Ctx memory c = _ctx();
        _commitAnchor(c);
        return c.anchor;
    }

    /// @inheritdoc ICovenantVault
    function fundBounty(uint256 amount) external payable nonReentrant {
        Currency quote = _quote();
        if (quote.isAddressZero()) {
            if (msg.value != amount) revert InsufficientPayment(amount, msg.value);
        } else {
            if (msg.value != 0) revert InsufficientPayment(0, msg.value);
            SafeTransferLib.safeTransferFrom(Currency.unwrap(quote), msg.sender, address(this), amount);
        }
        bountyPool += amount;
        emit BountyFunded(msg.sender, amount);
    }

    /// @inheritdoc ICovenantVault
    function collectFees() external nonReentrant {
        if (_ranges.length > 0) poolManager.unlock(abi.encode(Op.Harvest, bytes("")));
        _accrue(PRINCIPAL_ACCOUNT, principalShares);
        FeeAccount storage a = _fees[PRINCIPAL_ACCOUNT];
        // Top the bounty pool up from the principal's quote fees before the treasury is paid.
        uint256 reserve = uint256(_terms.bounty) * BOUNTY_RESERVE;
        bool q0 = quoteIsCurrency0;
        uint256 toBounty = bountyPool < reserve ? _min(reserve - bountyPool, q0 ? a.owed0 : a.owed1) : 0;
        if (toBounty > 0) {
            if (q0) a.owed0 -= toBounty;
            else a.owed1 -= toBounty;
            if (q0) feePot0 -= toBounty;
            else feePot1 -= toBounty;
            bountyPool += toBounty;
        }
        (uint256 out0, uint256 out1) = _payFees(PRINCIPAL_ACCOUNT, treasury);
        emit FeesCollected(out0, out1, toBounty);
    }

    /// @inheritdoc ICovenantVault
    function claimFees() external nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (_ranges.length > 0) poolManager.unlock(abi.encode(Op.Harvest, bytes("")));
        _accrue(msg.sender, sharesOf[msg.sender]);
        (amount0, amount1) = _payFees(msg.sender, msg.sender);
        emit FeesClaimed(msg.sender, amount0, amount1);
    }

    /// @inheritdoc ICovenantVault
    function claimCuratorFees() external nonReentrant returns (uint256 amount0, uint256 amount1) {
        amount0 = curatorFees0[msg.sender];
        amount1 = curatorFees1[msg.sender];
        curatorFees0[msg.sender] = 0;
        curatorFees1[msg.sender] = 0;
        feePot0 -= amount0;
        feePot1 -= amount1;
        if (amount0 > 0) _key.currency0.transfer(msg.sender, amount0);
        if (amount1 > 0) _key.currency1.transfer(msg.sender, amount1);
        emit CuratorFeesClaimed(msg.sender, amount0, amount1);
    }

    /// @inheritdoc ICovenantVault
    function acceptCurator() external {
        uint64 readyAt = curatorReadyAt;
        if (readyAt == 0) revert NoCuratorProposal();
        if (block.timestamp < readyAt) revert TimelockActive(readyAt);
        address previous = curator;
        curator = pendingCurator;
        pendingCurator = address(0);
        curatorReadyAt = 0;
        emit CuratorChanged(previous, curator);
    }

    // =========================================================================================== issuer

    /// @inheritdoc ICovenantVault
    function withdrawPrincipal(uint256 shares, uint256 min0, uint256 min1, uint256 deadline)
        external
        onlyIssuer
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        if (shares == 0) revert ZeroShares();
        uint256 allowed = principalWithdrawable();
        if (shares > allowed) revert Locked(allowed, shares);
        principalWithdrawn += shares;
        (amount0, amount1) = _exit(shares, PRINCIPAL_ACCOUNT, principalShares, treasury, min0, min1);
        emit PrincipalWithdrawn(shares, amount0, amount1);
    }

    /// @inheritdoc ICovenantVault
    function proposeCurator(address next) external onlyIssuer {
        uint64 readyAt = uint64(block.timestamp) + _terms.curatorTimelock;
        pendingCurator = next;
        curatorReadyAt = readyAt;
        emit CuratorProposed(next, readyAt);
    }

    /// @inheritdoc ICovenantVault
    function cancelCuratorProposal() external onlyIssuer {
        if (curatorReadyAt == 0) revert NoCuratorProposal();
        emit CuratorProposalCancelled(pendingCurator);
        pendingCurator = address(0);
        curatorReadyAt = 0;
    }

    /// @inheritdoc ICovenantVault
    function transferIssuer(address next) external onlyIssuer {
        pendingIssuer = next;
        emit IssuerTransferStarted(issuer, next);
    }

    /// @inheritdoc ICovenantVault
    function acceptIssuer() external {
        if (msg.sender != pendingIssuer) revert NotPendingIssuer();
        emit IssuerTransferred(issuer, msg.sender);
        issuer = msg.sender;
        pendingIssuer = address(0);
    }

    // =========================================================================================== unlock

    /// @dev The PoolManager calls back only the contract that unlocked it, so this runs only inside this vault's own
    ///      calls. The body executes in VaultOps on this vault's storage.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert UnexpectedSender();
        (bool ok, bytes memory ret) = address(ops).delegatecall(abi.encodeCall(VaultOps.execute, (data)));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return abi.decode(ret, (bytes));
    }

    // =========================================================================================== internals

    /// @dev Validate the NFTs and build one PositionManager call that burns them all and pays this vault.
    function _burnPlan(uint256[] calldata tokenIds)
        internal
        view
        returns (bytes memory plan, Range[] memory adds, uint256 principal0, uint256 principal1)
    {
        uint256 n = tokenIds.length;
        bytes memory actions = new bytes(n + 1);
        bytes[] memory params = new bytes[](n + 1);
        adds = new Range[](n);
        (uint160 sqrtSpot,,,) = poolManager.getSlot0(poolId);
        for (uint256 i; i < n; i++) {
            uint256 id = tokenIds[i];
            if (IERC721(address(positionManager)).ownerOf(id) != address(this)) revert NotOwnedByVault(id);
            (PoolKey memory k, PositionInfo info) = positionManager.getPoolAndPositionInfo(id);
            if (PoolId.unwrap(k.toId()) != PoolId.unwrap(poolId)) revert WrongPool(id);
            Range memory r = Range(info.tickLower(), info.tickUpper(), positionManager.getPositionLiquidity(id));
            adds[i] = r;
            (uint256 a0, uint256 a1) = CovenantLogic.amounts(sqrtSpot, r.tickLower, r.tickUpper, r.liquidity);
            principal0 += a0;
            principal1 += a1;
            actions[i] = bytes1(uint8(Actions.BURN_POSITION));
            params[i] = abi.encode(id, uint128(0), uint128(0), bytes(""));
        }
        actions[n] = bytes1(uint8(Actions.TAKE_PAIR));
        params[n] = abi.encode(_key.currency0, _key.currency1, address(this));
        plan = abi.encode(actions, params);
    }

    function _burnAndReceive(bytes memory plan) internal returns (uint256 got0, uint256 got1) {
        Currency c0 = _key.currency0;
        Currency c1 = _key.currency1;
        uint256 before0 = c0.balanceOfSelf();
        uint256 before1 = c1.balanceOfSelf();
        positionManager.modifyLiquidities(plan, block.timestamp);
        got0 = c0.balanceOfSelf() - before0;
        got1 = c1.balanceOfSelf() - before1;
    }

    /// @dev First adoption: mint the issuer's principal, start the setup epoch, set the Anchor at the clearing price.
    function _start(int24 initialTick) internal {
        Terms memory t = _terms;
        adoptedAt = uint64(block.timestamp);
        principalShares = PRINCIPAL_SHARES;
        totalShares = PRINCIPAL_SHARES;
        _anchor = Orient.toPrice(quoteIsCurrency0, initialTick);
        _anchorUpdatedAt = uint64(block.timestamp);
        // Pace starts full once the setup epoch ends.
        _paceBudget = uint64(uint256(t.paceBps) * PaceLib.ONE / 1e4);
        _paceUpdatedAt = uint64(block.timestamp) + t.epochLength;
    }

    /// @dev Burn `shares` of `account` (whose balance is `balance`): remove that fraction of every range and of idle,
    ///      accrue the account's fees on its full balance (this unlock's own touch realized fees those shares earned),
    ///      burn, then pay `to` once the unlock has closed, so no outside code runs while the PoolManager is unlocked
    ///      on this vault's behalf.
    function _exit(uint256 shares, address account, uint256 balance, address to, uint256 min0, uint256 min1)
        internal
        returns (uint256 amount0, uint256 amount1)
    {
        bytes memory result = poolManager.unlock(abi.encode(Op.Withdraw, abi.encode(shares)));
        (amount0, amount1) = abi.decode(result, (uint256, uint256));
        if (amount0 < min0 || amount1 < min1) revert Slippage(amount0, amount1);
        _accrue(account, balance);
        if (account == PRINCIPAL_ACCOUNT) principalShares = balance - shares;
        else sharesOf[account] = balance - shares;
        totalShares -= shares;
        if (amount0 > 0) _key.currency0.transfer(to, amount0);
        if (amount1 > 0) _key.currency1.transfer(to, amount1);
    }

    /// @dev Bring `account`'s owed fees up to the current per-share growth, for `balance` shares.
    function _accrue(address account, uint256 balance) internal {
        FeeAccount storage a = _fees[account];
        uint256 g0 = feeGrowth0;
        uint256 g1 = feeGrowth1;
        if (balance > 0) {
            a.owed0 += FullMath.mulDiv(balance, g0 - a.growth0, Q128);
            a.owed1 += FullMath.mulDiv(balance, g1 - a.growth1, Q128);
        }
        a.growth0 = g0;
        a.growth1 = g1;
    }

    /// @dev Pay out and clear `account`'s owed fees.
    function _payFees(address account, address to) internal returns (uint256 amount0, uint256 amount1) {
        FeeAccount storage a = _fees[account];
        amount0 = a.owed0;
        amount1 = a.owed1;
        a.owed0 = 0;
        a.owed1 = 0;
        feePot0 -= amount0;
        feePot1 -= amount1;
        if (amount0 > 0) _key.currency0.transfer(to, amount0);
        if (amount1 > 0) _key.currency1.transfer(to, amount1);
    }

    function _ctx() internal view returns (Ctx memory c) {
        c.q0 = quoteIsCurrency0;
        c.spacing = _key.tickSpacing;
        c.t = _terms;
        (, c.spotTick,,) = poolManager.getSlot0(poolId);
        c.twapTick = hook.consult(poolId, c.t.twapWindow);
        c.twapPrice = Orient.toPrice(c.q0, c.twapTick);
        (c.anchor,) = CovenantLogic.anchorAt(_anchor, _anchorUpdatedAt, c.twapPrice, c.t, block.timestamp);
    }

    /// @dev Guard: no state change while spot and TWAP disagree by more than G.
    function _guard(Ctx memory c) internal pure {
        int256 diff = int256(c.spotTick) - int256(c.twapTick);
        if (diff > c.t.guardTicks || diff < -int256(c.t.guardTicks)) revert PriceGuard(c.spotTick, c.twapTick);
    }

    function _commitAnchor(Ctx memory c) internal {
        (int24 a, uint64 updatedAt) =
            CovenantLogic.anchorAt(_anchor, _anchorUpdatedAt, c.twapPrice, c.t, block.timestamp);
        _anchor = a;
        _anchorUpdatedAt = updatedAt;
    }

    function _supportBps(Ctx memory c) internal view returns (uint256) {
        return
            CovenantLogic.supportBps(_ranges, c.q0, c.twapPrice, c.anchor, c.t.supportBandTicks, c.q0 ? idle0 : idle1);
    }

    /// @dev Pace: no limit in the setup epoch, then a refilling allowance of M per epoch.
    function _spendPace(Terms memory t, uint256 fraction) internal {
        if (block.timestamp < uint256(adoptedAt) + t.epochLength) return;
        uint256 available = PaceLib.available(_paceBudget, _paceUpdatedAt, t.paceBps, t.epochLength, block.timestamp);
        if (fraction > available) revert PaceExceeded(fraction, available);
        _paceBudget = uint64(available - fraction);
        _paceUpdatedAt = uint64(block.timestamp);
    }

    // =========================================================================================== views

    /// @inheritdoc ICovenantVault
    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    /// @inheritdoc ICovenantVault
    function terms() external view returns (Terms memory) {
        return _terms;
    }

    /// @inheritdoc ICovenantVault
    function rangeCount() external view returns (uint256) {
        return _ranges.length;
    }

    /// @inheritdoc ICovenantVault
    function rangeAt(uint256 index) external view returns (Range memory) {
        return _ranges[index];
    }

    /// @inheritdoc ICovenantVault
    function ranges() external view returns (Range[] memory) {
        return _ranges;
    }

    /// @inheritdoc ICovenantVault
    function support() external view returns (uint256 haveBps, uint256 needBps) {
        return (_supportBps(_ctx()), _terms.supportBps);
    }

    /// @inheritdoc ICovenantVault
    function anchor() external view returns (int24) {
        return _ctx().anchor;
    }

    /// @inheritdoc ICovenantVault
    function paceAvailable() external view returns (uint256) {
        Terms memory t = _terms;
        if (adoptedAt == 0 || block.timestamp < uint256(adoptedAt) + t.epochLength) return type(uint256).max;
        return PaceLib.available(_paceBudget, _paceUpdatedAt, t.paceBps, t.epochLength, block.timestamp);
    }

    /// @inheritdoc ICovenantVault
    function principalWithdrawable() public view returns (uint256) {
        if (adoptedAt == 0) return 0;
        Terms memory t = _terms;
        uint256 start = uint256(adoptedAt) + t.lockDuration;
        if (block.timestamp < start) return 0;
        uint256 elapsed = block.timestamp - start;
        uint256 vested = elapsed >= t.vestDuration ? PRINCIPAL_SHARES : PRINCIPAL_SHARES * elapsed / t.vestDuration;
        return vested - principalWithdrawn;
    }

    /// @inheritdoc ICovenantVault
    function feesOwed(address account) external view returns (uint256 amount0, uint256 amount1) {
        FeeAccount memory a = _fees[account];
        uint256 balance = account == PRINCIPAL_ACCOUNT ? principalShares : sharesOf[account];
        amount0 = a.owed0 + FullMath.mulDiv(balance, feeGrowth0 - a.growth0, Q128);
        amount1 = a.owed1 + FullMath.mulDiv(balance, feeGrowth1 - a.growth1, Q128);
    }

    /// @inheritdoc ICovenantVault
    function totalValue() external view returns (uint256) {
        return CovenantLogic.totalValue(_ranges, quoteIsCurrency0, _ctx().twapTick, idle0, idle1);
    }

    // =========================================================================================== utils

    function _quote() internal view returns (Currency) {
        return quoteIsCurrency0 ? _key.currency0 : _key.currency1;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
