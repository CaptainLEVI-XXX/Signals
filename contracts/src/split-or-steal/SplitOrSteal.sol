// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {CustomRevert} from "../libraries/CustomRevert.sol";
import {BettingEngine} from "./BettingEngine.sol";

interface IAgentRegistry {
    function isRegistered(address wallet) external view returns (bool);
}

contract SplitOrSteal is BettingEngine, EIP712 {
    using SafeERC20 for IERC20;
    using CustomRevert for bytes4;


    bytes32 public constant MATCH_CHOICE_TYPEHASH =
        keccak256("MatchChoice(uint256 matchId,uint8 choice,uint256 nonce)");

    enum Choice {
        NONE, // 0
        SPLIT, // 1
        STEAL // 2
    }

    enum TournamentState {
        NONE, // 0
        REGISTRATION, // 1
        ACTIVE, // 2
        FINAL, // 3
        COMPLETE, // 4
        CANCELLED // 5
    }


    struct Tournament {
        uint256 id;
        uint256 entryStake;
        uint256 prizePool;
        uint8 playerCount;
        uint8 maxPlayers;
        uint8 currentRound;
        uint8 totalRounds;
        TournamentState state;
        uint64 registrationDeadline;
    }

    struct Match {
        uint256 id;
        uint256 tournamentId; // 0 = quick match
        uint8 round;
        address agentA;
        address agentB;
        Choice choiceA;
        Choice choiceB;
        bool settled;
        uint64 deadline; // choice submission deadline
    }

    struct PlayerStats {
        uint256 points;
        uint256 matchesPlayed;
        bool hasClaimed;
    }

    struct AgentStats {
        uint256 totalMatches;
        uint256 splits;
        uint256 steals;
        uint256 totalPoints;
        uint256 tournamentsPlayed;
        uint256 tournamentsWon;
        uint256 totalPrizesEarned;
    }

    struct QuickMatchPair {
        address agentA;
        address agentB;
    }

    struct SettlementData {
        uint256 matchId;
        uint8 choiceA;
        uint256 nonceA;
        bytes sigA;
        uint8 choiceB;
        uint256 nonceB;
        bytes sigB;
    }

    struct TournamentMatchPair {
        address agentA;
        address agentB;
    }

    // ─── Constants ──────────────────────────────────────────────────────

    uint256 public constant QUICK_MATCH_STAKE =1 ether; // 1 ARENA
    uint8 public constant BATCH_CAP = 30;

    uint256 public constant POINTS_BOTH_SPLIT = 3;
    uint256 public constant POINTS_STEAL_WIN = 5;
    uint256 public constant POINTS_SPLIT_LOSE = 1;
    uint256 public constant POINTS_BOTH_STEAL = 0;
    uint256 public constant POINTS_TIMEOUT = 1;

    // ─── State ──────────────────────────────────────────────────────────

    IERC20 public immutable arenaToken;
    address public immutable agentRegistry;

    address public operator;
    address public treasury;

    uint256 public tournamentCount;
    uint256 public matchCount;

    mapping(uint256 => Tournament) public tournaments;
    mapping(uint256 => address[]) public tournamentPlayers;
    mapping(uint256 => Match) public matches;
    mapping(uint256 => mapping(address => PlayerStats)) public playerStats;
    mapping(uint256 => mapping(address => bool)) public hasJoined;

    // Signature-verified settlement
    mapping(address => uint256) public choiceNonces;

    // Fixed rankings (operator-set)
    mapping(uint256 => mapping(address => uint256)) public finalRankings;
    mapping(uint256 => bool) public rankingsSet;

    // Quick match stakes tracked per match
    mapping(uint256 => uint256) internal _quickMatchStakes;

    // Global agent stats (across all matches/tournaments)
    mapping(address => AgentStats) public agentStats;

    // ─── Events ─────────────────────────────────────────────────────────

    event TournamentCreated(uint256 indexed id, uint256 entryStake, uint8 maxPlayers, uint8 totalRounds);
    event TournamentStarted(uint256 indexed id, uint8 playerCount);
    event TournamentCancelled(uint256 indexed id);
    event TournamentComplete(uint256 indexed id);
    event PlayerJoined(uint256 indexed tournamentId, address indexed player, uint8 playerCount);
    event MatchCreated(
        uint256 indexed matchId, uint256 indexed tournamentId, uint8 round, address agentA, address agentB
    );
    event MatchSettled(uint256 indexed matchId, uint8 choiceA, uint8 choiceB, uint256 pointsA, uint256 pointsB);
    event QuickMatchPayout(uint256 indexed matchId, address indexed winner, uint256 amount);
    event PrizeClaimed(uint256 indexed tournamentId, address indexed player, uint256 rank, uint256 amount);
    event RankingsSet(uint256 indexed tournamentId);
    event RoundAdvanced(uint256 indexed tournamentId, uint8 round);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    // ─── Errors ─────────────────────────────────────────────────────────

    error NotOperator();
    error InvalidConfig();
    error TournamentNotInRegistration();
    error TournamentFull();
    error AgentNotRegistered();
    error AlreadyJoined();
    error NotEnoughPlayers();
    error TournamentNotActive();
    error TournamentNotComplete();
    error AgentNotInTournament();
    error MatchAlreadySettled();
    error InvalidChoice();
    error InvalidSignature();
    error InvalidNonce();
    error DeadlineNotPassed();
    error RankingsAlreadySet();
    error RankingsNotSet();
    error InvalidRankings();
    error AlreadyClaimedPrize();
    error InvalidRank();
    error BatchTooLarge();
    error TournamentNotCancelled();
    error SelfMatch();
    error ChoiceWindowTooShort();

    // ─── Modifiers ──────────────────────────────────────────────────────

    modifier onlyOperator() {
        if (msg.sender != operator) NotOperator.selector.revertWith();
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────

    constructor(address _arenaToken, address _agentRegistry, address _operator, address _treasury)
        EIP712("Signals", "2")
    {
        if (_arenaToken == address(0)) InvalidConfig.selector.revertWith();
        if (_agentRegistry == address(0)) InvalidConfig.selector.revertWith();
        if (_operator == address(0)) InvalidConfig.selector.revertWith();
        if (_treasury == address(0)) InvalidConfig.selector.revertWith();

        arenaToken = IERC20(_arenaToken);
        agentRegistry = _agentRegistry;
        operator = _operator;
        treasury = _treasury;
    }


    /// @notice Create a quick match and pull stakes from both agents via permit
    /// @dev Single tx: permit A + permit B + transferFrom A + transferFrom B + create match + create pool
    function createQuickMatch(
        address agentA,
        address agentB,
        uint256 deadlineA,
        uint8 vA,
        bytes32 rA,
        bytes32 sA,
        uint256 deadlineB,
        uint8 vB,
        bytes32 rB,
        bytes32 sB
    ) external onlyOperator lockUnlock returns (uint256 matchId) {
        if (agentA == agentB) SelfMatch.selector.revertWith();
        _requireRegistered(agentA);
        _requireRegistered(agentB);

        // Permit + transfer stakes
        IERC20Permit(address(arenaToken)).permit(agentA, address(this), QUICK_MATCH_STAKE, deadlineA, vA, rA, sA);
        IERC20Permit(address(arenaToken)).permit(agentB, address(this), QUICK_MATCH_STAKE, deadlineB, vB, rB, sB);
        arenaToken.safeTransferFrom(agentA, address(this), QUICK_MATCH_STAKE);
        arenaToken.safeTransferFrom(agentB, address(this), QUICK_MATCH_STAKE);

        // Create match
        matchId = _createMatchInternal(0, 0, agentA, agentB, 60);

        // Track stakes
        _quickMatchStakes[matchId] = QUICK_MATCH_STAKE;
    }

    /// @notice Create a quick match when agents have already approved tokens
    function createQuickMatchWithApproval(address agentA, address agentB)
        external
        onlyOperator
        lockUnlock
        returns (uint256 matchId)
    {
        if (agentA == agentB) SelfMatch.selector.revertWith();
        _requireRegistered(agentA);
        _requireRegistered(agentB);

        arenaToken.safeTransferFrom(agentA, address(this), QUICK_MATCH_STAKE);
        arenaToken.safeTransferFrom(agentB, address(this), QUICK_MATCH_STAKE);

        matchId = _createMatchInternal(0, 0, agentA, agentB, 60);
        _quickMatchStakes[matchId] = QUICK_MATCH_STAKE;
    }

    /// @notice Create multiple quick matches in a single transaction
    function createQuickMatchBatch(QuickMatchPair[] calldata pairs)
        external
        onlyOperator
        lockUnlock
        returns (uint256[] memory matchIds)
    {
        uint256 size = pairs.length;
        if (size > BATCH_CAP) BatchTooLarge.selector.revertWith();

        matchIds = new uint256[](pairs.length);

        for (uint256 i; i < size;) {
            if (pairs[i].agentA == pairs[i].agentB) SelfMatch.selector.revertWith();
            _requireRegistered(pairs[i].agentA);
            _requireRegistered(pairs[i].agentB);

            arenaToken.safeTransferFrom(pairs[i].agentA, address(this), QUICK_MATCH_STAKE);
            arenaToken.safeTransferFrom(pairs[i].agentB, address(this), QUICK_MATCH_STAKE);

            matchIds[i] = _createMatchInternal(0, 0, pairs[i].agentA, pairs[i].agentB, 60);
            _quickMatchStakes[matchIds[i]] = QUICK_MATCH_STAKE;
            unchecked{i++;}
        }
    }

    /// @notice Settle multiple matches in a single transaction
    function settleMultiple(SettlementData[] calldata settlements) external onlyOperator lockUnlock {

        uint256 size = settlements.length;
        if (size > BATCH_CAP) BatchTooLarge.selector.revertWith();

        for (uint256 i; i < size;) {
            SettlementData calldata s = settlements[i];
            Match storage m = matches[s.matchId];

            if (m.settled) MatchAlreadySettled.selector.revertWith();
            if (s.choiceA < 1 || s.choiceA > 2) InvalidChoice.selector.revertWith();
            if (s.choiceB < 1 || s.choiceB > 2) InvalidChoice.selector.revertWith();

            _verifyChoiceSignature(s.matchId, s.choiceA, s.nonceA, s.sigA, m.agentA);
            _verifyChoiceSignature(s.matchId, s.choiceB, s.nonceB, s.sigB, m.agentB);

            _settleMatchInternal(s.matchId, Choice(s.choiceA), Choice(s.choiceB), false, false);

            unchecked{i++;}
        }
    }

    /// @notice Create multiple tournament matches in a single transaction
    function createTournamentMatchBatch(
        uint256 tournamentId,
        TournamentMatchPair[] calldata pairs,
        uint256 choiceWindowSec
    ) external onlyOperator returns (uint256[] memory matchIds) {
        if (pairs.length > BATCH_CAP) BatchTooLarge.selector.revertWith();
        if (choiceWindowSec < 30) ChoiceWindowTooShort.selector.revertWith();

        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.ACTIVE && t.state != TournamentState.FINAL) {
            TournamentNotActive.selector.revertWith();
        }

        matchIds = new uint256[](pairs.length);

        for (uint256 i = 0; i < pairs.length; i++) {
            if (pairs[i].agentA == pairs[i].agentB) SelfMatch.selector.revertWith();
            if (!hasJoined[tournamentId][pairs[i].agentA] || !hasJoined[tournamentId][pairs[i].agentB]) {
                AgentNotInTournament.selector.revertWith();
            }

            matchIds[i] =
                _createMatchInternal(tournamentId, t.currentRound, pairs[i].agentA, pairs[i].agentB, choiceWindowSec);
        }
    }

    function createTournament(uint256 entryStake, uint8 maxPlayers, uint8 totalRounds, uint256 registrationDuration)
        external
        onlyOperator
        returns (uint256 id)
    {
        if (maxPlayers < 4 || maxPlayers > 16) InvalidConfig.selector.revertWith();
        if (totalRounds < 1 || totalRounds > 5) InvalidConfig.selector.revertWith();
        if (entryStake == 0) InvalidConfig.selector.revertWith();
        if (registrationDuration < 60) InvalidConfig.selector.revertWith();

        id = ++tournamentCount;
        tournaments[id] = Tournament({
            id: id,
            entryStake: entryStake,
            prizePool: 0,
            playerCount: 0,
            maxPlayers: maxPlayers,
            currentRound: 0,
            totalRounds: totalRounds,
            state: TournamentState.REGISTRATION,
            registrationDeadline: uint64(block.timestamp + registrationDuration)
        });

        emit TournamentCreated(id, entryStake, maxPlayers, totalRounds);
    }

    function joinTournament(uint256 tournamentId) external lockUnlock {
        _joinTournamentInternal(tournamentId);
    }

    /// @notice Join tournament with permit (1 tx: approve + join)
    function joinTournamentWithPermit(uint256 tournamentId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        lockUnlock
    {
        Tournament storage t = tournaments[tournamentId];
        IERC20Permit(address(arenaToken)).permit(msg.sender, address(this), t.entryStake, deadline, v, r, s);
        _joinTournamentInternal(tournamentId);
    }

    function startTournament(uint256 tournamentId) external onlyOperator {
        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.REGISTRATION) TournamentNotInRegistration.selector.revertWith();
        if (t.playerCount < 4) NotEnoughPlayers.selector.revertWith();

        t.state = TournamentState.ACTIVE;
        t.currentRound = 1;
        emit TournamentStarted(tournamentId, t.playerCount);
    }

    function cancelTournament(uint256 tournamentId) external onlyOperator {
        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.REGISTRATION) TournamentNotInRegistration.selector.revertWith();
        t.state = TournamentState.CANCELLED;
        emit TournamentCancelled(tournamentId);
    }

    function claimCancellationRefund(uint256 tournamentId) external lockUnlock {
        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.CANCELLED) TournamentNotCancelled.selector.revertWith();
        if (!hasJoined[tournamentId][msg.sender]) AgentNotInTournament.selector.revertWith();

        PlayerStats storage stats = playerStats[tournamentId][msg.sender];
        if (stats.hasClaimed) AlreadyClaimedPrize.selector.revertWith();
        stats.hasClaimed = true;

        arenaToken.safeTransfer(msg.sender, t.entryStake);
        emit PrizeClaimed(tournamentId, msg.sender, 0, t.entryStake);
    }

    function advanceToFinal(uint256 tournamentId) external onlyOperator {
        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.ACTIVE) TournamentNotActive.selector.revertWith();
        t.state = TournamentState.FINAL;
    }

    function completeTournament(uint256 tournamentId) external onlyOperator {
        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.FINAL) TournamentNotActive.selector.revertWith();
        t.state = TournamentState.COMPLETE;
        emit TournamentComplete(tournamentId);
    }

    /// @notice Create a match within a tournament
    function createTournamentMatch(uint256 tournamentId, address agentA, address agentB, uint256 choiceWindowSec)
        external
        onlyOperator
        returns (uint256 matchId)
    {
        if (choiceWindowSec < 30) ChoiceWindowTooShort.selector.revertWith();
        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.ACTIVE && t.state != TournamentState.FINAL) {
            TournamentNotActive.selector.revertWith();
        }
        if (!hasJoined[tournamentId][agentA] || !hasJoined[tournamentId][agentB]) {
            AgentNotInTournament.selector.revertWith();
        }

        matchId = _createMatchInternal(tournamentId, t.currentRound, agentA, agentB, choiceWindowSec);
    }

    /// @notice Close betting on a match before settlement (prevents front-running)
    /// @dev Must be called before settleWithSignatures / settleMultiple to close pools
    function closeBetting(uint256 matchId) external onlyOperator {
        _closePool(matchId);
    }

    /// @notice Close betting on multiple matches in a single transaction
    function closeBettingBatch(uint256[] calldata matchIds) external onlyOperator {
        if (matchIds.length > BATCH_CAP) BatchTooLarge.selector.revertWith();
        for (uint256 i; i < matchIds.length;) {
            _closePool(matchIds[i]);
            unchecked { i++; }
        }
    }

    /// @notice Advance the tournament to the next round
    function advanceRound(uint256 tournamentId) external onlyOperator {
        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.ACTIVE) TournamentNotActive.selector.revertWith();
        if (t.currentRound >= t.totalRounds) InvalidConfig.selector.revertWith();
        t.currentRound++;
        emit RoundAdvanced(tournamentId, t.currentRound);
    }


    /// @notice Settle a match with both agents' signed choices
    /// @dev 1 transaction replaces: advancePhase + commitA + commitB + advancePhase + revealA + revealB + settle
    function settleWithSignatures(
        uint256 matchId,
        uint8 choiceA,
        uint256 nonceA,
        bytes memory sigA,
        uint8 choiceB,
        uint256 nonceB,
        bytes memory sigB
    ) external onlyOperator lockUnlock {
        Match storage m = matches[matchId];
        if (m.settled) MatchAlreadySettled.selector.revertWith();
        if (choiceA < 1 || choiceA > 2) InvalidChoice.selector.revertWith();
        if (choiceB < 1 || choiceB > 2) InvalidChoice.selector.revertWith();

        // Verify Agent A's signature
        _verifyChoiceSignature(matchId, choiceA, nonceA, sigA, m.agentA);

        // Verify Agent B's signature
        _verifyChoiceSignature(matchId, choiceB, nonceB, sigB, m.agentB);

        // Score and settle
        _settleMatchInternal(matchId, Choice(choiceA), Choice(choiceB), false, false);
    }

    /// @notice Settle when both agents timed out (no signatures)
    function settleTimeout(uint256 matchId) external onlyOperator lockUnlock {
        Match storage m = matches[matchId];
        if (m.settled) MatchAlreadySettled.selector.revertWith();
        if (block.timestamp <= m.deadline) DeadlineNotPassed.selector.revertWith();

        _settleMatchInternal(matchId, Choice.NONE, Choice.NONE, true, true);
    }

    /// @notice Settle when one agent responded and the other timed out
    function settlePartialTimeout(uint256 matchId, uint8 choice, uint256 nonce, bytes memory sig, bool agentATimedOut)
        external
        onlyOperator
        lockUnlock
    {
        Match storage m = matches[matchId];
        if (m.settled) MatchAlreadySettled.selector.revertWith();
        if (block.timestamp <= m.deadline) DeadlineNotPassed.selector.revertWith();
        if (choice < 1 || choice > 2) InvalidChoice.selector.revertWith();

        if (agentATimedOut) {
            // Agent A timed out, verify Agent B's signature
            _verifyChoiceSignature(matchId, choice, nonce, sig, m.agentB);
            _settleMatchInternal(matchId, Choice.NONE, Choice(choice), true, false);
        } else {
            // Agent B timed out, verify Agent A's signature
            _verifyChoiceSignature(matchId, choice, nonce, sig, m.agentA);
            _settleMatchInternal(matchId, Choice(choice), Choice.NONE, false, true);
        }
    }


    /// @notice Set final rankings for a completed tournament (operator only)
    /// @param rankedPlayers Addresses in rank order (index 0 = 1st place)
    function setFinalRankings(uint256 tournamentId, address[] calldata rankedPlayers) external onlyOperator {
        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.COMPLETE) TournamentNotComplete.selector.revertWith();
        if (rankingsSet[tournamentId]) RankingsAlreadySet.selector.revertWith();
        if (rankedPlayers.length != t.playerCount) InvalidRankings.selector.revertWith();

        for (uint256 i = 0; i < rankedPlayers.length; i++) {
            if (!hasJoined[tournamentId][rankedPlayers[i]]) AgentNotInTournament.selector.revertWith();
            // Duplicate check: default is 0, we set i+1 (>= 1), so non-zero means already ranked
            if (finalRankings[tournamentId][rankedPlayers[i]] != 0) InvalidRankings.selector.revertWith();
            finalRankings[tournamentId][rankedPlayers[i]] = i + 1; // 1-indexed
        }

        rankingsSet[tournamentId] = true;
        emit RankingsSet(tournamentId);
    }

    /// @notice Claim prize — rank is read from on-chain verified rankings
    function claimPrize(uint256 tournamentId) external lockUnlock {
        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.COMPLETE) TournamentNotComplete.selector.revertWith();
        if (!rankingsSet[tournamentId]) RankingsNotSet.selector.revertWith();
        if (!hasJoined[tournamentId][msg.sender]) AgentNotInTournament.selector.revertWith();

        PlayerStats storage stats = playerStats[tournamentId][msg.sender];
        if (stats.hasClaimed) AlreadyClaimedPrize.selector.revertWith();

        uint256 rank = finalRankings[tournamentId][msg.sender];
        if (rank == 0) InvalidRank.selector.revertWith();

        stats.hasClaimed = true;

        uint256 prize = _calculatePrize(t.prizePool, t.entryStake, rank, t.playerCount);
        if (prize > 0) {
            arenaToken.safeTransfer(msg.sender, prize);
        }

        // Track global tournament wins and prizes
        if (rank == 1) {
            agentStats[msg.sender].tournamentsWon++;
        }
        agentStats[msg.sender].totalPrizesEarned += prize;

        emit PrizeClaimed(tournamentId, msg.sender, rank, prize);
    }

    function setOperator(address newOperator) external onlyOperator {
        if (newOperator == address(0)) InvalidConfig.selector.revertWith();
        address old = operator;
        operator = newOperator;
        emit OperatorUpdated(old, newOperator);
    }


    function getTournamentPlayers(uint256 tournamentId) external view returns (address[] memory) {
        return tournamentPlayers[tournamentId];
    }

    function getPlayerStats(uint256 tournamentId, address player) external view returns (PlayerStats memory) {
        return playerStats[tournamentId][player];
    }

    function hasPlayerJoined(uint256 tournamentId, address player) external view returns (bool) {
        return hasJoined[tournamentId][player];
    }

    function getMatch(uint256 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    function getAgentStats(address agent) external view returns (AgentStats memory) {
        return agentStats[agent];
    }

    /// @notice Get the EIP-712 domain separator
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _getMatchParticipants(uint256 matchId) internal view override returns (address agentA, address agentB) {
        Match storage m = matches[matchId];
        return (m.agentA, m.agentB);
    }

    function _getBettingToken() internal view override returns (IERC20) {
        return arenaToken;
    }

    function _getTreasury() internal view override returns (address) {
        return treasury;
    }

    function _createMatchInternal(
        uint256 tournamentId,
        uint8 round,
        address agentA,
        address agentB,
        uint256 choiceWindowSec
    ) internal returns (uint256 matchId) {
        matchId = ++matchCount;

        uint64 matchDeadline = uint64(block.timestamp + choiceWindowSec);

        matches[matchId] = Match({
            id: matchId,
            tournamentId: tournamentId,
            round: round,
            agentA: agentA,
            agentB: agentB,
            choiceA: Choice.NONE,
            choiceB: Choice.NONE,
            settled: false,
            deadline: matchDeadline
        });

        // Create betting pool (emergency window anchored to match deadline)
        _createPool(matchId, matchDeadline);

        emit MatchCreated(matchId, tournamentId, round, agentA, agentB);
    }

    function _joinTournamentInternal(uint256 tournamentId) internal {
        Tournament storage t = tournaments[tournamentId];
        if (t.state != TournamentState.REGISTRATION) TournamentNotInRegistration.selector.revertWith();
        if (block.timestamp > t.registrationDeadline) TournamentNotInRegistration.selector.revertWith();
        if (t.playerCount >= t.maxPlayers) TournamentFull.selector.revertWith();
        if (hasJoined[tournamentId][msg.sender]) AlreadyJoined.selector.revertWith();

        _requireRegistered(msg.sender);

        arenaToken.safeTransferFrom(msg.sender, address(this), t.entryStake);

        hasJoined[tournamentId][msg.sender] = true;
        tournamentPlayers[tournamentId].push(msg.sender);
        t.playerCount++;
        t.prizePool += t.entryStake;

        // Track global tournament participation
        agentStats[msg.sender].tournamentsPlayed++;

        emit PlayerJoined(tournamentId, msg.sender, t.playerCount);
    }

    function _verifyChoiceSignature(
        uint256 matchId,
        uint8 choice,
        uint256 nonce,
        bytes memory sig,
        address expectedSigner
    ) internal {
        if (nonce != choiceNonces[expectedSigner]) InvalidNonce.selector.revertWith();

        bytes32 structHash = keccak256(abi.encode(MATCH_CHOICE_TYPEHASH, matchId, choice, nonce));
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, sig);

        if (recovered != expectedSigner) InvalidSignature.selector.revertWith();

        choiceNonces[expectedSigner]++;
    }

    function _settleMatchInternal(uint256 matchId, Choice choiceA, Choice choiceB, bool aTimedOut, bool bTimedOut)
        internal
    {
        Match storage m = matches[matchId];

        // Calculate points
        (uint256 pointsA, uint256 pointsB) = _calculatePoints(choiceA, choiceB, aTimedOut, bTimedOut);

        // Store choices (timeout = STEAL for display)
        m.choiceA = aTimedOut ? Choice.STEAL : choiceA;
        m.choiceB = bTimedOut ? Choice.STEAL : choiceB;
        m.settled = true;

        // Update global agent stats
        AgentStats storage globalA = agentStats[m.agentA];
        AgentStats storage globalB = agentStats[m.agentB];
        globalA.totalMatches++;
        globalB.totalMatches++;
        globalA.totalPoints += pointsA;
        globalB.totalPoints += pointsB;
        if (m.choiceA == Choice.SPLIT) globalA.splits++;
        else if (m.choiceA == Choice.STEAL) globalA.steals++;
        if (m.choiceB == Choice.SPLIT) globalB.splits++;
        else if (m.choiceB == Choice.STEAL) globalB.steals++;

        // Quick match payout
        if (m.tournamentId == 0) {
            _handleQuickMatchPayout(matchId, m.agentA, m.agentB, choiceA, choiceB, aTimedOut, bTimedOut);
        } else {
            // Tournament: update player stats
            PlayerStats storage statsA = playerStats[m.tournamentId][m.agentA];
            PlayerStats storage statsB = playerStats[m.tournamentId][m.agentB];
            statsA.points += pointsA;
            statsA.matchesPlayed++;
            statsB.points += pointsB;
            statsB.matchesPlayed++;
        }

        // Settle betting pool
        uint8 betOutcome = _determineBetOutcome(m.choiceA, m.choiceB);
        _settlePool(matchId, betOutcome);

        emit MatchSettled(matchId, uint8(m.choiceA), uint8(m.choiceB), pointsA, pointsB);
    }

    function _handleQuickMatchPayout(
        uint256 matchId,
        address agentA,
        address agentB,
        Choice choiceA,
        Choice choiceB,
        bool aTimedOut,
        bool bTimedOut
    ) internal {
        uint256 stake = _quickMatchStakes[matchId];
        uint256 totalPot = stake * 2;
        uint256 houseFee = (totalPot * HOUSE_FEE_BPS) / BPS_DENOMINATOR;

        if (aTimedOut && bTimedOut) {
            // Both timed out — refund minus fee
            uint256 refundEach = (totalPot - houseFee) / 2;
            arenaToken.safeTransfer(agentA, refundEach);
            arenaToken.safeTransfer(agentB, refundEach);
            arenaToken.safeTransfer(treasury, houseFee);
        } else if (aTimedOut) {
            // A timed out — B wins
            uint256 winnerPayout = totalPot - houseFee;
            arenaToken.safeTransfer(agentB, winnerPayout);
            arenaToken.safeTransfer(treasury, houseFee);
            emit QuickMatchPayout(matchId, agentB, winnerPayout);
        } else if (bTimedOut) {
            // B timed out — A wins
            uint256 winnerPayout = totalPot - houseFee;
            arenaToken.safeTransfer(agentA, winnerPayout);
            arenaToken.safeTransfer(treasury, houseFee);
            emit QuickMatchPayout(matchId, agentA, winnerPayout);
        } else if (choiceA == Choice.SPLIT && choiceB == Choice.SPLIT) {
            // Both split — full refund, no fee
            arenaToken.safeTransfer(agentA, stake);
            arenaToken.safeTransfer(agentB, stake);
        } else if (choiceA == Choice.STEAL && choiceB == Choice.STEAL) {
            // Both steal — split pot minus fee
            uint256 splitEach = (totalPot - houseFee) / 2;
            arenaToken.safeTransfer(agentA, splitEach);
            arenaToken.safeTransfer(agentB, splitEach);
            arenaToken.safeTransfer(treasury, houseFee);
        } else if (choiceA == Choice.STEAL && choiceB == Choice.SPLIT) {
            // A steals, B splits — A wins
            uint256 winnerPayout = totalPot - houseFee;
            arenaToken.safeTransfer(agentA, winnerPayout);
            arenaToken.safeTransfer(treasury, houseFee);
            emit QuickMatchPayout(matchId, agentA, winnerPayout);
        } else if (choiceA == Choice.SPLIT && choiceB == Choice.STEAL) {
            // B steals, A splits — B wins
            uint256 winnerPayout = totalPot - houseFee;
            arenaToken.safeTransfer(agentB, winnerPayout);
            arenaToken.safeTransfer(treasury, houseFee);
            emit QuickMatchPayout(matchId, agentB, winnerPayout);
        } else {
            revert InvalidChoice();
        }
    }

    function _calculatePoints(Choice choiceA, Choice choiceB, bool aTimedOut, bool bTimedOut)
        internal
        pure
        returns (uint256 pointsA, uint256 pointsB)
    {
        if (aTimedOut && bTimedOut) return (0, 0);
        if (aTimedOut) return (0, POINTS_TIMEOUT);
        if (bTimedOut) return (POINTS_TIMEOUT, 0);

        if (choiceA == Choice.SPLIT && choiceB == Choice.SPLIT) {
            return (POINTS_BOTH_SPLIT, POINTS_BOTH_SPLIT);
        } else if (choiceA == Choice.STEAL && choiceB == Choice.SPLIT) {
            return (POINTS_STEAL_WIN, POINTS_SPLIT_LOSE);
        } else if (choiceA == Choice.SPLIT && choiceB == Choice.STEAL) {
            return (POINTS_SPLIT_LOSE, POINTS_STEAL_WIN);
        } else {
            return (POINTS_BOTH_STEAL, POINTS_BOTH_STEAL);
        }
    }

    /// @dev 1st: 50%, 2nd: 30%, 3rd: 20%, 4th+: 0
    function _calculatePrize(uint256 prizePool, uint256, uint256 rank, uint8) internal pure returns (uint256) {
        if (rank == 1) return (prizePool * 50) / 100;
        if (rank == 2) return (prizePool * 30) / 100;
        if (rank == 3) return (prizePool * 20) / 100;
        return 0;
    }

    function _determineBetOutcome(Choice choiceA, Choice choiceB) internal pure returns (uint8) {
        if (choiceA == Choice.SPLIT && choiceB == Choice.SPLIT) return 1; // BOTH_SPLIT
        if (choiceA == Choice.STEAL && choiceB == Choice.SPLIT) return 2; // AGENT_A_STEALS
        if (choiceA == Choice.SPLIT && choiceB == Choice.STEAL) return 3; // AGENT_B_STEALS
        return 4; // BOTH_STEAL
    }

    function _requireRegistered(address agent) internal view {
        if (!IAgentRegistry(agentRegistry).isRegistered(agent)) AgentNotRegistered.selector.revertWith();
    }
}
