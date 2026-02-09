// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {SplitOrSteal} from "../src/split-or-steal/SplitOrSteal.sol";
import {AgentRegistry} from "../src/split-or-steal/AgentRegistry.sol";
import {MockToken} from "./mocks/MockToken.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract SplitOrStealTest is Test {
    SplitOrSteal public game;
    AgentRegistry public registry;
    MockToken public token;

    address public operator = makeAddr("operator");
    address public treasury = makeAddr("treasury");
    address public bettor1 = makeAddr("bettor1");
    address public bettor2 = makeAddr("bettor2");

    // Agent private keys (needed for EIP-712 signing)
    uint256 public agent1Key = 0xA1;
    uint256 public agent2Key = 0xA2;
    uint256 public agent3Key = 0xA3;
    uint256 public agent4Key = 0xA4;

    address public agent1;
    address public agent2;
    address public agent3;
    address public agent4;

    uint256 public constant ENTRY_STAKE = 100e18;
    uint256 public constant INITIAL_BALANCE = 10_000e18;
    uint256 public constant QUICK_MATCH_STAKE = 100e18;

    function setUp() public {
        // Derive addresses from private keys
        agent1 = vm.addr(agent1Key);
        agent2 = vm.addr(agent2Key);
        agent3 = vm.addr(agent3Key);
        agent4 = vm.addr(agent4Key);

        // Deploy contracts
        registry = new AgentRegistry();
        token = new MockToken();
        game = new SplitOrSteal(address(token), address(registry), operator, treasury);

        // Register agents
        _registerAgent(agent1, "Agent1");
        _registerAgent(agent2, "Agent2");
        _registerAgent(agent3, "Agent3");
        _registerAgent(agent4, "Agent4");

        // Mint tokens to all participants
        token.mint(agent1, INITIAL_BALANCE);
        token.mint(agent2, INITIAL_BALANCE);
        token.mint(agent3, INITIAL_BALANCE);
        token.mint(agent4, INITIAL_BALANCE);
        token.mint(bettor1, INITIAL_BALANCE);
        token.mint(bettor2, INITIAL_BALANCE);

        // Approve game contract (for tournament joins and non-permit flows)
        _approve(agent1);
        _approve(agent2);
        _approve(agent3);
        _approve(agent4);
        _approve(bettor1);
        _approve(bettor2);
    }

    function _registerAgent(address agent, string memory name) internal {
        vm.prank(agent);
        registry.register(name, "", "");
    }

    function _approve(address user) internal {
        vm.prank(user);
        token.approve(address(game), type(uint256).max);
    }

    // ─── EIP-712 Helper ─────────────────────────────────────────────────

    function _signChoice(uint256 privateKey, uint256 matchId, uint8 choice, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(game.MATCH_CHOICE_TYPEHASH(), matchId, choice, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", game.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ─── Tournament Helper ──────────────────────────────────────────────

    function _createAndFillTournament() internal returns (uint256 tournamentId) {
        vm.prank(operator);
        tournamentId = game.createTournament(ENTRY_STAKE, 8, 3, 300);

        vm.prank(agent1);
        game.joinTournament(tournamentId);
        vm.prank(agent2);
        game.joinTournament(tournamentId);
        vm.prank(agent3);
        game.joinTournament(tournamentId);
        vm.prank(agent4);
        game.joinTournament(tournamentId);
    }

    function _startTournament(uint256 tournamentId) internal {
        vm.prank(operator);
        game.startTournament(tournamentId);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  QUICK MATCH TESTS
    // ═════════════════════════════════════════════════════════════════════

    function test_createQuickMatch_withApproval() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        assertEq(matchId, 1);

        SplitOrSteal.Match memory m = game.getMatch(matchId);
        assertEq(m.agentA, agent1);
        assertEq(m.agentB, agent2);
        assertEq(m.tournamentId, 0);
        assertEq(m.settled, false);

        // Stakes transferred
        assertEq(token.balanceOf(agent1), INITIAL_BALANCE - QUICK_MATCH_STAKE);
        assertEq(token.balanceOf(agent2), INITIAL_BALANCE - QUICK_MATCH_STAKE);
    }

    function test_quickMatch_bothSplit_noFee() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        uint256 nonce1 = game.choiceNonces(agent1);
        uint256 nonce2 = game.choiceNonces(agent2);

        bytes memory sigA = _signChoice(agent1Key, matchId, 1, nonce1); // SPLIT
        bytes memory sigB = _signChoice(agent2Key, matchId, 1, nonce2); // SPLIT

        vm.prank(operator);
        game.settleWithSignatures(matchId, 1, nonce1, sigA, 1, nonce2, sigB);

        // Both split → full refund, no fee
        assertEq(token.balanceOf(agent1), INITIAL_BALANCE);
        assertEq(token.balanceOf(agent2), INITIAL_BALANCE);
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_quickMatch_aStealsBSplits() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        bytes memory sigA = _signChoice(agent1Key, matchId, 2, 0); // STEAL
        bytes memory sigB = _signChoice(agent2Key, matchId, 1, 0); // SPLIT

        vm.prank(operator);
        game.settleWithSignatures(matchId, 2, 0, sigA, 1, 0, sigB);

        // A steals → A gets 190, B gets 0, treasury gets 10
        uint256 totalPot = QUICK_MATCH_STAKE * 2;
        uint256 houseFee = (totalPot * 500) / 10000; // 5%
        uint256 winnerPayout = totalPot - houseFee;

        assertEq(token.balanceOf(agent1), INITIAL_BALANCE - QUICK_MATCH_STAKE + winnerPayout);
        assertEq(token.balanceOf(agent2), INITIAL_BALANCE - QUICK_MATCH_STAKE);
        assertEq(token.balanceOf(treasury), houseFee);
    }

    function test_quickMatch_bothSteal_splitMinusFee() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        bytes memory sigA = _signChoice(agent1Key, matchId, 2, 0); // STEAL
        bytes memory sigB = _signChoice(agent2Key, matchId, 2, 0); // STEAL

        vm.prank(operator);
        game.settleWithSignatures(matchId, 2, 0, sigA, 2, 0, sigB);

        // Both steal → split pot minus fee
        uint256 totalPot = QUICK_MATCH_STAKE * 2;
        uint256 houseFee = (totalPot * 500) / 10000;
        uint256 splitEach = (totalPot - houseFee) / 2;

        assertEq(token.balanceOf(agent1), INITIAL_BALANCE - QUICK_MATCH_STAKE + splitEach);
        assertEq(token.balanceOf(agent2), INITIAL_BALANCE - QUICK_MATCH_STAKE + splitEach);
        assertEq(token.balanceOf(treasury), houseFee);
    }

    function test_quickMatch_invalidSignature_reverts() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        // Agent1 signs, but we use agent3's key for agent2's sig (wrong signer)
        bytes memory sigA = _signChoice(agent1Key, matchId, 1, 0);
        bytes memory badSigB = _signChoice(agent3Key, matchId, 1, 0); // WRONG KEY

        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.InvalidSignature.selector);
        game.settleWithSignatures(matchId, 1, 0, sigA, 1, 0, badSigB);
    }

    function test_quickMatch_replayProtection() public {
        // First match
        vm.prank(operator);
        uint256 matchId1 = game.createQuickMatchWithApproval(agent1, agent2);

        bytes memory sigA = _signChoice(agent1Key, matchId1, 1, 0);
        bytes memory sigB = _signChoice(agent2Key, matchId1, 1, 0);

        vm.prank(operator);
        game.settleWithSignatures(matchId1, 1, 0, sigA, 1, 0, sigB);

        // Nonces incremented
        assertEq(game.choiceNonces(agent1), 1);
        assertEq(game.choiceNonces(agent2), 1);

        // Second match — old nonce (0) should fail
        vm.prank(operator);
        uint256 matchId2 = game.createQuickMatchWithApproval(agent1, agent2);

        bytes memory oldSigA = _signChoice(agent1Key, matchId2, 1, 0); // nonce 0 (old)

        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.InvalidNonce.selector);
        game.settleWithSignatures(matchId2, 1, 0, oldSigA, 1, 0, sigB);

        // Use correct nonce
        bytes memory newSigA = _signChoice(agent1Key, matchId2, 1, 1); // nonce 1
        bytes memory newSigB = _signChoice(agent2Key, matchId2, 1, 1); // nonce 1

        vm.prank(operator);
        game.settleWithSignatures(matchId2, 1, 1, newSigA, 1, 1, newSigB);
    }

    function test_quickMatch_cannotSettleTwice() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        bytes memory sigA = _signChoice(agent1Key, matchId, 1, 0);
        bytes memory sigB = _signChoice(agent2Key, matchId, 1, 0);

        vm.prank(operator);
        game.settleWithSignatures(matchId, 1, 0, sigA, 1, 0, sigB);

        // Second settle should revert
        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.MatchAlreadySettled.selector);
        game.settleWithSignatures(matchId, 1, 0, sigA, 1, 0, sigB);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  TIMEOUT TESTS
    // ═════════════════════════════════════════════════════════════════════

    function test_settleTimeout_bothTimedOut() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        // Warp past deadline
        vm.warp(block.timestamp + 61);

        vm.prank(operator);
        game.settleTimeout(matchId);

        SplitOrSteal.Match memory m = game.getMatch(matchId);
        assertEq(m.settled, true);

        // Both get refund minus fee
        uint256 totalPot = QUICK_MATCH_STAKE * 2;
        uint256 houseFee = (totalPot * 500) / 10000;
        uint256 refundEach = (totalPot - houseFee) / 2;
        assertEq(token.balanceOf(agent1), INITIAL_BALANCE - QUICK_MATCH_STAKE + refundEach);
        assertEq(token.balanceOf(agent2), INITIAL_BALANCE - QUICK_MATCH_STAKE + refundEach);
    }

    function test_settleTimeout_revertBeforeDeadline() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.DeadlineNotPassed.selector);
        game.settleTimeout(matchId);
    }

    function test_settlePartialTimeout_agentATimedOut() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        vm.warp(block.timestamp + 61);

        // Agent B responded with SPLIT
        bytes memory sigB = _signChoice(agent2Key, matchId, 1, 0);

        vm.prank(operator);
        game.settlePartialTimeout(matchId, 1, 0, sigB, true); // agentA timed out

        // Agent B wins (responded), Agent A timed out
        uint256 totalPot = QUICK_MATCH_STAKE * 2;
        uint256 houseFee = (totalPot * 500) / 10000;
        uint256 winnerPayout = totalPot - houseFee;

        // Agent B should get the pot (since A timed out = treated as steal loss)
        assertEq(token.balanceOf(agent2), INITIAL_BALANCE - QUICK_MATCH_STAKE + winnerPayout);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  TOURNAMENT TESTS
    // ═════════════════════════════════════════════════════════════════════

    function test_createTournament() public {
        vm.prank(operator);
        uint256 id = game.createTournament(ENTRY_STAKE, 8, 3, 300);
        assertEq(id, 1);

        (, uint256 entryStake,,, uint8 maxPlayers,, uint8 totalRounds, SplitOrSteal.TournamentState state,) =
            game.tournaments(id);
        assertEq(entryStake, ENTRY_STAKE);
        assertEq(maxPlayers, 8);
        assertEq(totalRounds, 3);
        assertTrue(state == SplitOrSteal.TournamentState.REGISTRATION);
    }

    function test_joinTournament() public {
        vm.prank(operator);
        uint256 id = game.createTournament(ENTRY_STAKE, 8, 3, 300);

        vm.prank(agent1);
        game.joinTournament(id);

        assertTrue(game.hasPlayerJoined(id, agent1));
        assertEq(token.balanceOf(agent1), INITIAL_BALANCE - ENTRY_STAKE);
    }

    function test_startTournament_revertIfNotEnoughPlayers() public {
        vm.prank(operator);
        uint256 id = game.createTournament(ENTRY_STAKE, 8, 3, 300);

        vm.prank(agent1);
        game.joinTournament(id);

        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.NotEnoughPlayers.selector);
        game.startTournament(id);
    }

    function test_tournamentMatch_settleWithSignatures() public {
        uint256 id = _createAndFillTournament();
        _startTournament(id);

        // Create tournament match
        vm.prank(operator);
        uint256 matchId = game.createTournamentMatch(id, agent1, agent2, 60);

        // Settle with signatures
        bytes memory sigA = _signChoice(agent1Key, matchId, 1, 0); // SPLIT
        bytes memory sigB = _signChoice(agent2Key, matchId, 2, 0); // STEAL

        vm.prank(operator);
        game.settleWithSignatures(matchId, 1, 0, sigA, 2, 0, sigB);

        // Check stats: A=SPLIT(1pt), B=STEAL(5pts)
        SplitOrSteal.PlayerStats memory statsA = game.getPlayerStats(id, agent1);
        SplitOrSteal.PlayerStats memory statsB = game.getPlayerStats(id, agent2);

        assertEq(statsA.points, 1);
        assertEq(statsB.points, 5);
        assertEq(statsA.matchesPlayed, 1);
        assertEq(statsB.matchesPlayed, 1);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  PRIZE CLAIMING (FIXED)
    // ═════════════════════════════════════════════════════════════════════

    function test_claimPrize_fixedRankings() public {
        uint256 id = _createAndFillTournament();
        _startTournament(id);

        // Play a match
        vm.prank(operator);
        uint256 matchId = game.createTournamentMatch(id, agent1, agent2, 60);

        bytes memory sigA = _signChoice(agent1Key, matchId, 2, 0); // STEAL
        bytes memory sigB = _signChoice(agent2Key, matchId, 1, 0); // SPLIT

        vm.prank(operator);
        game.settleWithSignatures(matchId, 2, 0, sigA, 1, 0, sigB);

        // Advance to final and complete
        vm.prank(operator);
        game.advanceToFinal(id);
        vm.prank(operator);
        game.completeTournament(id);

        // Set rankings (agent1 won)
        address[] memory ranked = new address[](4);
        ranked[0] = agent1; // 1st
        ranked[1] = agent2; // 2nd
        ranked[2] = agent3; // 3rd
        ranked[3] = agent4; // 4th

        vm.prank(operator);
        game.setFinalRankings(id, ranked);

        // Claim prizes
        uint256 prizePool = ENTRY_STAKE * 4;

        uint256 balBefore1 = token.balanceOf(agent1);
        vm.prank(agent1);
        game.claimPrize(id);
        assertEq(token.balanceOf(agent1), balBefore1 + (prizePool * 50) / 100);

        uint256 balBefore2 = token.balanceOf(agent2);
        vm.prank(agent2);
        game.claimPrize(id);
        assertEq(token.balanceOf(agent2), balBefore2 + (prizePool * 30) / 100);

        uint256 balBefore3 = token.balanceOf(agent3);
        vm.prank(agent3);
        game.claimPrize(id);
        assertEq(token.balanceOf(agent3), balBefore3 + (prizePool * 20) / 100);

        // 4th place gets nothing (top 3 take 100% of pool)
        uint256 balBefore4 = token.balanceOf(agent4);
        vm.prank(agent4);
        game.claimPrize(id);
        assertEq(token.balanceOf(agent4), balBefore4); // No payout
    }

    function test_claimPrize_revertWithoutRankings() public {
        uint256 id = _createAndFillTournament();
        _startTournament(id);

        vm.prank(operator);
        game.advanceToFinal(id);
        vm.prank(operator);
        game.completeTournament(id);

        // Try to claim without rankings set
        vm.prank(agent1);
        vm.expectRevert(SplitOrSteal.RankingsNotSet.selector);
        game.claimPrize(id);
    }

    function test_claimPrize_cannotClaimTwice() public {
        uint256 id = _createAndFillTournament();
        _startTournament(id);

        vm.prank(operator);
        game.advanceToFinal(id);
        vm.prank(operator);
        game.completeTournament(id);

        address[] memory ranked = new address[](4);
        ranked[0] = agent1;
        ranked[1] = agent2;
        ranked[2] = agent3;
        ranked[3] = agent4;

        vm.prank(operator);
        game.setFinalRankings(id, ranked);

        vm.prank(agent1);
        game.claimPrize(id);

        vm.prank(agent1);
        vm.expectRevert(SplitOrSteal.AlreadyClaimedPrize.selector);
        game.claimPrize(id);
    }

    function test_claimPrize_cannotFakeRank() public {
        // This test proves the V1 vulnerability is fixed
        // In V1, any agent could call claimPrize(tournamentId, 1) to claim 1st place
        // Now rank comes from on-chain rankings set by operator - no user input
        uint256 id = _createAndFillTournament();
        _startTournament(id);

        vm.prank(operator);
        game.advanceToFinal(id);
        vm.prank(operator);
        game.completeTournament(id);

        // Agent4 is ranked 4th (last)
        address[] memory ranked = new address[](4);
        ranked[0] = agent1; // 1st
        ranked[1] = agent2; // 2nd
        ranked[2] = agent3; // 3rd
        ranked[3] = agent4; // 4th

        vm.prank(operator);
        game.setFinalRankings(id, ranked);

        // Agent4 claims — gets 0 (4th place), NOT 1st place prize
        uint256 prizePool = ENTRY_STAKE * 4;
        uint256 balBefore = token.balanceOf(agent4);

        vm.prank(agent4);
        game.claimPrize(id);

        // Agent4 gets 0 — 4th place gets nothing. Cannot fake rank 1.
        assertEq(token.balanceOf(agent4), balBefore);
        assertTrue(0 < (prizePool * 50) / 100); // Proves they got less than 1st
    }

    function test_setFinalRankings_revertIfNotOperator() public {
        uint256 id = _createAndFillTournament();
        _startTournament(id);

        vm.prank(operator);
        game.advanceToFinal(id);
        vm.prank(operator);
        game.completeTournament(id);

        address[] memory ranked = new address[](4);
        ranked[0] = agent1;
        ranked[1] = agent2;
        ranked[2] = agent3;
        ranked[3] = agent4;

        // Non-operator cannot set rankings
        vm.prank(agent1);
        vm.expectRevert(SplitOrSteal.NotOperator.selector);
        game.setFinalRankings(id, ranked);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  BETTING TESTS
    // ═════════════════════════════════════════════════════════════════════

    function test_placeBet_andClaimWinnings() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        // Bettor1 bets on AGENT_A_STEALS (outcome 2)
        vm.prank(bettor1);
        game.placeBet(matchId, 2, 50e18);

        // Bettor2 bets on BOTH_SPLIT (outcome 1)
        vm.prank(bettor2);
        game.placeBet(matchId, 1, 50e18);

        // Close betting before settlement (required when bets exist)
        vm.prank(operator);
        game.closeBetting(matchId);

        // Settle: A steals, B splits
        bytes memory sigA = _signChoice(agent1Key, matchId, 2, 0);
        bytes memory sigB = _signChoice(agent2Key, matchId, 1, 0);

        vm.prank(operator);
        game.settleWithSignatures(matchId, 2, 0, sigA, 1, 0, sigB);

        // Bettor1 wins (predicted AGENT_A_STEALS)
        uint256 balBefore = token.balanceOf(bettor1);
        vm.prank(bettor1);
        game.claimWinnings(matchId);

        // Bettor1 should get: (50 * 95) / 50 = 95 ARENA (net pool after 5% fee)
        uint256 totalPool = 100e18;
        uint256 netPool = totalPool - (totalPool * 500) / 10000;
        uint256 expectedPayout = (50e18 * netPool) / 50e18;
        assertEq(token.balanceOf(bettor1), balBefore + expectedPayout);

        // Bettor2 loses — nothing to claim
        vm.prank(bettor2);
        vm.expectRevert(); // NothingToClaim
        game.claimWinnings(matchId);
    }

    function test_placeBet_revertIfParticipant() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        // Agent in the match cannot bet on it
        vm.prank(agent1);
        vm.expectRevert(); // CannotBetOnOwnMatch
        game.placeBet(matchId, 1, 50e18);
    }

    function test_placeBet_revertIfDoublebet() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        vm.prank(bettor1);
        game.placeBet(matchId, 1, 50e18);

        vm.prank(bettor1);
        vm.expectRevert(); // AlreadyBet
        game.placeBet(matchId, 2, 50e18);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  CANCELLATION TESTS
    // ═════════════════════════════════════════════════════════════════════

    function test_cancelTournament_refund() public {
        vm.prank(operator);
        uint256 id = game.createTournament(ENTRY_STAKE, 8, 3, 300);

        vm.prank(agent1);
        game.joinTournament(id);

        uint256 balAfterJoin = token.balanceOf(agent1);

        vm.prank(operator);
        game.cancelTournament(id);

        vm.prank(agent1);
        game.claimCancellationRefund(id);

        assertEq(token.balanceOf(agent1), balAfterJoin + ENTRY_STAKE);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  EDGE CASES
    // ═════════════════════════════════════════════════════════════════════

    function test_nonOperatorCannotCreateMatch() public {
        vm.prank(agent1);
        vm.expectRevert(SplitOrSteal.NotOperator.selector);
        game.createQuickMatchWithApproval(agent1, agent2);
    }

    function test_nonOperatorCannotSettle() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        bytes memory sigA = _signChoice(agent1Key, matchId, 1, 0);
        bytes memory sigB = _signChoice(agent2Key, matchId, 1, 0);

        vm.prank(agent1);
        vm.expectRevert(SplitOrSteal.NotOperator.selector);
        game.settleWithSignatures(matchId, 1, 0, sigA, 1, 0, sigB);
    }

    function test_invalidChoice_reverts() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        bytes memory sigA = _signChoice(agent1Key, matchId, 0, 0); // NONE = invalid
        bytes memory sigB = _signChoice(agent2Key, matchId, 1, 0);

        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.InvalidChoice.selector);
        game.settleWithSignatures(matchId, 0, 0, sigA, 1, 0, sigB);
    }

    function test_matchCreatesPool() public {
        vm.prank(operator);
        uint256 matchId = game.createQuickMatchWithApproval(agent1, agent2);

        // Pool should exist and be OPEN
        (uint256 totalPool,,,, uint8 state,) = _getPoolData(matchId);
        assertEq(state, 1); // OPEN
        assertEq(totalPool, 0);
    }

    function _getPoolData(uint256 matchId)
        internal
        view
        returns (uint256 totalPool, uint256 o1, uint256 o2, uint256 o3, uint8 state, uint8 result)
    {
        // Use the getPool view function
        BettingEngine.Pool memory pool = game.getPool(matchId);
        return (
            pool.totalPool,
            pool.outcomePools[1],
            pool.outcomePools[2],
            pool.outcomePools[3],
            uint8(pool.state),
            pool.result
        );
    }

    // ═════════════════════════════════════════════════════════════════════
    //  BATCH: CREATE QUICK MATCHES
    // ═════════════════════════════════════════════════════════════════════

    function test_createQuickMatchBatch_twoPairs() public {
        SplitOrSteal.QuickMatchPair[] memory pairs = new SplitOrSteal.QuickMatchPair[](2);
        pairs[0] = SplitOrSteal.QuickMatchPair(agent1, agent2);
        pairs[1] = SplitOrSteal.QuickMatchPair(agent3, agent4);

        vm.prank(operator);
        uint256[] memory matchIds = game.createQuickMatchBatch(pairs);

        assertEq(matchIds.length, 2);
        assertEq(matchIds[0], 1);
        assertEq(matchIds[1], 2);

        // Verify match 1
        SplitOrSteal.Match memory m1 = game.getMatch(1);
        assertEq(m1.agentA, agent1);
        assertEq(m1.agentB, agent2);
        assertEq(m1.tournamentId, 0);

        // Verify match 2
        SplitOrSteal.Match memory m2 = game.getMatch(2);
        assertEq(m2.agentA, agent3);
        assertEq(m2.agentB, agent4);

        // Stakes transferred from all 4 agents
        assertEq(token.balanceOf(agent1), INITIAL_BALANCE - QUICK_MATCH_STAKE);
        assertEq(token.balanceOf(agent2), INITIAL_BALANCE - QUICK_MATCH_STAKE);
        assertEq(token.balanceOf(agent3), INITIAL_BALANCE - QUICK_MATCH_STAKE);
        assertEq(token.balanceOf(agent4), INITIAL_BALANCE - QUICK_MATCH_STAKE);

        // Pools created for both matches
        (,,,, uint8 state1,) = _getPoolData(1);
        (,,,, uint8 state2,) = _getPoolData(2);
        assertEq(state1, 1); // OPEN
        assertEq(state2, 1); // OPEN
    }

    function test_createQuickMatchBatch_emptyArray() public {
        SplitOrSteal.QuickMatchPair[] memory pairs = new SplitOrSteal.QuickMatchPair[](0);

        vm.prank(operator);
        uint256[] memory matchIds = game.createQuickMatchBatch(pairs);

        assertEq(matchIds.length, 0);
    }

    function test_createQuickMatchBatch_revertIfNotOperator() public {
        SplitOrSteal.QuickMatchPair[] memory pairs = new SplitOrSteal.QuickMatchPair[](1);
        pairs[0] = SplitOrSteal.QuickMatchPair(agent1, agent2);

        vm.prank(agent1);
        vm.expectRevert(SplitOrSteal.NotOperator.selector);
        game.createQuickMatchBatch(pairs);
    }

    function test_createQuickMatchBatch_revertIfOverCap() public {
        SplitOrSteal.QuickMatchPair[] memory pairs = new SplitOrSteal.QuickMatchPair[](31);
        for (uint256 i = 0; i < 31; i++) {
            pairs[i] = SplitOrSteal.QuickMatchPair(agent1, agent2);
        }

        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.BatchTooLarge.selector);
        game.createQuickMatchBatch(pairs);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  BATCH: SETTLE MULTIPLE
    // ═════════════════════════════════════════════════════════════════════

    function test_settleMultiple_twoMatches() public {
        // Create 2 matches
        SplitOrSteal.QuickMatchPair[] memory pairs = new SplitOrSteal.QuickMatchPair[](2);
        pairs[0] = SplitOrSteal.QuickMatchPair(agent1, agent2);
        pairs[1] = SplitOrSteal.QuickMatchPair(agent3, agent4);

        vm.prank(operator);
        uint256[] memory matchIds = game.createQuickMatchBatch(pairs);

        // Sign choices for match 1: both SPLIT
        uint256 nonce1A = game.choiceNonces(agent1);
        uint256 nonce1B = game.choiceNonces(agent2);
        bytes memory sig1A = _signChoice(agent1Key, matchIds[0], 1, nonce1A);
        bytes memory sig1B = _signChoice(agent2Key, matchIds[0], 1, nonce1B);

        // Sign choices for match 2: agent3 STEAL, agent4 SPLIT
        uint256 nonce2A = game.choiceNonces(agent3);
        uint256 nonce2B = game.choiceNonces(agent4);
        bytes memory sig2A = _signChoice(agent3Key, matchIds[1], 2, nonce2A);
        bytes memory sig2B = _signChoice(agent4Key, matchIds[1], 1, nonce2B);

        // Settle both in one tx
        SplitOrSteal.SettlementData[] memory settlements = new SplitOrSteal.SettlementData[](2);
        settlements[0] = SplitOrSteal.SettlementData({
            matchId: matchIds[0], choiceA: 1, nonceA: nonce1A, sigA: sig1A, choiceB: 1, nonceB: nonce1B, sigB: sig1B
        });
        settlements[1] = SplitOrSteal.SettlementData({
            matchId: matchIds[1], choiceA: 2, nonceA: nonce2A, sigA: sig2A, choiceB: 1, nonceB: nonce2B, sigB: sig2B
        });

        vm.prank(operator);
        game.settleMultiple(settlements);

        // Match 1: both split → full refund
        assertEq(token.balanceOf(agent1), INITIAL_BALANCE);
        assertEq(token.balanceOf(agent2), INITIAL_BALANCE);

        // Match 2: agent3 steals → gets 190, agent4 gets 0
        uint256 totalPot = QUICK_MATCH_STAKE * 2;
        uint256 houseFee = (totalPot * 500) / 10000;
        uint256 winnerPayout = totalPot - houseFee;
        assertEq(token.balanceOf(agent3), INITIAL_BALANCE - QUICK_MATCH_STAKE + winnerPayout);
        assertEq(token.balanceOf(agent4), INITIAL_BALANCE - QUICK_MATCH_STAKE);

        // Both matches settled
        SplitOrSteal.Match memory m1 = game.getMatch(matchIds[0]);
        SplitOrSteal.Match memory m2 = game.getMatch(matchIds[1]);
        assertTrue(m1.settled);
        assertTrue(m2.settled);
    }

    function test_settleMultiple_noncesIncrementCorrectly() public {
        // Create 2 matches with the SAME agents (tests nonce sequencing)
        vm.prank(operator);
        uint256 matchId1 = game.createQuickMatchWithApproval(agent1, agent2);
        vm.prank(operator);
        uint256 matchId2 = game.createQuickMatchWithApproval(agent1, agent2);

        // Nonces start at 0 for both agents
        assertEq(game.choiceNonces(agent1), 0);
        assertEq(game.choiceNonces(agent2), 0);

        // Match 1 uses nonce 0, match 2 uses nonce 1
        bytes memory sig1A = _signChoice(agent1Key, matchId1, 1, 0);
        bytes memory sig1B = _signChoice(agent2Key, matchId1, 1, 0);
        bytes memory sig2A = _signChoice(agent1Key, matchId2, 2, 1);
        bytes memory sig2B = _signChoice(agent2Key, matchId2, 2, 1);

        SplitOrSteal.SettlementData[] memory settlements = new SplitOrSteal.SettlementData[](2);
        settlements[0] = SplitOrSteal.SettlementData({
            matchId: matchId1, choiceA: 1, nonceA: 0, sigA: sig1A, choiceB: 1, nonceB: 0, sigB: sig1B
        });
        settlements[1] = SplitOrSteal.SettlementData({
            matchId: matchId2, choiceA: 2, nonceA: 1, sigA: sig2A, choiceB: 2, nonceB: 1, sigB: sig2B
        });

        vm.prank(operator);
        game.settleMultiple(settlements);

        // Nonces incremented to 2 (once per settlement)
        assertEq(game.choiceNonces(agent1), 2);
        assertEq(game.choiceNonces(agent2), 2);

        // Both settled
        assertTrue(game.getMatch(matchId1).settled);
        assertTrue(game.getMatch(matchId2).settled);
    }

    function test_settleMultiple_revertIfOverCap() public {
        SplitOrSteal.SettlementData[] memory settlements = new SplitOrSteal.SettlementData[](31);

        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.BatchTooLarge.selector);
        game.settleMultiple(settlements);
    }

    function test_settleMultiple_revertIfBadSignature() public {
        SplitOrSteal.QuickMatchPair[] memory pairs = new SplitOrSteal.QuickMatchPair[](2);
        pairs[0] = SplitOrSteal.QuickMatchPair(agent1, agent2);
        pairs[1] = SplitOrSteal.QuickMatchPair(agent3, agent4);

        vm.prank(operator);
        uint256[] memory matchIds = game.createQuickMatchBatch(pairs);

        // Match 1: valid sigs
        bytes memory sig1A = _signChoice(agent1Key, matchIds[0], 1, 0);
        bytes memory sig1B = _signChoice(agent2Key, matchIds[0], 1, 0);

        // Match 2: INVALID sig (agent1Key signing for agent3)
        bytes memory badSig2A = _signChoice(agent1Key, matchIds[1], 2, 0);
        bytes memory sig2B = _signChoice(agent4Key, matchIds[1], 1, 0);

        SplitOrSteal.SettlementData[] memory settlements = new SplitOrSteal.SettlementData[](2);
        settlements[0] = SplitOrSteal.SettlementData({
            matchId: matchIds[0], choiceA: 1, nonceA: 0, sigA: sig1A, choiceB: 1, nonceB: 0, sigB: sig1B
        });
        settlements[1] = SplitOrSteal.SettlementData({
            matchId: matchIds[1], choiceA: 2, nonceA: 0, sigA: badSig2A, choiceB: 1, nonceB: 0, sigB: sig2B
        });

        // Entire batch reverts (match 1 rolls back too)
        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.InvalidSignature.selector);
        game.settleMultiple(settlements);

        // Match 1 was NOT settled (rolled back)
        assertFalse(game.getMatch(matchIds[0]).settled);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  BATCH: TOURNAMENT MATCHES
    // ═════════════════════════════════════════════════════════════════════

    function test_createTournamentMatchBatch() public {
        uint256 id = _createAndFillTournament();
        _startTournament(id);

        SplitOrSteal.TournamentMatchPair[] memory pairs = new SplitOrSteal.TournamentMatchPair[](2);
        pairs[0] = SplitOrSteal.TournamentMatchPair(agent1, agent2);
        pairs[1] = SplitOrSteal.TournamentMatchPair(agent3, agent4);

        vm.prank(operator);
        uint256[] memory matchIds = game.createTournamentMatchBatch(id, pairs, 60);

        assertEq(matchIds.length, 2);

        // Verify both matches belong to the tournament
        SplitOrSteal.Match memory m1 = game.getMatch(matchIds[0]);
        SplitOrSteal.Match memory m2 = game.getMatch(matchIds[1]);
        assertEq(m1.tournamentId, id);
        assertEq(m2.tournamentId, id);
        assertEq(m1.agentA, agent1);
        assertEq(m1.agentB, agent2);
        assertEq(m2.agentA, agent3);
        assertEq(m2.agentB, agent4);
    }

    function test_createTournamentMatchBatch_revertIfNotInTournament() public {
        uint256 id = _createAndFillTournament();
        _startTournament(id);

        // agent1 is in the tournament, but create a non-registered address
        address outsider = makeAddr("outsider");

        SplitOrSteal.TournamentMatchPair[] memory pairs = new SplitOrSteal.TournamentMatchPair[](1);
        pairs[0] = SplitOrSteal.TournamentMatchPair(agent1, outsider);

        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.AgentNotInTournament.selector);
        game.createTournamentMatchBatch(id, pairs, 60);
    }

    function test_createTournamentMatchBatch_revertIfOverCap() public {
        uint256 id = _createAndFillTournament();
        _startTournament(id);

        SplitOrSteal.TournamentMatchPair[] memory pairs = new SplitOrSteal.TournamentMatchPair[](31);

        vm.prank(operator);
        vm.expectRevert(SplitOrSteal.BatchTooLarge.selector);
        game.createTournamentMatchBatch(id, pairs, 60);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  BATCH: FULL INTEGRATION (create batch + settle batch)
    // ═════════════════════════════════════════════════════════════════════

    function test_batchIntegration_createAndSettleMultiple() public {
        // Create 2 quick matches in one tx
        SplitOrSteal.QuickMatchPair[] memory pairs = new SplitOrSteal.QuickMatchPair[](2);
        pairs[0] = SplitOrSteal.QuickMatchPair(agent1, agent2);
        pairs[1] = SplitOrSteal.QuickMatchPair(agent3, agent4);

        vm.prank(operator);
        uint256[] memory matchIds = game.createQuickMatchBatch(pairs);

        // Sign all choices
        bytes memory sig1A = _signChoice(agent1Key, matchIds[0], 2, 0); // STEAL
        bytes memory sig1B = _signChoice(agent2Key, matchIds[0], 2, 0); // STEAL
        bytes memory sig2A = _signChoice(agent3Key, matchIds[1], 1, 0); // SPLIT
        bytes memory sig2B = _signChoice(agent4Key, matchIds[1], 1, 0); // SPLIT

        // Settle both in one tx
        SplitOrSteal.SettlementData[] memory settlements = new SplitOrSteal.SettlementData[](2);
        settlements[0] = SplitOrSteal.SettlementData({
            matchId: matchIds[0], choiceA: 2, nonceA: 0, sigA: sig1A, choiceB: 2, nonceB: 0, sigB: sig1B
        });
        settlements[1] = SplitOrSteal.SettlementData({
            matchId: matchIds[1], choiceA: 1, nonceA: 0, sigA: sig2A, choiceB: 1, nonceB: 0, sigB: sig2B
        });

        vm.prank(operator);
        game.settleMultiple(settlements);

        // Match 1: both steal → split pot minus fee
        uint256 totalPot = QUICK_MATCH_STAKE * 2;
        uint256 houseFee = (totalPot * 500) / 10000;
        uint256 splitEach = (totalPot - houseFee) / 2;
        assertEq(token.balanceOf(agent1), INITIAL_BALANCE - QUICK_MATCH_STAKE + splitEach);
        assertEq(token.balanceOf(agent2), INITIAL_BALANCE - QUICK_MATCH_STAKE + splitEach);

        // Match 2: both split → full refund
        assertEq(token.balanceOf(agent3), INITIAL_BALANCE);
        assertEq(token.balanceOf(agent4), INITIAL_BALANCE);

        // Treasury collected fee from match 1 only (both steal)
        // Plus betting pool fee from both matches
        assertGt(token.balanceOf(treasury), 0);
    }
}

// Import for type reference
import {BettingEngine} from "../src/split-or-steal/BettingEngine.sol";
