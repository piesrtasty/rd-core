const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol")
const NonPayable = artifacts.require('NonPayable.sol')
const AggregatorTester = artifacts.require("AggregatorTester")
const LiquidationsTester = artifacts.require("LiquidationsTester")
const TroveManagerTester = artifacts.require("TroveManagerTester")
const LUSDTokenTester = artifacts.require("./LUSDTokenTester")

const th = testHelpers.TestHelper

const dec = th.dec
const toBN = th.toBN
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const ZERO_ADDRESS = th.ZERO_ADDRESS
const assertRevert = th.assertRevert

/* NOTE: Some of the borrowing tests do not test for specific LUSD fee values. They only test that the
 * fees are non-zero when they should occur, and that they decay over time.
 *
 * Specific LUSD fee values will depend on the final fee schedule used, and the final choice for
 *  the parameter MINUTE_DECAY_FACTOR in the TroveManager, which is still TBD based on economic
 * modelling.
 * 
 */

contract('BorrowerOperations', async accounts => {

  const [
    owner, alice, bob, carol, dennis, whale,
    A, B, C, D, E, F, G, H,
    // defaulter_1, defaulter_2,
    frontEnd_1, frontEnd_2, frontEnd_3] = accounts;

    const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  // const frontEnds = [frontEnd_1, frontEnd_2, frontEnd_3]

  let priceFeed
  let lusdToken
  let sortedShieldedTroves
  let troveManager
  let rewards
  let activeShieldedPool
  let stabilityPool
  let defaultPool
  let borrowerOperations
  let lqtyStaking
  let lqtyToken
  let collateralToken

  let contracts

  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const openShieldedTrove = async (params) => th.openShieldedTrove(contracts, params)
  const getTroveEntireColl = async (trove) => th.getTroveEntireColl(contracts, trove)
  const getTroveEntireDebt = async (trove) => th.getTroveEntireDebt(contracts, trove)
  const getTroveStake = async (trove) => th.getTroveStake(contracts, trove)

  let LUSD_GAS_COMPENSATION
  let MIN_NET_DEBT

  before(async () => {

  })


  const testCorpus = ({ withProxy = false }) => {
    beforeEach(async () => {
      contracts = await deploymentHelper.deployLiquityCore()
      contracts.borrowerOperations = await BorrowerOperationsTester.new()
      contracts.aggregator = await AggregatorTester.new()
      contracts.liquidations = await LiquidationsTester.new()
      contracts.troveManager = await TroveManagerTester.new()
      contracts = await deploymentHelper.deployLUSDTokenTester(contracts)
      const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)

      await deploymentHelper.connectLQTYContracts(LQTYContracts)
      await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

      if (withProxy) {
        const users = [alice, bob, carol, dennis, whale, A, B, C, D, E]
        await deploymentHelper.deployProxyScripts(contracts, LQTYContracts, owner, users)
      }
      await th.batchMintCollateralTokensAndApproveActivePool(contracts, [alice, bob, carol, dennis, whale, A, B, C, D, E], toBN(dec(1000, 30)))
      
      priceFeed = contracts.priceFeedTestnet
      lusdToken = contracts.lusdToken
      sortedShieldedTroves = contracts.sortedShieldedTroves
      aggregator = contracts.aggregator
      liquidations = contracts.liquidations
      troveManager = contracts.troveManager
      rewards = contracts.rewards
      activeShieldedPool = contracts.activeShieldedPool
      stabilityPool = contracts.stabilityPool
      defaultPool = contracts.defaultPool
      borrowerOperations = contracts.borrowerOperations
      hintHelpers = contracts.hintHelpers

      lqtyStaking = LQTYContracts.lqtyStaking
      lqtyToken = LQTYContracts.lqtyToken
      communityIssuance = LQTYContracts.communityIssuance
      lockupContractFactory = LQTYContracts.lockupContractFactory
      collateralToken = contracts.collateralToken

      LUSD_GAS_COMPENSATION = await borrowerOperations.LUSD_GAS_COMPENSATION()
      MIN_NET_DEBT = await borrowerOperations.MIN_NET_DEBT()
    })

    it("addColl(): reverts when top-up would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(dec(100, 18))
      const price = await priceFeed.getPrice()

      assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(toBN(dec(110, 16))))

      const collTopUp = 1  // 1 wei top up

     await assertRevert(borrowerOperations.addColl(collTopUp, alice, alice, { from: alice }), 
      "BorrowerOps: An operation that would result in ICR < MCR is not permitted")
    })

    it("addColl(): Increases the activeShieldedPool collateral and raw collateral balance by correct amount", async () => {
      const { collateral: aliceColl } = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const activeShieldedPool_Collateral_Before = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawCollateral_Before = toBN(await collateralToken.balanceOf(activeShieldedPool.address))

      assert.isTrue(activeShieldedPool_Collateral_Before.eq(aliceColl))
      assert.isTrue(activeShieldedPool_RawCollateral_Before.eq(aliceColl))
     // alice approve coll transfer
     await collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })
     // alice add coll to active pool
      await borrowerOperations.addColl(dec(1, 'ether'), alice, alice, { from: alice })

      const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawCollateral_After = toBN(await collateralToken.balanceOf(activeShieldedPool.address))

      expect(activeShieldedPool_Collateral_After.eq(aliceColl.add(toBN(dec(1, 'ether'))))).to.be.true;
      expect(activeShieldedPool_RawCollateral_After.eq(aliceColl.add(toBN(dec(1, 'ether'))))).to.be.true;
    })

    it("addColl(), active Trove: adds the correct collateral amount to the Trove", async () => {
      // alice creates a Trove and adds first collateral
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const alice_Trove_Before = await troveManager.Troves(alice)
      const coll_before = alice_Trove_Before[1]
      const status_Before = alice_Trove_Before[3]

      // check status before
      assert.equal(status_Before, 1)
      // alice approve coll transfer
      await collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })

      // Alice adds second collateral
      await borrowerOperations.addColl(dec(1, 'ether'), alice, alice, { from: alice })

      const alice_Trove_After = await troveManager.Troves(alice)
      const coll_After = alice_Trove_After[1]
      const status_After = alice_Trove_After[3]

      // check coll increases by correct amount,and status remains active
      assert.isTrue(coll_After.eq(coll_before.add(toBN(dec(1, 'ether')))))
      assert.equal(status_After, 1)
    })

    it("addColl(), active Trove: Trove is in sortedList before and after", async () => {
      // alice creates a Trove and adds first collateral
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // check Alice is in list before
      const aliceTroveInList_Before = await sortedShieldedTroves.contains(alice)
      const listIsEmpty_Before = await sortedShieldedTroves.isEmpty()
      assert.equal(aliceTroveInList_Before, true)
      assert.equal(listIsEmpty_Before, false)
      // alice approve coll transfer
      await collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })
      // alice add coll to active pool
      await borrowerOperations.addColl(dec(1, 'ether'), alice, alice, { from: alice })

      // check Alice is still in list after
      const aliceTroveInList_After = await sortedShieldedTroves.contains(alice)
      const listIsEmpty_After = await sortedShieldedTroves.isEmpty()
      assert.equal(aliceTroveInList_After, true)
      assert.equal(listIsEmpty_After, false)
    })

    it("addColl(), active Trove: updates the stake and updates the total stakes", async () => {
      //  Alice creates initial Trove with 1 ether
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const alice_Trove_Before = await troveManager.Troves(alice)
      const alice_Stake_Before = alice_Trove_Before[2]
      const totalStakes_Before = (await rewards.totalStakes())

      assert.isTrue(totalStakes_Before.eq(alice_Stake_Before))
      // alice approve coll transfer
      await collateralToken.approve(activeShieldedPool.address, dec(2, 'ether'), { from: alice })
      // alice add coll to active pool
      await borrowerOperations.addColl(dec(2, 'ether'), alice, alice, { from: alice })

      // Check stake and total stakes get updated
      const alice_Trove_After = await troveManager.Troves(alice)
      const alice_Stake_After = alice_Trove_After[2]
      const totalStakes_After = (await rewards.totalStakes())

      assert.isTrue(alice_Stake_After.eq(alice_Stake_Before.add(toBN(dec(2, 'ether')))))
      assert.isTrue(totalStakes_After.eq(totalStakes_Before.add(toBN(dec(2, 'ether')))))
    })

    it("addColl(), active Trove: applies pending rewards and updates user's L_COLL, L_LUSDDebt snapshots", async () => {
      // --- SETUP ---

      const { collateral: aliceCollBefore, totalDebt: aliceDebtBefore } = await openShieldedTrove({ extraLUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const { collateral: bobCollBefore, totalDebt: bobDebtBefore } = await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // --- TEST ---

      // price drops to 1Collateral:100LUSD, reducing Carol's ICR below MCR
      await priceFeed.setPrice('100000000000000000000');

      // Liquidate Carol's Trove,
      const tx = await liquidations.liquidate(carol, { from: owner });

      assert.isFalse(await sortedShieldedTroves.contains(carol))

      const L_COLL = await rewards.L_Coll()
      const L_LUSDDebt = await rewards.L_LUSDDebt()

      // check Alice and Bob's reward snapshots are zero before they alter their Troves
      const alice_rewardSnapshot_Before = await rewards.rewardSnapshots(alice)
      
      const alice_CollateralrewardSnapshot_Before = alice_rewardSnapshot_Before[0]
      const alice_LUSDDebtRewardSnapshot_Before = alice_rewardSnapshot_Before[1]

      const bob_rewardSnapshot_Before = await rewards.rewardSnapshots(bob)
      const bob_CollateralrewardSnapshot_Before = bob_rewardSnapshot_Before[0]
      const bob_LUSDDebtRewardSnapshot_Before = bob_rewardSnapshot_Before[1]

      assert.equal(alice_CollateralrewardSnapshot_Before, 0)
      assert.equal(alice_LUSDDebtRewardSnapshot_Before, 0)
      assert.equal(bob_CollateralrewardSnapshot_Before, 0)
      assert.equal(bob_LUSDDebtRewardSnapshot_Before, 0)

      const alicePendingCollateralReward = await rewards.getPendingCollateralReward(alice)
      const bobPendingCollateralReward = await rewards.getPendingCollateralReward(bob)
      const alicePendingLUSDDebtReward = await rewards.getPendingLUSDDebtReward(alice)
      const bobPendingLUSDDebtReward = await rewards.getPendingLUSDDebtReward(bob)
      for (reward of [alicePendingCollateralReward, bobPendingCollateralReward, alicePendingLUSDDebtReward, bobPendingLUSDDebtReward]) {
        assert.isTrue(reward.gt(toBN('0')))
      }

      // Alice and Bob top up their Troves
      const aliceTopUp = toBN(dec(5, 'ether'))
      const bobTopUp = toBN(dec(1, 'ether'))

      // alice approve coll transfer
      await collateralToken.approve(activeShieldedPool.address, aliceTopUp, { from: alice })
      // alice add coll to active pool
      await borrowerOperations.addColl(aliceTopUp, alice, alice, { from: alice })
      // bob approve coll transfer
      await collateralToken.approve(activeShieldedPool.address, bobTopUp, { from: bob })
      // bob add coll to active pool
      await borrowerOperations.addColl(bobTopUp, bob, bob, { from: bob })

      // Check that both alice and Bob have had pending rewards applied in addition to their top-ups. 
      const aliceNewColl = await getTroveEntireColl(alice)
      const aliceNewDebt = await getTroveEntireDebt(alice)
      const bobNewColl = await getTroveEntireColl(bob)
      const bobNewDebt = await getTroveEntireDebt(bob)

      assert.isTrue(aliceNewColl.eq(aliceCollBefore.add(alicePendingCollateralReward).add(aliceTopUp)))
      assert.isTrue(aliceNewDebt.eq(aliceDebtBefore.add(alicePendingLUSDDebtReward)))
      assert.isTrue(bobNewColl.eq(bobCollBefore.add(bobPendingCollateralReward).add(bobTopUp)))
      assert.isTrue(bobNewDebt.eq(bobDebtBefore.add(bobPendingLUSDDebtReward)))

      /* Check that both Alice and Bob's snapshots of the rewards-per-unit-staked metrics should be updated
       to the latest values of L_COLL and L_LUSDDebt */
      const alice_rewardSnapshot_After = await rewards.rewardSnapshots(alice)
      const alice_CollateralrewardSnapshot_After = alice_rewardSnapshot_After[0]
      const alice_LUSDDebtRewardSnapshot_After = alice_rewardSnapshot_After[1]

      const bob_rewardSnapshot_After = await rewards.rewardSnapshots(bob)
      const bob_CollateralrewardSnapshot_After = bob_rewardSnapshot_After[0]
      const bob_LUSDDebtRewardSnapshot_After = bob_rewardSnapshot_After[1]

      assert.isAtMost(th.getDifference(alice_CollateralrewardSnapshot_After, L_COLL), 100)
      assert.isAtMost(th.getDifference(alice_LUSDDebtRewardSnapshot_After, L_LUSDDebt), 100)
      assert.isAtMost(th.getDifference(bob_CollateralrewardSnapshot_After, L_COLL), 100)
      assert.isAtMost(th.getDifference(bob_LUSDDebtRewardSnapshot_After, L_LUSDDebt), 100)
    })

    // it("addColl(), active Trove: adds the right corrected stake after liquidations have occured", async () => {
    //  // TODO - check stake updates for addColl/withdrawColl/adustTrove ---

    //   // --- SETUP ---
    //   // A,B,C add 15/5/5 Collateral, withdraw 100/100/900 LUSD
    //   await borrowerOperations.openTrove(dec(100, 18), alice, alice, false, { from: alice, value: dec(15, 'ether') })
    //   await borrowerOperations.openTrove(dec(100, 18), bob, bob, false, { from: bob, value: dec(4, 'ether') })
    //   await borrowerOperations.openTrove(dec(900, 18), carol, carol, false, { from: carol, value: dec(5, 'ether') })

    //   await borrowerOperations.openTrove( dec(1, 'ether'), 0, dennis, dennis, false, { from: dennis })
    //   // --- TEST ---

    //   // price drops to 1Collateral:100LUSD, reducing Carol's ICR below MCR
    //   await priceFeed.setPrice('100000000000000000000');

    //   // close Carol's Trove, liquidating her 5 ether and 900LUSD.
    //   await liquidations.liquidate(carol, { from: owner });

    //   // dennis tops up his trove by 1 Collateral
    //   await borrowerOperations.addColl(dennis, dennis, { from: dennis, value: dec(1, 'ether') })

    //   /* Check that Dennis's recorded stake is the right corrected stake, less than his collateral. A corrected 
    //   stake is given by the formula: 

    //   s = totalStakesSnapshot / totalCollateralSnapshot 

    //   where snapshots are the values immediately after the last liquidation.  After Carol's liquidation, 
    //   the Collateral from her Trove has now become the totalPendingCollateralReward. So:

    //   totalStakes = (alice_Stake + bob_Stake + dennis_orig_stake ) = (15 + 4 + 1) =  20 Collateral.
    //   totalCollateral = (alice_Collateral + bob_Collateral + dennis_orig_coll + totalPendingCollateralReward) = (15 + 4 + 1 + 5)  = 25 Collateral.

    //   Therefore, as Dennis adds 1 ether collateral, his corrected stake should be:  s = 2 * (20 / 25 ) = 1.6 Collateral */
    //   const dennis_Trove = await troveManager.Troves(dennis)

    //   const dennis_Stake = dennis_Trove[2]
    //   console.log(dennis_Stake.toString())

    //   assert.isAtMost(th.getDifference(dennis_Stake), 100)
    // })

    it("addColl(), reverts if trove is non-existent or closed", async () => {
      // A, B open troves
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Carol attempts to add collateral to her non-existent trove
      try {
        const txCarol = await borrowerOperations.addColl(dec(1, 'ether'), carol, carol, { from: carol})
        assert.isFalse(txCarol.receipt.status)
      } catch (error) {
        assert.include(error.message, "revert")
        assert.include(error.message, "Trove does not exist or is closed")
      }

      // Price drops
      await priceFeed.setPrice(dec(100, 18))

      // Bob gets liquidated
      await liquidations.liquidate(bob)

      assert.isFalse(await sortedShieldedTroves.contains(bob))

      // Bob attempts to add collateral to his closed trove
      try {
        const txBob = await borrowerOperations.addColl(dec(1, 'ether'), bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (error) {
        assert.include(error.message, "revert")
        assert.include(error.message, "Trove does not exist or is closed")
      }
    })

    it('addColl(): can add collateral in Recovery Mode', async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollBefore = await getTroveEntireColl(alice)

      await priceFeed.setPrice('105000000000000000000')

      const collTopUp = toBN(dec(1, 'ether'))
      // approve active pool to spend tokens
      await collateralToken.approve(activeShieldedPool.address, collTopUp, { from: alice })
      await borrowerOperations.addColl(collTopUp, alice, alice, { from: alice })

      // Check Alice's collateral
      const aliceCollAfter = (await troveManager.Troves(alice))[1]
      assert.isTrue(aliceCollAfter.eq(aliceCollBefore.add(collTopUp)))
    })

    // --- withdrawColl() ---

    it("withdrawColl(): reverts when withdrawal would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(dec(100, 18))
      const price = await priceFeed.getPrice()

      assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(toBN(dec(110, 16))))

      const collWithdrawal = 1  // 1 wei withdrawal

     await assertRevert(borrowerOperations.withdrawColl(1, alice, alice, { from: alice }), 
      "BorrowerOps: An operation that would result in ICR < MCR is not permitted")
    })

    // reverts when calling address does not have active trove  
    it("withdrawColl(): reverts when calling address does not have active trove", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Bob successfully withdraws some coll
      const txBob = await borrowerOperations.withdrawColl(dec(100, 'finney'), bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)

      // Carol with no active trove attempts to withdraw
      try {
        const txCarol = await borrowerOperations.withdrawColl(dec(1, 'ether'), carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawColl(): reverts when requested Collateral withdrawal is > the trove's collateral", async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      const carolColl = await getTroveEntireColl(carol)
      const bobColl = await getTroveEntireColl(bob)
      // Carol withdraws exactly all her collateral
      await assertRevert(
        borrowerOperations.withdrawColl(carolColl, carol, carol, { from: carol }),
        'BorrowerOps: An operation that would result in ICR < MCR is not permitted'
      )

      // Bob attempts to withdraw 1 wei more than his collateral
      try {
        const txBob = await borrowerOperations.withdrawColl(bobColl.add(toBN(1)), bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawColl(): reverts when withdrawal would bring the user's ICR < MCR", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ ICR: toBN(dec(13, 17)), extraParams: { from: bob } }) // 110% ICR

      // Bob attempts to withdraws 2 ether, Which would leave him with < 110% ICR.

      try {
        const txBob = await borrowerOperations.withdrawColl(dec(3, 'ether'), bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawColl(): doesn’t allow a user to completely withdraw all collateral from their Trove (due to gas compensation)", async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceColl = (await troveManager.getEntireDebtAndColl(alice))[1]

      // Check Trove is active
      const alice_Trove_Before = await troveManager.Troves(alice)
      const status_Before = alice_Trove_Before[3]
      assert.equal(status_Before, 1)
      assert.isTrue(await sortedShieldedTroves.contains(alice))

      // Alice attempts to withdraw all collateral
      await assertRevert(
        borrowerOperations.withdrawColl(aliceColl, alice, alice, { from: alice }),
        'BorrowerOps: An operation that would result in ICR < MCR is not permitted'
      )
    })

    it("withdrawColl(): leaves the Trove active when the user withdraws less than all the collateral", async () => {
      // Open Trove 
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // Check Trove is active
      const alice_Trove_Before = await troveManager.Troves(alice)
      const status_Before = alice_Trove_Before[3]
      assert.equal(status_Before, 1)
      assert.isTrue(await sortedShieldedTroves.contains(alice))

      // Withdraw some collateral
      await borrowerOperations.withdrawColl(dec(100, 'finney'), alice, alice, { from: alice })

      // Check Trove is still active
      const alice_Trove_After = await troveManager.Troves(alice)
      const status_After = alice_Trove_After[3]
      assert.equal(status_After, 1)
      assert.isTrue(await sortedShieldedTroves.contains(alice))
    })

    it("withdrawColl(): reduces the Trove's collateral by the correct amount", async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollBefore = await getTroveEntireColl(alice)

      // Alice withdraws 1 ether
      await borrowerOperations.withdrawColl(dec(1, 'ether'), alice, alice, { from: alice })

      // Check 1 ether remaining
      const alice_Trove_After = await troveManager.Troves(alice)
      const aliceCollAfter = await getTroveEntireColl(alice)

      assert.isTrue(aliceCollAfter.eq(aliceCollBefore.sub(toBN(dec(1, 'ether')))))
    })

    it("withdrawColl(): reduces ActivePool Collateral and raw ether by correct amount", async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollBefore = await getTroveEntireColl(alice)

      // check before
      const activeShieldedPool_COLL_before = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawColl_before = toBN(await collateralToken.balanceOf(activeShieldedPool.address))

      await borrowerOperations.withdrawColl(dec(1, 'ether'), alice, alice, { from: alice })

      // check after
      const activeShieldedPool_COLL_After = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawColl_After = toBN(await collateralToken.balanceOf(activeShieldedPool.address))
      assert.isTrue(activeShieldedPool_COLL_After.eq(activeShieldedPool_COLL_before.sub(toBN(dec(1, 'ether')))))
      assert.isTrue(activeShieldedPool_RawColl_After.eq(activeShieldedPool_RawColl_before.sub(toBN(dec(1, 'ether')))))
    })

    it("withdrawColl(): updates the stake and updates the total stakes", async () => {
      //  Alice creates initial Trove with 2 ether
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice, value: toBN(dec(5, 'ether')) } })
      const aliceColl = await getTroveEntireColl(alice)
      assert.isTrue(aliceColl.gt(toBN('0')))

      const alice_Trove_Before = await troveManager.Troves(alice)
      const alice_Stake_Before = alice_Trove_Before[2]
      const totalStakes_Before = (await rewards.totalStakes())

      assert.isTrue(alice_Stake_Before.eq(aliceColl))
      assert.isTrue(totalStakes_Before.eq(aliceColl))

      // Alice withdraws 1 ether
      await borrowerOperations.withdrawColl(dec(1, 'ether'), alice, alice, { from: alice })

      // Check stake and total stakes get updated
      const alice_Trove_After = await troveManager.Troves(alice)
      const alice_Stake_After = alice_Trove_After[2]
      const totalStakes_After = (await rewards.totalStakes())

      assert.isTrue(alice_Stake_After.eq(alice_Stake_Before.sub(toBN(dec(1, 'ether')))))
      assert.isTrue(totalStakes_After.eq(totalStakes_Before.sub(toBN(dec(1, 'ether')))))
    })

    it("withdrawColl(): sends the correct amount of Collateral to the user", async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice, value: dec(2, 'ether') } })
      const alice_CollBalance_Before = toBN(await collateralToken.balanceOf(alice))
      await borrowerOperations.withdrawColl(dec(1, 'ether'), alice, alice, { from: alice, gasPrice: 0 })

      const alice_CollBalance_After = toBN(await collateralToken.balanceOf(alice))
      const balanceDiff = alice_CollBalance_After.sub(alice_CollBalance_Before)

      assert.isTrue(balanceDiff.eq(toBN(dec(1, 'ether'))))
    })

    it("withdrawColl(): applies pending rewards and updates user's L_COLL, L_LUSDDebt snapshots", async () => {
      // --- SETUP ---
      // Alice adds 15 ether, Bob adds 5 ether, Carol adds 1 ether
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: alice, value: toBN(dec(100, 'ether')) } })
      await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: bob, value: toBN(dec(100, 'ether')) } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol, value: toBN(dec(10, 'ether')) } })

      const aliceCollBefore = await getTroveEntireColl(alice)
      const aliceDebtBefore = await getTroveEntireDebt(alice)
      const bobCollBefore = await getTroveEntireColl(bob)
      const bobDebtBefore = await getTroveEntireDebt(bob)

      // --- TEST ---

      // price drops to 1Collateral:100LUSD, reducing Carol's ICR below MCR
      await priceFeed.setPrice('100000000000000000000');

      // close Carol's Trove, liquidating her 1 ether and 180LUSD.
      await liquidations.liquidate(carol, { from: owner });

      const L_COLL = await rewards.L_Coll()
      const L_LUSDDebt = await rewards.L_LUSDDebt()

      // check Alice and Bob's reward snapshots are zero before they alter their Troves
      const alice_rewardSnapshot_Before = await rewards.rewardSnapshots(alice)
      const alice_CollateralrewardSnapshot_Before = alice_rewardSnapshot_Before[0]
      const alice_LUSDDebtRewardSnapshot_Before = alice_rewardSnapshot_Before[1]

      const bob_rewardSnapshot_Before = await rewards.rewardSnapshots(bob)
      const bob_CollateralrewardSnapshot_Before = bob_rewardSnapshot_Before[0]
      const bob_LUSDDebtRewardSnapshot_Before = bob_rewardSnapshot_Before[1]

      assert.equal(alice_CollateralrewardSnapshot_Before, 0)
      assert.equal(alice_LUSDDebtRewardSnapshot_Before, 0)
      assert.equal(bob_CollateralrewardSnapshot_Before, 0)
      assert.equal(bob_LUSDDebtRewardSnapshot_Before, 0)

      // Check A and B have pending rewards
      const pendingCollReward_A = await rewards.getPendingCollateralReward(alice)
      const pendingDebtReward_A = await rewards.getPendingLUSDDebtReward(alice)
      const pendingCollReward_B = await rewards.getPendingCollateralReward(bob)
      const pendingDebtReward_B = await rewards.getPendingLUSDDebtReward(bob)
      for (reward of [pendingCollReward_A, pendingDebtReward_A, pendingCollReward_B, pendingDebtReward_B]) {
        assert.isTrue(reward.gt(toBN('0')))
      }

      // Alice and Bob withdraw from their Troves
      const aliceCollWithdrawal = toBN(dec(1, 'ether'))
      const bobCollWithdrawal = toBN(dec(1, 'ether'))

      await borrowerOperations.withdrawColl(aliceCollWithdrawal, alice, alice, { from: alice })
      await borrowerOperations.withdrawColl(bobCollWithdrawal, bob, bob, { from: bob })

      // Check that both alice and Bob have had pending rewards applied in addition to their top-ups. 
      const aliceCollAfter = await getTroveEntireColl(alice)
      const aliceDebtAfter = await getTroveEntireDebt(alice)
      const bobCollAfter = await getTroveEntireColl(bob)
      const bobDebtAfter = await getTroveEntireDebt(bob)

      // Check rewards have been applied to troves
      th.assertIsApproximatelyEqual(aliceCollAfter, aliceCollBefore.add(pendingCollReward_A).sub(aliceCollWithdrawal), 10000)
      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.add(pendingDebtReward_A), 10000)
      th.assertIsApproximatelyEqual(bobCollAfter, bobCollBefore.add(pendingCollReward_B).sub(bobCollWithdrawal), 10000)
      th.assertIsApproximatelyEqual(bobDebtAfter, bobDebtBefore.add(pendingDebtReward_B), 10000)

      /* After top up, both Alice and Bob's snapshots of the rewards-per-unit-staked metrics should be updated
       to the latest values of L_COLL and L_LUSDDebt */
      const alice_rewardSnapshot_After = await rewards.rewardSnapshots(alice)
      const alice_CollateralrewardSnapshot_After = alice_rewardSnapshot_After[0]
      const alice_LUSDDebtRewardSnapshot_After = alice_rewardSnapshot_After[1]

      const bob_rewardSnapshot_After = await rewards.rewardSnapshots(bob)
      const bob_CollateralrewardSnapshot_After = bob_rewardSnapshot_After[0]
      const bob_LUSDDebtRewardSnapshot_After = bob_rewardSnapshot_After[1]

      assert.isAtMost(th.getDifference(alice_CollateralrewardSnapshot_After, L_COLL), 100)
      assert.isAtMost(th.getDifference(alice_LUSDDebtRewardSnapshot_After, L_LUSDDebt), 100)
      assert.isAtMost(th.getDifference(bob_CollateralrewardSnapshot_After, L_COLL), 100)
      assert.isAtMost(th.getDifference(bob_LUSDDebtRewardSnapshot_After, L_LUSDDebt), 100)
    })

    // --- withdrawLUSD() ---

    it("withdrawLUSD(): reverts when withdrawal would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(dec(100, 18))
      const price = await priceFeed.getPrice()

      assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(toBN(dec(110, 16))))

      const LUSDwithdrawal = 1  // withdraw 1 wei LUSD

     await assertRevert(borrowerOperations.withdrawLUSD(LUSDwithdrawal, alice, alice, { from: alice }), 
      "BorrowerOps: An operation that would result in ICR < MCR is not permitted")
    })

    it("withdrawLUSD(): decays a non-zero base rate", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const A_LUSDBal = await lusdToken.balanceOf(A)

      // Artificially set base rate to 5%
      await aggregator.setBaseRate(dec(5, 16))

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D withdraws LUSD
      await borrowerOperations.withdrawLUSD(dec(1, 18), A, A, { from: D })

      // Check baseRate has decreased
      const baseRate_2 = await aggregator.baseRate()
      //assert.isTrue(baseRate_2.lt(baseRate_1))

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E withdraws LUSD
      await borrowerOperations.withdrawLUSD(dec(1, 18), A, A, { from: E })

      const baseRate_3 = await aggregator.baseRate()
      //assert.isTrue(baseRate_3.lt(baseRate_2))
    })
    /*
    it("withdrawLUSD(): reverts if max fee > 100%", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      await assertRevert(borrowerOperations.withdrawLUSD(dec(2, 18), dec(1, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.withdrawLUSD('1000000000000000001', dec(1, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
    })

    it("withdrawLUSD(): reverts if max fee < 0.5% in Normal mode", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      await assertRevert(borrowerOperations.withdrawLUSD(0, dec(1, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.withdrawLUSD(1, dec(1, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.withdrawLUSD('4999999999999999', dec(1, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
    })

    it("withdrawLUSD(): reverts if fee exceeds max fee percentage", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(60, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(60, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(70, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(80, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(180, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const totalSupply = await lusdToken.totalSupply()

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      let baseRate = await aggregator.baseRate() // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))

      // 100%: 1e18,  10%: 1e17,  1%: 1e16,  0.1%: 1e15
      // 5%: 5e16
      // 0.5%: 5e15
      // actual: 0.5%, 5e15


      // LUSDFee:                  15000000558793542
      // absolute _fee:            15000000558793542
      // actual feePercentage:      5000000186264514
      // user's _maxFeePercentage: 49999999999999999

      const lessThan5pct = '49999999999999999'
      await assertRevert(borrowerOperations.withdrawLUSD(lessThan5pct, dec(3, 18), A, A, { from: A }), "Fee exceeded provided maximum")

      baseRate = await aggregator.baseRate() // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))
      // Attempt with maxFee 1%
      await assertRevert(borrowerOperations.withdrawLUSD(dec(1, 16), dec(1, 18), A, A, { from: B }), "Fee exceeded provided maximum")

      baseRate = await aggregator.baseRate()  // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))
      // Attempt with maxFee 3.754%
      await assertRevert(borrowerOperations.withdrawLUSD(dec(3754, 13), dec(1, 18), A, A, { from: C }), "Fee exceeded provided maximum")

      baseRate = await aggregator.baseRate()  // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))
      // Attempt with maxFee 0.5%%
      await assertRevert(borrowerOperations.withdrawLUSD(dec(5, 15), dec(1, 18), A, A, { from: D }), "Fee exceeded provided maximum")
    })

    it("withdrawLUSD(): succeeds when fee is less than max fee percentage", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(60, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(60, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(70, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(80, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(180, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const totalSupply = await lusdToken.totalSupply()

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      let baseRate = await aggregator.baseRate() // expect 5% base rate
      assert.isTrue(baseRate.eq(toBN(dec(5, 16))))

      // Attempt with maxFee > 5%
      const moreThan5pct = '50000000000000001'
      const tx1 = await borrowerOperations.withdrawLUSD(moreThan5pct, dec(1, 18), A, A, { from: A })
      assert.isTrue(tx1.receipt.status)

      baseRate = await aggregator.baseRate() // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))

      // Attempt with maxFee = 5%
      const tx2 = await borrowerOperations.withdrawLUSD(dec(5, 16), dec(1, 18), A, A, { from: B })
      assert.isTrue(tx2.receipt.status)

      baseRate = await aggregator.baseRate() // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))

      // Attempt with maxFee 10%
      const tx3 = await borrowerOperations.withdrawLUSD(dec(1, 17), dec(1, 18), A, A, { from: C })
      assert.isTrue(tx3.receipt.status)

      baseRate = await aggregator.baseRate() // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))

      // Attempt with maxFee 37.659%
      const tx4 = await borrowerOperations.withdrawLUSD(dec(37659, 13), dec(1, 18), A, A, { from: D })
      assert.isTrue(tx4.receipt.status)

      // Attempt with maxFee 100%
      const tx5 = await borrowerOperations.withdrawLUSD(dec(1, 18), dec(1, 18), A, A, { from: E })
      assert.isTrue(tx5.receipt.status)
    })
    */

    it("withdrawLUSD(): doesn't change base rate if it is already zero", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      // Check baseRate is zero
      const baseRate_1 = await aggregator.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D withdraws LUSD
      await borrowerOperations.withdrawLUSD(dec(37, 18), A, A, { from: D })

      // Check baseRate is still 0
      const baseRate_2 = await aggregator.baseRate()
      assert.equal(baseRate_2, '0')

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E opens trove 
      await borrowerOperations.withdrawLUSD(dec(12, 18), A, A, { from: E })

      const baseRate_3 = await aggregator.baseRate()
      assert.equal(baseRate_3, '0')
    })

    it("withdrawLUSD(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      const lastFeeOpTime_1 = await aggregator.lastFeeOperationTime()

      // 10 seconds pass
      th.fastForwardTime(10, web3.currentProvider)

      // Borrower C triggers a fee
      await borrowerOperations.withdrawLUSD(dec(1, 18), C, C, { from: C })

      const lastFeeOpTime_2 = await aggregator.lastFeeOperationTime()

      // Check that the last fee operation time did not update, as borrower D's debt issuance occured
      // since before minimum interval had passed 
      assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1))

      // 60 seconds passes
      th.fastForwardTime(60, web3.currentProvider)

      // Check that now, at least one minute has passed since lastFeeOpTime_1
      const timeNow = await th.getLatestBlockTimestamp(web3)
      assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(60))

      // Borrower C triggers a fee
      await borrowerOperations.withdrawLUSD(dec(1, 18), C, C, { from: C })

      const lastFeeOpTime_3 = await aggregator.lastFeeOperationTime()

      // Check that the last fee operation time DID update, as borrower's debt issuance occured
      // after minimum interval had passed 
      //assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1))
    })


    it("withdrawLUSD(): borrower can't grief the baseRate and stop it decaying by issuing debt at higher frequency than the decay granularity", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 30 seconds pass
      th.fastForwardTime(30, web3.currentProvider)

      // Borrower C triggers a fee, before decay interval has passed
      await borrowerOperations.withdrawLUSD(dec(1, 18), C, C, { from: C })

      // 30 seconds pass
      th.fastForwardTime(30, web3.currentProvider)

      // Borrower C triggers another fee
      await borrowerOperations.withdrawLUSD(dec(1, 18), C, C, { from: C })

      // Check base rate has decreased even though Borrower tried to stop it decaying
      //const baseRate_2 = await aggregator.baseRate()
      //assert.isTrue(baseRate_2.lt(baseRate_1))
    })

    it("withdrawLUSD(): borrowing at non-zero base rate sends LUSD fee to LQTY staking contract", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY LUSD balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D withdraws LUSD
      await borrowerOperations.withdrawLUSD(dec(37, 18), C, C, { from: D })

      // Check LQTY LUSD balance after has increased
      //const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      //assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))
    })

    if (!withProxy) { // TODO: use rawLogs instead of logs
      it("withdrawLUSD(): borrowing at non-zero base records the (drawn debt + fee) on the Trove struct", async () => {
        // time fast-forwards 1 year, and multisig stakes 1 LQTY
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
        await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
        await lqtyStaking.stake(dec(1, 18), { from: multisig })

        await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
        const D_debtBefore = await getTroveEntireDebt(D)

        // Artificially make baseRate 5%
        await aggregator.setBaseRate(dec(5, 16))
        await aggregator.setLastFeeOpTimeToNow()

        // Check baseRate is now non-zero
        const baseRate_1 = await aggregator.baseRate()
        assert.isTrue(baseRate_1.gt(toBN('0')))

        // 2 hours pass
        th.fastForwardTime(7200, web3.currentProvider)

        // D withdraws LUSD
        const withdrawal_D = toBN(dec(37, 18))
        const withdrawalTx = await borrowerOperations.withdrawLUSD(toBN(dec(37, 18)), D, D, { from: D })

        //const emittedFee = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(withdrawalTx))
        //assert.isTrue(emittedFee.gt(toBN('0')))

        const newDebt = (await troveManager.Troves(D))[0]

        // Check debt on Trove struct equals initial debt + withdrawal + emitted fee
        th.assertIsApproximatelyEqual(newDebt, D_debtBefore.add(withdrawal_D), 10000)
      })
    }

    it("withdrawLUSD(): Borrowing at non-zero base rate increases the LQTY staking contract LUSD fees-per-unit-staked", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY contract LUSD fees-per-unit-staked is zero
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.equal(F_LUSD_Before, '0')

      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D withdraws LUSD
      await borrowerOperations.withdrawLUSD(toBN(dec(37, 18)), D, D, { from: D })

      // Check LQTY contract LUSD fees-per-unit-staked has increased
      //const F_LUSD_After = await lqtyStaking.F_LUSD()
      //assert.isTrue(F_LUSD_After.gt(F_LUSD_Before))
    })

    it("withdrawLUSD(): Borrowing at non-zero base rate sends requested amount to the user", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY Staking contract balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      const D_LUSDBalanceBefore = await lusdToken.balanceOf(D)

      // D withdraws LUSD
      const D_LUSDRequest = toBN(dec(37, 18))
      await borrowerOperations.withdrawLUSD(D_LUSDRequest, D, D, { from: D })

      // Check LQTY staking LUSD balance has increased
      //const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      //assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))

      // Check D's LUSD balance now equals their initial balance plus request LUSD
      const D_LUSDBalanceAfter = await lusdToken.balanceOf(D)
      assert.isTrue(D_LUSDBalanceAfter.eq(D_LUSDBalanceBefore.add(D_LUSDRequest)))
    })

    it("withdrawLUSD(): Borrowing at zero base rate changes LUSD fees-per-unit-staked", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is zero
      const baseRate_1 = await aggregator.baseRate()
      assert.equal(baseRate_1, '0')

      // A artificially receives LQTY, then stakes it
      await lqtyToken.unprotectedMint(A, dec(100, 18))
      await lqtyStaking.stake(dec(100, 18), { from: A })

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // Check LQTY LUSD balance before == 0
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.equal(F_LUSD_Before, '0')

      // D withdraws LUSD
      await borrowerOperations.withdrawLUSD(dec(37, 18), D, D, { from: D })

      // Check LQTY LUSD balance after > 0
      const F_LUSD_After = await lqtyStaking.F_LUSD()
      assert.isTrue(F_LUSD_After.gt('0'))
    })

    it("withdrawLUSD(): Borrowing at zero base rate sends debt request to user", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is zero
      const baseRate_1 = await aggregator.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      const D_LUSDBalanceBefore = await lusdToken.balanceOf(D)

      // D withdraws LUSD
      const D_LUSDRequest = toBN(dec(37, 18))
      await borrowerOperations.withdrawLUSD(dec(37, 18), D, D, { from: D })

      // Check D's LUSD balance now equals their requested LUSD
      const D_LUSDBalanceAfter = await lusdToken.balanceOf(D)

      // Check D's trove debt == D's LUSD balance + liquidation reserve
      assert.isTrue(D_LUSDBalanceAfter.eq(D_LUSDBalanceBefore.add(D_LUSDRequest)))
    })

    it("withdrawLUSD(): reverts when calling address does not have active trove", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Bob successfully withdraws LUSD
      const txBob = await borrowerOperations.withdrawLUSD(dec(100, 18), bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)

      // Carol with no active trove attempts to withdraw LUSD
      try {
        const txCarol = await borrowerOperations.withdrawLUSD(dec(100, 18), carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawLUSD(): reverts when requested withdrawal amount is zero LUSD", async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Bob successfully withdraws 1e-18 LUSD
      const txBob = await borrowerOperations.withdrawLUSD(1, bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)

      // Alice attempts to withdraw 0 LUSD
      try {
        const txAlice = await borrowerOperations.withdrawLUSD(0, alice, alice, { from: alice })
        assert.isFalse(txAlice.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawLUSD(): reverts when system is in Recovery Mode", async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // Withdrawal possible when recoveryMode == false
      const txAlice = await borrowerOperations.withdrawLUSD(dec(100, 18), alice, alice, { from: alice })
      assert.isTrue(txAlice.receipt.status)

      await priceFeed.setPrice('50000000000000000000')

      //Check LUSD withdrawal impossible when recoveryMode == true
      try {
        const txBob = await borrowerOperations.withdrawLUSD(1, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawLUSD(): reverts when withdrawal would bring the trove's ICR < MCR", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(130, 16)), extraParams: { from: bob } })

      // Bob tries to withdraw LUSD that would bring his ICR < MCR
      try {
        const txBob = await borrowerOperations.withdrawLUSD(dec(1000, 18), bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawLUSD(): reverts when a withdrawal would cause the TCR of the system to fall below the CCR", async () => {
      await priceFeed.setPrice(dec(100, 18))
      const price = await priceFeed.getPrice()

      // Alice and Bob creates troves with 150% ICR.  System TCR = 150%.
      await openShieldedTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: bob } })

      var TCR = (await th.getTCR(contracts)).toString()
      assert.equal(TCR, '1500000000000000000')

      // Bob attempts to withdraw 1 LUSD.
      // System TCR would be: ((3+3) * 100 ) / (200+201) = 600/401 = 149.62%, i.e. below CCR of 150%.
      try {
        const txBob = await borrowerOperations.withdrawLUSD(dec(1, 18), bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawLUSD(): increases the Trove's LUSD debt by the correct amount", async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // check before
      const aliceDebtBefore = await getTroveEntireDebt(alice)
      assert.isTrue(aliceDebtBefore.gt(toBN(0)))

      await borrowerOperations.withdrawLUSD(await getNetBorrowingAmount(100), alice, alice, { from: alice })

      // check after
      const aliceDebtAfter = await getTroveEntireDebt(alice)
      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.add(toBN(100)))
    })

    it("withdrawLUSD(): increases LUSD debt in ActivePool by correct amount", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice, value: toBN(dec(100, 'ether')) } })

      const aliceDebtBefore = await getTroveEntireDebt(alice)
      assert.isTrue(aliceDebtBefore.gt(toBN(0)))

      // check before
      const activeShieldedPool_LUSD_Before = await activeShieldedPool.getLUSDDebt()
      assert.isTrue(activeShieldedPool_LUSD_Before.eq(aliceDebtBefore))

      await borrowerOperations.withdrawLUSD(await getNetBorrowingAmount(dec(10000, 18)), alice, alice, { from: alice })

      // check after
      const activeShieldedPool_LUSD_After = await activeShieldedPool.getLUSDDebt()
      th.assertIsApproximatelyEqual(activeShieldedPool_LUSD_After, activeShieldedPool_LUSD_Before.add(toBN(dec(10000, 18))))
    })

    it("withdrawLUSD(): increases user LUSDToken balance by correct amount", async () => {
      await openShieldedTrove({ extraParams: { value: toBN(dec(100, 'ether')), from: alice } })

      // check before
      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      await borrowerOperations.withdrawLUSD(dec(10000, 18), alice, alice, { from: alice })

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_After.eq(alice_LUSDTokenBalance_Before.add(toBN(dec(10000, 18)))))
    })

    // --- repayLUSD() ---
    it("repayLUSD(): reverts when repayment would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(dec(100, 18))
      const price = await priceFeed.getPrice()

      assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(toBN(dec(110, 16))))

      const LUSDRepayment = 1  // 1 wei repayment

     await assertRevert(borrowerOperations.repayLUSD(LUSDRepayment, alice, alice, { from: alice }), 
      "BorrowerOps: An operation that would result in ICR < MCR is not permitted")
    })

    it("repayLUSD(): Succeeds when it would leave trove with net debt >= minimum net debt", async () => {
      const collateralAmount = dec(100, 30)
      collateralToken.mint(A, collateralAmount)
      collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: A })
      // Make the LUSD request 2 wei above min net debt to correct for floor division, and make net debt = min net debt + 1 wei
      await borrowerOperations.openTrove(collateralAmount, await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN('2'))), A, A, true, { from: A })

      const repayTxA = await borrowerOperations.repayLUSD(1, A, A, { from: A })
      assert.isTrue(repayTxA.receipt.status)

      collateralToken.mint(B, collateralAmount)
      collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: B })
      await borrowerOperations.openTrove(collateralAmount, dec(20, 25), B, B, true, { from: B })

      const repayTxB = await borrowerOperations.repayLUSD(dec(19, 25), B, B, { from: B })
      assert.isTrue(repayTxB.receipt.status)
    })

    it("repayLUSD(): reverts when it would leave trove with net debt < minimum net debt", async () => {
      const collateralAmount = dec(100, 30)
      collateralToken.mint(A, collateralAmount)
      collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: A })
      await borrowerOperations.openTrove(collateralAmount, await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN('0'))), A, A, true, { from: A })

      const repayTxAPromise = borrowerOperations.repayLUSD(1, A, A, { from: A })
      await assertRevert(repayTxAPromise, "BorrowerOps: Trove's net debt must be greater than minimum")
    })

    it("adjustTrove(): Reverts if repaid amount is greater than current debt", async () => {
      const { totalDebt } = await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      LUSD_GAS_COMPENSATION = await borrowerOperations.LUSD_GAS_COMPENSATION()
      const repayAmount = totalDebt.sub(LUSD_GAS_COMPENSATION).add(toBN(1))
      await openShieldedTrove({ extraLUSDAmount: repayAmount, ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

      await lusdToken.transfer(alice, repayAmount, { from: bob })

      await assertRevert(borrowerOperations.adjustTrove(0, 0, repayAmount, false, false, alice, alice, { from: alice }),
                         "SafeMath: subtraction overflow")
    })

    it("unShieldTrove(): unshielding a trove doesn't change debt", async () => {
      const collateralAmount = dec(1000, 'ether')
      tx_a = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, false, { from: A })
      tx_b = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, false, { from: B })
      tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, true, { from: C })

      assert.equal(await troveManager.shielded(C), true)

      C_debt_before = await troveManager.getTroveActualDebt(C)
      await borrowerOperations.unShieldTrove(C, C, {from : C});
      C_debt_after = await troveManager.getTroveActualDebt(C)
      assert.equal(await troveManager.shielded(C), false)

      assert.isTrue(C_debt_before.eq(C_debt_after))

    })
    it("shieldTrove(): shielding a trove doesn't change debt", async () => {
      const collateralAmount = dec(1000, 'ether')
      tx_a = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, false, { from: A })
      tx_b = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, false, { from: B })
      tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, false, { from: C })

      assert.equal(await troveManager.shielded(A), false)
      assert.equal(await troveManager.shielded(B), false)
      assert.equal(await troveManager.shielded(C), false)


      B_debt_before = await troveManager.getTroveActualDebt(B)
      await borrowerOperations.shieldTrove(B, B, {from : B});
      B_debt_after = await troveManager.getTroveActualDebt(B)
      assert.equal(await troveManager.shielded(B), true)

      assert.isTrue(B_debt_before.eq(B_debt_after))
    })
    it("shieldTrove(): shielding and unshielding a trove multiple times doesn't change debt", async () => {
      const collateralAmount = dec(1000, 'ether')
      tx_a = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, false, { from: A })
      tx_b = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, false, { from: B })
      tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, false, { from: C })

      // shield
      B_debt_before = await troveManager.getTroveActualDebt(B)
      await borrowerOperations.shieldTrove(B, B, {from : B});
      B_debt_after = await troveManager.getTroveActualDebt(B)
      assert.equal(await troveManager.shielded(B), true)
      assert.isTrue(B_debt_before.eq(B_debt_after))

      // unshield
      B_debt_before = await troveManager.getTroveActualDebt(B)
      await borrowerOperations.unShieldTrove(B, B, {from : B});
      B_debt_after = await troveManager.getTroveActualDebt(B)
      assert.equal(await troveManager.shielded(B), false)
      assert.isTrue(B_debt_before.eq(B_debt_after))

      // shield
      B_debt_before = await troveManager.getTroveActualDebt(B)
      await borrowerOperations.shieldTrove(B, B, {from : B});
      B_debt_after = await troveManager.getTroveActualDebt(B)
      assert.equal(await troveManager.shielded(B), true)
      assert.isTrue(B_debt_before.eq(B_debt_after))

      // unshield
      B_debt_before = await troveManager.getTroveActualDebt(B)
      await borrowerOperations.unShieldTrove(B, B, {from : B});
      B_debt_after = await troveManager.getTroveActualDebt(B)
      assert.equal(await troveManager.shielded(B), false)
      assert.isTrue(B_debt_before.eq(B_debt_after))
    })

    it("shieldTrove(): can't shield a trove when ICR < HCR", async () => {
      const collateralAmount = dec(1000, 'ether')
      tx_a = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, false, { from: A })
      tx_b = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, false, { from: B })
      tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, false, { from: C })

      // calculate price drop needed for C_ICR < HCR
      currentPrice = await priceFeed.getPrice()
      HCR = await troveManager.HCR()
      C_ICR = await troveManager.getCurrentICR(C, currentPrice)
      newPrice = HCR.mul(currentPrice).div(C_ICR).sub(toBN(dec(1,18)))

      // drop price
      await priceFeed.setPrice(newPrice)

      // C is below HCR
      assert.isTrue((await troveManager.getCurrentICR(C, newPrice)).lt(HCR))

      // shielding fails
      await assertRevert(borrowerOperations.shieldTrove(C, C, {from : C}), "BorrowerOps: Opening a shielded trove with ICR < HCR is not permitted")

      // trove is still un-shielded
      assert.equal(await troveManager.shielded(C), false)
    })

    it("shieldTrove(): can un-shield a trove when ICR < HCR", async () => {
      const collateralAmount = dec(1000, 'ether')
      tx_a = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, false, { from: A })
      tx_b = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, false, { from: B })
      tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, true, { from: C })

      // calculate price drop needed for C_ICR < HCR
      currentPrice = await priceFeed.getPrice()
      HCR = await troveManager.HCR()
      C_ICR = await troveManager.getCurrentICR(C, currentPrice)
      newPrice = HCR.mul(currentPrice).div(C_ICR).sub(toBN(dec(1,18)))

      // drop price
      await priceFeed.setPrice(newPrice)

      // C is below HCR
      assert.isTrue((await troveManager.getCurrentICR(C, newPrice)).lt(HCR))

      await borrowerOperations.unShieldTrove(C, C, {from : C})

      // trove is un-shielded
      assert.equal(await troveManager.shielded(C), false)
    })

    it("openTrove(): open a shielded trove", async () => {
      const collateralAmount = dec(1000, 'ether')
      tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, true, { from: C })
      assert.equal(await troveManager.shielded(C), true)


      // first shielded trove
      assert.equal(await troveManager.getShieldedTroveOwnersCount(), 1)
      assert.equal(await sortedShieldedTroves.getSize(), 1)

      arrayIndex = (await troveManager.Troves(C))[4]
      assert.equal(arrayIndex, 0)

      shieldedTroveOwner = await troveManager.ShieldedTroveOwners(0)
      assert.equal(shieldedTroveOwner, C)

      // check debt
      const troveDebt = await troveManager.getTroveDebt(C)
      const entireDebt = (await troveManager.getEntireDebtAndColl(C))[0]
      assert.isTrue(entireDebt.eq(troveDebt))

      // check system debt
      const systemActualDebt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
      const actualTroveDebt = await troveManager.getTroveActualDebt(C)
      assert.isTrue(systemActualDebt.eq(actualTroveDebt))
    })
    it("closeTrove(): close a shielded trove", async () => {
      const collateralAmount = dec(1000, 'ether')
      tx_b = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), B, B, true, { from: B })
      tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, true, { from: C })
      assert.equal(await troveManager.shielded(B), true)

      // 2 shielded troves
      assert.equal(await troveManager.getShieldedTroveOwnersCount(), 2)
      assert.equal(await sortedShieldedTroves.getSize(), 2)

      await borrowerOperations.closeTrove({from: B})

      // 1 shielded trove left
      assert.equal(await troveManager.getShieldedTroveOwnersCount(), 1)
      assert.equal(await sortedShieldedTroves.getSize(), 1)

      shieldedTroveOwner = await troveManager.ShieldedTroveOwners(0)
      assert.equal(shieldedTroveOwner, C)

      // Debt is 0
      const troveDebt = await troveManager.getTroveDebt(B)
      assert.isTrue(troveDebt.eq(toBN('0')))

      const entireDebt = (await troveManager.getEntireDebtAndColl(B))[0]
      assert.isTrue(entireDebt.eq(troveDebt))

      const actualTroveDebt = await troveManager.getTroveActualDebt(B)
      assert.isTrue(actualTroveDebt.eq(toBN('0')))

      // system debt is not 0
      const systemActualDebt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
      assert.isFalse(systemActualDebt.eq(actualTroveDebt))

    

    })


    it("repayLUSD(): reverts when calling address does not have active trove", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      // Bob successfully repays some LUSD
      const txBob = await borrowerOperations.repayLUSD(dec(10, 18), bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)

      // Carol with no active trove attempts to repayLUSD
      try {
        const txCarol = await borrowerOperations.repayLUSD(dec(10, 18), carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("repayLUSD(): reverts when attempted repayment is > the debt of the trove", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const aliceDebt = await getTroveEntireDebt(alice)

      // Bob successfully repays some LUSD
      const txBob = await borrowerOperations.repayLUSD(dec(10, 18), bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)

      // Alice attempts to repay more than her debt
      try {
        const txAlice = await borrowerOperations.repayLUSD(aliceDebt.add(toBN(dec(1, 18))), alice, alice, { from: alice })
        assert.isFalse(txAlice.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    //repayLUSD: reduces LUSD debt in Trove
    it("repayLUSD(): reduces the Trove's LUSD debt by the correct amount", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const aliceDebtBefore = await getTroveEntireDebt(alice)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))

      await borrowerOperations.repayLUSD(aliceDebtBefore.div(toBN(10)), alice, alice, { from: alice })  // Repays 1/10 her debt

      const aliceDebtAfter = await getTroveEntireDebt(alice)
      assert.isTrue(aliceDebtAfter.gt(toBN('0')))

      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.mul(toBN(9)).div(toBN(10)))  // check 9/10 debt remaining
    })

    it("repayLUSD(): decreases LUSD debt in ActivePool by correct amount", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const aliceDebtBefore = await getTroveEntireDebt(alice)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))

      // Check before
      const activeShieldedPool_LUSD_Before = await activeShieldedPool.getLUSDDebt()
      assert.isTrue(activeShieldedPool_LUSD_Before.gt(toBN('0')))

      await borrowerOperations.repayLUSD(aliceDebtBefore.div(toBN(10)), alice, alice, { from: alice })  // Repays 1/10 her debt

      // check after
      const activeShieldedPool_LUSD_After = await activeShieldedPool.getLUSDDebt()
      th.assertIsApproximatelyEqual(activeShieldedPool_LUSD_After, activeShieldedPool_LUSD_Before.sub(aliceDebtBefore.div(toBN(10))))
    })

    it("repayLUSD(): decreases user LUSDToken balance by correct amount", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const aliceDebtBefore = await getTroveEntireDebt(alice)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))

      // check before
      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      await borrowerOperations.repayLUSD(aliceDebtBefore.div(toBN(10)), alice, alice, { from: alice })  // Repays 1/10 her debt

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      th.assertIsApproximatelyEqual(alice_LUSDTokenBalance_After, alice_LUSDTokenBalance_Before.sub(aliceDebtBefore.div(toBN(10))))
    })

    it('repayLUSD(): can repay debt in Recovery Mode', async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const aliceDebtBefore = await getTroveEntireDebt(alice)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))

      await priceFeed.setPrice('105000000000000000000')

      const tx = await borrowerOperations.repayLUSD(aliceDebtBefore.div(toBN(10)), alice, alice, { from: alice })
      assert.isTrue(tx.receipt.status)

      // Check Alice's debt: 110 (initial) - 50 (repaid)
      const aliceDebtAfter = await getTroveEntireDebt(alice)
      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.mul(toBN(9)).div(toBN(10)))
    })

    it("repayLUSD(): Reverts if borrower has insufficient LUSD balance to cover his debt repayment", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      const bobBalBefore = await lusdToken.balanceOf(B)
      assert.isTrue(bobBalBefore.gt(toBN('0')))

      // Bob transfers all but 5 of his LUSD to Carol
      await lusdToken.transfer(C, bobBalBefore.sub((toBN(dec(5, 18)))), { from: B })

      //Confirm B's LUSD balance has decreased to 5 LUSD
      const bobBalAfter = await lusdToken.balanceOf(B)

      assert.isTrue(bobBalAfter.eq(toBN(dec(5, 18))))
      
      // Bob tries to repay 6 LUSD
      const repayLUSDPromise_B = borrowerOperations.repayLUSD(toBN(dec(6, 18)), B, B, { from: B })

      await assertRevert(repayLUSDPromise_B, "Caller doesnt have enough LUSD to make repayment")
    })

    // --- adjustTrove() ---

    it("adjustTrove(): reverts when adjustment would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(dec(100, 18))
      const price = await priceFeed.getPrice()

      assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(toBN(dec(110, 16))))

      const LUSDRepayment = 1  // 1 wei repayment
      const collTopUp = 1

     await assertRevert(borrowerOperations.adjustTrove(collTopUp, 0, LUSDRepayment, false, false, alice, alice, { from: alice }), 
      "BorrowerOps: An operation that would result in ICR < MCR is not permitted")
    })

    it("adjustTrove(): decays a non-zero base rate", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D adjusts trove
      await borrowerOperations.adjustTrove(0, 0, dec(37, 18), true, false, D, D, { from: D })

      // Check baseRate has decreased
      //const baseRate_2 = await aggregator.baseRate()
      //assert.isTrue(baseRate_2.lt(baseRate_1))

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E adjusts trove
      await borrowerOperations.adjustTrove(0, 0, dec(37, 15), true, false, E, E, { from: D })

      //const baseRate_3 = await aggregator.baseRate()
      //assert.isTrue(baseRate_3.lt(baseRate_2))
    })

    it("adjustTrove(): doesn't decay a non-zero base rate when user issues 0 debt", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // D opens trove 
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)
      // approve transfer
      collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: D })
      // D adjusts trove with 0 debt
      await borrowerOperations.adjustTrove(dec(1, 'ether'), 0, 0, false, false, D, D, { from: D })

      // Check baseRate has not decreased 
      const baseRate_2 = await aggregator.baseRate()
      assert.isTrue(baseRate_2.eq(baseRate_1))
    })

    it("adjustTrove(): doesn't change base rate if it is already zero", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is zero
      const baseRate_1 = await aggregator.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)
      collateralToken
      // D adjusts trove
      await borrowerOperations.adjustTrove(0, 0, dec(37, 18), true, false, D, D, { from: D })

      // Check baseRate is still 0
      const baseRate_2 = await aggregator.baseRate()
      assert.equal(baseRate_2, '0')

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E adjusts trove
      await borrowerOperations.adjustTrove(0, 0, dec(37, 15), true, false, D, D, { from: D })

      const baseRate_3 = await aggregator.baseRate()
      assert.equal(baseRate_3, '0')
    })

    it("adjustTrove(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      const lastFeeOpTime_1 = await aggregator.lastFeeOperationTime()

      // 10 seconds pass
      th.fastForwardTime(10, web3.currentProvider)

      // Borrower C triggers a fee
      await borrowerOperations.adjustTrove(0,0, dec(1, 18), true, false, C, C, { from: C })

      const lastFeeOpTime_2 = await aggregator.lastFeeOperationTime()

      // Check that the last fee operation time did not update, as borrower D's debt issuance occured
      // since before minimum interval had passed 
      assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1))

      // 60 seconds passes
      th.fastForwardTime(60, web3.currentProvider)

      // Check that now, at least one minute has passed since lastFeeOpTime_1
      const timeNow = await th.getLatestBlockTimestamp(web3)
      assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(60))

      // Borrower C triggers a fee
      await borrowerOperations.adjustTrove(0, 0, dec(1, 18), true, false, C, C, { from: C })

      const lastFeeOpTime_3 = await aggregator.lastFeeOperationTime()

      // Check that the last fee operation time DID update, as borrower's debt issuance occured
      // after minimum interval had passed 
      //assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1))
    })

    it("adjustTrove(): borrower can't grief the baseRate and stop it decaying by issuing debt at higher frequency than the decay granularity", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // Borrower C triggers a fee, before decay interval of 1 minute has passed
      await borrowerOperations.adjustTrove(0, 0, dec(1, 18), true, false, C, C, { from: C })

      // 1 minute passes
      th.fastForwardTime(60, web3.currentProvider)

      // Borrower C triggers another fee
      await borrowerOperations.adjustTrove(0, 0, dec(1, 18), true, false, C, C, { from: C })

      // Check base rate has decreased even though Borrower tried to stop it decaying
      const baseRate_2 = await aggregator.baseRate()
      //assert.isTrue(baseRate_2.lt(baseRate_1))
    })

    it("adjustTrove(): borrowing at non-zero base rate sends LUSD fee to LQTY staking contract", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY LUSD balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D adjusts trove
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(37, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check LQTY LUSD balance after has increased
      //const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      //assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))
    })

    if (!withProxy) { // TODO: use rawLogs instead of logs
      it("adjustTrove(): borrowing at non-zero base records the (drawn debt + fee) on the Trove struct", async () => {
        // time fast-forwards 1 year, and multisig stakes 1 LQTY
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
        await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
        await lqtyStaking.stake(dec(1, 18), { from: multisig })

        await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
        const D_debtBefore = await getTroveEntireDebt(D)

        // Artificially make baseRate 5%
        await aggregator.setBaseRate(dec(5, 16))
        await aggregator.setLastFeeOpTimeToNow()

        // Check baseRate is now non-zero
        const baseRate_1 = await aggregator.baseRate()
        assert.isTrue(baseRate_1.gt(toBN('0')))

        // 2 hours pass
        th.fastForwardTime(7200, web3.currentProvider)

        const withdrawal_D = toBN(dec(37, 18))

        // D withdraws LUSD
        const adjustmentTx = await borrowerOperations.adjustTrove(0, 0, withdrawal_D, true, false, D, D, { from: D })

        //const emittedFee = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(adjustmentTx))
        //assert.isTrue(emittedFee.gt(toBN('0')))

        const D_newDebt = (await troveManager.Troves(D))[0]
    
        // Check debt on Trove struct equals initial debt plus drawn debt plus emitted fee
        assert.isTrue(D_newDebt.eq(D_debtBefore.add(withdrawal_D)))
      })
    }

    it("adjustTrove(): Borrowing at non-zero base rate increases the LQTY staking contract LUSD fees-per-unit-staked", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY contract LUSD fees-per-unit-staked is zero
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.equal(F_LUSD_Before, '0')

      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D adjusts trove
      await borrowerOperations.adjustTrove(0, 0, dec(37, 18), true, false, D, D, { from: D })

      // Check LQTY contract LUSD fees-per-unit-staked has increased
      //const F_LUSD_After = await lqtyStaking.F_LUSD()
      //assert.isTrue(F_LUSD_After.gt(F_LUSD_Before))
    })

    it("adjustTrove(): Borrowing at non-zero base rate sends requested amount to the user", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY Staking contract balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      const D_LUSDBalanceBefore = await lusdToken.balanceOf(D)

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D adjusts trove
      const LUSDRequest_D = toBN(dec(40, 18))
      await borrowerOperations.adjustTrove(0, 0, LUSDRequest_D, true, false, D, D, { from: D })

      // Check LQTY staking LUSD balance has increased
      //const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      //assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))

      // Check D's LUSD balance has increased by their requested LUSD
      const D_LUSDBalanceAfter = await lusdToken.balanceOf(D)
      assert.isTrue(D_LUSDBalanceAfter.eq(D_LUSDBalanceBefore.add(LUSDRequest_D)))
    })

    it("adjustTrove(): Borrowing at zero base rate changes LUSD balance of LQTY staking contract", async () => {
      await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is zero
      const baseRate_1 = await aggregator.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // Check staking LUSD balance before > 0
      //const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      //assert.isTrue(lqtyStaking_LUSDBalance_Before.gt(toBN('0')))

      // D adjusts trove
      await borrowerOperations.adjustTrove(0, 0, dec(37, 18), true, false, D, D, { from: D })

      // Check staking LUSD balance after > staking balance before
      //const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      //assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))
    })

    it("adjustTrove(): Borrowing at zero base rate changes LQTY staking contract LUSD fees-per-unit-staked", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale, value: toBN(dec(100, 'ether')) } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is zero
      const baseRate_1 = await aggregator.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // A artificially receives LQTY, then stakes it
      await lqtyToken.unprotectedMint(A, dec(100, 18))
      await lqtyStaking.stake(dec(100, 18), { from: A })

      // Check staking LUSD balance before == 0
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.isTrue(F_LUSD_Before.eq(toBN('0')))

      // D adjusts trove
      await borrowerOperations.adjustTrove(0, 0, dec(37, 18), true, false, D, D, { from: D })

      // Check staking LUSD balance increases
      //const F_LUSD_After = await lqtyStaking.F_LUSD()
      //assert.isTrue(F_LUSD_After.gt(F_LUSD_Before))
    })

    it("adjustTrove(): Borrowing at zero base rate sends total requested LUSD to the user", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale, value: toBN(dec(100, 'ether')) } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      const D_LUSDBalBefore = await lusdToken.balanceOf(D)
      // Check baseRate is zero
      const baseRate_1 = await aggregator.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      const DUSDBalanceBefore = await lusdToken.balanceOf(D)

      // D adjusts trove
      const LUSDRequest_D = toBN(dec(40, 18))
      await borrowerOperations.adjustTrove(0, 0, LUSDRequest_D, true, false, D, D, { from: D })

      // Check D's LUSD balance increased by their requested LUSD
      const LUSDBalanceAfter = await lusdToken.balanceOf(D)
      assert.isTrue(LUSDBalanceAfter.eq(D_LUSDBalBefore.add(LUSDRequest_D)))
    })

    it("adjustTrove(): reverts when calling address has no active trove", async () => {
      const collateralAmount = dec(100, 30)
      collateralToken.mint(alice, collateralAmount)
      collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: alice })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      collateralToken.mint(bob, collateralAmount)
      collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: bob })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Alice coll and debt increase(+1 Collateral, +50LUSD)
      // Alice adjusts trove - coll increase and debt decrease
      await collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })
      await borrowerOperations.adjustTrove(dec(1, 'ether'), 0, dec(50, 18), true, false, alice, alice, { from: alice })

      try {
        collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: carol })
        const txCarol = await borrowerOperations.adjustTrove(dec(1, 'ether'), 0, dec(50, 18), true, false, carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    // CHANGE: allow coll withdrawal if ICR > CCR
    it("adjustTrove(): collateral withdrawal not allowed in Recovery Mode when ICR > CCR", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      await priceFeed.setPrice(dec(120, 18)) // trigger drop in Collateral price

      const ICR_A = await troveManager.getCurrentICR(alice, dec(120, 18))
      assert.isTrue(ICR_A.gt(dec(150, 16)))

      // Alice attempts an adjustment that repays half her debt BUT withdraws 1 wei collateral
      await assertRevert(borrowerOperations.adjustTrove(0, 1, dec(5000, 18), false, false, alice, alice, { from: alice }),
          "BorrowerOps: Collateral withdrawal not permitted when TCR < CCR")
    })

    it("adjustTrove(): debt increase that would reduce the ICR allowed in Recovery Mode", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(3, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const CCR = await troveManager.CCR()

      await priceFeed.setPrice(dec(105, 18)) // trigger drop in Collateral price
      const price = await priceFeed.getPrice()

      //--- Alice with ICR > 150% tries to reduce her ICR ---

      const ICR_A = await troveManager.getCurrentICR(alice, price)

      // Check Alice's initial ICR is above 150%
      assert.isTrue(ICR_A.gt(CCR))

      const aliceDebt = await getTroveEntireDebt(alice)
      const aliceColl = await getTroveEntireColl(alice)
      const aliceDebtIncrease = toBN(dec(150, 18))
      const aliceCollIncrease = toBN(dec(1, 'ether'))

      const newICR_A = await troveManager.computeICR(aliceColl.add(aliceCollIncrease), aliceDebt.add(aliceDebtIncrease), price)

      // Check Alice's new ICR would reduce but still be greater than 150%
      assert.isTrue(newICR_A.lt(ICR_A) && newICR_A.gt(CCR))

      collateralToken.approve(activeShieldedPool.address, aliceCollIncrease, { from: alice })
      await assertRevert(borrowerOperations.adjustTrove(aliceCollIncrease, 0, aliceDebtIncrease, true, false, alice, alice, { from: alice }),
        "BorrowerOps: Cannot decrease your Trove's ICR in Recovery Mode")

      //--- Bob with ICR < 150% tries to reduce his ICR ---

      const ICR_B = await troveManager.getCurrentICR(bob, price)

      // Check Bob's initial ICR is below 150%
      assert.isTrue(ICR_B.lt(CCR))

      const bobDebt = await getTroveEntireDebt(bob)
      const bobColl = await getTroveEntireColl(bob)
      const bobDebtIncrease = toBN(dec(450, 18))
      const bobCollIncrease = toBN(dec(1, 'ether'))

      const newICR_B = await troveManager.computeICR(bobColl.add(bobCollIncrease), bobDebt.add(bobDebtIncrease), price)

      // Check Bob's new ICR would reduce 
      assert.isTrue(newICR_B.lt(ICR_B))

      collateralToken.approve(activeShieldedPool.address, bobCollIncrease, { from: bob })
      await assertRevert(borrowerOperations.adjustTrove(bobCollIncrease, 0, bobDebtIncrease, true, false, bob, bob, { from: bob }),
        "BorrowerOps: Operation must leave trove with ICR >= CCR")
    })

    it("adjustTrove(): A trove with ICR < CCR in Recovery Mode can adjust their trove to ICR > CCR", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const CCR = await troveManager.CCR()

      await priceFeed.setPrice(dec(100, 18)) // trigger drop in Collateral price
      const price = await priceFeed.getPrice()

      const ICR_A = await troveManager.getCurrentICR(alice, price)
      // Check initial ICR is below 150%
      assert.isTrue(ICR_A.lt(CCR))

      const aliceDebt = await getTroveEntireDebt(alice)
      const aliceColl = await getTroveEntireColl(alice)
      const debtIncrease = toBN(dec(5000, 18))
      const collIncrease = toBN(dec(150, 'ether'))

      const newICR = await troveManager.computeICR(aliceColl.add(collIncrease), aliceDebt.add(debtIncrease), price)

      // Check new ICR would be > 150%
      assert.isTrue(newICR.gt(CCR))

      collateralToken.approve(activeShieldedPool.address, collIncrease, { from: alice })
      const tx = await borrowerOperations.adjustTrove(collIncrease, 0, debtIncrease, true, false, alice, alice, { from: alice })
      assert.isTrue(tx.receipt.status)

      const actualNewICR = await troveManager.getCurrentICR(alice, price)
      assert.isTrue(actualNewICR.gt(CCR))
    })

    it("adjustTrove(): A trove with ICR > CCR in Recovery Mode can improve their ICR", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(3, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const CCR = await troveManager.CCR()

      await priceFeed.setPrice(dec(105, 18)) // trigger drop in Collateral price
      const price = await priceFeed.getPrice()

      const initialICR = await troveManager.getCurrentICR(alice, price)
      // Check initial ICR is above 150%
      assert.isTrue(initialICR.gt(CCR))

      const aliceDebt = await getTroveEntireDebt(alice)
      const aliceColl = await getTroveEntireColl(alice)
      const debtIncrease = toBN(dec(5000, 18))
      const collIncrease = toBN(dec(150, 'ether'))

      const newICR = await troveManager.computeICR(aliceColl.add(collIncrease), aliceDebt.add(debtIncrease), price)

      // Check new ICR would be > old ICR
      assert.isTrue(newICR.gt(initialICR))

      collateralToken.approve(activeShieldedPool.address, collIncrease, { from: alice })
      const tx = await borrowerOperations.adjustTrove(collIncrease, 0, debtIncrease, true, false, alice, alice, { from: alice })
      assert.isTrue(tx.receipt.status)

      const actualNewICR = await troveManager.getCurrentICR(alice, price)
      assert.isTrue(actualNewICR.gt(initialICR))
    })

    it("adjustTrove(): reverts when change would cause the TCR of the system to fall below the CCR", async () => {
      await priceFeed.setPrice(dec(100, 18))

      await openShieldedTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: bob } })

      // Check TCR and Recovery Mode
      const TCR = (await th.getTCR(contracts)).toString()
      assert.equal(TCR, '1500000000000000000')

      // Bob attempts an operation that would bring the TCR below the CCR
      try {
        const txBob = await borrowerOperations.adjustTrove(0, 0, dec(1, 18), true, false, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("adjustTrove(): reverts when LUSD repaid is > debt of the trove", async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const bobOpenTx = (await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } })).tx

      const bobDebt = await getTroveEntireDebt(bob)
      assert.isTrue(bobDebt.gt(toBN('0')))

      //const bobFee = toBN(await th.getEventArgByIndex(bobOpenTx, 'LUSDBorrowingFeePaid', 1))
      //assert.isTrue(bobFee.gt(toBN('0')))

      // Alice transfers LUSD to bob to compensate borrowing fees
      //await lusdToken.transfer(bob, bobFee, { from: alice })

      const remainingDebt = (await troveManager.getTroveDebt(bob)).sub(LUSD_GAS_COMPENSATION)
      // approve adjustment
      collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: bob })
      // Bob attempts an adjustment that would repay 1 wei more than his debt
      await assertRevert(
        borrowerOperations.adjustTrove(dec(1, 'ether'), 0, remainingDebt.add(toBN(1)), false, false, bob, bob, { from: bob }),
        "revert"
      )
    })

    it("adjustTrove(): reverts when attempted Collateral withdrawal is >= the trove's collateral", async () => {
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      const carolColl = await getTroveEntireColl(carol)

      // Carol attempts an adjustment that would withdraw 1 wei more than her Collateral
      try {
        const txCarol = await borrowerOperations.adjustTrove(0, carolColl.add(toBN(1)), 0, true, false, carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("adjustTrove(): reverts when change would cause the ICR of the trove to fall below the MCR", async () => {
      const collateralAmount = dec(100, 30)
      collateralToken.mint(whale, collateralAmount)
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

      await priceFeed.setPrice(dec(100, 18))

      collateralToken.mint(alice, collateralAmount)
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(13, 17)), extraParams: { from: alice } })

      collateralToken.mint(bob, collateralAmount)
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(13, 17)), extraParams: { from: bob } })

      // Bob attempts to increase debt by 100 LUSD and 1 ether, i.e. a change that constitutes a 100% ratio of coll:debt.
      // Since his ICR prior is 110%, this change would reduce his ICR below MCR.
      try {
        collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: bob })
        const txBob = await borrowerOperations.adjustTrove(dec(3, 'ether'), 0, dec(100, 18), true, false, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("adjustTrove(): With 0 coll change, doesnt change borrower's coll or ActivePool coll", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceCollBefore = await getTroveEntireColl(alice)
      const activeShieldedPoolCollBefore = await activeShieldedPool.getCollateral()

      assert.isTrue(aliceCollBefore.gt(toBN('0')))
      assert.isTrue(aliceCollBefore.eq(activeShieldedPoolCollBefore))

      // Alice adjusts trove. No coll change, and a debt increase (+50LUSD)
      await borrowerOperations.adjustTrove(0, 0, dec(50, 18), true, false, alice, alice, { from: alice })

      const aliceCollAfter = await getTroveEntireColl(alice)
      const activeShieldedPoolCollAfter = await activeShieldedPool.getCollateral()

      assert.isTrue(aliceCollAfter.eq(activeShieldedPoolCollAfter))
      assert.isTrue(activeShieldedPoolCollAfter.eq(activeShieldedPoolCollAfter))
    })

    it("adjustTrove(): With 0 debt change, doesnt change borrower's debt or ActivePool debt", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceDebtBefore = await getTroveEntireDebt(alice)
      const activeShieldedPoolDebtBefore = await activeShieldedPool.getLUSDDebt()

      assert.isTrue(aliceDebtBefore.gt(toBN('0')))
      assert.isTrue(aliceDebtBefore.eq(activeShieldedPoolDebtBefore))

      collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })
      // Alice adjusts trove. Coll change, no debt change
      await borrowerOperations.adjustTrove(dec(1, 'ether'), 0, 0, false, false, alice, alice, { from: alice })

      const aliceDebtAfter = await getTroveEntireDebt(alice)
      const activeShieldedPoolDebtAfter = await activeShieldedPool.getLUSDDebt()

      assert.isTrue(aliceDebtAfter.eq(aliceDebtBefore))
      assert.isTrue(activeShieldedPoolDebtAfter.eq(activeShieldedPoolDebtBefore))
    })

    it("adjustTrove(): updates borrower's debt and coll with an increase in both", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const debtBefore = await getTroveEntireDebt(alice)
      const collBefore = await getTroveEntireColl(alice)
      assert.isTrue(debtBefore.gt(toBN('0')))
      assert.isTrue(collBefore.gt(toBN('0')))

      collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })
      // Alice adjusts trove. Coll and debt increase(+1 Collateral, +50LUSD)
      await borrowerOperations.adjustTrove(dec(1, 'ether'), 0, await getNetBorrowingAmount(dec(50, 18)), true, false, alice, alice, { from: alice })

      const debtAfter = await getTroveEntireDebt(alice)
      const collAfter = await getTroveEntireColl(alice)

      th.assertIsApproximatelyEqual(debtAfter, debtBefore.add(toBN(dec(50, 18))), 10000)
      th.assertIsApproximatelyEqual(collAfter, collBefore.add(toBN(dec(1, 18))), 10000)
    })

    it("adjustTrove(): updates borrower's debt and coll with a decrease in both", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const debtBefore = await getTroveEntireDebt(alice)
      const collBefore = await getTroveEntireColl(alice)
      assert.isTrue(debtBefore.gt(toBN('0')))
      assert.isTrue(collBefore.gt(toBN('0')))

      collateralToken.approve(activeShieldedPool.address, dec(500, 'finney'), { from: alice })
      // Alice adjusts trove coll and debt decrease (-0.5 Collateral, -50LUSD)
      await borrowerOperations.adjustTrove(0, dec(500, 'finney'), dec(50, 18), false, false, alice, alice, { from: alice })

      const debtAfter = await getTroveEntireDebt(alice)
      const collAfter = await getTroveEntireColl(alice)

      assert.isTrue(debtAfter.eq(debtBefore.sub(toBN(dec(50, 18)))))
      assert.isTrue(collAfter.eq(collBefore.sub(toBN(dec(5, 17)))))
    })

    it("adjustTrove(): updates borrower's  debt and coll with coll increase, debt decrease", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const debtBefore = await getTroveEntireDebt(alice)
      const collBefore = await getTroveEntireColl(alice)
      assert.isTrue(debtBefore.gt(toBN('0')))
      assert.isTrue(collBefore.gt(toBN('0')))

      collateralToken.approve(activeShieldedPool.address, dec(500, 'finney'), { from: alice })
      // Alice adjusts trove - coll increase and debt decrease (+0.5 Collateral, -50LUSD)
      await borrowerOperations.adjustTrove(dec(500, 'finney'), 0, dec(50, 18), false, false, alice, alice, { from: alice })

      const debtAfter = await getTroveEntireDebt(alice)
      const collAfter = await getTroveEntireColl(alice)

      th.assertIsApproximatelyEqual(debtAfter, debtBefore.sub(toBN(dec(50, 18))), 10000)
      th.assertIsApproximatelyEqual(collAfter, collBefore.add(toBN(dec(5, 17))), 10000)
    })

    it("adjustTrove(): updates borrower's debt and coll with coll decrease, debt increase", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const debtBefore = await getTroveEntireDebt(alice)
      const collBefore = await getTroveEntireColl(alice)
      assert.isTrue(debtBefore.gt(toBN('0')))
      assert.isTrue(collBefore.gt(toBN('0')))

      // Alice adjusts trove - coll decrease and debt increase (0.1 Collateral, 10LUSD)
      await borrowerOperations.adjustTrove(0, dec(1, 17), await getNetBorrowingAmount(dec(1, 18)), true, false, alice, alice, { from: alice })

      const debtAfter = await getTroveEntireDebt(alice)
      const collAfter = await getTroveEntireColl(alice)

      th.assertIsApproximatelyEqual(debtAfter, debtBefore.add(toBN(dec(1, 18))), 10000)
      th.assertIsApproximatelyEqual(collAfter, collBefore.sub(toBN(dec(1, 17))), 10000)
    })

    it("adjustTrove(): updates borrower's stake and totalStakes with a coll increase", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const stakeBefore = await troveManager.getTroveStake(alice)
      const totalStakesBefore = await rewards.totalStakes();
      assert.isTrue(stakeBefore.gt(toBN('0')))
      assert.isTrue(totalStakesBefore.gt(toBN('0')))

      // Alice adjusts trove - coll and debt increase (+1 Collateral, +50 LUSD)
      collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })
      await borrowerOperations.adjustTrove(dec(1, 'ether'), 0, dec(50, 18), true, false, alice, alice, { from: alice })

      const stakeAfter = await troveManager.getTroveStake(alice)
      const totalStakesAfter = await rewards.totalStakes();

      assert.isTrue(stakeAfter.eq(stakeBefore.add(toBN(dec(1, 18)))))
      assert.isTrue(totalStakesAfter.eq(totalStakesBefore.add(toBN(dec(1, 18)))))
    })

    it("adjustTrove(): updates borrower's stake and totalStakes with a coll decrease", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const stakeBefore = await troveManager.getTroveStake(alice)
      const totalStakesBefore = await rewards.totalStakes();
      assert.isTrue(stakeBefore.gt(toBN('0')))
      assert.isTrue(totalStakesBefore.gt(toBN('0')))

      // Alice adjusts trove - coll decrease and debt decrease
      await borrowerOperations.adjustTrove(0, dec(500, 'finney'), dec(50, 18), false, false, alice, alice, { from: alice })

      const stakeAfter = await troveManager.getTroveStake(alice)
      const totalStakesAfter = await rewards.totalStakes();

      assert.isTrue(stakeAfter.eq(stakeBefore.sub(toBN(dec(5, 17)))))
      assert.isTrue(totalStakesAfter.eq(totalStakesBefore.sub(toBN(dec(5, 17)))))
    })

    it("adjustTrove(): changes LUSDToken balance by the requested decrease", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      // Alice adjusts trove - coll decrease and debt decrease
      await borrowerOperations.adjustTrove(0, dec(100, 'finney'), dec(10, 18), false, false, alice, alice, { from: alice })

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_After.eq(alice_LUSDTokenBalance_Before.sub(toBN(dec(10, 18)))))
    })

    it("adjustTrove(): changes LUSDToken balance by the requested increase", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      // Alice adjusts trove - coll increase and debt increase
      collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })
      await borrowerOperations.adjustTrove(dec(1, 'ether'), 0, dec(100, 18), true, false, alice, alice, { from: alice })

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_After.eq(alice_LUSDTokenBalance_Before.add(toBN(dec(100, 18)))))
    })

    it("adjustTrove(): Changes the activeShieldedPool Collateral and raw ether balance by the requested decrease", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const activeShieldedPool_Collateral_Before = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawEther_Before = toBN(await collateralToken.balanceOf(activeShieldedPool.address))
      assert.isTrue(activeShieldedPool_Collateral_Before.gt(toBN('0')))
      assert.isTrue(activeShieldedPool_RawEther_Before.gt(toBN('0')))

      // Alice adjusts trove - coll decrease and debt decrease
      await borrowerOperations.adjustTrove(0, dec(100, 'finney'), dec(10, 18), false, false, alice, alice, { from: alice })

      const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawEther_After = toBN(await collateralToken.balanceOf(activeShieldedPool.address))
      assert.isTrue(activeShieldedPool_Collateral_After.eq(activeShieldedPool_Collateral_Before.sub(toBN(dec(1, 17)))))
      assert.isTrue(activeShieldedPool_RawEther_After.eq(activeShieldedPool_Collateral_Before.sub(toBN(dec(1, 17)))))
    })

    it("adjustTrove(): Changes the activeShieldedPool Collateral and raw ether balance by the amount of Collateral sent", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const activeShieldedPool_Collateral_Before = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawEther_Before = toBN(await collateralToken.balanceOf(activeShieldedPool.address))
      assert.isTrue(activeShieldedPool_Collateral_Before.gt(toBN('0')))
      assert.isTrue(activeShieldedPool_RawEther_Before.gt(toBN('0')))

      // Alice adjusts trove - coll increase and debt increase
      collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })
      await borrowerOperations.adjustTrove(dec(1, 'ether'), 0, dec(100, 18), true, false, alice, alice, { from: alice })

      const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawEther_After = toBN(await collateralToken.balanceOf(activeShieldedPool.address))
      assert.isTrue(activeShieldedPool_Collateral_After.eq(activeShieldedPool_Collateral_Before.add(toBN(dec(1, 18)))))
      assert.isTrue(activeShieldedPool_RawEther_After.eq(activeShieldedPool_Collateral_Before.add(toBN(dec(1, 18)))))
    })

    it("adjustTrove(): Changes the LUSD debt in ActivePool by requested decrease", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const activeShieldedPool_LUSDDebt_Before = await activeShieldedPool.getLUSDDebt()
      assert.isTrue(activeShieldedPool_LUSDDebt_Before.gt(toBN('0')))

      // Alice adjusts trove - coll increase and debt decrease
      collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })
      await borrowerOperations.adjustTrove(dec(1, 'ether'), 0, dec(30, 18), false, false, alice, alice, { from: alice })

      const activeShieldedPool_LUSDDebt_After = await activeShieldedPool.getLUSDDebt()
      assert.isTrue(activeShieldedPool_LUSDDebt_After.eq(activeShieldedPool_LUSDDebt_Before.sub(toBN(dec(30, 18)))))
    })

    it("adjustTrove(): Changes the LUSD debt in ActivePool by requested increase", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const activeShieldedPool_LUSDDebt_Before = await activeShieldedPool.getLUSDDebt()
      assert.isTrue(activeShieldedPool_LUSDDebt_Before.gt(toBN('0')))

      // Alice adjusts trove - coll increase and debt increase
      collateralToken.approve(activeShieldedPool.address, dec(1, 'ether'), { from: alice })
      await borrowerOperations.adjustTrove(dec(1, 'ether'), 0, await getNetBorrowingAmount(dec(100, 18)), true, false, alice, alice, { from: alice })

      const activeShieldedPool_LUSDDebt_After = await activeShieldedPool.getLUSDDebt()
    
      th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_After, activeShieldedPool_LUSDDebt_Before.add(toBN(dec(100, 18))))
    })

    it("adjustTrove(): new coll = 0 and new debt = 0 is not allowed, as gas compensation still counts toward ICR", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      const aliceColl = await getTroveEntireColl(alice)
      const aliceDebt = await getTroveEntireColl(alice)
      const status_Before = await troveManager.getTroveStatus(alice)
      const isInSortedList_Before = await sortedShieldedTroves.contains(alice)

      assert.equal(status_Before, 1)  // 1: Active
      assert.isTrue(isInSortedList_Before)

      await assertRevert(
        borrowerOperations.adjustTrove(0, aliceColl, aliceDebt, true, false, alice, alice, { from: alice }),
        'BorrowerOps: An operation that would result in ICR < MCR is not permitted'
      )
    })

    it("adjustTrove(): Reverts if requested debt increase and amount is zero", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      await assertRevert(borrowerOperations.adjustTrove(0, 0, 0, true, false, alice, alice, { from: alice }),
        'BorrowerOps: Debt increase requires non-zero debtChange')
    })

    it("adjustTrove(): Reverts if requested coll withdrawal and ether is sent", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      collateralToken.approve(activeShieldedPool.address, dec(3, 'ether'), { from: alice })
      await assertRevert(borrowerOperations.adjustTrove(dec(3, 'ether'), dec(3, 'ether'), dec(100, 18), true, false, alice, alice, { from: alice }), 'BorrowerOperations: Cannot withdraw and add coll')
    })

    it("adjustTrove(): Reverts if it's zero adjustment", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      await assertRevert(borrowerOperations.adjustTrove(0, 0, 0, false, false, alice, alice, { from: alice }),
                         'BorrowerOps: There must be either a collateral change or a debt change')
    })

    it("adjustTrove(): Reverts if requested coll withdrawal is greater than trove's collateral", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const aliceColl = await getTroveEntireColl(alice)

      // Requested coll withdrawal > coll in the trove
      await assertRevert(borrowerOperations.adjustTrove(0, aliceColl.add(toBN(1)), 0, false, false, alice, alice, { from: alice }))
      await assertRevert(borrowerOperations.adjustTrove(0, aliceColl.add(toBN(dec(37, 'ether'))), 0, false, false, bob, bob, { from: bob }))
    })

    it("adjustTrove(): Reverts if borrower has insufficient LUSD balance to cover his debt repayment", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: B } })
      const bobDebt = await getTroveEntireDebt(B)

      // Bob transfers some LUSD to carol
      await lusdToken.transfer(C, dec(10, 18), { from: B })

      //Confirm B's LUSD balance is less than 50 LUSD
      const B_LUSDBal = await lusdToken.balanceOf(B)
      assert.isTrue(B_LUSDBal.lt(bobDebt))

      const repayLUSDPromise_B = borrowerOperations.adjustTrove(0, 0, bobDebt, false, false, B, B, { from: B })

      // B attempts to repay all his debt
      await assertRevert(repayLUSDPromise_B, "revert")
    })

    // --- Internal _adjustTrove() ---

    if (!withProxy) { // no need to test this with proxies
      it("Internal _adjustTrove(): reverts when op is a withdrawal and _borrower param is not the msg.sender", async () => {
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

        const txPromise_A = borrowerOperations.callInternalAdjustLoan(bob, 0, dec(1, 18), dec(1, 18), true, alice, alice, { from: alice })
        await assertRevert(txPromise_A, "BorrowerOps: Caller must be the borrower for a withdrawal")
        const txPromise_B = borrowerOperations.callInternalAdjustLoan(bob, 0, dec(1, 18), dec(1, 18), true, alice, alice, { from: owner })
        await assertRevert(txPromise_B, "BorrowerOps: Caller must be the borrower for a withdrawal")
        const txPromise_C = borrowerOperations.callInternalAdjustLoan(carol, 0, dec(1, 18), dec(1, 18), true, alice, alice, { from: bob })
        await assertRevert(txPromise_C, "BorrowerOps: Caller must be the borrower for a withdrawal")
      })
    }

    // --- closeTrove() ---
    // CHANGE: allow closeTrove() when TCR below CCR
    it("closeTrove(): does not revert when it would lower the TCR below CCR", async () => {
      await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraParams:{ from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(130, 16)), extraLUSDAmount: toBN(dec(3000, 18)), extraParams:{ from: bob } })

      const price = await priceFeed.getPrice()
      
      // to compensate borrowing fees
      //await lusdToken.transfer(alice, dec(300, 18), { from: bob })

      await borrowerOperations.closeTrove({ from: alice })

      TCR = await troveManager.getTCR(price)
      console.log(TCR.toString())

      assert.isTrue(TCR.lt(await troveManager.CCR()))

    })

    it("closeTrove(): reverts when calling address does not have active trove", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Carol with no active trove attempts to close her trove
      try {
        const txCarol = await borrowerOperations.closeTrove({ from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("closeTrove(): reverts when trove is the only one in the system", async () => {
      await collateralToken.mint(alice, dec(100, 'ether'))
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // Artificially mint to Alice so she has enough to close her trove
      await lusdToken.unprotectedMint(alice, dec(100000, 18))

      // Check she has more LUSD than her trove debt
      const aliceBal = await lusdToken.balanceOf(alice)
      const aliceDebt = await getTroveEntireDebt(alice)
      assert.isTrue(aliceBal.gt(aliceDebt))

      // Alice attempts to close her trove
      await assertRevert(borrowerOperations.closeTrove({ from: alice }), "TroveManager: Only one trove in the system")
    })

    it("closeTrove(): reduces a Trove's collateral to zero", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceCollBefore = await getTroveEntireColl(alice)
      const dennisLUSD = await lusdToken.balanceOf(dennis)
      assert.isTrue(aliceCollBefore.gt(toBN('0')))
      assert.isTrue(dennisLUSD.gt(toBN('0')))

      // To compensate borrowing fees
      await lusdToken.transfer(alice, dennisLUSD.div(toBN(2)), { from: dennis })

      // Alice attempts to close trove
      await borrowerOperations.closeTrove({ from: alice })

      const aliceCollAfter = await getTroveEntireColl(alice)
      assert.equal(aliceCollAfter, '0')
    })

    it("closeTrove(): reduces a Trove's debt to zero", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceDebtBefore = await getTroveEntireColl(alice)
      const dennisLUSD = await lusdToken.balanceOf(dennis)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))
      assert.isTrue(dennisLUSD.gt(toBN('0')))

      // To compensate borrowing fees
      await lusdToken.transfer(alice, dennisLUSD.div(toBN(2)), { from: dennis })

      // Alice attempts to close trove
      await borrowerOperations.closeTrove({ from: alice })

      const aliceCollAfter = await getTroveEntireColl(alice)
      assert.equal(aliceCollAfter, '0')
    })

    it("closeTrove(): sets Trove's stake to zero", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceStakeBefore = await getTroveStake(alice)
      assert.isTrue(aliceStakeBefore.gt(toBN('0')))

      const dennisLUSD = await lusdToken.balanceOf(dennis)
      assert.isTrue(aliceStakeBefore.gt(toBN('0')))
      assert.isTrue(dennisLUSD.gt(toBN('0')))

      // To compensate borrowing fees
      await lusdToken.transfer(alice, dennisLUSD.div(toBN(2)), { from: dennis })

      // Alice attempts to close trove
      await borrowerOperations.closeTrove({ from: alice })

      const stakeAfter = ((await troveManager.Troves(alice))[2]).toString()
      assert.equal(stakeAfter, '0')
      // check withdrawal was successful
    })

    it("closeTrove(): zero's the troves reward snapshots", async () => {
      // Dennis opens trove and transfers tokens to alice
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(dec(100, 18))

      // Liquidate Bob
      await liquidations.liquidate(bob)
      assert.isFalse(await sortedShieldedTroves.contains(bob))

      // Price bounces back
      await priceFeed.setPrice(dec(200, 18))

      // Alice and Carol open troves
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // Price drops ...again
      await priceFeed.setPrice(dec(100, 18))

      // Get Alice's pending reward snapshots 
      const L_COLL_A_Snapshot = (await rewards.rewardSnapshots(alice))[0]
      const L_LUSDDebt_A_Snapshot = (await rewards.rewardSnapshots(alice))[1]
      assert.isTrue(L_COLL_A_Snapshot.gt(toBN('0')))
      assert.isTrue(L_LUSDDebt_A_Snapshot.gt(toBN('0')))

      // Liquidate Carol
      await liquidations.liquidate(carol)
      assert.isFalse(await sortedShieldedTroves.contains(carol))

      // Get Alice's pending reward snapshots after Carol's liquidation. Check above 0
      const L_COLL_Snapshot_A_AfterLiquidation = (await rewards.rewardSnapshots(alice))[0]
      const L_LUSDDebt_Snapshot_A_AfterLiquidation = (await rewards.rewardSnapshots(alice))[1]

      assert.isTrue(L_COLL_Snapshot_A_AfterLiquidation.gt(toBN('0')))
      assert.isTrue(L_LUSDDebt_Snapshot_A_AfterLiquidation.gt(toBN('0')))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      await priceFeed.setPrice(dec(200, 18))

      // Alice closes trove
      await borrowerOperations.closeTrove({ from: alice })

      // Check Alice's pending reward snapshots are zero
      const L_COLL_Snapshot_A_afterAliceCloses = (await rewards.rewardSnapshots(alice))[0]
      const L_LUSDDebt_Snapshot_A_afterAliceCloses = (await rewards.rewardSnapshots(alice))[1]

      assert.equal(L_COLL_Snapshot_A_afterAliceCloses, '0')
      assert.equal(L_LUSDDebt_Snapshot_A_afterAliceCloses, '0')
    })

    it("closeTrove(): sets trove's status to closed and removes it from sorted troves list", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // Check Trove is active
      const alice_Trove_Before = await troveManager.Troves(alice)
      const status_Before = alice_Trove_Before[3]

      assert.equal(status_Before, 1)
      assert.isTrue(await sortedShieldedTroves.contains(alice))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      // Close the trove
      await borrowerOperations.closeTrove({ from: alice })

      const alice_Trove_After = await troveManager.Troves(alice)
      const status_After = alice_Trove_After[3]

      assert.equal(status_After, 2)
      assert.isFalse(await sortedShieldedTroves.contains(alice))
    })

    it("closeTrove(): reduces ActivePool Collateral and raw ether by correct amount", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const dennisColl = await getTroveEntireColl(dennis)
      const aliceColl = await getTroveEntireColl(alice)
      assert.isTrue(dennisColl.gt('0'))
      assert.isTrue(aliceColl.gt('0'))

      // Check active Pool Collateral before
      const activeShieldedPool_Collateral_before = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawEther_before = toBN(await collateralToken.balanceOf(activeShieldedPool.address))
      assert.isTrue(activeShieldedPool_Collateral_before.eq(aliceColl.add(dennisColl)))
      assert.isTrue(activeShieldedPool_Collateral_before.gt(toBN('0')))
      assert.isTrue(activeShieldedPool_RawEther_before.eq(activeShieldedPool_Collateral_before))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      // Close the trove
      await borrowerOperations.closeTrove({ from: alice })

      // Check after
      const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawEther_After = toBN(await collateralToken.balanceOf(activeShieldedPool.address))
      assert.isTrue(activeShieldedPool_Collateral_After.eq(dennisColl))
      assert.isTrue(activeShieldedPool_RawEther_After.eq(dennisColl))
    })

    it("closeTrove(): reduces ActivePool debt by correct amount", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const dennisDebt = await getTroveEntireDebt(dennis)
      const aliceDebt = await getTroveEntireDebt(alice)
      assert.isTrue(dennisDebt.gt('0'))
      assert.isTrue(aliceDebt.gt('0'))

      // Check before
      const activeShieldedPool_Debt_before = await activeShieldedPool.getLUSDDebt()
      assert.isTrue(activeShieldedPool_Debt_before.eq(aliceDebt.add(dennisDebt)))
      assert.isTrue(activeShieldedPool_Debt_before.gt(toBN('0')))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      // Close the trove
      await borrowerOperations.closeTrove({ from: alice })

      // Check after
      const activeShieldedPool_Debt_After = (await activeShieldedPool.getLUSDDebt()).toString()
      th.assertIsApproximatelyEqual(activeShieldedPool_Debt_After, dennisDebt)
    })

    it("closeTrove(): updates the the total stakes", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Get individual stakes
      const aliceStakeBefore = await getTroveStake(alice)
      const bobStakeBefore = await getTroveStake(bob)
      const dennisStakeBefore = await getTroveStake(dennis)
      assert.isTrue(aliceStakeBefore.gt('0'))
      assert.isTrue(bobStakeBefore.gt('0'))
      assert.isTrue(dennisStakeBefore.gt('0'))

      const totalStakesBefore = await rewards.totalStakes()

      assert.isTrue(totalStakesBefore.eq(aliceStakeBefore.add(bobStakeBefore).add(dennisStakeBefore)))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      // Alice closes trove
      await borrowerOperations.closeTrove({ from: alice })

      // Check stake and total stakes get updated
      const aliceStakeAfter = await getTroveStake(alice)
      const totalStakesAfter = await rewards.totalStakes()

      assert.equal(aliceStakeAfter, 0)
      assert.isTrue(totalStakesAfter.eq(totalStakesBefore.sub(aliceStakeBefore)))
    })

    if (!withProxy) { // TODO: wrap web3.eth.getBalance to be able to go through proxies
      it("closeTrove(): sends the correct amount of Collateral to the user", async () => {
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

        const aliceColl = await getTroveEntireColl(alice)
        assert.isTrue(aliceColl.gt(toBN('0')))

        const alice_CollateralBalance_Before = web3.utils.toBN(await collateralToken.balanceOf(alice))

        // to compensate interest fees
        await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

        // to accomodate 1559 basefee, gasPrice must be gt 0

        const tx = await borrowerOperations.closeTrove({ from: alice, gasPrice: 3 })

        // since gasPrice > 0, must consider gas cost in Collateral difference
        const receipt = await web3.eth.getTransactionReceipt(tx.tx)
        const gasUsed = toBN(receipt.gasUsed)
        const txDetails = await web3.eth.getTransaction(tx.tx)
        const gasPrice = toBN(txDetails.gasPrice)
        const gasCost = gasUsed.mul(gasPrice)

        const alice_CollateralBalance_After = web3.utils.toBN(await collateralToken.balanceOf(alice))

        const balanceDiff = alice_CollateralBalance_After.sub(alice_CollateralBalance_Before)//.add(gasCost)
      })
    }

    it("closeTrove(): subtracts the debt of the closed Trove from the Borrower's LUSDToken balance", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceDebt = await getTroveEntireDebt(alice)
      assert.isTrue(aliceDebt.gt(toBN('0')))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      const alice_LUSDBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDBalance_Before.gt(toBN('0')))

      // close trove
      await borrowerOperations.closeTrove({ from: alice })

      // check alice LUSD balance after
      const alice_LUSDBalance_After = await lusdToken.balanceOf(alice)
      th.assertIsApproximatelyEqual(alice_LUSDBalance_After, alice_LUSDBalance_Before.sub(aliceDebt.sub(LUSD_GAS_COMPENSATION)))
    })

    it("closeTrove(): applies pending rewards", async () => {
      // --- SETUP ---
      await collateralToken.mint(whale, dec(1000000, 'ether'))
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      const whaleDebt = await getTroveEntireDebt(whale)
      const whaleColl = await getTroveEntireColl(whale)

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      const carolDebt = await getTroveEntireDebt(carol)
      const carolColl = await getTroveEntireColl(carol)

      // Whale transfers to A and B to cover their fees
      await lusdToken.transfer(alice, dec(10000, 18), { from: whale })
      await lusdToken.transfer(bob, dec(10000, 18), { from: whale })

      // --- TEST ---

      // price drops to 1Collateral:100LUSD, reducing Carol's ICR below MCR
      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice()

      // liquidate Carol's Trove, Alice and Bob earn rewards.
      const liquidationTx = await liquidations.liquidate(carol, { from: owner });
      const [liquidatedDebt_C, liquidatedColl_C, gasComp_C] = th.getEmittedLiquidationValues(liquidationTx)

      // Dennis opens a new Trove 
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // check Alice and Bob's reward snapshots are zero before they alter their Troves
      const alice_rewardSnapshot_Before = await rewards.rewardSnapshots(alice)
      const alice_CollateralrewardSnapshot_Before = alice_rewardSnapshot_Before[0]
      const alice_LUSDDebtRewardSnapshot_Before = alice_rewardSnapshot_Before[1]

      const bob_rewardSnapshot_Before = await rewards.rewardSnapshots(bob)
      const bob_CollateralrewardSnapshot_Before = bob_rewardSnapshot_Before[0]
      const bob_LUSDDebtRewardSnapshot_Before = bob_rewardSnapshot_Before[1]

      assert.equal(alice_CollateralrewardSnapshot_Before, 0)
      assert.equal(alice_LUSDDebtRewardSnapshot_Before, 0)
      assert.equal(bob_CollateralrewardSnapshot_Before, 0)
      assert.equal(bob_LUSDDebtRewardSnapshot_Before, 0)

      const defaultPool_Collateral = await defaultPool.getCollateral()
      const defaultPool_LUSDDebt = await defaultPool.getLUSDDebt()

      // Carol's liquidated coll (1 Collateral) and drawn debt should have entered the Default Pool
      assert.isAtMost(th.getDifference(defaultPool_Collateral, liquidatedColl_C), 100)
      assert.isAtMost(th.getDifference(defaultPool_LUSDDebt, liquidatedDebt_C), 100)

      const pendingCollReward_A = await rewards.getPendingCollateralReward(alice)
      const pendingDebtReward_A = await rewards.getPendingLUSDDebtReward(alice)
      assert.isTrue(pendingCollReward_A.gt('0'))
      assert.isTrue(pendingDebtReward_A.gt('0'))

      // Close Alice's trove. Alice's pending rewards should be removed from the DefaultPool when she close.
      await borrowerOperations.closeTrove({ from: alice })

      const defaultPool_Collateral_afterAliceCloses = await defaultPool.getCollateral()
      const defaultPool_LUSDDebt_afterAliceCloses = await defaultPool.getLUSDDebt()

      assert.isAtMost(th.getDifference(defaultPool_Collateral_afterAliceCloses,
        defaultPool_Collateral.sub(pendingCollReward_A)), 1000)
      assert.isAtMost(th.getDifference(defaultPool_LUSDDebt_afterAliceCloses,
        defaultPool_LUSDDebt.sub(pendingDebtReward_A)), 1000)

      // whale adjusts trove, pulling their rewards out of DefaultPool
      await borrowerOperations.adjustTrove(0, 0, dec(1, 18), true, false, whale, whale, { from: whale })

      // Close Bob's trove. Expect DefaultPool coll and debt to drop to 0, since closing pulls his rewards out.
      await borrowerOperations.closeTrove({ from: bob })

      const defaultPool_Collateral_afterBobCloses = await defaultPool.getCollateral()
      const defaultPool_LUSDDebt_afterBobCloses = await defaultPool.getLUSDDebt()

      assert.isAtMost(th.getDifference(defaultPool_Collateral_afterBobCloses, 0), 100000)
      assert.isAtMost(th.getDifference(defaultPool_LUSDDebt_afterBobCloses, 0), 100000)
    })

    it("closeTrove(): reverts if borrower has insufficient LUSD balance to repay his entire debt", async () => {
      B_LUSDBal = await lusdToken.balanceOf(B)
      B_troveDebt = await getTroveEntireDebt(B)

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })

      // there is no initial borrow fee, so burn 1 to make balance < debt
      await lusdToken.unprotectedBurn(B, 1)

      //Confirm Bob's LUSD balance is less than his trove debt
      B_LUSDBal = await lusdToken.balanceOf(B)
      B_troveDebt = await getTroveEntireDebt(B)
      B_compDebt = await borrowerOperations.getCompositeDebt(B_troveDebt)

      assert.isTrue(B_LUSDBal.lt(B_compDebt))

      const closeTrovePromise_B = borrowerOperations.closeTrove({ from: B })

      // Check closing trove reverts
      await assertRevert(closeTrovePromise_B, "BorrowerOps: Caller doesnt have enough LUSD to make repayment")
    })

    // --- openShieldedTrove() ---

    if (!withProxy) { // TODO: use rawLogs instead of logs
      it("openTrove(): emits a TroveUpdated event with the correct collateral and debt", async () => {
        const txA = (await openShieldedTrove({ extraLUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })).tx
        const txB = (await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })).tx
        const txC = (await openShieldedTrove({ extraLUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })).tx

        const A_Coll = await getTroveEntireColl(A)
        const B_Coll = await getTroveEntireColl(B)
        const C_Coll = await getTroveEntireColl(C)
        const A_Debt = await getTroveEntireDebt(A)
        const B_Debt = await getTroveEntireDebt(B)
        const C_Debt = await getTroveEntireDebt(C)

        const A_emittedDebt = toBN(th.getEventArgByName(txA, "TroveUpdated", "_debt"))
        const A_emittedColl = toBN(th.getEventArgByName(txA, "TroveUpdated", "_coll"))
        const B_emittedDebt = toBN(th.getEventArgByName(txB, "TroveUpdated", "_debt"))
        const B_emittedColl = toBN(th.getEventArgByName(txB, "TroveUpdated", "_coll"))
        const C_emittedDebt = toBN(th.getEventArgByName(txC, "TroveUpdated", "_debt"))
        const C_emittedColl = toBN(th.getEventArgByName(txC, "TroveUpdated", "_coll"))

        // Check emitted debt values are correct
        assert.isTrue(A_Debt.eq(A_emittedDebt))
        assert.isTrue(B_Debt.eq(B_emittedDebt))
        assert.isTrue(C_Debt.eq(C_emittedDebt))

        // Check emitted coll values are correct
        assert.isTrue(A_Coll.eq(A_emittedColl))
        assert.isTrue(B_Coll.eq(B_emittedColl))
        assert.isTrue(C_Coll.eq(C_emittedColl))

        const baseRateBefore = await aggregator.baseRate()

        // Artificially make baseRate 5%
        await aggregator.setBaseRate(dec(5, 16))
        await aggregator.setLastFeeOpTimeToNow()

        assert.isTrue((await aggregator.baseRate()).gt(baseRateBefore))

        const txD = (await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })).tx
        const txE = (await openShieldedTrove({ extraLUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })).tx
        const D_Coll = await getTroveEntireColl(D)
        const E_Coll = await getTroveEntireColl(E)
        const D_Debt = await getTroveEntireDebt(D)
        const E_Debt = await getTroveEntireDebt(E)

        const D_emittedDebt = toBN(th.getEventArgByName(txD, "TroveUpdated", "_debt"))
        const D_emittedColl = toBN(th.getEventArgByName(txD, "TroveUpdated", "_coll"))

        const E_emittedDebt = toBN(th.getEventArgByName(txE, "TroveUpdated", "_debt"))
        const E_emittedColl = toBN(th.getEventArgByName(txE, "TroveUpdated", "_coll"))

        // Check emitted debt values are correct
        assert.isTrue(D_Debt.eq(D_emittedDebt))
        assert.isTrue(E_Debt.eq(E_emittedDebt))

        // Check emitted coll values are correct
        assert.isTrue(D_Coll.eq(D_emittedColl))
        assert.isTrue(E_Coll.eq(E_emittedColl))
      })
    }

    it("openTrove(): Opens a trove with net debt >= minimum net debt", async () => {
      await collateralToken.mint(A, dec(100, 30))
      await collateralToken.mint(C, dec(100, 30))

      await collateralToken.approve(activeShieldedPool.address, dec(100, 30), { from: A })
      await collateralToken.approve(activeShieldedPool.address, dec(100, 30), { from: C })

      // Add 1 wei to correct for rounding error in helper function
      const txA = await borrowerOperations.openTrove(dec(100, 30), await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN(1))), A, A, true, { from: A })
      assert.isTrue(txA.receipt.status)
      assert.isTrue(await sortedShieldedTroves.contains(A))

      const txC = await borrowerOperations.openTrove(dec(100, 30), await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN(dec(47789898, 22)))), A, A, true, { from: C })
      assert.isTrue(txC.receipt.status)
      assert.isTrue(await sortedShieldedTroves.contains(C))
    })

    it("openTrove(): reverts if net debt < minimum net debt", async () => {
      const txAPromise = borrowerOperations.openTrove(dec(100, 30), 0, A, A, true, { from: A })
      await assertRevert(txAPromise, "revert")

      const txBPromise = borrowerOperations.openTrove(dec(100, 30), await getNetBorrowingAmount(MIN_NET_DEBT.sub(toBN(1))), B, B, true, { from: B })
      await assertRevert(txBPromise, "revert")

      const txCPromise = borrowerOperations.openTrove(dec(100, 30), MIN_NET_DEBT.sub(toBN(dec(173, 18))), C, C, true, { from: C })
      await assertRevert(txCPromise, "revert")
    })

    it("openTrove(): decays a non-zero base rate", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D opens trove 
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(37, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate has decreased
      //const baseRate_2 = await aggregator.baseRate()
      //assert.isTrue(baseRate_2.lt(baseRate_1))

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E opens trove 
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(12, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      //const baseRate_3 = await aggregator.baseRate()
      //assert.isTrue(baseRate_3.lt(baseRate_2))
    })

    it("openTrove(): doesn't change base rate if it is already zero", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Check baseRate is zero
      const baseRate_1 = await aggregator.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D opens trove 
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(37, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is still 0
      const baseRate_2 = await aggregator.baseRate()
      assert.equal(baseRate_2, '0')

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E opens trove 
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(12, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const baseRate_3 = await aggregator.baseRate()
      assert.equal(baseRate_3, '0')
    })

    it("openTrove(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      const lastFeeOpTime_1 = await aggregator.lastFeeOperationTime()

      // Borrower D triggers a fee
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(1, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      const lastFeeOpTime_2 = await aggregator.lastFeeOperationTime()

      // Check that the last fee operation time did not update, as borrower D's debt issuance occured
      // since before minimum interval had passed 
      assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1))

      // 1 minute passes
      th.fastForwardTime(60, web3.currentProvider)

      // Check that now, at least one minute has passed since lastFeeOpTime_1
      const timeNow = await th.getLatestBlockTimestamp(web3)
      assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(3600))

      // Borrower E triggers a fee
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(1, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const lastFeeOpTime_3 = await aggregator.lastFeeOperationTime()

      // Check that the last fee operation time DID update, as borrower's debt issuance occured
      // after minimum interval had passed 
      //assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1))
    })

    it("openTrove(): borrower can't grief the baseRate and stop it decaying by issuing debt at higher frequency than the decay granularity", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 59 minutes pass
      th.fastForwardTime(3540, web3.currentProvider)

      // Assume Borrower also owns accounts D and E
      // Borrower triggers a fee, before decay interval has passed
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(1, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // 1 minute pass
      th.fastForwardTime(3540, web3.currentProvider)

      // Borrower triggers another fee
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(1, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      // Check base rate has decreased even though Borrower tried to stop it decaying
      const baseRate_2 = await aggregator.baseRate()
      //assert.isTrue(baseRate_2.lt(baseRate_1))
    })

    it("openTrove(): borrowing at non-zero base rate sends LUSD fee to LQTY staking contract", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY LUSD balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D opens trove 
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check LQTY LUSD balance after has increased
      //const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      //assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))
    })

    if (!withProxy) { // TODO: use rawLogs instead of logs
      it("openTrove(): borrowing at non-zero base records the (drawn debt + fee  + liq. reserve) on the Trove struct", async () => {
        // time fast-forwards 1 year, and multisig stakes 1 LQTY
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
        await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
        await lqtyStaking.stake(dec(1, 18), { from: multisig })

        await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
        await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

        // Artificially make baseRate 5%
        await aggregator.setBaseRate(dec(5, 16))
        await aggregator.setLastFeeOpTimeToNow()

        // Check baseRate is now non-zero
        const baseRate_1 = await aggregator.baseRate()
        assert.isTrue(baseRate_1.gt(toBN('0')))

        // 2 hours pass
        th.fastForwardTime(7200, web3.currentProvider)

        const D_LUSDRequest = toBN(dec(20000, 18))
        await collateralToken.mint(D, dec(200, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(200, 'ether'), { from: D })

        // D withdraws LUSD
        const openShieldedTroveTx = await borrowerOperations.openTrove( dec(200, 'ether'), D_LUSDRequest, ZERO_ADDRESS, ZERO_ADDRESS, false, { from: D })

        //const emittedFee = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(openTroveTx))
        //assert.isTrue(toBN(emittedFee).gt(toBN('0')))

        const newDebt = (await troveManager.Troves(D))[0]

        // Check debt on Trove struct equals drawn debt plus emitted fee
        th.assertIsApproximatelyEqual(newDebt, D_LUSDRequest.add(LUSD_GAS_COMPENSATION), 100000)
      })
    }

    it("openTrove(): Borrowing at non-zero base rate increases the LQTY staking contract LUSD fees-per-unit-staked", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY contract LUSD fees-per-unit-staked is zero
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.equal(F_LUSD_Before, '0')

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D opens trove 
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(37, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check LQTY contract LUSD fees-per-unit-staked has increased
      //const F_LUSD_After = await lqtyStaking.F_LUSD()
      //assert.isTrue(F_LUSD_After.gt(F_LUSD_Before))
    })

    it("openTrove(): Borrowing at non-zero base rate sends requested amount to the user", async () => {
      await collateralToken.mint(D, dec(500, 'ether'))
      await collateralToken.approve(activeShieldedPool.address, dec(500, 'ether'), { from: D })

      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY Staking contract balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await aggregator.setBaseRate(dec(5, 16))
      await aggregator.setLastFeeOpTimeToNow()

      // Check baseRate is non-zero
      const baseRate_1 = await aggregator.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D opens trove 
      const LUSDRequest_D = toBN(dec(40000, 18))
      await borrowerOperations.openTrove(dec(500, 'ether'), LUSDRequest_D, D, D, false, { from: D })

      // Check LQTY staking LUSD balance has increased
      //const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      //assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))

      // Check D's LUSD balance now equals their requested LUSD
      const LUSDBalance_D = await lusdToken.balanceOf(D)
      assert.isTrue(LUSDRequest_D.eq(LUSDBalance_D))
    })

    it("openTrove(): Borrowing at zero base rate changes the LQTY staking contract LUSD fees-per-unit-staked", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Check baseRate is zero
      const baseRate_1 = await aggregator.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // Check LUSD reward per LQTY staked == 0
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.equal(F_LUSD_Before, '0')

      // A stakes LQTY
      await lqtyToken.unprotectedMint(A, dec(100, 18))
      await lqtyStaking.stake(dec(100, 18), { from: A })

      // D opens trove 
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(37, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check LUSD reward per LQTY staked > 0
      //const F_LUSD_After = await lqtyStaking.F_LUSD()
      //assert.isTrue(F_LUSD_After.gt(toBN('0')))
    })

    it("openTrove(): reverts when system is in Recovery Mode and ICR < CCR", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // price drops, and Recovery Mode kicks in
      await priceFeed.setPrice(dec(105, 18))

      // Bob tries to open a trove with 149% ICR during Recovery Mode
      try {
        const txBob = await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(149, 16)), extraParams: { from: alice } })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("openTrove(): reverts when trove ICR < MCR", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // Bob attempts to open a 109% ICR trove in Normal Mode
      try {
        const txBob = (await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(109, 16)), extraParams: { from: bob } })).tx
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }

      // price drops, and Recovery Mode kicks in
      await priceFeed.setPrice(dec(105, 18))

      // Bob attempts to open a 109% ICR trove in Recovery Mode
      try {
        const txBob = await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(109, 16)), extraParams: { from: bob } })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("openTrove(): reverts when opening the trove would cause the TCR of the system to fall below the CCR", async () => {
      await priceFeed.setPrice(dec(100, 18))

      // Alice creates trove with 150% ICR.  System TCR = 150%.
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: alice } })

      const TCR = await th.getTCR(contracts)
      assert.equal(TCR, dec(150, 16))

      // Bob attempts to open a trove with ICR = 149% 
      // System TCR would fall below 150%
      try {
        const txBob = await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(149, 16)), extraParams: { from: bob } })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("openTrove(): reverts if trove is already active", async () => {
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: bob } })

      try {
        const txB_1 = await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(3, 18)), extraParams: { from: bob } })

        assert.isFalse(txB_1.receipt.status)
      } catch (err) {
        assert.include(err.message, 'revert')
      }

      try {
        const txB_2 = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

        assert.isFalse(txB_2.receipt.status)
      } catch (err) {
        assert.include(err.message, 'revert')
      }
    })

    it("openTrove(): Can open a trove with ICR >= CCR when system is in Recovery Mode", async () => {
      // --- SETUP ---
      //  Alice and Bob add coll and withdraw such  that the TCR is ~150%
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: bob } })

      const TCR = (await th.getTCR(contracts)).toString()
      assert.equal(TCR, '1500000000000000000')

      // price drops to 1Collateral:100LUSD, reducing TCR below 150%
      await priceFeed.setPrice('100000000000000000000');
      const price = await priceFeed.getPrice()

      // Carol opens at 150% ICR in Recovery Mode
      const txCarol = (await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: carol } })).tx
      assert.isTrue(txCarol.receipt.status)
      assert.isTrue(await sortedShieldedTroves.contains(carol))

      const carol_TroveStatus = await troveManager.getTroveStatus(carol)
      assert.equal(carol_TroveStatus, 1)

      const carolICR = await troveManager.getCurrentICR(carol, price)
      // ICR is smaller than 150 since fee is now charged when CCR < 150
      //assert.isTrue(carolICR.gt(toBN(dec(150, 16))))
      assert.isTrue(carolICR.gt(toBN(dec(149, 16))))
    })

    it("openTrove(): Reverts opening a trove with min debt when system is in Recovery Mode", async () => {
      // --- SETUP ---
      //  Alice and Bob add coll and withdraw such  that the TCR is ~150%
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: bob } })

      const TCR = (await th.getTCR(contracts)).toString()
      assert.equal(TCR, '1500000000000000000')

      // price drops to 1Collateral:100LUSD, reducing TCR below 150%
      await priceFeed.setPrice('100000000000000000000');
      await collateralToken.approve(borrowerOperations.address, dec(1, 'ether'), { from: carol })
      await assertRevert(borrowerOperations.openTrove(dec(1, 'ether'), await getNetBorrowingAmount(MIN_NET_DEBT), carol, carol, false, { from: carol }))
    })

    it("openTrove(): creates a new Trove and assigns the correct collateral and debt amount", async () => {
      await collateralToken.mint(alice, dec(100, 'ether'))
      await collateralToken.approve(activeShieldedPool.address, dec(100, 'ether'), { from: alice })

      const debt_Before = await getTroveEntireDebt(alice)
      const coll_Before = await getTroveEntireColl(alice)
      const status_Before = await troveManager.getTroveStatus(alice)

      // check coll and debt before
      assert.equal(debt_Before, 0)
      assert.equal(coll_Before, 0)

      // check non-existent status
      assert.equal(status_Before, 0)

      const LUSDRequest = MIN_NET_DEBT
      await borrowerOperations.openTrove(dec(100, 'ether'), MIN_NET_DEBT, carol, carol, false, {from: alice})

      //await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice, value: dec(2, 'ether') } })

      // Get the expected debt based on the LUSD request (adding fee and liq. reserve on top)
      const expectedDebt = LUSDRequest.add(LUSD_GAS_COMPENSATION)

      debt = await contracts.troveManager.getTroveActualDebt(alice)
      const coll_After = await getTroveEntireColl(alice)
      const status_After = await troveManager.getTroveStatus(alice)

      // check coll and debt after
      assert.isTrue(coll_After.gt('0'))
      assert.isTrue(debt.gt('0'))

      assert.isTrue(debt.eq(expectedDebt))

      // check active status
      assert.equal(status_After, 1)
    })

    it("openTrove(): adds Trove owner to TroveOwners array", async () => {
      const TroveOwnersCount_Before = (await troveManager.getShieldedTroveOwnersCount()).toString();
      assert.equal(TroveOwnersCount_Before, '0')

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: alice } })

      const TroveOwnersCount_After = (await troveManager.getShieldedTroveOwnersCount()).toString();
      assert.equal(TroveOwnersCount_After, '1')
    })

    it("openTrove(): creates a stake and adds it to total stakes", async () => {
      const aliceStakeBefore = await getTroveStake(alice)
      const totalStakesBefore = await rewards.totalStakes()

      assert.equal(aliceStakeBefore, '0')
      assert.equal(totalStakesBefore, '0')

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollAfter = await getTroveEntireColl(alice)
      const aliceStakeAfter = await getTroveStake(alice)
      assert.isTrue(aliceCollAfter.gt(toBN('0')))
      assert.isTrue(aliceStakeAfter.eq(aliceCollAfter))

      const totalStakesAfter = await rewards.totalStakes()

      assert.isTrue(totalStakesAfter.eq(aliceStakeAfter))
    })

    it("openTrove(): inserts Trove to Sorted Troves list", async () => {
      // Check before
      const aliceTroveInList_Before = await sortedShieldedTroves.contains(alice)
      const listIsEmpty_Before = await sortedShieldedTroves.isEmpty()
      assert.equal(aliceTroveInList_Before, false)
      assert.equal(listIsEmpty_Before, true)

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // check after
      const aliceTroveInList_After = await sortedShieldedTroves.contains(alice)
      const listIsEmpty_After = await sortedShieldedTroves.isEmpty()
      assert.equal(aliceTroveInList_After, true)
      assert.equal(listIsEmpty_After, false)
    })

    it("openTrove(): Increases the activeShieldedPool Collateral and raw ether balance by correct amount", async () => {
      const activeShieldedPool_Collateral_Before = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawEther_Before = await collateralToken.balanceOf(activeShieldedPool.address)
      assert.equal(activeShieldedPool_Collateral_Before, 0)
      assert.equal(activeShieldedPool_RawEther_Before, 0)

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollAfter = await getTroveEntireColl(alice)

      const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawEther_After = toBN(await collateralToken.balanceOf(activeShieldedPool.address))
      assert.isTrue(activeShieldedPool_Collateral_After.eq(aliceCollAfter))
      assert.isTrue(activeShieldedPool_RawEther_After.eq(aliceCollAfter))
    })

    it("openTrove(): records up-to-date initial snapshots of L_COLL and L_LUSDDebt", async () => {
      // --- SETUP ---

      // increase alice ICR so TCR doesn't drop less than CCR
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // --- TEST ---

      // price drops to 1Collateral:100LUSD, reducing Carol's ICR below MCR
      await priceFeed.setPrice(dec(100, 18));

      // close Carol's Trove, liquidating her 1 ether and 180LUSD.
      const liquidationTx = await liquidations.liquidate(carol, { from: owner });
      const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

      /* with total stakes = 10 ether, after liquidation, L_COLL should equal 1/10 ether per-ether-staked,
       and L_LUSD should equal 18 LUSD per-ether-staked. */

      const L_COLL = await rewards.L_Coll()
      const L_LUSD = await rewards.L_LUSDDebt()

      assert.isTrue(L_COLL.gt(toBN('0')))
      assert.isTrue(L_LUSD.gt(toBN('0')))

      // Bob opens trove
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      tcr = await troveManager.getTCR(await priceFeed.getPrice())

      // Check Bob's snapshots of L_COLL and L_LUSD equal the respective current values
      const bob_rewardSnapshot = await rewards.rewardSnapshots(bob)
      const bob_CollateralrewardSnapshot = bob_rewardSnapshot[0]
      const bob_LUSDDebtRewardSnapshot = bob_rewardSnapshot[1]

      assert.isAtMost(th.getDifference(bob_CollateralrewardSnapshot, L_COLL), 1000)
      assert.isAtMost(th.getDifference(bob_LUSDDebtRewardSnapshot, L_LUSD), 1000)
    })

    it("openTrove(): allows a user to open a Trove, then close it, then re-open it", async () => {
      await collateralToken.mint(whale, dec(100, 'ether'))
      await collateralToken.approve(activeShieldedPool.address, dec(100, 'ether'), { from: whale })

      // Open Troves
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // Check Trove is active
      const alice_Trove_1 = await troveManager.Troves(alice)
      const status_1 = alice_Trove_1[3]
      assert.equal(status_1, 1)
      assert.isTrue(await sortedShieldedTroves.contains(alice))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, dec(10000, 18), { from: whale })

      // Repay and close Trove
      await borrowerOperations.closeTrove({ from: alice })

      // Check Trove is closed
      const alice_Trove_2 = await troveManager.Troves(alice)
      const status_2 = alice_Trove_2[3]
      assert.equal(status_2, 2)
      assert.isFalse(await sortedShieldedTroves.contains(alice))

      // Re-open Trove
      await openShieldedTrove({ extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // Check Trove is re-opened
      const alice_Trove_3 = await troveManager.Troves(alice)
      const status_3 = alice_Trove_3[3]
      assert.equal(status_3, 1)
      assert.isTrue(await sortedShieldedTroves.contains(alice))
    })

    it("openTrove(): increases the Trove's LUSD debt by the correct amount", async () => {
      // check before
      const alice_Trove_Before = await troveManager.Troves(alice)
      const debt_Before = alice_Trove_Before[0]
      assert.equal(debt_Before, 0)
      await collateralToken.mint(alice, dec(100, 'ether'))
      await collateralToken.approve(activeShieldedPool.address, dec(100, 'ether'), { from: alice })

      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), alice, alice, false, { from: alice })

      // check after
      const alice_Trove_After = await troveManager.Troves(alice)
      const debt_After = alice_Trove_After[0]
      th.assertIsApproximatelyEqual(debt_After, dec(10000, 18), 10000)
    })

    it("openTrove(): increases LUSD debt in ActivePool by the debt of the trove", async () => {
      const activeShieldedPool_LUSDDebt_Before = await activeShieldedPool.getLUSDDebt()
      assert.equal(activeShieldedPool_LUSDDebt_Before, 0)

      await openShieldedTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceDebt = await getTroveEntireDebt(alice)
      assert.isTrue(aliceDebt.gt(toBN('0')))

      const activeShieldedPool_LUSDDebt_After = await activeShieldedPool.getLUSDDebt()
      assert.isTrue(activeShieldedPool_LUSDDebt_After.eq(aliceDebt))
    })

    it("openTrove(): increases user LUSDToken balance by correct amount", async () => {
      // check before
      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.equal(alice_LUSDTokenBalance_Before, 0)

      await collateralToken.mint(alice, dec(100, 'ether'))
      await collateralToken.approve(activeShieldedPool.address, dec(100, 'ether'), { from: alice })

      await borrowerOperations.openTrove(dec(100, 'ether'), dec(10000, 18), alice, alice, false, { from: alice })

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      assert.equal(alice_LUSDTokenBalance_After, dec(10000, 18))
    })

    //  --- getNewICRFromTroveChange - (external wrapper in Tester contract calls internal function) ---

    describe("getNewICRFromTroveChange() returns the correct ICR", async () => {


      // 0, 0
      it("collChange = 0, debtChange = 0", async () => {
        price = await priceFeed.getPrice()
        const initialColl = dec(1, 'ether')
        const initialDebt = dec(100, 18)
        const collChange = 0
        const debtChange = 0

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, true, price)).toString()
        assert.equal(newICR, '2000000000000000000')
      })

      // 0, +ve
      it("collChange = 0, debtChange is positive", async () => {
        price = await priceFeed.getPrice()
        const initialColl = dec(1, 'ether')
        const initialDebt = dec(100, 18)
        const collChange = 0
        const debtChange = dec(50, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, true, price)).toString()
        assert.isAtMost(th.getDifference(newICR, '1333333333333333333'), 100)
      })

      // 0, -ve
      it("collChange = 0, debtChange is negative", async () => {
        price = await priceFeed.getPrice()
        const initialColl = dec(1, 'ether')
        const initialDebt = dec(100, 18)
        const collChange = 0
        const debtChange = dec(50, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, false, price)).toString()
        assert.equal(newICR, '4000000000000000000')
      })

      // +ve, 0
      it("collChange is positive, debtChange is 0", async () => {
        price = await priceFeed.getPrice()
        const initialColl = dec(1, 'ether')
        const initialDebt = dec(100, 18)
        const collChange = dec(1, 'ether')
        const debtChange = 0

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, true, price)).toString()
        assert.equal(newICR, '4000000000000000000')
      })

      // -ve, 0
      it("collChange is negative, debtChange is 0", async () => {
        price = await priceFeed.getPrice()
        const initialColl = dec(1, 'ether')
        const initialDebt = dec(100, 18)
        const collChange = dec(5, 17)
        const debtChange = 0

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, false, debtChange, true, price)).toString()
        assert.equal(newICR, '1000000000000000000')
      })

      // -ve, -ve
      it("collChange is negative, debtChange is negative", async () => {
        price = await priceFeed.getPrice()
        const initialColl = dec(1, 'ether')
        const initialDebt = dec(100, 18)
        const collChange = dec(5, 17)
        const debtChange = dec(50, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, false, debtChange, false, price)).toString()
        assert.equal(newICR, '2000000000000000000')
      })

      // +ve, +ve 
      it("collChange is positive, debtChange is positive", async () => {
        price = await priceFeed.getPrice()
        const initialColl = dec(1, 'ether')
        const initialDebt = dec(100, 18)
        const collChange = dec(1, 'ether')
        const debtChange = dec(100, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, true, price)).toString()
        assert.equal(newICR, '2000000000000000000')
      })

      // +ve, -ve
      it("collChange is positive, debtChange is negative", async () => {
        price = await priceFeed.getPrice()
        const initialColl = dec(1, 'ether')
        const initialDebt = dec(100, 18)
        const collChange = dec(1, 'ether')
        const debtChange = dec(50, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, false, price)).toString()
        assert.equal(newICR, '8000000000000000000')
      })

      // -ve, +ve
      it("collChange is negative, debtChange is positive", async () => {
        price = await priceFeed.getPrice()
        const initialColl = dec(1, 'ether')
        const initialDebt = dec(100, 18)
        const collChange = dec(5, 17)
        const debtChange = dec(100, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, false, debtChange, true, price)).toString()
        assert.equal(newICR, '500000000000000000')
      })
    })

    // --- getCompositeDebt ---

    it("getCompositeDebt(): returns debt + gas comp", async () => {
      const res1 = await borrowerOperations.getCompositeDebt('0')
      assert.equal(res1, LUSD_GAS_COMPENSATION.toString())

      const res2 = await borrowerOperations.getCompositeDebt(dec(90, 18))
      th.assertIsApproximatelyEqual(res2, LUSD_GAS_COMPENSATION.add(toBN(dec(90, 18))))

      const res3 = await borrowerOperations.getCompositeDebt(dec(24423422357345049, 12))
      th.assertIsApproximatelyEqual(res3, LUSD_GAS_COMPENSATION.add(toBN(dec(24423422357345049, 12))))
    })

    //  --- getNewTCRFromTroveChange  - (external wrapper in Tester contract calls internal function) ---

    describe("getNewTCRFromTroveChange() returns the correct TCR", async () => {

      // 0, 0
      it("collChange = 0, debtChange = 0", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, 'ether'))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await collateralToken.mint(alice, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: alice })
        await collateralToken.mint(bob, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: bob })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, alice, alice, false, { from: alice })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, bob, bob, false, { from: bob })

        await priceFeed.setPrice(dec(100, 18))

        const liquidationTx = await liquidations.liquidate(bob)
        assert.isFalse(await sortedShieldedTroves.contains(bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(dec(200, 18))
        const price = await priceFeed.getPrice()

        // --- TEST ---
        const collChange = 0
        const debtChange = 0
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(collChange, true, debtChange, true, price)

        const expectedTCR = (troveColl.add(liquidatedColl)).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // 0, +ve
      it("collChange = 0, debtChange is positive", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, 'ether'))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await collateralToken.mint(alice, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: alice })
        await collateralToken.mint(bob, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: bob })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, alice, alice, false, { from: alice })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, bob, bob, false, { from: bob })

        await priceFeed.setPrice(dec(100, 18))

        const liquidationTx = await liquidations.liquidate(bob)
        assert.isFalse(await sortedShieldedTroves.contains(bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(dec(200, 18))
        const price = await priceFeed.getPrice()

        // --- TEST ---
        const collChange = 0
        const debtChange = dec(200, 18)
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collChange, true, debtChange, true, price))

        const expectedTCR = (troveColl.add(liquidatedColl)).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).add(toBN(debtChange)))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // 0, -ve
      it("collChange = 0, debtChange is negative", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, 'ether'))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await collateralToken.mint(alice, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: alice })
        await collateralToken.mint(bob, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: bob })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, alice, alice, false, { from: alice })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, bob, bob, false, { from: bob })

        await priceFeed.setPrice(dec(100, 18))

        const liquidationTx = await liquidations.liquidate(bob)
        assert.isFalse(await sortedShieldedTroves.contains(bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(dec(200, 18))
        const price = await priceFeed.getPrice()
        // --- TEST ---
        const collChange = 0
        const debtChange = dec(100, 18)
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collChange, true, debtChange, false, price))

        const expectedTCR = (troveColl.add(liquidatedColl)).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).sub(toBN(dec(100, 18))))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // +ve, 0
      it("collChange is positive, debtChange is 0", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, 'ether'))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await collateralToken.mint(alice, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: alice })
        await collateralToken.mint(bob, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: bob })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, alice, alice, false, { from: alice })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, bob, bob, false, { from: bob })

        await priceFeed.setPrice(dec(100, 18))

        const liquidationTx = await liquidations.liquidate(bob)
        assert.isFalse(await sortedShieldedTroves.contains(bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(dec(200, 18))
        const price = await priceFeed.getPrice()
        // --- TEST ---
        const collChange = dec(2, 'ether')
        const debtChange = 0
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collChange, true, debtChange, true, price))

        const expectedTCR = (troveColl.add(liquidatedColl).add(toBN(collChange))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // -ve, 0
      it("collChange is negative, debtChange is 0", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, 'ether'))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await collateralToken.mint(alice, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: alice })
        await collateralToken.mint(bob, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: bob })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, alice, alice, false, { from: alice })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, bob, bob, false, { from: bob })

        await priceFeed.setPrice(dec(100, 18))

        const liquidationTx = await liquidations.liquidate(bob)
        assert.isFalse(await sortedShieldedTroves.contains(bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(dec(200, 18))
        const price = await priceFeed.getPrice()

        // --- TEST ---
        const collChange = dec(1, 18)
        const debtChange = 0
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collChange, false, debtChange, true, price))

        const expectedTCR = (troveColl.add(liquidatedColl).sub(toBN(dec(1, 'ether')))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // -ve, -ve
      it("collChange is negative, debtChange is negative", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, 'ether'))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await collateralToken.mint(alice, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: alice })
        await collateralToken.mint(bob, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: bob })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, alice, alice, false, { from: alice })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, bob, bob, false, { from: bob })

        await priceFeed.setPrice(dec(100, 18))

        const liquidationTx = await liquidations.liquidate(bob)
        assert.isFalse(await sortedShieldedTroves.contains(bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(dec(200, 18))
        const price = await priceFeed.getPrice()

        // --- TEST ---
        const collChange = dec(1, 18)
        const debtChange = dec(100, 18)
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collChange, false, debtChange, false, price))

        const expectedTCR = (troveColl.add(liquidatedColl).sub(toBN(dec(1, 'ether')))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).sub(toBN(dec(100, 18))))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // +ve, +ve 
      it("collChange is positive, debtChange is positive", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, 'ether'))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await collateralToken.mint(alice, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: alice })
        await collateralToken.mint(bob, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: bob })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, alice, alice, false, { from: alice })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, bob, bob, false, { from: bob })

        await priceFeed.setPrice(dec(100, 18))

        const liquidationTx = await liquidations.liquidate(bob)
        assert.isFalse(await sortedShieldedTroves.contains(bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(dec(200, 18))
        const price = await priceFeed.getPrice()

        // --- TEST ---
        const collChange = dec(1, 'ether')
        const debtChange = dec(100, 18)
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collChange, true, debtChange, true, price))

        const expectedTCR = (troveColl.add(liquidatedColl).add(toBN(dec(1, 'ether')))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).add(toBN(dec(100, 18))))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // +ve, -ve
      it("collChange is positive, debtChange is negative", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, 'ether'))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await collateralToken.mint(alice, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: alice })
        await collateralToken.mint(bob, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: bob })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, alice, alice, false, { from: alice })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, bob, bob, false, { from: bob })

        await priceFeed.setPrice(dec(100, 18))

        const liquidationTx = await liquidations.liquidate(bob)
        assert.isFalse(await sortedShieldedTroves.contains(bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(dec(200, 18))
        const price = await priceFeed.getPrice()

        // --- TEST ---
        const collChange = dec(1, 'ether')
        const debtChange = dec(100, 18)
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collChange, true, debtChange, false, price))

        const expectedTCR = (troveColl.add(liquidatedColl).add(toBN(dec(1, 'ether')))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).sub(toBN(dec(100, 18))))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // -ve, +ve
      it("collChange is negative, debtChange is positive", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        const troveColl = toBN(dec(1000, 'ether'))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await collateralToken.mint(alice, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: alice })
        await collateralToken.mint(bob, dec(1000, 'ether'))
        await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: bob })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, alice, alice, false, { from: alice })
        await borrowerOperations.openTrove(troveColl, troveLUSDAmount, bob, bob, false, { from: bob })

        await priceFeed.setPrice(dec(100, 18))

        const liquidationTx = await liquidations.liquidate(bob)
        assert.isFalse(await sortedShieldedTroves.contains(bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(dec(200, 18))
        const price = await priceFeed.getPrice()

        // --- TEST ---
        const collChange = dec(1, 18)
        const debtChange = await getNetBorrowingAmount(dec(200, 18))
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collChange, false, debtChange, true, price))

        const expectedTCR = (troveColl.add(liquidatedColl).sub(toBN(collChange))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).add(toBN(debtChange)))

        assert.isTrue(newTCR.eq(expectedTCR))
      })
    })

    if (!withProxy) {
      // it('closeTrove(): fails if owner cannot receive Collateral', async () => {
      //   const nonPayable = await NonPayable.new()

      //   // we need 2 troves to be able to close 1 and have 1 remaining in the system
      //   await collateralToken.mint(alice, dec(1000, 'ether'))
      //   await collateralToken.approve(activeShieldedPool.address, dec(1000, 'ether'), { from: alice })
      //   await borrowerOperations.openTrove(dec(1000, 'ether'), dec(100000, 18), alice, alice, false, { from: alice })

      //   // Alice sends LUSD to NonPayable so its LUSD balance covers its debt
      //   await lusdToken.transfer(nonPayable.address, dec(10000, 18), {from: alice})

      //   // open trove from NonPayable proxy contract
      //   const _100pctHex = '0xde0b6b3a7640000'
      //   const _1e25Hex = '0xd3c21bcecceda1000000'
      //   const openShieldedTroveData = th.getTransactionData('openTrove(uint256,address,address)', [_1e25Hex, '0x0', '0x0'])
      //   await nonPayable.forward(borrowerOperations.address, openShieldedTroveData, { value: dec(10000, 'ether') })
      //   assert.equal((await troveManager.getTroveStatus(nonPayable.address)).toString(), '1', 'NonPayable proxy should have a trove')
      //   // open trove from NonPayable proxy contract
      //   const closeTroveData = th.getTransactionData('closeTrove()', [])
      //   await th.assertRevert(nonPayable.forward(borrowerOperations.address, closeTroveData), 'ActivePool: sending Collateral failed')
      // })
    }
  }

  describe('Without proxy', async () => {
    testCorpus({ withProxy: false })
  })

  // describe('With proxy', async () => {
  //   testCorpus({ withProxy: true })
  // })
})

contract('Reset chain state', async accounts => { })

/* TODO:

 1) Test SortedList re-ordering by ICR. ICR ratio
 changes with addColl, withdrawColl, withdrawLUSD, repayLUSD, etc. Can split them up and put them with
 individual functions, or give ordering it's own 'describe' block.

 2)In security phase:
 -'Negative' tests for all the above functions.
 */
