/**
 * Fund agents with ARENA tokens.
 * Uses the operator wallet to claim faucet and transfer to agents.
 */
import { ethers } from 'ethers';
import { config } from './config.js';

const provider = new ethers.JsonRpcProvider(config.rpcUrl);
const operator = new ethers.Wallet(config.operatorPrivateKey, provider);

const ARENA = new ethers.Contract(config.arenaTokenAddress, [
  'function faucet() external',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
], operator);

const HOUSEBOT_ADDRESS = new ethers.Wallet(process.env.HOUSEBOT_PRIVATE_KEY!).address;
const TEST_AGENT_ADDRESS = new ethers.Wallet(process.env.TEST_AGENT_PRIVATE_KEY!).address;
const AMOUNT = ethers.parseEther('500');

async function main() {
  console.log(`Operator: ${operator.address}`);
  console.log(`HouseBot: ${HOUSEBOT_ADDRESS}`);
  console.log(`TestAgent: ${TEST_AGENT_ADDRESS}`);

  // Check operator balance
  let balance = await ARENA.balanceOf(operator.address);
  console.log(`\nOperator ARENA balance: ${ethers.formatEther(balance)}`);

  // Try faucet if low
  if (balance < AMOUNT * 2n) {
    console.log('Claiming faucet for operator...');
    try {
      const tx = await ARENA.faucet();
      await tx.wait();
      balance = await ARENA.balanceOf(operator.address);
      console.log(`Operator ARENA balance after faucet: ${ethers.formatEther(balance)}`);
    } catch (e: any) {
      console.log(`Faucet failed (cooldown?): ${e.shortMessage || e.message}`);
    }
  }

  // Check agent balances
  const housebotBal = await ARENA.balanceOf(HOUSEBOT_ADDRESS);
  const testAgentBal = await ARENA.balanceOf(TEST_AGENT_ADDRESS);
  console.log(`\nHouseBot ARENA: ${ethers.formatEther(housebotBal)}`);
  console.log(`TestAgent ARENA: ${ethers.formatEther(testAgentBal)}`);

  // Fund HouseBot if needed
  if (housebotBal < ethers.parseEther('100')) {
    if (balance >= AMOUNT) {
      console.log(`\nTransferring ${ethers.formatEther(AMOUNT)} ARENA to HouseBot...`);
      const tx = await ARENA.transfer(HOUSEBOT_ADDRESS, AMOUNT);
      await tx.wait();
      balance -= AMOUNT;
      console.log('Done.');
    } else {
      console.log('\nNot enough operator ARENA to fund HouseBot.');
    }
  } else {
    console.log('\nHouseBot already funded.');
  }

  // Fund TestAgent if needed
  if (testAgentBal < ethers.parseEther('100')) {
    if (balance >= AMOUNT) {
      console.log(`\nTransferring ${ethers.formatEther(AMOUNT)} ARENA to TestAgent...`);
      const tx = await ARENA.transfer(TEST_AGENT_ADDRESS, AMOUNT);
      await tx.wait();
      console.log('Done.');
    } else {
      console.log('\nNot enough operator ARENA to fund TestAgent.');
    }
  } else {
    console.log('\nTestAgent already funded.');
  }

  // Final balances
  console.log('\n═══ Final balances ═══');
  console.log(`Operator: ${ethers.formatEther(await ARENA.balanceOf(operator.address))} ARENA`);
  console.log(`HouseBot: ${ethers.formatEther(await ARENA.balanceOf(HOUSEBOT_ADDRESS))} ARENA`);
  console.log(`TestAgent: ${ethers.formatEther(await ARENA.balanceOf(TEST_AGENT_ADDRESS))} ARENA`);
}

main().catch(console.error);
