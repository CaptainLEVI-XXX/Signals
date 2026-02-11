// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Lock} from "../libraries/Lock.sol";
import {CustomRevert} from "../libraries/CustomRevert.sol";

abstract contract BettingEngine {
    using SafeERC20 for IERC20;
    using CustomRevert for bytes4;


    enum BetOutcome {
        NONE, // 0 - invalid
        BOTH_SPLIT, // 1
        AGENT_A_STEALS, // 2
        AGENT_B_STEALS, // 3
        BOTH_STEAL // 4
    }

    enum PoolState {
        NONE, // 0 - doesn't exist
        OPEN, // 1 - accepting bets
        CLOSED, // 2 - no more bets
        SETTLED // 3 - result determined
    }


    struct Pool {
        uint256 totalPool;
        uint256[5] outcomePools; // index 0 unused, 1-4 = outcomes
        PoolState state;
        uint8 result; // winning BetOutcome
        uint64 expiresAt; // emergency refund available after this timestamp
    }

    struct Bet {
        uint256 amount;
        uint8 outcome;
        bool claimed;
    }

    // ─── Constants ──────────────────────────────────────────────────────

    uint256 public constant HOUSE_FEE_BPS = 500; // 5%
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MIN_BET = 1 ether; // 1 ARENA
    uint256 public constant POOL_EMERGENCY_WINDOW = 7 days;

    // ─── State ──────────────────────────────────────────────────────────

    mapping(uint256 => Pool) internal _pools;
    mapping(uint256 => mapping(address => Bet)) internal _bets;
    mapping(address => uint256[]) internal _bettorMatchIds;
    uint256 public totalFeesCollected;

    // ─── Events ─────────────────────────────────────────────────────────

    event PoolCreated(uint256 indexed matchId);
    event BetPlaced(uint256 indexed matchId, address indexed bettor, uint8 outcome, uint256 amount);
    event BettingClosed(uint256 indexed matchId, uint256 totalPool);
    event PoolSettled(uint256 indexed matchId, uint8 result, uint256 winningPool, uint256 houseFee);
    event WinningsClaimed(uint256 indexed matchId, address indexed bettor, uint256 amount);
    event RefundClaimed(uint256 indexed matchId, address indexed bettor, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────────────

    error PoolAlreadyExists();
    error PoolNotOpen();
    error PoolNotClosed();
    error PoolNotSettled();
    error BetTooSmall();
    error InvalidOutcome();
    error AlreadyBet();
    error CannotBetOnOwnMatch();
    error NothingToClaim();
    error AlreadyClaimed();
    error NoWinnersRefundNotAvailable();
    error PoolNotExpired();
    error PoolAlreadySettled();
    error PoolDoesNotExist();
    error OperationLocked();

    modifier lockUnlock() {
        if (Lock.isUnlocked()) OperationLocked.selector.revertWith();
        Lock.unlock();
        _;
        Lock.lock();
    }


    function _getMatchParticipants(uint256 matchId) internal view virtual returns (address agentA, address agentB);

    function _getBettingToken() internal view virtual returns (IERC20);

    function _getTreasury() internal view virtual returns (address);


    function _createPool(uint256 matchId, uint64 matchDeadline) internal {
        if (_pools[matchId].state != PoolState.NONE) PoolAlreadyExists.selector.revertWith();
        Pool storage pool = _pools[matchId];
        pool.state = PoolState.OPEN;
        //shoudn't we add this like expires at block.timestamp + some_time
        //why thf pool is been open for & 7 days
        pool.expiresAt = matchDeadline + uint64(POOL_EMERGENCY_WINDOW);
        emit PoolCreated(matchId);
    }

    function _closePool(uint256 matchId) internal {
        Pool storage pool = _pools[matchId];
        if (pool.state != PoolState.OPEN) PoolNotOpen.selector.revertWith();
        pool.state = PoolState.CLOSED;
        emit BettingClosed(matchId, pool.totalPool);
    }

    function _settlePool(uint256 matchId, uint8 winningOutcome) internal {
        Pool storage pool = _pools[matchId];

        // Auto-close only if no bets exist (nothing to front-run).
        // Pools with bets MUST be closed via closeBetting() before settlement.
        if (pool.state == PoolState.OPEN) {
            if (pool.totalPool > 0) PoolNotClosed.selector.revertWith();
            pool.state = PoolState.CLOSED;
            emit BettingClosed(matchId, pool.totalPool);
        }

        if (pool.state != PoolState.CLOSED) PoolNotClosed.selector.revertWith();

        pool.result = winningOutcome;
        pool.state = PoolState.SETTLED;

        // Transfer house fee if there were bets
        uint256 houseFee = 0;
        if (pool.totalPool > 0) {
            houseFee = (pool.totalPool * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
            totalFeesCollected += houseFee;
            _getBettingToken().safeTransfer(_getTreasury(), houseFee);
        }

        emit PoolSettled(matchId, winningOutcome, pool.outcomePools[winningOutcome], houseFee);
    }


    /// @notice Place a bet on a match outcome
    function placeBet(uint256 matchId, uint8 outcome, uint256 amount) external lockUnlock {
        _placeBetInternal(matchId, outcome, amount);
    }

    /// @notice Place a bet using EIP-2612 permit (1 tx instead of approve + bet)
    function placeBetWithPermit(
        uint256 matchId,
        uint8 outcome,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external lockUnlock {
        IERC20Permit(address(_getBettingToken())).permit(msg.sender, address(this), amount, deadline, v, r, s);
        _placeBetInternal(matchId, outcome, amount);
    }

    /// @notice Claim winnings after pool is settled
    function claimWinnings(uint256 matchId) external lockUnlock {
        Pool storage pool = _pools[matchId];
        if (pool.state != PoolState.SETTLED) PoolNotSettled.selector.revertWith();

        // you cant claim if pool is not settled, already claimed,nothing to claim

        Bet storage bet = _bets[matchId][msg.sender];
        if (bet.amount == 0) NothingToClaim.selector.revertWith();
        if (bet.claimed) AlreadyClaimed.selector.revertWith();
        if (bet.outcome != pool.result) NothingToClaim.selector.revertWith();

        bet.claimed = true;

        uint256 winningPool = pool.outcomePools[pool.result];
        uint256 netPool = pool.totalPool - (pool.totalPool * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
        uint256 payout = (bet.amount * netPool) / winningPool;

        _getBettingToken().safeTransfer(msg.sender, payout);
        emit WinningsClaimed(matchId, msg.sender, payout);
    }

    /// @notice Claim refund if nobody predicted the winning outcome
    function claimRefund(uint256 matchId) external lockUnlock{
        Pool storage pool = _pools[matchId];
        if (pool.state != PoolState.SETTLED) PoolNotSettled.selector.revertWith();

        // Refund only available if nobody bet on the winning outcome
        if (pool.outcomePools[pool.result] != 0) NoWinnersRefundNotAvailable.selector.revertWith();

        Bet storage bet = _bets[matchId][msg.sender];
        if (bet.amount == 0) NothingToClaim.selector.revertWith();
        if (bet.claimed) AlreadyClaimed.selector.revertWith();

        bet.claimed = true;

        // Refund minus house fee
        uint256 refund = bet.amount - (bet.amount * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
        _getBettingToken().safeTransfer(msg.sender, refund);
        emit RefundClaimed(matchId, msg.sender, refund);
    }

    /// @notice Emergency refund if pool was never settled (e.g. operator disappeared)
    /// @dev Only available after POOL_EMERGENCY_WINDOW (7 days past match deadline) and pool is not settled
    function emergencyRefund(uint256 matchId) external lockUnlock {
        Pool storage pool = _pools[matchId];
        if (pool.state == PoolState.SETTLED) PoolAlreadySettled.selector.revertWith();
        if (pool.state == PoolState.NONE) PoolDoesNotExist.selector.revertWith();
        if (block.timestamp <= pool.expiresAt) PoolNotExpired.selector.revertWith();

        Bet storage bet = _bets[matchId][msg.sender];
        if (bet.amount == 0) NothingToClaim.selector.revertWith();
        if (bet.claimed) AlreadyClaimed.selector.revertWith();

        bet.claimed = true;

        // Decrement pool accounting so settlement math stays solvent
        pool.totalPool -= bet.amount;
        pool.outcomePools[bet.outcome] -= bet.amount;

        // Full refund — no house fee since the match was never settled
        _getBettingToken().safeTransfer(msg.sender, bet.amount);
        emit RefundClaimed(matchId, msg.sender, bet.amount);
    }


    function getPool(uint256 matchId) external view returns (Pool memory) {
        return _pools[matchId];
    }

    function getBet(uint256 matchId, address bettor) external view returns (Bet memory) {
        return _bets[matchId][bettor];
    }

    function getOdds(uint256 matchId, uint8 outcome) external view returns (uint256) {
        Pool storage pool = _pools[matchId];
        if (pool.state == PoolState.NONE || pool.outcomePools[outcome] == 0) return 0;
        uint256 netPool = pool.totalPool - (pool.totalPool * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
        return (netPool * BPS_DENOMINATOR) / pool.outcomePools[outcome];
    }

    function getOutcomePools(uint256 matchId) external view returns (uint256[5] memory) {
        return _pools[matchId].outcomePools;
    }

    function getBettorMatchIds(address bettor) external view returns (uint256[] memory) {
        return _bettorMatchIds[bettor];
    }

    function getBettorMatchCount(address bettor) external view returns (uint256) {
        return _bettorMatchIds[bettor].length;
    }

    function calculatePotentialWinnings(uint256 matchId, uint8 outcome, uint256 amount)
        external
        view
        returns (uint256)
    {
        Pool storage pool = _pools[matchId];
        if (pool.state == PoolState.NONE) return 0;

        uint256 newTotal = pool.totalPool + amount;
        uint256 newOutcomePool = pool.outcomePools[outcome] + amount;
        uint256 netPool = newTotal - (newTotal * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
        return (amount * netPool) / newOutcomePool;
    }

    // ─── Internal ───────────────────────────────────────────────────────

    function _placeBetInternal(uint256 matchId, uint8 outcome, uint256 amount) internal {
        Pool storage pool = _pools[matchId];
        if (pool.state != PoolState.OPEN) PoolNotOpen.selector.revertWith();
        if (amount < MIN_BET) BetTooSmall.selector.revertWith();
        if (outcome == 0 || outcome > 4) InvalidOutcome.selector.revertWith();

        // Prevent match participants from betting on their own match
        (address agentA, address agentB) = _getMatchParticipants(matchId);
        if (msg.sender == agentA || msg.sender == agentB) CannotBetOnOwnMatch.selector.revertWith();

        // One bet per user per match
        if (_bets[matchId][msg.sender].amount != 0) AlreadyBet.selector.revertWith();

        //transfer the tokens
        _getBettingToken().safeTransferFrom(msg.sender, address(this), amount);

        _bets[matchId][msg.sender] = Bet({amount: amount, outcome: outcome, claimed: false});
        _bettorMatchIds[msg.sender].push(matchId);

        pool.totalPool += amount;
        pool.outcomePools[outcome] += amount;

        emit BetPlaced(matchId, msg.sender, outcome, amount);
    }
}
