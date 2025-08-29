const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const testInvariants = require("../utils/testInvariants.js")
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol")
const LiquidationsTester = artifacts.require("./LiquidationsTester.sol")
const AggregatorTester = artifacts.require("./AggregatorTester.sol")
const RelayerTester = artifacts.require("./RelayerTester.sol")
const RateControlTester = artifacts.require("./RateControlTester.sol")
const LUSDTokenTester = artifacts.require("./LUSDTokenTester.sol")
const BigNumber = require("@ethersproject/bignumber");

const Decimal = require("@liquity/lib-base");

const th = testHelpers.TestHelper
const ti = testInvariants.TestInvariant
const dec = th.dec
const toBN = th.toBN
const assertRevert = th.assertRevert
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const GAS_PRICE = 10000000


/* NOTE: Some tests involving Collateral redemption fees do not test for specific fee values.
 * Some only test that the fees are non-zero when they should occur.
 *
 * Specific Collateral gain values will depend on the final fee schedule used, and the final choices for
 * the parameter BETA in the TroveManager, which is still TBD based on economic modelling.
 * 
 */ 
contract('TroveManager - Shielded', async accounts => {

  const _18_zeros = '000000000000000000'
  const ZERO_ADDRESS = th.ZERO_ADDRESS
  const ONE_DOLLAR = toBN(dec(1, 18))
  const ONE_CENT = toBN(dec(1, 16))

  const [
    owner,
    alice, bob, carol, dennis, erin, flyn, graham, harriet, ida,
    defaulter_1, defaulter_2, defaulter_3, defaulter_4, whale,
    A, B, C, D, E] = accounts;

    const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)
  

  let priceFeed
  let lusdToken
  let sortedTroves
  let sortedShieldedTroves
  let troveManager
  let rewards
  let activePool
  let activeShieldedPool
  let stabilityPool
  let collSurplusPool
  let defaultPool
  let borrowerOperations
  let hintHelpers
  let collateralToken

  let contracts

  const getOpenTroveTotalDebt = async (lusdAmount) => th.getOpenTroveTotalDebt(contracts, lusdAmount)
  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const openTrove = async (params) => th.openTrove(contracts, params)
  const openShieldedTrove = async (params) => th.openShieldedTrove(contracts, params)
  const withdrawLUSD = async (params) => th.withdrawLUSD(contracts, params)

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.aggregator = await AggregatorTester.new()
    contracts.liquidations = await LiquidationsTester.new()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.rateControl = await RateControlTester.new()
    contracts.lusdToken = await LUSDTokenTester.new(
      contracts.troveManager.address,
      contracts.liquidations.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    )
    const LQTYContracts = await deploymentHelper.deployLQTYContracts(bountyAddress, lpRewardsAddress, multisig)

    priceFeed = contracts.priceFeedTestnet
    lusdToken = contracts.lusdToken
    sortedTroves = contracts.sortedTroves
    sortedShieldedTroves = contracts.sortedShieldedTroves
    aggregator = contracts.aggregator
    troveManager = contracts.troveManager
    rewards = contracts.rewards
    liquidations = contracts.liquidations
    activePool = contracts.activePool
    activeShieldedPool = contracts.activeShieldedPool
    stabilityPool = contracts.stabilityPool
    defaultPool = contracts.defaultPool
    collSurplusPool = contracts.collSurplusPool
    borrowerOperations = contracts.borrowerOperations
    hintHelpers = contracts.hintHelpers
    relayer = contracts.relayer
    //relayer = await RelayerTester.new()
    parControl = contracts.parControl
    rateControl = contracts.rateControl
    marketOracle = contracts.marketOracleTestnet
    collateralToken = contracts.collateralToken

    lqtyStaking = LQTYContracts.lqtyStaking
    lqtyToken = LQTYContracts.lqtyToken
    communityIssuance = LQTYContracts.communityIssuance
    lockupContractFactory = LQTYContracts.lockupContractFactory

    await th.batchMintCollateralTokensAndApproveActivePool(contracts, [
      owner,
      alice, bob, carol, dennis, erin, flyn, graham, harriet, ida,
      defaulter_1, defaulter_2, defaulter_3, defaulter_4, whale,
      A, B, C, D, E], toBN(dec(1000, 26)))
    // Interfaces
    stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", stabilityPool.address)).interface;
    troveManagerInterface = (await ethers.getContractAt("TroveManager", troveManager.address)).interface;
    liquidationsInterface = (await ethers.getContractAt("Liquidations", liquidations.address)).interface;
    rewardsInterface = (await ethers.getContractAt("Rewards", rewards.address)).interface;
    collSurplusPoolInterface = (await ethers.getContractAt("CollSurplusPool", collSurplusPool.address)).interface;
    borrowerOperationsInterface = (await ethers.getContractAt("BorrowerOperations", borrowerOperations.address)).interface;

    await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
    await deploymentHelper.connectLQTYContracts(LQTYContracts)
    await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)
  })

  afterEach(async () => {
    assert.isTrue(await ti.SpBalanceEqualsErc20Balance(contracts))
    assert.isTrue(await ti.debtEqualsSupply(contracts))
  })

  it('liquidate(): closes a Trove that has ICR < MCR', async () => {
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })

    const price = await priceFeed.getPrice()
    const ICR_Before = await troveManager.getCurrentICR(alice, price)

    assert.equal(dec(1, 18), await relayer.par())

    assert.isTrue(ICR_Before.eq(toBN(dec(4, 18))))

    const MCR = (await troveManager.MCR()).toString()
    assert.equal(MCR.toString(), '1100000000000000000')
    const HCR = toBN(await troveManager.HCR())

    const targetICR = HCR.add(toBN(dec(1, 12)))
    await withdrawLUSD({ ICR: targetICR, extraParams: { from: alice } })

    const ICR_AfterWithdrawal = await troveManager.getCurrentICR(alice, price)
    assert.isAtMost(th.getDifference(ICR_AfterWithdrawal, targetICR), 100)

    // ensure it can't be liquidated
    try {
      const txAlice = await liquidations.liquidate(alice)

      assert.isFalse(txAlice.receipt.status)
    } catch (err) {
      assert.include(err.message, "revert")
      assert.include(err.message, "Liquidations: nothing to liquidate")
    }

    // price drops to 1CollateralToken:100LUSD, reducing Alice's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');
    assert.isFalse(await th.checkRecoveryMode(contracts))


    // close Trove
    await liquidations.liquidate(alice, { from: owner });

    // check the Trove is successfully closed, and removed from sortedList
    const status = (await troveManager.Troves(alice))[3]
    assert.equal(status, 3)  // status enum 3 corresponds to "Closed by liquidation"
    const alice_Trove_isInSortedList = await sortedShieldedTroves.contains(alice)
    assert.isFalse(alice_Trove_isInSortedList)

  })
  it('liquidate(): closes a Trove that has ICR < MCR from par rising', async () => {
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
    const { collateral: A_collateral, totalDebt: A_totalDebt }  = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

    const price = await priceFeed.getPrice()
    const ICR_Before = await troveManager.getCurrentICR(alice, price)

    assert.equal(dec(1, 18), await relayer.par())

    assert.isTrue(ICR_Before.eq(toBN(dec(2, 18))))

    const MCR = (await troveManager.MCR()).toString()
    assert.equal(MCR.toString(), '1100000000000000000')
    const HCR = toBN(await troveManager.HCR())

    const targetICR = HCR.add(toBN(dec(1, 12)))

    await withdrawLUSD({ ICR: targetICR, extraParams: { from: alice } })

    const ICR_AfterWithdrawal = await troveManager.getCurrentICR(alice, price)
    assert.isAtMost(th.getDifference(ICR_AfterWithdrawal, targetICR), 100)

    // ensure it can't be liquidated
    try {
      const txAlice = await liquidations.liquidate(alice)

      assert.isFalse(txAlice.receipt.status)
    } catch (err) {
      assert.include(err.message, "revert")
      assert.include(err.message, "Liquidations: nothing to liquidate")
    }

    // drop market -> raise pair
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(10).mul(ONE_CENT)));
    await relayer.updateRateAndPar();
    th.fastForwardTime(2*365 * 24 * 3600, web3.currentProvider)
    await relayer.updateRateAndPar();
    console.log("par", (await relayer.par()).toString())

    // ICR has dropped
    assert.isTrue(ICR_AfterWithdrawal > await troveManager.getCurrentICR(alice, price));

    const alice_ICR = await troveManager.getCurrentICR(alice, price)
    console.log("alice_ICR", alice_ICR.toString())

    console.log("A_collateral", A_collateral.toString())
    shieldedColl = await activeShieldedPool.getCollateral()
    console.log("shieldedColl", shieldedColl.toString())
    // close Trove
    tx = await liquidations.liquidate(alice, { from: owner });

    /*
    liq_event = tx.logs.find(e => e.event === 'TroveLiqInfo');
    console.log("entireColl", liq_event.args.entireColl.toString())
    console.log("collToLiquidate", liq_event.args.collToLiquidate.toString())
    console.log("collToSp", liq_event.args.collToSp.toString())
    console.log("collToRedistribute", liq_event.args.collToRedistribute.toString())
    */

    // check the Trove is successfully closed, and removed from sortedList
    const status = (await troveManager.Troves(alice))[3]
    assert.equal(status, 3)  // status enum 3 corresponds to "Closed by liquidation"
    const alice_Trove_isInSortedList = await sortedShieldedTroves.contains(alice)
    assert.isFalse(alice_Trove_isInSortedList)
  })

  it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts", async () => {
    // --- SETUP 
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    // --- TEST ---

    // check ActivePool Collateral and LUSD debt before
    const activeShieldedPool_Collateral_Before = (await activeShieldedPool.getCollateral()).toString()
    const activeShieldedPool_RawCollateral_Before = (await collateralToken.balanceOf(activeShieldedPool.address)).toString()
    const activeShieldedPool_LUSDDebt_Before = (await activeShieldedPool.getLUSDDebt()).toString()

    assert.equal(activeShieldedPool_Collateral_Before, A_collateral.add(B_collateral))
    assert.equal(activeShieldedPool_RawCollateral_Before, A_collateral.add(B_collateral))
    th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_Before, A_totalDebt.add(B_totalDebt))

    // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');
    assert.isFalse(await th.checkRecoveryMode(contracts))

    /* close Bob's Trove. Should liquidate his ether and LUSD, 
    leaving Alice’s ether and LUSD debt in the ActivePool. */
    await liquidations.liquidate(bob, { from: owner });

    // check ActivePool Collateral and LUSD debt 
    const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
    const activeShieldedPool_RawCollateral_After= await collateralToken.balanceOf(activeShieldedPool.address)
    const activeShieldedPool_LUSDDebt_After = await activeShieldedPool.getLUSDDebt()

    //console.log("activeShieldedPool_Collateral_After", activeShieldedPool_Collateral_After.toString())
    //console.log("A_collateral", A_collateral.toString())
    //console.log("B_collateral", B_collateral.toString())
    // TODO Fix off by one
    //assert.equal(activeShieldedPool_Collateral_After, A_collateral)
    assert.isAtMost(th.getDifference(activeShieldedPool_Collateral_After, A_collateral), 1)
    //assert.equal(activeShieldedPool_RawEther_After, A_collateral)
    assert.isAtMost(th.getDifference(activeShieldedPool_RawCollateral_After, A_collateral), 1)
    th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_After, A_totalDebt)
  })
  it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts, with liq surplus", async () => {
    // --- SETUP 
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    // --- TEST ---

    // check ActivePool Collateral and LUSD debt before
    const activeShieldedPool_Collateral_Before = (await activeShieldedPool.getCollateral()).toString()
    const activeShieldedPool_RawCollateral_Before = (await collateralToken.balanceOf(activeShieldedPool.address)).toString()
    const activeShieldedPool_LUSDDebt_Before = (await activeShieldedPool.getLUSDDebt()).toString()

    //console.log("activeShieldedPool_RawCollateral_Before", activeShieldedPool_RawCollateral_Before.toString())
    assert.equal(activeShieldedPool_Collateral_Before, A_collateral.add(B_collateral))
    assert.equal(activeShieldedPool_RawCollateral_Before, A_collateral.add(B_collateral))
    th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_Before, A_totalDebt.add(B_totalDebt))

    // price drops to 1ETH:100LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');
    assert.isFalse(await th.checkRecoveryMode(contracts))

    /* close Bob's Trove. Should liquidate his ether and LUSD, 
    leaving Alice’s ether and LUSD debt in the ActivePool. */
    await liquidations.liquidate(bob, { from: owner });

    // check ActivePool Collateral and LUSD debt 
    const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
    const activeShieldedPool_RawCollateral_After = await collateralToken.balanceOf(activeShieldedPool.address)
    const activeShieldedPool_LUSDDebt_After = await activeShieldedPool.getLUSDDebt()

    // TODO Fix off by one
    //assert.equal(activeShieldedPool_ETH_After, A_collateral)
    assert.isAtMost(th.getDifference(activeShieldedPool_Collateral_After, A_collateral), 1)
    //assert.equal(activeShieldedPool_RawEther_After, A_collateral)
    assert.isAtMost(th.getDifference(activeShieldedPool_RawCollateral_After, A_collateral), 1)
    th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_After, A_totalDebt)
  })
  it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts, with liq surplus", async () => {
    // --- SETUP 
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    // --- TEST ---

    // check ActivePool Collateral and LUSD debt before
    const activeShieldedPool_Collateral_Before = (await activeShieldedPool.getCollateral()).toString()
    const activeShieldedPool_RawCollateral_Before = (await collateralToken.balanceOf(activeShieldedPool.address)).toString()
    const activeShieldedPool_LUSDDebt_Before = (await activeShieldedPool.getLUSDDebt()).toString()

    console.log("activeShieldedPool_RawCollateral_Before", activeShieldedPool_RawCollateral_Before.toString())
    console.log("sum", A_collateral.add(B_collateral).toString())
    assert.equal(activeShieldedPool_Collateral_Before, A_collateral.add(B_collateral))
    assert.equal(activeShieldedPool_RawCollateral_Before, A_collateral.add(B_collateral))
    th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_Before, A_totalDebt.add(B_totalDebt))

    // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');
    assert.isFalse(await th.checkRecoveryMode(contracts))

    /* close Bob's Trove. Should liquidate his ether and LUSD, 
    leaving Alice’s ether and LUSD debt in the ActivePool. */
    await liquidations.liquidate(bob, { from: owner });

    // check ActivePool Collateral and LUSD debt 
    const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
    const activeShieldedPool_RawCollateral_After = await collateralToken.balanceOf(activeShieldedPool.address)
    const activeShieldedPool_LUSDDebt_After = await activeShieldedPool.getLUSDDebt()

    // TODO Fix off by one
    //assert.equal(activeShieldedPool_ETH_After, A_collateral)
    assert.isAtMost(th.getDifference(activeShieldedPool_Collateral_After, A_collateral), 1)
    //assert.equal(activeShieldedPool_RawEther_After, A_collateral)
    assert.isAtMost(th.getDifference(activeShieldedPool_RawCollateral_After, A_collateral), 1)
    th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_After, A_totalDebt)
  })

  it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts, rising par", async () => {
    // --- SETUP ---
    HCR = await troveManager.HCR()
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: HCR.add(toBN(dec(1, 16))), extraParams: { from: bob } })

    // --- TEST ---

    // check ActivePool Collateral and LUSD debt before
    const activeShieldedPool_Collateral_Before = (await activeShieldedPool.getCollateral()).toString()
    const activeShieldedPool_RawCollateral_Before = (await collateralToken.balanceOf(activeShieldedPool.address)).toString()
    const activeShieldedPool_LUSDDebt_Before = (await activeShieldedPool.getLUSDDebt()).toString()

    assert.equal(activeShieldedPool_Collateral_Before, A_collateral.add(B_collateral))
    assert.equal(activeShieldedPool_RawCollateral_Before, A_collateral.add(B_collateral))
    th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_Before, A_totalDebt.add(B_totalDebt))

    // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
    //await priceFeed.setPrice('100000000000000000000');

    // move market enough to cause par to liquidate bob's trove
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
    await relayer.updatePar();
    th.fastForwardTime(2 * 365 * 24 * 3600, web3.currentProvider)
    await relayer.updatePar();
    assert.isFalse(await th.checkRecoveryMode(contracts))

    /* close Bob's Trove. Should liquidate his ether and LUSD, 
    leaving Alice’s ether and LUSD debt in the ActivePool. */
    await liquidations.liquidate(bob, { from: owner });

    // check ActivePool collateral and LUSD debt 
    const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
    const activeShieldedPool_RawCollateral_After = await collateralToken.balanceOf(activeShieldedPool.address)
    const activeShieldedPool_LUSDDebt_After = await activeShieldedPool.getLUSDDebt()

    // TODO fix off by one
    //assert.equal(activeShieldedPool_Collateral_After, A_collateral)
    assert.isAtMost(th.getDifference(activeShieldedPool_Collateral_After, A_collateral), 1)
    //assert.equal(activeShieldedPool_RawEther_After, A_collateral)
    assert.isAtMost(th.getDifference(activeShieldedPool_RawCollateral_After, A_collateral), 1)
    th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_After, A_totalDebt)
  })

  it("liquidate(): increases DefaultPool Collateral and LUSD debt by correct amounts 1", async () => {
    // --- SETUP ---
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    // --- TEST ---

    // check DefaultPool Collateral and LUSD debt before
    const defaultPool_Collateral_Before = (await defaultPool.getCollateral())
    const defaultPool_RawCollateral_Before = (await collateralToken.balanceOf(defaultPool.address)).toString()
    const defaultPool_LUSDDebt_Before = (await defaultPool.getLUSDDebt()).toString()

    assert.equal(defaultPool_Collateral_Before, '0')
    assert.equal(defaultPool_RawCollateral_Before, '0')
    assert.equal(defaultPool_LUSDDebt_Before, '0')

    // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // close Bob's Trove
    tx = await liquidations.liquidate(bob, { from: owner });
    //const value = toBN(th.getRawEventArgByName(tx, rewardsInterface, rewards.address, "Value", "value"));

    /*
    liq_event = tx.logs.find(e => e.event === 'TroveLiqInfo');
    console.log("entireColl", liq_event.args.entireColl.toString())
    console.log("collToLiquidate", liq_event.args.collToLiquidate.toString())
    console.log("B_collateral", B_collateral.toString())
    */

    // check after
    const defaultPool_Collateral_After = await defaultPool.getCollateral()
    const defaultPool_RawCollateral_After = await collateralToken.balanceOf(defaultPool.address)
    const defaultPool_LUSDDebt_After = await defaultPool.getLUSDDebt()

    const defaultPool_Collateral = th.applyLiquidationFee(B_collateral)

    // TODO: should these be exactly equal?
    //assert.isTrue(defaultPool_Collateral_After.eq(defaultPool_Collateral))
    assert.isAtMost(th.getDifference(defaultPool_Collateral_After, defaultPool_Collateral), 1)
    //assert.isTrue(defaultPool_RawCollateral_After.eq(defaultPool_Collateral))
    assert.isAtMost(th.getDifference(defaultPool_RawCollateral_After, defaultPool_Collateral), 1)
    //assert.isAtMost(th.getDifference(defaultPool_Collateral_After, defaultPool_Collateral), 1)

    th.assertIsApproximatelyEqual(defaultPool_LUSDDebt_After, B_totalDebt)
  })
  it("liquidate(): increases DefaultPool Collateral and LUSD debt by correct amounts, rising par", async () => {
    // --- SETUP ---
    HCR = await troveManager.HCR()
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: HCR.add(toBN(dec(1, 16))), extraParams: { from: bob } })

    // --- TEST ---

    // check DefaultPool Collateral and LUSD debt before
    const defaultPool_Collateral_Before = (await defaultPool.getCollateral())
    const defaultPool_RawCollateral_Before = (await collateralToken.balanceOf(defaultPool.address)).toString()
    const defaultPool_LUSDDebt_Before = (await defaultPool.getLUSDDebt()).toString()

    assert.equal(defaultPool_Collateral_Before, '0')
    assert.equal(defaultPool_RawCollateral_Before, '0')
    assert.equal(defaultPool_LUSDDebt_Before, '0')

    // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
    //await priceFeed.setPrice('100000000000000000000');
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
    await relayer.updatePar();
    th.fastForwardTime(2 * 365 * 24 * 3600, web3.currentProvider)
    await relayer.updatePar();
    assert.isFalse(await th.checkRecoveryMode(contracts))

    bobICR = await troveManager.getCurrentICR(bob, await priceFeed.getPrice())
    console.log("bobICR", bobICR.toString())
    console.log("par", (await relayer.par()).toString())
    // close Bob's Trove
    await liquidations.liquidate(bob, { from: owner });

    // check after
    const defaultPool_Collateral_After = (await defaultPool.getCollateral()).toString()
    const defaultPool_RawCollateral_After = (await collateralToken.balanceOf(defaultPool.address)).toString()
    const defaultPool_LUSDDebt_After = (await defaultPool.getLUSDDebt()).toString()

    const defaultPool_Collateral = th.applyLiquidationFee(B_collateral)

    console.log("defaultPool_Collateral_After", defaultPool_Collateral_After.toString())
    console.log("defaultPool_Collateral", defaultPool_Collateral.toString())

    // TODO: should these be exactly equal?
    //assert.equal(defaultPool_Collateral_After, defaultPool_Collateral)
    assert.isAtMost(th.getDifference(defaultPool_Collateral_After, defaultPool_Collateral), 1)
    //assert.equal(defaultPool_RawCollateral_After, defaultPool_Collateral)
    assert.isAtMost(th.getDifference(defaultPool_RawCollateral_After, defaultPool_Collateral), 1)
    th.assertIsApproximatelyEqual(defaultPool_LUSDDebt_After, B_totalDebt)
  })

  it("liquidate(): removes the Trove's stake from the total stakes", async () => {
    // --- SETUP ---
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    // --- TEST ---

    // check totalStakes before
    const totalStakes_Before = (await rewards.totalStakes()).toString()
    assert.equal(totalStakes_Before, A_collateral.add(B_collateral))

    // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Close Bob's Trove
    await liquidations.liquidate(bob, { from: owner });

    // check totalStakes after
    const totalStakes_After = (await rewards.totalStakes()).toString()
    assert.equal(totalStakes_After, A_collateral)
  })
  it("liquidate(): removes the Trove's stake from the total stakes, rising par", async () => {
    // --- SETUP ---
    HCR = await troveManager.HCR()
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: HCR.add(toBN(dec(1, 16))), extraParams: { from: bob } })

    // --- TEST ---

    // check totalStakes before
    const totalStakes_Before = (await rewards.totalStakes()).toString()
    assert.equal(totalStakes_Before, A_collateral.add(B_collateral))

    // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
    //await priceFeed.setPrice('100000000000000000000');
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
    await relayer.updatePar();
    th.fastForwardTime(2 * 365 * 24 * 3600, web3.currentProvider)
    await relayer.updatePar();
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Close Bob's Trove
    await liquidations.liquidate(bob, { from: owner });

    // check totalStakes after
    const totalStakes_After = (await rewards.totalStakes()).toString()
    assert.equal(totalStakes_After, A_collateral)
  })

  it("liquidate(): Removes the correct trove from the TroveOwners array, and moves the last array element to the new empty slot", async () => {
    // --- SETUP --- 
    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol, Dennis, Erin open troves with consecutively decreasing collateral ratio
    await openShieldedTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(216, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(214, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(212, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: erin } })

    // At this stage, TroveOwners array should be: [W, A, B, C, D, E] 

    // Drop price
    await priceFeed.setPrice(dec(100, 18))

    const arrayLength_Before = await troveManager.getShieldedTroveOwnersCount()
    assert.equal(arrayLength_Before, 6)
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate carol
    await liquidations.liquidate(carol)

    // Check Carol no longer has an active trove
    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // Check length of array has decreased by 1
    const arrayLength_After = await troveManager.getShieldedTroveOwnersCount()
    assert.equal(arrayLength_After, 5)

    /* After Carol is removed from array, the last element (Erin's address) should have been moved to fill 
    the empty slot left by Carol, and the array length decreased by one.  The final TroveOwners array should be:
  
    [W, A, B, E, D] 

    Check all remaining troves in the array are in the correct order */
    const trove_0 = await troveManager.ShieldedTroveOwners(0)
    const trove_1 = await troveManager.ShieldedTroveOwners(1)
    const trove_2 = await troveManager.ShieldedTroveOwners(2)
    const trove_3 = await troveManager.ShieldedTroveOwners(3)
    const trove_4 = await troveManager.ShieldedTroveOwners(4)

    assert.equal(trove_0, whale)
    assert.equal(trove_1, alice)
    assert.equal(trove_2, bob)
    assert.equal(trove_3, erin)
    assert.equal(trove_4, dennis)

    // Check correct indices recorded on the active trove structs
    const whale_arrayIndex = (await troveManager.Troves(whale))[4]
    const alice_arrayIndex = (await troveManager.Troves(alice))[4]
    const bob_arrayIndex = (await troveManager.Troves(bob))[4]
    const dennis_arrayIndex = (await troveManager.Troves(dennis))[4]
    const erin_arrayIndex = (await troveManager.Troves(erin))[4]

    // [W, A, B, E, D] 
    assert.equal(whale_arrayIndex, 0)
    assert.equal(alice_arrayIndex, 1)
    assert.equal(bob_arrayIndex, 2)
    assert.equal(erin_arrayIndex, 3)
    assert.equal(dennis_arrayIndex, 4)
  })

  it("liquidate(): updates the snapshots of total stakes and total collateral", async () => {
    // --- SETUP ---
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    // --- TEST ---

    // check snapshots before 
    const totalStakesSnapshot_Before = (await rewards.totalStakesSnapshot()).toString()
    const totalCollateralSnapshot_Before = (await rewards.totalCollateralSnapshot()).toString()
    assert.equal(totalStakesSnapshot_Before, '0')
    assert.equal(totalCollateralSnapshot_Before, '0')

    // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // close Bob's Trove.  His ether*0.995 and LUSD should be added to the DefaultPool.
    await liquidations.liquidate(bob, { from: owner });

    /* check snapshots after. Total stakes should be equal to the  remaining stake then the system: 
    10 ether, Alice's stake.
     
    Total collateral should be equal to Alice's collateral plus her pending collateral reward (Bob's collaterale*0.995 ether), earned
    from the liquidation of Bob's Trove */
    const totalStakesSnapshot_After = await rewards.totalStakesSnapshot()
    const totalCollateralSnapshot_After = await rewards.totalCollateralSnapshot()

    assert.isTrue(totalStakesSnapshot_After.eq(A_collateral))
    //assert.isTrue(totalCollateralSnapshot_After.eq(A_collateral.add(th.applyLiquidationFee(B_collateral))))
    // TODO fix off by one
    assert.isAtMost(th.getDifference(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral))), 1)

  })
  it("liquidate(): updates the snapshots of total stakes and total collateral, rising par", async () => {
    // --- SETUP ---
    HCR = await troveManager.HCR()
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: HCR.add(toBN(dec(1, 16))), extraParams: { from: bob } })

    // --- TEST ---

    // check snapshots before 
    const totalStakesSnapshot_Before = (await rewards.totalStakesSnapshot()).toString()
    const totalCollateralSnapshot_Before = (await rewards.totalCollateralSnapshot()).toString()
    assert.equal(totalStakesSnapshot_Before, '0')
    assert.equal(totalCollateralSnapshot_Before, '0')

    // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
    //await priceFeed.setPrice('100000000000000000000');
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
    await relayer.updatePar();
    th.fastForwardTime(2 * 365 * 24 * 3600, web3.currentProvider)
    await relayer.updatePar();
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // close Bob's Trove.  His ether*0.995 and LUSD should be added to the DefaultPool.
    await liquidations.liquidate(bob, { from: owner });

    /* check snapshots after. Total stakes should be equal to the  remaining stake then the system: 
    10 ether, Alice's stake.
     
    Total collateral should be equal to Alice's collateral plus her pending collateral reward (Bob's collateral*0.995 ether), earned
    from the liquidation of Bob's Trove */
    const totalStakesSnapshot_After = (await rewards.totalStakesSnapshot()).toString()
    const totalCollateralSnapshot_After = (await rewards.totalCollateralSnapshot()).toString()

    assert.equal(totalStakesSnapshot_After, A_collateral)
    // TODO fix off by one
    //assert.equal(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral)))
    assert.isAtMost(th.getDifference(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral))), 1)
  })

  it("liquidate(): updates the L_Coll and L_LUSDDebt reward-per-unit-staked totals", async () => {
    await contracts.rateControl.setCoBias(0)
    HCR = await troveManager.HCR()
    // --- SETUP ---
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: alice } })
    const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })
    const { collateral: C_collateral, totalDebt: C_totalDebt } = await openShieldedTrove({ ICR: HCR.add(toBN(dec(1, 16))), extraParams: { from: carol } })

    // --- TEST ---

    // price drops to 1CollateralToken:100LUSD, reducing Carols's ICR below MCR
    await priceFeed.setPrice('100000000000000000000');
    assert.isFalse(await th.checkRecoveryMode(contracts))
    const L_Coll_BeforeCarolLiquidated = await rewards.L_Coll()
    const L_LUSDDebt_BeforeCarolLiquidated = await rewards.L_LUSDDebt()

    // close Carol's Trove.  

    assert.isTrue(await sortedShieldedTroves.contains(carol))
    await liquidations.liquidate(carol, { from: owner });
    assert.isFalse(await sortedShieldedTroves.contains(carol))
    // Carol's collateral*0.995 and LUSD should be added to the DefaultPool.
    const L_Coll_AfterCarolLiquidated = await rewards.L_Coll()
    const L_LUSDDebt_AfterCarolLiquidated = await rewards.L_LUSDDebt()

    // Debug values for understanding the issue
    const totalStakes_afterCarol = await rewards.totalStakes()
    const A_stake_afterCarol = await troveManager.getTroveStake(alice)
    const B_stake_afterCarol = await troveManager.getTroveStake(bob)
    const expectedLiquidationFee = C_collateral.div(toBN(200))
    const liquidatedCollAfterFee = C_collateral.sub(expectedLiquidationFee) //th.applyLiquidationFee(C_collateral)

    const L_Coll_expected_1 = liquidatedCollAfterFee.mul(mv._1e18BN).div(totalStakes_afterCarol)
    const L_LUSDDebt_expected_1 = C_totalDebt.mul(mv._1e18BN).div(totalStakes_afterCarol)

    console.log("L_Coll_AfterCarolLiquidated", L_Coll_AfterCarolLiquidated.toString())
    console.log("L_Coll_expected_1", L_Coll_expected_1.toString())    
      
    assert.isAtMost(th.getDifference(L_Coll_AfterCarolLiquidated, L_Coll_expected_1), 100)
    assert.isAtMost(th.getDifference(L_LUSDDebt_AfterCarolLiquidated, L_LUSDDebt_expected_1), 100)

    b_coll = (await troveManager.getEntireDebtAndColl(bob))[1]
    b_coll_pending = (await troveManager.getEntireDebtAndColl(bob))[3]
    b_exp = B_collateral.mul(L_Coll_expected_1).div(mv._1e18BN)
    /*
    console.log("b_coll", b_coll.toString())
    console.log("b_exp", b_exp.toString())
    console.log("b_coll_pending", b_coll_pending.toString())
    */

    // Bob now withdraws LUSD, bringing his ICR to 1.11
    const { increasedTotalDebt: B_increasedTotalDebt } = await withdrawLUSD({ ICR: HCR.add(toBN(dec(1, 16))), extraParams: { from: bob } })
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // price drops to 1CollateralToken:50LUSD, reducing Bob's ICR below MCR
    await priceFeed.setPrice(dec(50, 18));
    const price = await priceFeed.getPrice()

    assert.isTrue(await sortedShieldedTroves.contains(bob))
    tx = await liquidations.liquidate(bob, { from: owner });
    assert.isFalse(await sortedShieldedTroves.contains(bob))


    /* Alice now has all the active stake. totalStakes in the system is now 10 collateral token.
  
   Bob's pending collateral reward and debt reward are applied to his Trove
   before his liquidation.
   His total collateral*0.995 and debt are then added to the DefaultPool. 
   
   The system rewards-per-unit-staked should now be:
   
   L_Coll = (0.995 / 20) + (10.4975*0.995  / 10) = 1.09425125 CollateralToken
   L_LUSDDebt = (180 / 20) + (890 / 10) = 98 LUSD */
    const L_Coll_AfterBobLiquidated = await rewards.L_Coll()
    const L_LUSDDebt_AfterBobLiquidated = await rewards.L_LUSDDebt()


      const L_Coll_expected_2 = L_Coll_expected_1.add(th.applyLiquidationFee(B_collateral.add(B_collateral.mul(L_Coll_expected_1).div(mv._1e18BN))).mul(mv._1e18BN).div(A_collateral))
    const L_LUSDDebt_expected_2 = L_LUSDDebt_expected_1.add(B_totalDebt.add(B_increasedTotalDebt).add(B_collateral.mul(L_LUSDDebt_expected_1).div(mv._1e18BN)).mul(mv._1e18BN).div(A_collateral))
   
    assert.isAtMost(th.getDifference(L_Coll_AfterBobLiquidated, L_Coll_expected_2), 100)
    assert.isAtMost(th.getDifference(L_LUSDDebt_AfterBobLiquidated, L_LUSDDebt_expected_2), 100)
  })


  it("liquidate(): Liquidates undercollateralized trove if there are two troves in the system", async () => {
    await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: bob, value: dec(100, 'ether') } })

    // Alice creates a single trove with 0.7 CT and a debt of 70 LUSD, and provides 10 LUSD to SP
    const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

    // Alice proves 10 LUSD to SP
    await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, { from: alice })

    // Set CollateralToken:USD price to 105
    await priceFeed.setPrice('105000000000000000000')
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    const alice_ICR = (await troveManager.getCurrentICR(alice, price)).toString()
    assert.equal(alice_ICR, '1050000000000000000')
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lte(mv._MCR))

    const activeTrovesCount_Before = await troveManager.getShieldedTroveOwnersCount()

    assert.equal(activeTrovesCount_Before, 2)
    assert.isFalse(await th.checkRecoveryMode(contracts))
    console.log("before liq")
    console.log("bob actual debt", (await contracts.troveManager.getTroveActualDebt(bob)).toString())
    console.log("bob entire debt", (await contracts.troveManager.getEntireDebtAndColl(bob))[0].toString())
    console.log("default sh pool coll", (await contracts.defaultPool.getCollateral()).toString())
    console.log("alice actual debt", (await contracts.troveManager.getTroveActualDebt(bob)).toString())
    console.log("debt", (await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())).toString())
    console.log("supply", (await contracts.lusdToken.totalSupply()).toString())
     
    // Liquidate
    tx = await liquidations.liquidate(alice, { from: owner })

    // Check Alice's trove is removed, and bob remains
    const activeTrovesCount_After = await troveManager.getShieldedTroveOwnersCount()
    assert.equal(activeTrovesCount_After, 1)

    const alice_isInSortedList = await sortedShieldedTroves.contains(alice)
    assert.isFalse(alice_isInSortedList)

    const bob_isInSortedList = await sortedShieldedTroves.contains(bob)
    assert.isTrue(bob_isInSortedList)

    /*
    console.log("after liq")
    console.log("bob actual debt", (await contracts.troveManager.getTroveActualDebt(bob)).toString())
    console.log("bob entire debt", (await contracts.troveManager.getEntireDebtAndColl(bob))[0].toString())
    console.log("default sh pool coll", (await contracts.defaultPool.getCollateral()).toString())
    console.log("alice actual debt", (await contracts.troveManager.getTroveActualDebt(alice)).toString())
    */
    //console.log("debt", (await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())).toString())
    //console.log("supply", (await contracts.lusdToken.totalSupply()).toString())

  })

  it("liquidate(): reverts if trove is non-existent", async () => {
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

    assert.equal(await troveManager.getTroveStatus(carol), 0) // check trove non-existent

    assert.isFalse(await sortedShieldedTroves.contains(carol))
    assert.isFalse(await th.checkRecoveryMode(contracts))

    try {
      const txCarol = await liquidations.liquidate(carol)

      assert.isFalse(txCarol.receipt.status)
    } catch (err) {
      assert.include(err.message, "revert")
      assert.include(err.message, "Trove does not exist or is closed")
    }
  })

  it("liquidate(): reverts if trove has been closed", async () => {
    await openShieldedTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

    assert.isTrue(await sortedShieldedTroves.contains(carol))

    // price drops, Carol ICR falls below MCR
    await priceFeed.setPrice(dec(100, 18))

    // Carol liquidated, and her trove is closed
    const txCarol_L1 = await liquidations.liquidate(carol)
    assert.isTrue(txCarol_L1.receipt.status)

    assert.isFalse(await sortedShieldedTroves.contains(carol))

    assert.equal(await troveManager.getTroveStatus(carol), 3)  // check trove closed by liquidation
    assert.isFalse(await th.checkRecoveryMode(contracts))

    try {
      const txCarol_L2 = await liquidations.liquidate(carol)

      assert.isFalse(txCarol_L2.receipt.status)
    } catch (err) {
      assert.include(err.message, "revert")
      assert.include(err.message, "Trove does not exist or is closed")
    }
  })

  it("liquidate(): does nothing if trove has >= 110% ICR", async () => {
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: whale } })
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: bob } })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    const price = await priceFeed.getPrice()

    // Check Bob's ICR > 110%
    const bob_ICR = await troveManager.getCurrentICR(bob, price)
    assert.isTrue(bob_ICR.gte(mv._MCR))
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Attempt to liquidate bob
    await assertRevert(liquidations.liquidate(bob), "Liquidations: nothing to liquidate")

    // Check bob active, check whale active
    assert.isTrue((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    assert.equal(TCR_Before, TCR_After)
    assert.equal(listSize_Before, listSize_After)
  })

  it("liquidate(): surplus collateral if liquidated above penalty", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate bob
    tx = await liquidations.liquidate(bob)
    const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    const offsetActualBaseDebt = th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Offset", "actualBaseDebt");
    const offsetBaseDebt = th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Offset", "baseDebt");
    const offsetBaseColl = th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Offset", "baseColl");

    console.log("offsetActualBaseDebt", offsetActualBaseDebt.toString())
    console.log("offsetBaseDebt", offsetBaseDebt.toString())
    console.log("offsetBaseColl", offsetBaseColl.toString())

    gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(collGasComp.eq(gasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    console.log("bobCollateral", bobCollateral.toString())
    console.log("liquidatedColl", liquidatedColl.toString())
    console.log("ethGain", ethGain.toString())
    assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 98000)

    // Check bob in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    // bob has been removed from list
    assert.isTrue(listSize_Before > listSize_After)

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))

    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

    // bob claims surplus collateral
    tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})

    // check bob eth difference, considering eth used in tx
    txCost = th.ethUsed(tx)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
  })
  
  it("liquidate(): surplus collateral if liquidated by par above penalty, sp", async () => {
    // disable rates to ensure ICR change is from par only
    await contracts.rateControl.setCoBias(0)
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: bobCollateral, lusdAmount: bobLUSDAmount} = await openShieldedTrove({ ICR: await troveManager.HCR(), extraParams: { from: bob } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    // this will raise par, increasing ICR
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(1).mul(ONE_CENT)));
    await relayer.updateRateAndPar()

    // fast forward the right amount to get bob's icr liquidatable but w/ surplus
    th.fastForwardTime(110 * 24 * 3600, web3.currentProvider)
    await relayer.updateRateAndPar()
    await troveManager.drip()

    price = await priceFeed.getPrice()

    bobICR = await troveManager.getCurrentICR(bob, price)

    // The minimum liq ratio to receive collateral surplus is slightly higher than liq. penalty
    // since the collGas compensation is not included in liquidated coll
    minLiqRatio = (await liquidations.LIQUIDATION_PENALTY()).mul(toBN(dec(1, 18))).div(toBN(dec(995, 15)))

    console.log("bobICR " + bobICR)
    console.log("minLiqRatio " + minLiqRatio)
    assert.isTrue(bobICR.gt(minLiqRatio))

    assert.isTrue(bobICR.lt((await troveManager.MCR())))
    assert.isTrue(bobICR.gt((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate bob
    tx = await liquidations.liquidate(bob)
    const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)

    gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(collGasComp.eq(gasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)

    // Check bob in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    // bob has been removed from list
    assert.isTrue(listSize_Before > listSize_After)

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))

    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

    // bob claims surplus collateral
    tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})

    // check bob eth difference, considering eth used in tx
    txCost = th.ethUsed(tx)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
  })
  it("liquidate(): surplus collateral if liquidated by drip above penalty", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: await troveManager.HCR(), extraParams: { from: bob } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    //price = await priceFeed.getPrice()
   
    price = dec(170, 18)
    await priceFeed.setPrice(price)
    bobICR = await troveManager.getCurrentICR(bob, price)
    console.log("bobICR", bobICR.toString())

   
    // first update doesn't update anything
    await relayer.updateRateAndPar()

    // Stil above MCR
    await troveManager.drip()
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await troveManager.MCR())))

    // Long time passes so new interest will push bob under MCR
    th.fastForwardTime(365 * 24 * 3600, web3.currentProvider)
    await relayer.updateRateAndPar()
    await troveManager.drip()

    bobICR = await troveManager.getCurrentICR(bob, price)
    console.log("bobICR", bobICR.toString())

    // liquidate bob
    tx = await liquidations.liquidate(bob)

    const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)

    gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(collGasComp.eq(gasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)

    // Check bob in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    // bob has been removed from list
    assert.isTrue(listSize_Before > listSize_After)

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))

    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

    // bob claims surplus collateral
    tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})

    // check bob eth difference, considering eth used in tx
    txCost = th.ethUsed(tx)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")

  })
  it("liquidate(): surplus collateral if liquidated above penalty, redistribution", async () => {
    // set liq penalty to less than MCR
    await liquidations.setLiqPenaltyRedist(toBN(dec(106, 16)));
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()
    price = dec(100, 18)
    await priceFeed.setPrice(price)

    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY_REDIST())))
   
    // liquidate bob
    tx = await liquidations.liquidate(bob)

    const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)

    gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(collGasComp.eq(gasComp))

    // Check bob in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(bob)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    // bob has been removed from list
    assert.isTrue(listSize_Before > listSize_After)
    // bob has surplus collateral
    // bobSurplus = await contracts.collSurplusPool.getCollateral(bob)

    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))

    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

    // bob claims surplus collateral
    tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})

    // check bob eth difference, considering eth used in tx
    txCost = th.ethUsed(tx)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
  })
  it("liquidate(): surplus collateral if liquidated by par above penalty, redistribution", async () => {
    // disable rates to ensure ICR change is from par only
    await contracts.rateControl.setCoBias(0)
    // set liq penalty to less than MCR
    await liquidations.setLiqPenaltyRedist(toBN(dec(106, 16)));


    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: await troveManager.HCR(), extraParams: { from: bob } })

    // Need to provideToSp since interest cannot accru when SP is empty. interest is needed to make bob < MCR
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    // open another trove so drip() can now reduce bob's ICR
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    // withdraw so redistribution will happen w/ next liquidation
    await stabilityPool.withdrawFromSP(spDeposit.sub(toBN(dec(1,18))), { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    // this will raise par, increasing ICR
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(5).mul(ONE_CENT)));
    await relayer.updatePar()

    th.fastForwardTime(65 * 24 * 3600, web3.currentProvider)
    await relayer.updatePar()
    price = await priceFeed.getPrice()

    /*
    // call drip before liq to find correct ICR for this test case
    await troveManager.drip()
    console.log("bob icr", (await troveManager.getCurrentICR(bob, price)).toString())

    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY_REDIST())))
    */

    // liquidate bob
    tx = await liquidations.liquidate(bob)

    const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)

    gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(collGasComp.eq(gasComp))

    // Check bob in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    // bob has been removed from list
    assert.isTrue(listSize_Before > listSize_After)

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))

    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

    // bob claims surplus collateral
    tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})

    // check bob eth difference, considering eth used in tx
    txCost = th.ethUsed(tx)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
  })
  it("liquidate(): no surplus collateral if liquidated below penalty", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: toBN(dec(209, 16)), extraParams: { from: bob } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate bob
    tx = await liquidations.liquidate(bob)

    const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)

    gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(collGasComp.eq(gasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)

    // Check bob in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    // bob has been removed from list
    assert.isTrue(listSize_Before > listSize_After)

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.eq(toBN('0')))

    assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))

    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

    // bob claims surplus collateral
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
  })
  it("liquidate(): no surplus collateral if liquidated below penalty, redistribution", async () => {
    await liquidations.setLiqPenaltyRedist(toBN(dec(109, 16)));
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: toBN(dec(209, 16)), extraParams: { from: bob } })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await liquidations.LIQUIDATION_PENALTY_REDIST())))

    // liquidate bob
    tx = await liquidations.liquidate(bob)

    const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)

    gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(collGasComp.eq(gasComp))

    // Check bob in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    // bob has been removed from list
    assert.isTrue(listSize_Before > listSize_After)

    // bob has no surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.eq(toBN('0')))

    assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))

    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

    // bob can't claim surplus collateral
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
  })
  it("liquidate(): no surplus collateral if liquidated by par below penalty", async () => {
    // disable rates to ensure ICR change is from par only
    await contracts.rateControl.setCoBias(0)
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: await troveManager.HCR(), extraParams: { from: bob } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    // this will raise par, increasing ICR
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(5).mul(ONE_CENT)));
    await relayer.updatePar()
    
    // par rate of change is bounded so we need a lot of time to make a par change large
    // enough to cause ICR < LIQ_PENALTY
    await th.fastForwardTime(10 * timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider)

    await relayer.updatePar()

    price = await priceFeed.getPrice()

    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate bob
    tx = await liquidations.liquidate(bob)

    const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)

    gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(collGasComp.eq(gasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 109000)

    // Check bob in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    // bob has been removed from list
    assert.isTrue(listSize_Before > listSize_After)

    // bob has no surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.eq(toBN('0')))

    assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))

    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

    // bob claims surplus collateral
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
  })
  it("liquidate(): no surplus collateral if liquidated by rate below penalty", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: await troveManager.HCR(), extraParams: { from: bob } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    await relayer.updateRate()
    // we need a lot of time to make dripped interest to cause ICR < LIQ_PENALTY
    await th.fastForwardTime(45*timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await relayer.updateRate()

    price = await priceFeed.getPrice()

    // liquidate bob
    tx = await liquidations.liquidate(bob)


    const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)

    gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(collGasComp.eq(gasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 107000)

    // Check bob in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    // bob has been removed from list
    assert.isTrue(listSize_Before > listSize_After)

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.eq(toBN('0')))

    assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))

    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

    // bob claims surplus collateral
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
  })
  it("liquidate(): no surplus collateral if liquidated at penalty", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: bob } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).eq((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate bob
    tx = await liquidations.liquidate(bob)

    const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)

    gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(collGasComp.eq(gasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)

    // Check bob in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    // bob has been removed from list
    assert.isTrue(listSize_Before > listSize_After)

    // bob has no surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.eq(toBN('0')))

    assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))

    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

    // bob claims surplus collateral
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))

  })
  it("liquidate(): surplus collateral if A,B,C liquidated above penalty", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: aliceCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
    const {collateral: carolCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })


    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = await sortedShieldedTroves.getSize()

    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue((await troveManager.getCurrentICR(alice, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(alice, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(carol, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(carol, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate alice
    tx_alice = await liquidations.liquidate(alice)
    const [aliceLiquidatedDebt, aliceLiquidatedColl, aliceCollGasComp, aliceLusdGasComp] = th.getEmittedLiquidationValues(tx_alice)
    aliceGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(aliceCollGasComp.eq(aliceGasComp))

    // liquidate bob
    tx_bob = await liquidations.liquidate(bob)
    const [bobLiquidatedDebt, bobLiquidatedColl, bobCollGasComp, bobLusdGasComp] = th.getEmittedLiquidationValues(tx_bob)
    bobGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(bobCollGasComp.eq(bobGasComp))

    // liquidate carol
    tx_carol = await liquidations.liquidate(carol)
    const [carolLiquidatedDebt, carolLiquidatedColl, carolCollGasComp, carolLusdGasComp] = th.getEmittedLiquidationValues(tx_carol)
    carolGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(carolCollGasComp.eq(carolGasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl), ethGain), 100000)

    // Check alice, bob, carol in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(alice)))
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isFalse((await sortedShieldedTroves.contains(carol)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = await sortedShieldedTroves.getSize()

    // alice, bob, carol have been removed from list
    assert.isTrue(listSize_Before == 4)
    assert.isTrue(listSize_After == 1)

    // alice has surplus collateral
    aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
    assert.isTrue(aliceSurplus.gt(toBN('0')))

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    // carol has surplus collateral
    carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
    assert.isTrue(carolSurplus.gt(toBN('0')))

    // check total surplus
    totalSurplus = await collSurplusPool.getCollateral()
    assert.isTrue(totalSurplus.eq(aliceSurplus.add(bobSurplus).add(carolSurplus)))

    assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
    assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
    assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))

    aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 

    // alice claims surplus collateral
    tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
    const aliceAmount = th.getRawEventArgByName(tx_alice_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
    assert.isTrue(toBN(aliceAmount).eq(aliceSurplus))
    // bob claims surplus collateral
    tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    const bobAmount = th.getRawEventArgByName(tx_bob_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
    assert.isTrue(toBN(bobAmount).eq(bobSurplus))
    // carol claims surplus collateral
    tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
    const carolAmount = th.getRawEventArgByName(tx_carol_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
    assert.isTrue(toBN(carolAmount).eq(carolSurplus))

    // check alice eth difference, considering eth used in tx
    aliceTxCost = th.ethUsed(tx_alice_claim)
    aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
    aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)

    assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))

    // alice 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")

    // check bob eth difference, considering eth used in tx
    bobTxCost = th.ethUsed(tx_bob_claim)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // bob 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")

    // check carol eth difference, considering eth used in tx
    carolTxCost = th.ethUsed(tx_carol_claim)
    carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
    carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)

    assert.isTrue(carolBalanceDiff.eq(carolSurplus))

    // carol 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")

    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))

  })
  it("liquidateTroves(): A,B,C same size troves. surplus collateral if A,B,C liquidated above penalty", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: aliceCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
    const {collateral: carolCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })


    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = await sortedShieldedTroves.getSize()

    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue((await troveManager.getCurrentICR(alice, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(alice, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(carol, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(carol, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate all
    tx_liq = await liquidations.liquidateTroves(3)
    const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
    totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(totalCollGasComp.eq(totalGasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)

    // Check alice, bob, carol in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(alice)))
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isFalse((await sortedShieldedTroves.contains(carol)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = await sortedShieldedTroves.getSize()

    // alice, bob, carol have been removed from list
    assert.isTrue(listSize_Before == 4)
    assert.isTrue(listSize_After == 1)

    // alice has surplus collateral
    aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
    assert.isTrue(aliceSurplus.gt(toBN('0')))

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    // carol has surplus collateral
    carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
    assert.isTrue(carolSurplus.gt(toBN('0')))

    // check total surplus
    totalSurplus = await collSurplusPool.getCollateral()
    assert.isTrue(totalSurplus.eq(aliceSurplus.add(bobSurplus).add(carolSurplus)))

    aliceLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
    bobLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
    carolLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
    aliceCollGasComp = totalGasComp.div(toBN('3'))
    bobCollGasComp = totalGasComp.div(toBN('3'))
    carolCollGasComp = totalGasComp.div(toBN('3'))

    assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
    assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
    assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))

    aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 

    // alice claims surplus collateral
    tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
    // bob claims surplus collateral
    tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    // bob claims surplus collateral
    tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})

    // check alice eth difference, considering eth used in tx
    aliceTxCost = th.ethUsed(tx_alice_claim)
    aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
    aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)

    assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))

    // alice 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")

    // check bob eth difference, considering eth used in tx
    bobTxCost = th.ethUsed(tx_bob_claim)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // bob 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")

    // check carol eth difference, considering eth used in tx
    carolTxCost = th.ethUsed(tx_carol_claim)
    carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
    carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)

    assert.isTrue(carolBalanceDiff.eq(carolSurplus))

    // carol 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))

  })
  it("batchLiquidate(): A,B,C same size troves. surplus collateral if A,B,C liquidated above penalty", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    const {collateral: aliceCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
    const {collateral: bobCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
    const {collateral: carolCollateral} = await openShieldedTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })


    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = await sortedShieldedTroves.getSize()

    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue((await troveManager.getCurrentICR(alice, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(alice, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(carol, dec(100, 18))).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(carol, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate all
    //tx_liq = await liquidations.liquidateTroves(3)
    tx_liq = await liquidations.batchLiquidate([alice, bob, carol])
    const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
    totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(totalCollGasComp.eq(totalGasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)

    // Check alice, bob, carol in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(alice)))
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isFalse((await sortedShieldedTroves.contains(carol)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = await sortedShieldedTroves.getSize()

    // alice, bob, carol have been removed from list
    assert.isTrue(listSize_Before == 4)
    assert.isTrue(listSize_After == 1)

    // alice has surplus collateral
    aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
    assert.isTrue(aliceSurplus.gt(toBN('0')))

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    // carol has surplus collateral
    carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
    assert.isTrue(carolSurplus.gt(toBN('0')))

    // check total surplus
    totalSurplus = await collSurplusPool.getCollateral()
    assert.isTrue(totalSurplus.eq(aliceSurplus.add(bobSurplus).add(carolSurplus)))

    aliceLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
    bobLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
    carolLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
    aliceCollGasComp = totalGasComp.div(toBN('3'))
    bobCollGasComp = totalGasComp.div(toBN('3'))
    carolCollGasComp = totalGasComp.div(toBN('3'))

    assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
    assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
    assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))

    aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 

    // alice claims surplus collateral
    tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
    // bob claims surplus collateral
    tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    // carol claims surplus collateral
    tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})

    // check alice eth difference, considering eth used in tx
    aliceTxCost = th.ethUsed(tx_alice_claim)
    aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
    aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)

    assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))

    // alice 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")

    // check bob eth difference, considering eth used in tx
    bobTxCost = th.ethUsed(tx_bob_claim)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // bob 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")

    // check carol eth difference, considering eth used in tx
    carolTxCost = th.ethUsed(tx_carol_claim)
    carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
    carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)

    assert.isTrue(carolBalanceDiff.eq(carolSurplus))

    // carol 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))

  })
  it("liquidateTroves(): A,B,C different size troves, different ICRs. A,B,C have surplus collateral liquidated above penalty", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })

    const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openShieldedTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
    const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openShieldedTrove({ ICR: toBN(dec(216, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
    const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openShieldedTrove({ ICR: toBN(dec(219, 16)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = await sortedShieldedTroves.getSize()


    //console.log("entire debt", (await troveManager.getEntireSystemActualDebt()).toString())
    entireDebt = (await troveManager.getTroveActualDebt(alice)).add((await troveManager.getTroveActualDebt(bob)))
          .add((await troveManager.getTroveActualDebt(carol))).add((await troveManager.getTroveActualDebt(whale)))

    price = dec(100, 18)
    await priceFeed.setPrice(price)

    aliceICR = await troveManager.getCurrentICR(alice, price)
    bobICR = await troveManager.getCurrentICR(bob, price)
    carolICR = await troveManager.getCurrentICR(carol, price)
    console.log("aliceICR", aliceICR.toString())
    console.log("bobICR", bobICR.toString())
    console.log("carolICR", carolICR.toString())

    // ensure trove owners will have surplus collateral after liquidation
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).gt((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate all
    tx_liq = await liquidations.liquidateTroves(3)
    //tx_liq = await liquidations.liquidate(alice)
    const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)

    //const [stakeDrip, spDrip] = th.getEmittedDripValues(contracts,tx_liq)
    spDrip = toBN(th.getRawEventArgByName(tx_liq, troveManagerInterface, troveManager.address, "Drip", "_spInterest"))
    stakeDrip = toBN(th.getRawEventArgByName(tx_liq, troveManagerInterface, troveManager.address, "Drip", "_stakeInterest"))

    totalInterest = stakeDrip.add(spDrip)
    entireDebtDrip = entireDebt.add(totalInterest)
    
    aliceDebtLiq = aliceDebt.add((totalInterest.mul(aliceDebt).div(entireDebt)))
    bobDebtLiq = bobDebt.add((totalInterest.mul(bobDebt).div(entireDebt)))
    carolDebtLiq = carolDebt.add((totalInterest.mul(carolDebt).div(entireDebt)))

    console.log("totalLiquidatedDebt", totalLiquidatedDebt.toString())

    assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)

    totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(totalCollGasComp.eq(totalGasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 102000)

    // Check alice, bob, carol in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(alice)))
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isFalse((await sortedShieldedTroves.contains(carol)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = await sortedShieldedTroves.getSize()

    // alice, bob, carol have been removed from list
    assert.isTrue(listSize_Before == 4)
    assert.isTrue(listSize_After == 1)

    // alice has surplus collateral
    aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
    assert.isTrue(aliceSurplus.gt(toBN('0')))

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    // carol has surplus collateral
    carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
    assert.isTrue(carolSurplus.gt(toBN('0')))

    par = await relayer.par()
    aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))

    // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
    // so this can be off by a few wei
    expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl) // totalLiquidatedDebt.mul(par).mul((await troveManager.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    //expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)

    //console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
    console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
    console.log("totalLiquidatedColl", totalLiquidatedColl.toString())

    assert.isTrue(totalLiquidatedColl.eq(expTotalLiquidatedColl))
    // // verify total liq coll
    // assert.isAtMost(th.getDifference(expTotalLiquidatedColl, totalLiquidatedColl), 2)

    // verift total gas comp
    aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
    bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())

    assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))

    // verify collateral invariant
    assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
    assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
    assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))

    aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 

    // alice claims surplus collateral
    tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
    // bob claims surplus collateral
    tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    // bob claims surplus collateral
    tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})

    // check alice eth difference, considering eth used in tx
    aliceTxCost = th.ethUsed(tx_alice_claim)
    aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
    aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)

    assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))

    // alice 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")

    // check bob eth difference, considering eth used in tx
    bobTxCost = th.ethUsed(tx_bob_claim)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // bob 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")

    // check carol eth difference, considering eth used in tx
    carolTxCost = th.ethUsed(tx_carol_claim)
    carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
    carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)

    assert.isTrue(carolBalanceDiff.eq(carolSurplus))

    // carol 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
  })
  it("batchLiquidate(): A,B,C different size troves, different ICRs. A,B,C have surplus collateral liquidated above penalty", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })

    const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openShieldedTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
    const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openShieldedTrove({ ICR: toBN(dec(216, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
    const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openShieldedTrove({ ICR: toBN(dec(219, 16)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = await sortedShieldedTroves.getSize()


    //console.log("entire debt", (await troveManager.getEntireSystemActualDebt()).toString())
    entireDebt = (await troveManager.getTroveActualDebt(alice)).add((await troveManager.getTroveActualDebt(bob)))
          .add((await troveManager.getTroveActualDebt(carol))).add((await troveManager.getTroveActualDebt(whale)))

    price = dec(100, 18)
    await priceFeed.setPrice(price)


    aliceICR = await troveManager.getCurrentICR(alice, price)
    bobICR = await troveManager.getCurrentICR(bob, price)
    carolICR = await troveManager.getCurrentICR(carol, price)
    console.log("aliceICR", aliceICR.toString())
    console.log("bobICR", bobICR.toString())
    console.log("carolICR", carolICR.toString())

    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).gt((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate all
    tx_liq = await liquidations.batchLiquidate([alice, bob, carol])
    //tx_liq = await liquidations.liquidate(alice)
    const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)

    //const [stakeDrip, spDrip] = th.getEmittedDripValues(contracts,tx_liq)
    spDrip = toBN(th.getRawEventArgByName(tx_liq, troveManagerInterface, troveManager.address, "Drip", "_spInterest"))
    stakeDrip = toBN(th.getRawEventArgByName(tx_liq, troveManagerInterface, troveManager.address, "Drip", "_stakeInterest"))

    totalInterest = stakeDrip.add(spDrip)
    
    aliceDebtLiq = aliceDebt.add((totalInterest.mul(aliceDebt).div(entireDebt)))
    bobDebtLiq = bobDebt.add((totalInterest.mul(bobDebt).div(entireDebt)))
    carolDebtLiq = carolDebt.add((totalInterest.mul(carolDebt).div(entireDebt)))

    //assert.isTrue(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq).eq(totalLiquidatedDebt))
    assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)

    totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(totalCollGasComp.eq(totalGasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100030)

    // Check alice, bob, carol in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(alice)))
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isFalse((await sortedShieldedTroves.contains(carol)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = await sortedShieldedTroves.getSize()

    // alice, bob, carol have been removed from list
    assert.isTrue(listSize_Before == 4)
    assert.isTrue(listSize_After == 1)

    // alice has surplus collateral
    aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
    assert.isTrue(aliceSurplus.gt(toBN('0')))

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    // carol has surplus collateral
    carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
    assert.isTrue(carolSurplus.gt(toBN('0')))

    par = await relayer.par()
    aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))

    // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
    // so this can be off by a few wei
    //expTotalLiquidatedColl = totalLiquidatedDebt.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)

    /*
    console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
    console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
    console.log("totalLiquidatedColl", totalLiquidatedColl.toString())
    */

    // verify total liq coll
    assert.isTrue(expTotalLiquidatedColl.eq(totalLiquidatedColl))

    // verift total gas comp
    aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
    bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())

    assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))

    // verify collateral invariant
    assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
    assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
    assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))

    aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 

    // alice claims surplus collateral
    tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
    // bob claims surplus collateral
    tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    // bob claims surplus collateral
    tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})

    // check alice eth difference, considering eth used in tx
    aliceTxCost = th.ethUsed(tx_alice_claim)
    aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
    aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)

    assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))

    // alice 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")

    // check bob eth difference, considering eth used in tx
    bobTxCost = th.ethUsed(tx_bob_claim)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // bob 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")

    // check carol eth difference, considering eth used in tx
    carolTxCost = th.ethUsed(tx_carol_claim)
    carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
    carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)

    assert.isTrue(carolBalanceDiff.eq(carolSurplus))

    // carol 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
  })
  it("liquidateTroves(): A,B,C different size troves, different ICRs. Only A,B have surplus collateral", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })

    const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openShieldedTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
    const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openShieldedTrove({ ICR: toBN(dec(216, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
    const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = await sortedShieldedTroves.getSize()


    //console.log("entire debt", (await troveManager.getEntireSystemActualDebt()).toString())
    entireDebt = (await troveManager.getTroveActualDebt(alice)).add((await troveManager.getTroveActualDebt(bob)))
          .add((await troveManager.getTroveActualDebt(carol))).add((await troveManager.getTroveActualDebt(whale)))

    price = dec(100, 18)
    await priceFeed.setPrice(price)


    aliceICR = await troveManager.getCurrentICR(alice, price)
    bobICR = await troveManager.getCurrentICR(bob, price)
    carolICR = await troveManager.getCurrentICR(carol, price)
    console.log("aliceICR", aliceICR.toString())
    console.log("bobICR", bobICR.toString())
    console.log("carolICR", carolICR.toString())

    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt((await troveManager.MCR())))
    // check for eq here since drip() in liquidate will pull carol under the penalty 
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).eq((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate all
    tx_liq = await liquidations.liquidateTroves(3)
    //tx_liq = await liquidations.liquidate(alice)
    const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)

    //const [stakeDrip, spDrip] = th.getEmittedDripValues(contracts,tx_liq)
    spDrip = toBN(th.getRawEventArgByName(tx_liq, troveManagerInterface, troveManager.address, "Drip", "_spInterest"))
    stakeDrip = toBN(th.getRawEventArgByName(tx_liq, troveManagerInterface, troveManager.address, "Drip", "_stakeInterest"))

    totalInterest = stakeDrip.add(spDrip)
    
    aliceDebtLiq = aliceDebt.add((totalInterest.mul(aliceDebt).div(entireDebt)))
    bobDebtLiq = bobDebt.add((totalInterest.mul(bobDebt).div(entireDebt)))
    carolDebtLiq = carolDebt.add((totalInterest.mul(carolDebt).div(entireDebt)))

    //assert.isTrue(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq).eq(totalLiquidatedDebt))
    assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)

    totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(totalCollGasComp.eq(totalGasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)

    // Check alice, bob, carol in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(alice)))
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isFalse((await sortedShieldedTroves.contains(carol)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = await sortedShieldedTroves.getSize()

    // alice, bob, carol have been removed from list
    assert.isTrue(listSize_Before == 4)
    assert.isTrue(listSize_After == 1)

    // alice has surplus collateral
    aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
    assert.isTrue(aliceSurplus.gt(toBN('0')))

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    // carol does not have surplus collateral
    carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
    assert.isTrue(carolSurplus.eq(toBN('0')))

    // verift total gas comp
    aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
    bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())

    assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))

    par = await relayer.par()
    aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    //carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    carolLiquidatedColl = carolCollateral.sub(carolCollGasComp)

    // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
    // so this can be off by a few wei
    //expTotalLiquidatedColl = totalLiquidatedDebt.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)

    /*
    console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
    console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
    console.log("totalLiquidatedColl", totalLiquidatedColl.toString())
    */

    // verify total liq coll
    assert.isTrue(expTotalLiquidatedColl.eq(totalLiquidatedColl))

    // verify collateral invariant
    assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
    assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
    assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))

    aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 

    // alice claims surplus collateral
    tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
    const aliceAmount = th.getRawEventArgByName(tx_alice_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
    assert.isTrue(toBN(aliceAmount).eq(aliceSurplus))
    // bob claims surplus collateral
    tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    const bobAmount = th.getRawEventArgByName(tx_bob_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
    assert.isTrue(toBN(bobAmount).eq(bobSurplus))
    // carol can't claim surplus collateral
    assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")

    // check alice eth difference, considering eth used in tx
    aliceTxCost = th.ethUsed(tx_alice_claim)
    aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
    aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)

    assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))

    // alice 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")

    // check bob eth difference, considering eth used in tx
    bobTxCost = th.ethUsed(tx_bob_claim)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // bob 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")

    carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
    carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)

    // carol should gain no collateral
    assert.isTrue(carolBalanceDiff.eq(toBN('0')))

    // carol 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))

  })
  it("batchLiquidate(): A,B,C different size troves, different ICRs. Only A,B have surplus collateral", async () => {
    const spDeposit = toBN(dec(100, 21))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })

    const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openShieldedTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
    const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openShieldedTrove({ ICR: toBN(dec(216, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
    const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })

    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    const TCR_Before = (await th.getTCR(contracts)).toString()
    const listSize_Before = await sortedShieldedTroves.getSize()


    //console.log("entire debt", (await troveManager.getEntireSystemActualDebt()).toString())
    entireDebt = (await troveManager.getTroveActualDebt(alice)).add((await troveManager.getTroveActualDebt(bob)))
          .add((await troveManager.getTroveActualDebt(carol))).add((await troveManager.getTroveActualDebt(whale)))

    price = dec(100, 18)
    await priceFeed.setPrice(price)


    aliceICR = await troveManager.getCurrentICR(alice, price)
    bobICR = await troveManager.getCurrentICR(bob, price)
    carolICR = await troveManager.getCurrentICR(carol, price)
    console.log("aliceICR", aliceICR.toString())
    console.log("bobICR", bobICR.toString())
    console.log("carolICR", carolICR.toString())

    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt((await troveManager.MCR())))
    // check for eq here since drip() in liquidate will pull carol under the penalty 
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).eq((await liquidations.LIQUIDATION_PENALTY())))

    // liquidate all
    tx_liq = await liquidations.batchLiquidate([alice, bob, carol])
    //tx_liq = await liquidations.liquidate(alice)
    const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)

    //const [stakeDrip, spDrip] = th.getEmittedDripValues(contracts,tx_liq)
    spDrip = toBN(th.getRawEventArgByName(tx_liq, troveManagerInterface, troveManager.address, "Drip", "_spInterest"))
    stakeDrip = toBN(th.getRawEventArgByName(tx_liq, troveManagerInterface, troveManager.address, "Drip", "_stakeInterest"))

    totalInterest = stakeDrip.add(spDrip)
    
    aliceDebtLiq = aliceDebt.add((totalInterest.mul(aliceDebt).div(entireDebt)))
    bobDebtLiq = bobDebt.add((totalInterest.mul(bobDebt).div(entireDebt)))
    carolDebtLiq = carolDebt.add((totalInterest.mul(carolDebt).div(entireDebt)))

    //assert.isTrue(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq).eq(totalLiquidatedDebt))
    assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)

    totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
    assert.isTrue(totalCollGasComp.eq(totalGasComp))

    ethGain = await stabilityPool.getDepositorCollateralGain(whale)
    assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)

    // Check alice, bob, carol in-active, check whale active
    assert.isFalse((await sortedShieldedTroves.contains(alice)))
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isFalse((await sortedShieldedTroves.contains(carol)))
    assert.isTrue((await sortedShieldedTroves.contains(whale)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = await sortedShieldedTroves.getSize()

    // alice, bob, carol have been removed from list
    assert.isTrue(listSize_Before == 4)
    assert.isTrue(listSize_After == 1)

    // alice has surplus collateral
    aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
    assert.isTrue(aliceSurplus.gt(toBN('0')))

    // bob has surplus collateral
    bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
    assert.isTrue(bobSurplus.gt(toBN('0')))

    // carol does not have surplus collateral
    carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
    assert.isTrue(carolSurplus.eq(toBN('0')))

    // verift total gas comp
    aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
    bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
    carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())

    assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))

    par = await relayer.par()
    aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    //carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    carolLiquidatedColl = carolCollateral.sub(carolCollGasComp)

    // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
    // so this can be off by a few wei
    //expTotalLiquidatedColl = totalLiquidatedDebt.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)

    /*
    console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
    console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
    console.log("totalLiquidatedColl", totalLiquidatedColl.toString())
    */

    // verify total liq coll
    assert.isTrue(expTotalLiquidatedColl.eq(totalLiquidatedColl))

    // verify collateral invariant
    assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
    assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
    assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))

    aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
    bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 

    // alice claims surplus collateral
    tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
    const aliceAmount = th.getRawEventArgByName(tx_alice_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
    assert.isTrue(toBN(aliceAmount).eq(aliceSurplus))
    // bob claims surplus collateral
    tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    const bobAmount = th.getRawEventArgByName(tx_bob_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
    assert.isTrue(toBN(bobAmount).eq(bobSurplus))
    // carol can't claim surplus collateral
    assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")

    // check alice eth difference, considering eth used in tx
    aliceTxCost = th.ethUsed(tx_alice_claim)
    aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
    aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)

    assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))

    // alice 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")

    // check bob eth difference, considering eth used in tx
    bobTxCost = th.ethUsed(tx_bob_claim)
    bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
    bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)

    assert.isTrue(bobBalanceDiff.eq(bobSurplus))

    // bob 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")

    carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
    carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)

    // carol should gain no collateral
    assert.isTrue(carolBalanceDiff.eq(toBN('0')))

    // carol 2nd attempt to withdraw fails
    assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))

  })

  it("drip(): debt equals supply", async () => {
    // Whale provides LUSD to SP
    const spDeposit = toBN(dec(100, 24))
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    // provide to SP so drip will mint interest
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraParams: { from: defaulter_2 } })
    await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: defaulter_3 } })
    await openShieldedTrove({ ICR: toBN(dec(192, 16)), extraParams: { from: defaulter_4 } })

    for (let i = 0; i < 100; i++) {
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await troveManager.drip()

      debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
      supply = await contracts.lusdToken.totalSupply()

      whale_debt = await contracts.troveManager.getTroveActualDebt(whale)
      trove_1_debt = await contracts.troveManager.getTroveActualDebt(defaulter_1)
      trove_2_debt = await contracts.troveManager.getTroveActualDebt(defaulter_2)
      trove_3_debt = await contracts.troveManager.getTroveActualDebt(defaulter_3)
      trove_4_debt = await contracts.troveManager.getTroveActualDebt(defaulter_4)

      // debt equals supply
      assert.isTrue(supply.eq(debt))

      trove_debt_sum = whale_debt.add(trove_1_debt).add(trove_2_debt).add(trove_3_debt).add(trove_4_debt)
      // allow at most divergence of 1 per trove
      assert.isTrue(supply.sub(trove_debt_sum).lte(toBN('4')))
    }
  })

  it("drip(): debt equals supply, SP empty", async () => {
    // Whale provides LUSD to SP
    const spDeposit = toBN(dec(100, 24))
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    //await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraParams: { from: defaulter_2 } })
    await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: defaulter_3 } })
    await openShieldedTrove({ ICR: toBN(dec(192, 16)), extraParams: { from: defaulter_4 } })

    debt_start = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
    supply_start = await contracts.lusdToken.totalSupply()
    assert.isTrue(debt_start.eq(supply_start))
    for (let i = 0; i < 100; i++) {
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await troveManager.drip()

      debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
      supply = await contracts.lusdToken.totalSupply()

      whale_debt = await contracts.troveManager.getTroveActualDebt(whale)
      trove_1_debt = await contracts.troveManager.getTroveActualDebt(defaulter_1)
      trove_2_debt = await contracts.troveManager.getTroveActualDebt(defaulter_2)
      trove_3_debt = await contracts.troveManager.getTroveActualDebt(defaulter_3)
      trove_4_debt = await contracts.troveManager.getTroveActualDebt(defaulter_4)

      // debt equals supply
      assert.isTrue(supply.eq(debt))

      // no debt or interest has accrued
      assert.isTrue(supply.eq(debt_start))

      trove_debt_sum = whale_debt.add(trove_1_debt).add(trove_2_debt).add(trove_3_debt).add(trove_4_debt)
      // allow at most divergence of 1 per trove
      assert.isTrue(supply.sub(trove_debt_sum).lte(toBN('4')))
    }

  })
  it("drip(): debt and interest only accrues once per block", async () => {
    // Whale provides LUSD to SP
    const spDeposit = toBN(dec(100, 24))
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraParams: { from: defaulter_2 } })
    await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: defaulter_3 } })
    await openShieldedTrove({ ICR: toBN(dec(192, 16)), extraParams: { from: defaulter_4 } })

    // disable automine so 2 drips() can be done per block
    await network.provider.send("evm_setAutomine", [false]);

    for (let i = 0; i < 10; i++) {
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

      // Queue two txs
      const txHash1 = await th.sendQueuedTx({contract: troveManager, methodName:"drip"});
      const txHash2 = await th.sendQueuedTx({contract: troveManager, methodName: "drip"});

      // Mine a block manually
      await network.provider.send("evm_mine");

      // Retrieve and decode logs
      const rec1 = await ethers.provider.getTransactionReceipt(txHash1);
      const rec2 = await ethers.provider.getTransactionReceipt(txHash2);

      // parse logs
      const iface = new ethers.utils.Interface(["event Drip(uint256 _stakeInterest, uint256 _spInterest)"]);

      // first drip should be positive
      const drip1 = iface.parseLog(rec1.logs.find(log => log.topics[0] === iface.getEventTopic("Drip")));
      assert.isTrue(drip1.args._spInterest.gt(0))

      // expected empty logs for tx2(no drip event)
      const drip2 = (rec2.logs || []).filter(log => log && log.topics && log.topics[0] === iface.getEventTopic("Drip"));
      assert.equal(drip2.length , 0)
    }
    await network.provider.send("evm_setAutomine", [true]);

  })
  it("drip(): accumulatedShieldRate increase when no shielded troves", async () => {
    // Whale provides LUSD to SP
    const spDeposit = toBN(dec(100, 24))
    await openTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_1 } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraParams: { from: defaulter_2 } })
    await openTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: defaulter_3 } })
    await openTrove({ ICR: toBN(dec(192, 16)), extraParams: { from: defaulter_4 } })

    await troveManager.drip()

    accRateBefore = await troveManager.accumulatedShieldRate()

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    await troveManager.drip()

    accRateAfter = await troveManager.accumulatedShieldRate()

    assert.isTrue(accRateAfter.gt(accRateBefore))

  })

  it("liquidate(): Given the same price and no other trove changes, complete Pool offsets restore the TCR to its value prior to the defaulters opening troves", async () => {
    // Whale provides LUSD to SP
    const spDeposit = toBN(dec(100, 24))
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(70, 18)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: dennis } })

    const TCR_Before = await th.getTCR(contracts)
    const debtBefore = await troveManager.getEntireSystemDebt(await troveManager.accumulatedRate(), await troveManager.accumulatedShieldRate())

    await openShieldedTrove({ ICR: toBN(dec(202, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_2 } })
    await openShieldedTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: defaulter_3 } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_4 } })

    assert.isTrue((await sortedShieldedTroves.contains(defaulter_1)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_2)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_3)));
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_4)));

    // Price drop
    await priceFeed.setPrice(dec(100, 18))
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // All defaulters liquidated
    tx = await liquidations.liquidate(defaulter_1)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_1)))
    tx = await liquidations.liquidate(defaulter_2)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_2)))
    tx = await liquidations.liquidate(defaulter_3)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_3)))
    tx = await liquidations.liquidate(defaulter_4)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_4)))

    /*
    drip_event = tx.logs.find(e => e.event === 'Drip');
    */

    // Price bounces back
    await priceFeed.setPrice(dec(200, 18))

    const TCR_After = await th.getTCR(contracts)
    const debtAfter = await troveManager.getEntireSystemDebt(await troveManager.accumulatedRate(), await troveManager.accumulatedShieldRate())
    const supplyAfter = await lusdToken.totalSupply()

    await troveManager.drip()
    // console.log("debt", debtAfter.toString())
    // console.log("supply", supplyAfter.toString())

    // debt grew a little from interest
    assert.isTrue(debtAfter.gt(debtBefore))
    assert.isAtMost(th.getDifference(debtBefore, debtAfter), 2000000000000000000)

    // TCR drops a little from interest
    assert.isTrue(TCR_After.lt(TCR_Before))
    assert.isAtMost(th.getDifference(TCR_Before, TCR_After), 50000000000)
  })
  it("liquidate(): Given the same price and no other trove changes, complete Pool offsets restore the TCR to its value prior to the defaulters opening troves, rising par", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(1).mul(ONE_CENT)));

    tx = await relayer.updatePar();
    tx = await relayer.updatePar();
    // Whale provides LUSD to SP
    const spDeposit = toBN(dec(100, 24))
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(70, 18)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: dennis } })

    const TCR_Before = await th.getTCR(contracts)
    const debtBefore = await troveManager.getEntireSystemDebt(await troveManager.accumulatedRate(), await troveManager.accumulatedShieldRate())

    await openShieldedTrove({ ICR: toBN(dec(202, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_2 } })
    await openShieldedTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: defaulter_3 } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_4 } })

    assert.isTrue((await sortedShieldedTroves.contains(defaulter_1)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_2)));
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_3)));
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_4)));

    // Price drop
    await priceFeed.setPrice(dec(100, 18))
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // All defaulters liquidated
    tx = await liquidations.liquidate(defaulter_1)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_1)))
    tx = await liquidations.liquidate(defaulter_2)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_2)))
    tx = await liquidations.liquidate(defaulter_3)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_3)))
    tx = await liquidations.liquidate(defaulter_4)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_4)))

    /*
    drip_event = tx.logs.find(e => e.event === 'Drip');
    */

    // Price bounces back
    await priceFeed.setPrice(dec(200, 18))
    await troveManager.drip()

    const TCR_After = await th.getTCR(contracts)
    const debtAfter = await troveManager.getEntireSystemDebt(await troveManager.accumulatedRate(), await troveManager.accumulatedShieldRate())
    const supplyAfter = await lusdToken.totalSupply()

    // console.log("debt", debtAfter.toString())
    // console.log("supply", supplyAfter.toString())

    // debt grew a little from interest
    assert.isTrue(debtAfter.gt(debtBefore))
    assert.isAtMost(th.getDifference(debtBefore, debtAfter), 2000000000000000000)

    // TCR drops a little from interest
    assert.isTrue(TCR_After.lt(TCR_Before))
    assert.isAtMost(th.getDifference(TCR_Before, TCR_After), 50000000000)
  })

  it("liquidate(): Pool offsets increase the TCR", async () => {
    // Whale provides LUSD to SP
    const spDeposit = toBN(dec(100, 24))
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(70, 18)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: dennis } })

    await openShieldedTrove({ ICR: toBN(dec(202, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_2 } })
    await openShieldedTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: defaulter_3 } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_4 } })

    assert.isTrue((await sortedShieldedTroves.contains(defaulter_1)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_2)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_3)));
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_4)));

    await priceFeed.setPrice(dec(100, 18))

    const TCR_1 = await th.getTCR(contracts)
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Check TCR improves with each liquidation that is offset with Pool
    await liquidations.liquidate(defaulter_1)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_1)))
    const TCR_2 = await th.getTCR(contracts)
    assert.isTrue(TCR_2.gte(TCR_1))

    await liquidations.liquidate(defaulter_2)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_2)))
    const TCR_3 = await th.getTCR(contracts)
    assert.isTrue(TCR_3.gte(TCR_2))

    await liquidations.liquidate(defaulter_3)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_3)))
    const TCR_4 = await th.getTCR(contracts)
    assert.isTrue(TCR_4.gte(TCR_3))

    await liquidations.liquidate(defaulter_4)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_4)))
    const TCR_5 = await th.getTCR(contracts)
    assert.isTrue(TCR_5.gte(TCR_4))

    trove_debt_sum = (await contracts.troveManager.getTroveActualDebt(whale)).add(await contracts.troveManager.getTroveActualDebt(alice)).add(await contracts.troveManager.getTroveActualDebt(bob)).add(await contracts.troveManager.getTroveActualDebt(carol)).add(await contracts.troveManager.getTroveActualDebt(dennis))
    console.log("trove_debt_sum", trove_debt_sum.toString())
    console.log("supply", (await lusdToken.totalSupply()).toString())
    // allow at most divergence of 1 per trove
    //assert.isTrue((await lusdToken.totalSupply()).sub(trove_debt_sum).lte(toBN('2')))


    const debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
    const supply = await contracts.lusdToken.totalSupply()
    // console.log("debt", debt.toString())
    // console.log("supply", supply.toString())
  })

  it("liquidate(): debt and supply don't diverge", async () => {
    // Whale provides LUSD to SP
    const spDeposit = toBN(dec(100, 24))
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    for (let i = 0; i < 10; i++) {
      await openShieldedTrove({ ICR: toBN(dec(202, 16)), extraParams: { from: defaulter_1 } })
      await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_2 } })
      await openShieldedTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: defaulter_3 } })
      await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_4 } })

      assert.isTrue((await sortedShieldedTroves.contains(defaulter_1)))
      assert.isTrue((await sortedShieldedTroves.contains(defaulter_2)));
      assert.isTrue((await sortedShieldedTroves.contains(defaulter_3)));
      assert.isTrue((await sortedShieldedTroves.contains(defaulter_4)));

      await priceFeed.setPrice(dec(100, 18))
      const TCR_1 = await th.getTCR(contracts)

      // Check TCR improves with each liquidation that is offset with Pool
      await liquidations.liquidate(defaulter_1)
      assert.isFalse((await sortedShieldedTroves.contains(defaulter_1)))
      const TCR_2 = await th.getTCR(contracts)
      assert.isTrue(TCR_2.gte(TCR_1))

      await liquidations.liquidate(defaulter_2)
      assert.isFalse((await sortedShieldedTroves.contains(defaulter_2)))
      const TCR_3 = await th.getTCR(contracts)
      assert.isTrue(TCR_3.gte(TCR_2))

      await liquidations.liquidate(defaulter_3)
      assert.isFalse((await sortedShieldedTroves.contains(defaulter_3)))
      const TCR_4 = await th.getTCR(contracts)
      assert.isTrue(TCR_4.gte(TCR_3))

      await liquidations.liquidate(defaulter_4)
      assert.isFalse((await sortedShieldedTroves.contains(defaulter_4)))
      const TCR_5 = await th.getTCR(contracts)
      assert.isTrue(TCR_5.gte(TCR_4))

      await priceFeed.setPrice(dec(200, 18))
      //await contracts.troveManager.drip()
      supply = await contracts.lusdToken.totalSupply()
      debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())

      // allow at most divergence of 1 per trove
      assert.isTrue(supply.sub(debt).lte(toBN('1')))
    }
    supply = await contracts.lusdToken.totalSupply()
    debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
  })

  it("liquidate(): a pure redistribution reduces the TCR only as a result of compensation", async () => {
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(70, 18)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: dennis } })

    await openShieldedTrove({ ICR: toBN(dec(202, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_2 } })
    await openShieldedTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: defaulter_3 } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_4 } })

    assert.isTrue((await sortedShieldedTroves.contains(defaulter_1)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_2)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_3)));
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_4)));

    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    const TCR_0 = await th.getTCR(contracts)

    const entireSystemCollBefore = await troveManager.getEntireSystemColl()
    const entireSystemDebtBefore = await troveManager.getEntireSystemDebt(await troveManager.accumulatedRate(), await troveManager.accumulatedShieldRate())

    const expectedTCR_0 = entireSystemCollBefore.mul(price).div(entireSystemDebtBefore)

    assert.isTrue(expectedTCR_0.eq(TCR_0))
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Check TCR does not decrease with each liquidation 
    const liquidationTx_1 = await liquidations.liquidate(defaulter_1)
    const [liquidatedDebt_1, liquidatedColl_1, gasComp_1] = th.getEmittedLiquidationValues(liquidationTx_1)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_1)))
    const TCR_1 = await th.getTCR(contracts)

    // Expect only change to TCR to be due to the issued gas compensation
    const expectedTCR_1 = (entireSystemCollBefore
      .sub(gasComp_1))
      .mul(price)
      .div(entireSystemDebtBefore)

    assert.isTrue(expectedTCR_1.eq(TCR_1))

    const liquidationTx_2 = await liquidations.liquidate(defaulter_2)
    const [liquidatedDebt_2, liquidatedColl_2, gasComp_2] = th.getEmittedLiquidationValues(liquidationTx_2)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_2)))

    const TCR_2 = await th.getTCR(contracts)

    const expectedTCR_2 = (entireSystemCollBefore
      .sub(gasComp_1)
      .sub(gasComp_2))
      .mul(price)
      .div(entireSystemDebtBefore)

    assert.isTrue(expectedTCR_2.eq(TCR_2))

    const liquidationTx_3 = await liquidations.liquidate(defaulter_3)
    const [liquidatedDebt_3, liquidatedColl_3, gasComp_3] = th.getEmittedLiquidationValues(liquidationTx_3)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_3)))

    const TCR_3 = await th.getTCR(contracts)

    const expectedTCR_3 = (entireSystemCollBefore
      .sub(gasComp_1)
      .sub(gasComp_2)
      .sub(gasComp_3))
      .mul(price)
      .div(entireSystemDebtBefore)

    assert.isTrue(expectedTCR_3.eq(TCR_3))


    const liquidationTx_4 = await liquidations.liquidate(defaulter_4)
    const [liquidatedDebt_4, liquidatedColl_4, gasComp_4] = th.getEmittedLiquidationValues(liquidationTx_4)
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_4)))

    const TCR_4 = await th.getTCR(contracts)

    const expectedTCR_4 = (entireSystemCollBefore
      .sub(gasComp_1)
      .sub(gasComp_2)
      .sub(gasComp_3)
      .sub(gasComp_4))
      .mul(price)
      .div(entireSystemDebtBefore)

    assert.isTrue(expectedTCR_4.eq(TCR_4))
  })

  it("liquidate(): does not affect the SP deposit or collateral gain when called on an SP depositor's address that has no trove", async () => {
    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    const spDeposit = toBN(dec(1, 24))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: bob } })
    const { C_totalDebt, C_collateral } = await openShieldedTrove({ ICR: toBN(dec(218, 16)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: carol } })

    // Bob sends tokens to Dennis, who has no trove
    await lusdToken.transfer(dennis, spDeposit, { from: bob })

    //Dennis provides LUSD to SP
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: dennis })

    const totalLUSDDeposits = await stabilityPool.getTotalLUSDDeposits()

    /*
    const erc20balanceBefore = await contracts.lusdToken.balanceOf(contracts.stabilityPool.address)
    console.log("SP ERC-20 balance before", erc20balanceBefore.toString())

    console.log("dennis initial sp deposit", (await stabilityPool.deposits(dennis))[0].toString())
    console.log("Sp.P before", (await stabilityPool.P()).toString())
    */

    await th.fastForwardTime(60, web3.currentProvider)

    //const accRateBefore = await troveManager.accumulatedRate()

    // Carol gets liquidated
    await priceFeed.setPrice(dec(100, 18))
    const liquidationTX_C = await liquidations.liquidate(carol)
    const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTX_C)

    // drip is called in liquidate(), so SP.totalLUSDDeposits increases beforehand by lusdGain
    //
    const lusdGain = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "DistributeToSP", "lusdGain");

    const debtOffset = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "Offset", "debtToOffset");
    //const nDebtOffset = th.getRawEventArgByName(liquidationTX_C, troveManagerInterface, troveManager.address, "Offset", "_nDebtToOffset");

    /*
    const newP = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "DistributeToSP", "newP");
    const existingP = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "DistributeToSP", "P");
    const totalLUSD = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "DistributeToSP", "totalLUSDDeposits");

    const rewardCurrentP = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "UpdateRewardSum", "currentP");
    const rewardNewP = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "UpdateRewardSum", "newP");
    const rewardNewPF = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "UpdateRewardSum", "newProductFactor");
    const rewardLoss = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "UpdateRewardSum", "lusdLoss");

    //event Offset(uint collToAdd, uint debtToOffset, uint totalLUSD, uint lusdLoss, uint ethGain);
    const offsetColl = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "Offset", "collToAdd");
    const offsetDebt = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "Offset", "debtToOffset");
    const offsetTotalLUSD = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "Offset", "totalLUSD");
    const offsetLUSDLoss = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "Offset", "lusdLoss");
    const offsetCollateralGain = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "Offset", "ethGain");

    //const newP = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "P_Updated", "_P");
    const ethUpdated = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "StabilityPoolCollateralBalanceUpdated", "_newBalance");

    console.log("DistributeToSP------------")
    console.log("existingP", existingP.toString())
    console.log("newP", newP.toString())
    console.log("lusdGain", lusdGain.toString())
    console.log("totalLUSD", totalLUSD.toString())
    console.log("UpdateRewardSum-----------")
    console.log("rewardCurrentP", rewardCurrentP.toString())
    console.log("rewardNewP", rewardNewP.toString())
    console.log("rewardNewPF", rewardNewPF.toString())
    console.log("rewardLoss", rewardLoss.toString())
    console.log("Offset--------------------")
    console.log("offsetColl", offsetColl.toString())
    console.log("offsetDebt", offsetDebt.toString())
    console.log("offsetTotalLUSD", offsetTotalLUSD.toString())
    console.log("offsetLUSDLoss", offsetLUSDLoss.toString())
    console.log("offsetCollateralGain", offsetCollateralGain.toString())

    console.log("ethUpdated", ethUpdated.toString())
    const erc20balanceAfter = await contracts.lusdToken.balanceOf(contracts.stabilityPool.address)
    console.log("SP ERC-20 balance after", erc20balanceAfter.toString())

    // This is wrong, too large
    console.log("P after", (await stabilityPool.P()).toString())
    */

    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // Check Dennis' SP deposit has absorbed Carol's debt, and he has received her liquidated Collateral
    // Dennis values after absorbing liquidation
    const dennis_Deposit_Before = (await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString()
    const dennis_CollGain_Before = (await stabilityPool.getDepositorCollateralGain(dennis)).toString()

    /*
    console.log("spDeposit", spDeposit.toString())
    console.log("LiquidatedDebt", liquidatedDebt.toString())
    console.log("dennis_Deposit_Before", dennis_Deposit_Before)
    console.log("debtOffset", debtOffset.toString())
    console.log("nDebtOffset", nDebtOffset.toString())
    */

    const newSpDeposit = spDeposit.add(toBN(lusdGain));

    // liquidations drips interest to SP first, so Sp deposit grows right before offset
    //console.log("lusdGain", lusdGain.toString())
    //console.log("newSpDeposit w/ lusdg gain", newSpDeposit.toString())
    //console.log("new dep minus liquidation", newSpDeposit.sub(liquidatedDebt).toString())
    //console.log("old dep minus liquidation", spDeposit.sub(liquidatedDebt).toString())

    assert.isAtMost(th.getDifference(dennis_Deposit_Before, newSpDeposit.sub(liquidatedDebt)), 2450000)
    /*
    console.log("dennis_CollGain_Before", dennis_CollGain_Before.toString())
    console.log("liquidatedColl", liquidatedColl.toString())
    console.log("Eth error", (await stabilityPool.lastCollateralError_Offset()).toString())
    */

    const collateralError = toBN(await stabilityPool.lastCollateralError_Offset()).div(toBN(dec(1,18)))
    //console.log("collateralError", collateralError.toString())
    const expGainPlusError = toBN(dennis_CollGain_Before).add(collateralError)
    assert.isAtMost(th.getDifference(expGainPlusError, liquidatedColl.toString()), 100)
    //assert.isAtMost(th.getDifference(dennis_CollGain_Before, liquidatedColl.toString()), 1000)

    // Confirm system is not in Recovery Mode
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Attempt to liquidate Dennis
    try {
      const txDennis = await liquidations.liquidate(dennis)
      assert.isFalse(txDennis.receipt.status)
    } catch (err) {
      assert.include(err.message, "revert")
      assert.include(err.message, "Trove does not exist or is closed")
    }

    // Check Dennis' SP deposit does not change after liquidation attempt
    const dennis_Deposit_After = (await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString()
    const dennis_CollGain_After = (await stabilityPool.getDepositorCollateralGain(dennis)).toString()
    assert.equal(dennis_Deposit_Before, dennis_Deposit_After)
    assert.equal(dennis_CollGain_Before, dennis_CollGain_After)
  })

  it("liquidate(): does not liquidate a SP depositor's trove with ICR > 110%, and does not affect their SP deposit or collateral gain", async () => {
    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    const spDeposit = toBN(dec(1, 24))
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(218, 16)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: carol } })

    //Bob provides LUSD to SP
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: bob })

    // Carol gets liquidated
    await priceFeed.setPrice(dec(100, 18))
    const liquidationTX_C = await liquidations.liquidate(carol)
    const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTX_C)

    const lusdGain = th.getRawEventArgByName(liquidationTX_C, stabilityPoolInterface, stabilityPool.address, "DistributeToSP", "lusdGain");

    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // price bounces back - Bob's trove is >110% ICR again
    await priceFeed.setPrice(dec(200, 18))
    const price = await priceFeed.getPrice()
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt(mv._MCR))

    // Check Bob' SP deposit has absorbed Carol's debt, and he has received her liquidated collateral
    const bob_Deposit_Before = (await stabilityPool.getCompoundedLUSDDeposit(bob)).toString()
    const bob_CollateralGain_Before = (await stabilityPool.getDepositorCollateralGain(bob)).toString()

    const newSpDeposit = spDeposit.add(toBN(lusdGain));

    assert.isAtMost(th.getDifference(bob_Deposit_Before, newSpDeposit.sub(liquidatedDebt)), 2500000)
    assert.isFalse(await th.checkRecoveryMode(contracts))

    const collateralError = toBN(await stabilityPool.lastCollateralError_Offset()).div(toBN(dec(1,18)))
    //console.log("collateralError", collateralError.toString())
    const expGainPlusError = toBN(bob_CollateralGain_Before).add(collateralError)
    assert.isAtMost(th.getDifference(expGainPlusError, liquidatedColl.toString()), 100)
    //assert.isAtMost(th.getDifference(bob_CollateralGain_Before, liquidatedColl), 1000)

    // Attempt to liquidate Bob
    await assertRevert(liquidations.liquidate(bob), "Liquidations: nothing to liquidate")

    // Confirm Bob's trove is still active
    assert.isTrue(await sortedShieldedTroves.contains(bob))

    // Check Bob' SP deposit does not change after liquidation attempt
    const bob_Deposit_After = (await stabilityPool.getCompoundedLUSDDeposit(bob)).toString()
    const bob_CollateralGain_After = (await stabilityPool.getDepositorCollateralGain(bob)).toString()
    assert.equal(bob_Deposit_Before, bob_Deposit_After)
    assert.equal(bob_CollateralGain_Before, bob_CollateralGain_After)
  })

  it("liquidate(): liquidates a SP depositor's trove with ICR < 110%, and the liquidation correctly impacts their SP deposit and Collateral gain", async () => {
    const A_spDeposit = toBN(dec(3, 24))
    const B_spDeposit = toBN(dec(1, 24))
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
    await openShieldedTrove({ ICR: toBN(dec(8, 18)), extraLUSDAmount: A_spDeposit, extraParams: { from: alice } })
    // lowered bob's ICR from 218 to 211 so ensure liq ratio < liq penalty and full collateral is seized
    // other tests will cover collateral surplus
    const { collateral: B_collateral, totalDebt: B_debt } = await openShieldedTrove({ ICR: toBN(dec(211, 16)), extraLUSDAmount: B_spDeposit, extraParams: { from: bob } })
    const { collateral: C_collateral, totalDebt: C_debt } = await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: carol } })

    //Bob provides LUSD to SP
    await stabilityPool.provideToSP(B_spDeposit, ZERO_ADDRESS, { from: bob })

    /*
    const depositsBeforeLiq = await stabilityPool.getTotalLUSDDeposits()
    console.log("depositsBeforeLiq", depositsBeforeLiq.toString())
    const bob_Deposit_BeforeLiq = await stabilityPool.getCompoundedLUSDDeposit(bob)
    console.log("bob_Deposit_BeforeLiq", bob_Deposit_BeforeLiq.toString())
    */

    collateral_before = await stabilityPool.getCollateral()
    /*
    scaleSumSnapshot = await stabilityPool.scaleToSum(1)
    console.log("scaleSumSnapshot1", scaleSumSnapshot.toString())
    console.log("P", (await stabilityPool.P()).toString());

    console.log("lastCollateralError_Offset", (await stabilityPool.lastCollateralError_Offset()).toString())
    console.log("lastLUSDLossError_Offset", (await stabilityPool.lastLUSDLossError_Offset()).toString())
    */

    // Carol gets liquidated
    await priceFeed.setPrice(dec(100, 18))
    tx = await liquidations.liquidate(carol)
    lusdGain = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "DistributeToSP", "lusdGain"));

    //const ethGain = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "Offset", "ethGain"));
    //const debtToOffset = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "Offset", "debtToOffset"));
    //console.log("ethGain", ethGain.toString())
    //console.log("debtToOffset", debtToOffset.toString())
    //const totalLUSD = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "Offset", "totalLUSD"));
    //console.log("totalLUSD", totalLUSD.toString())
    liquidatedC_debt = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "Offset", "debtToOffset"));
    //liquidatedC_debtSeq = toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Offset", "_debtInSequence"));

    //collToSp = toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "TroveLiqInfo", "collToSp"));
    //console.log("collToSp", collToSp.toString())
    const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(tx)
    //console.log("liquidatedC_debtSeq", liquidatedC_debtSeq.toString())
    //console.log("liquidatedDebt", liquidatedDebt.toString())

    collateral_after = await stabilityPool.getCollateral()
    //console.log("collateral diff", (collateral_before.sub(collateral_after).toString()))

    const newB_spDeposit = B_spDeposit.add(lusdGain)
    //console.log("lusdGain", lusdGain.toString())
    // Check Bob' SP deposit has absorbed Carol's debt, and he has received her liquidated collateral
    const bob_Deposit_Before = await stabilityPool.getCompoundedLUSDDeposit(bob)
    const initialDeposits = await stabilityPool.getTotalLUSDDeposits()
    const bob_CollateralGain_Before = await stabilityPool.getDepositorCollateralGain(bob)
    //const [initial_val, tag] = await stabilityPool.deposits(bob)
    const initial_val = (await stabilityPool.deposits(bob))[0]
    //console.log("bob_initial_val", initial_val.toString())
    const {S, P, G, scale} = await stabilityPool.depositSnapshots(bob)

    /*
    console.log("S", S.toString())
    console.log("P", P.toString())
    console.log("G", G.toString())
    console.log("scale", scale.toString())
    */
    scaleSumSnapshot = await stabilityPool.scaleToSum(scale)
    //console.log("scaleSumSnapshot", scaleSumSnapshot.toString())
    //console.log("init_val x ssumsnap", initial_val.mul(scaleSumSnapshot).div(toBN(dec(1,18))).div(toBN(dec(1,18))).toString())
    init_val_time_ssumsnap = initial_val.mul(scaleSumSnapshot).div(toBN(dec(1,18))).div(toBN(dec(1,18)))
    assert.isTrue(bob_CollateralGain_Before.eq(init_val_time_ssumsnap))

    //console.log("bob_deposit_snaphost", bob_deposit_snapshot.toString())


    /*
    console.log("initialDeposits", initialDeposits.toString())
    console.log("bob_Deposit_Before", bob_Deposit_Before.toString())
    console.log("liquidatedColl", liquidatedColl.toString())
    console.log("C_collateral", C_collateral.toString())
    console.log("bob_CollateralGain_Before", bob_CollateralGain_Before.toString())
    console.log("th.applyLiquidationFee(C_collateral)", th.applyLiquidationFee(C_collateral).toString())
    console.log("lastCollateralError_Offset", (await stabilityPool.lastCollateralError_Offset()).toString())
    console.log("lastLUSDLossError_Offset", (await stabilityPool.lastLUSDLossError_Offset()).toString())
    */

    //assert.isAtMost(th.getDifference(bob_Deposit_Before, newB_spDeposit.sub(liquidatedC_debt)), 1000000)
    assert.isAtMost(th.getDifference(bob_Deposit_Before, newB_spDeposit.sub(liquidatedC_debt)), 2280000)
    // Increase tolerance here but might be okay with collateral error feedback in stabilityPool._computeRewardsPerUnitStaked()
    assert.isAtMost(th.getDifference(bob_CollateralGain_Before, th.applyLiquidationFee(C_collateral)), 1000000)

    // Alice provides LUSD to SP
    await stabilityPool.provideToSP(A_spDeposit, ZERO_ADDRESS, { from: alice })
    assert.isFalse(await th.checkRecoveryMode(contracts))

    prev_deposits = await stabilityPool.getTotalLUSDDeposits()
    // Liquidate Bob
    tx = await liquidations.liquidate(bob)
    lusdGain = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "DistributeToSP", "lusdGain"));
    liquidatedB_debt = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "Offset", "debtToOffset"));
    // liquidate calls drip() and thus increases SP deposits right before liquidating
    const newA_spDeposit = A_spDeposit.add(lusdGain.mul(A_spDeposit).div(prev_deposits))
    const newBob_Deposit_Before = bob_Deposit_Before.add(lusdGain.mul(bob_Deposit_Before).div(prev_deposits))
    console.log("newA_spDeposit", newA_spDeposit.toString())
    console.log("A_spDeposit", A_spDeposit.toString())

    // Confirm Bob's trove has been closed
    assert.isFalse(await sortedShieldedTroves.contains(bob))
    const bob_Trove_Status = ((await troveManager.Troves(bob))[3]).toString()
    assert.equal(bob_Trove_Status, 3) // check closed by liquidation

    /* Alice's LUSD Loss = (300 / 400) * 200 = 150 LUSD
       Alice's collateral gain = (300 / 400) * 2*0.995 = 1.4925 collateral

       Bob's LUSDLoss = (100 / 400) * 200 = 50 LUSD
       Bob's collateral gain = (100 / 400) * 2*0.995 = 0.4975 collateral

     Check Bob' SP deposit has been reduced to 50 LUSD, and his collateral gain has increased to 1.5 collateral. */
    const alice_Deposit_After = (await stabilityPool.getCompoundedLUSDDeposit(alice)).toString()
    const alice_CollateralGain_After = (await stabilityPool.getDepositorCollateralGain(alice)).toString()

    //const totalDeposits = bob_Deposit_Before.add(A_spDeposit)
    const totalDeposits = prev_deposits.add(lusdGain)
    
    // TODO increased tolerance for both of these from 1e6 to 43e5. is this ok? 
    assert.isAtMost(th.getDifference(alice_Deposit_After, newA_spDeposit.sub(liquidatedB_debt.mul(newA_spDeposit).div(totalDeposits))), 6120000)
    assert.isAtMost(th.getDifference(alice_CollateralGain_After, th.applyLiquidationFee(B_collateral).mul(newA_spDeposit).div(totalDeposits)), 3000000)

    const bob_Deposit_After = await stabilityPool.getCompoundedLUSDDeposit(bob)
    const bob_CollateralGain_After = await stabilityPool.getDepositorCollateralGain(bob)

    assert.isAtMost(th.getDifference(bob_Deposit_After, newBob_Deposit_Before.sub(liquidatedB_debt.mul(newBob_Deposit_Before).div(totalDeposits))), 2040000)
    assert.isAtMost(th.getDifference(bob_CollateralGain_After, bob_CollateralGain_Before.add(th.applyLiquidationFee(B_collateral).mul(newBob_Deposit_Before).div(totalDeposits))), 1000000)
  })

  it("liquidate(): does not alter the liquidated user's token balance", async () => {
    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    const { lusdAmount: A_lusdAmount } = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: toBN(dec(300, 18)), extraParams: { from: alice } })
    const { lusdAmount: B_lusdAmount } = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: toBN(dec(200, 18)), extraParams: { from: bob } })
    const { lusdAmount: C_lusdAmount } = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: carol } })

    await priceFeed.setPrice(dec(100, 18))

    // Check sortedList size
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '4')
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate A, B and C
    const activeLUSDDebt_0 = await activeShieldedPool.getLUSDDebt()
    const defaultLUSDDebt_0 = await defaultPool.getLUSDDebt()

    await liquidations.liquidate(alice)
    const activeLUSDDebt_A = await activeShieldedPool.getLUSDDebt()
    const defaultLUSDDebt_A = await defaultPool.getLUSDDebt()

    await liquidations.liquidate(bob)
    const activeLUSDDebt_B = await activeShieldedPool.getLUSDDebt()
    const defaultLUSDDebt_B = await defaultPool.getLUSDDebt()

    await liquidations.liquidate(carol)

    // Confirm A, B, C closed
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))
    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // Check sortedList size reduced to 1
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '1')

    // Confirm token balances have not changed
    assert.equal((await lusdToken.balanceOf(alice)).toString(), A_lusdAmount)
    assert.equal((await lusdToken.balanceOf(bob)).toString(), B_lusdAmount)
    assert.equal((await lusdToken.balanceOf(carol)).toString(), C_lusdAmount)
  })

  it("liquidate(): liquidates based on entire/collateral debt (including pending rewards), not raw collateral/debt", async () => {
    await openShieldedTrove({ ICR: toBN(dec(8, 18)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(221, 16)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: carol } })

    // Defaulter opens with 60 LUSD, 0.6 Collateral
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    const alice_ICR_Before = await troveManager.getCurrentICR(alice, price)
    const bob_ICR_Before = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_Before = await troveManager.getCurrentICR(carol, price)

    /* Before liquidation: 
    Alice ICR: = (2 * 100 / 50) = 400%
    Bob ICR: (1 * 100 / 90.5) = 110.5%
    Carol ICR: (1 * 100 / 100 ) =  100%

    Therefore Alice and Bob above the MCR, Carol is below */
    assert.isTrue(alice_ICR_Before.gte(mv._MCR))
    assert.isTrue(bob_ICR_Before.gte(mv._MCR))
    assert.isTrue(carol_ICR_Before.lte(mv._MCR))

    assert.isFalse(await th.checkRecoveryMode(contracts))

    /* Liquidate defaulter. 30 LUSD and 0.3 collateral is distributed between A, B and C.

    A receives (30 * 2/4) = 15 LUSD, and (0.3*2/4) = 0.15 collateral
    B receives (30 * 1/4) = 7.5 LUSD, and (0.3*1/4) = 0.075 collateral
    C receives (30 * 1/4) = 7.5 LUSD, and (0.3*1/4) = 0.075 collateral
    */
    await liquidations.liquidate(defaulter_1)

    const alice_ICR_After = await troveManager.getCurrentICR(alice, price)
    const bob_ICR_After = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_After = await troveManager.getCurrentICR(carol, price)

    /* After liquidation: 

    Alice ICR: (10.15 * 100 / 60) = 183.33%
    Bob ICR:(1.075 * 100 / 98) =  109.69%
    Carol ICR: (1.075 *100 /  107.5 ) = 100.0%

    Check Alice is above MCR, Bob below, Carol below. */


    assert.isTrue(alice_ICR_After.gte(mv._MCR))
    assert.isTrue(bob_ICR_After.lte(mv._MCR))
    assert.isTrue(carol_ICR_After.lte(mv._MCR))

    /* Though Bob's true ICR (including pending rewards) is below the MCR, 
    check that Bob's raw coll and debt has not changed, and that his "raw" ICR is above the MCR */
    const bob_Coll = (await troveManager.Troves(bob))[1]
    const bob_Debt = (await troveManager.Troves(bob))[0]

    const bob_rawICR = bob_Coll.mul(toBN(dec(100, 18))).div(bob_Debt)
    assert.isTrue(bob_rawICR.gte(mv._MCR))

    // Whale enters system, pulling it into Normal Mode
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate Alice, Bob, Carol
    await assertRevert(liquidations.liquidate(alice), "Liquidations: nothing to liquidate")
    await liquidations.liquidate(bob)
    await liquidations.liquidate(carol)

    /* Check Alice stays active, Carol gets liquidated, and Bob gets liquidated 
   (because his pending rewards bring his ICR < MCR) */
    assert.isTrue(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))
    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // Check trove statuses - A active (1),  B and C liquidated (3)
    assert.equal((await troveManager.Troves(alice))[3].toString(), '1')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
  })

  it("liquidate(): when SP > 0, triggers LQTY reward event - increases the sum G", async () => {
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves 
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })
    assert.equal(await stabilityPool.getTotalLUSDDeposits(), dec(100, 18))

    const G_Before = await stabilityPool.scaleToG(0)

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // Price drops to 1collateral:100LUSD, reducing defaulters to below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate trove
    await liquidations.liquidate(defaulter_1)
    assert.isFalse(await sortedShieldedTroves.contains(defaulter_1))

    const G_After = await stabilityPool.scaleToG(0)

    // Expect G has increased from the LQTY reward event triggered
    assert.isTrue(G_After.gt(G_Before))
  })

  it("liquidate(): SP cannot be emptied by withdrawing", async () => {
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves 
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // B tries to fully withdraw
    await assertRevert(stabilityPool.withdrawFromSP(dec(100, 18), { from: B }), "Withdrawal must leave totalBoldDeposits >= MIN_LUSD_IN_SP")

    // Check SP is not empty
    assert.isTrue((await stabilityPool.getTotalLUSDDeposits()).gt(toBN('0')))
  })

  // --- liquidateTroves() ---

  it('liquidateTroves(): liquidates a Trove that a) was skipped in a previous liquidation and b) has pending rewards', async () => {
    // A, B, C, D, E open troves
    await openShieldedTrove({ ICR: toBN(dec(333, 16)), extraParams: { from: D } })
    await openShieldedTrove({ ICR: toBN(dec(333, 16)), extraParams: { from: E } })
    await openShieldedTrove({ ICR: toBN(dec(140, 16)), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    // Price drops
    await priceFeed.setPrice(dec(150, 18))
    let price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))
    
    // A gets liquidated, creates pending rewards for all
    const liqTxA = await liquidations.liquidate(A)
    assert.isTrue(liqTxA.receipt.status)
    assert.isFalse(await sortedShieldedTroves.contains(A))

    // A adds 10 LUSD to the SP, but less than C's debt
    await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, {from: A})

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    price = await priceFeed.getPrice()
    assert.isTrue(await th.checkRecoveryMode(contracts))

    // Confirm C has ICR > TCR
    const TCR = await troveManager.getTCR(price)
    const ICR_C = await troveManager.getCurrentICR(C, price)
  
    assert.isTrue(ICR_C.gt(TCR))

    // Attempt to liquidate B and C, which skips C in the liquidation since it is immune
    const liqTxBC = await liquidations.liquidateTroves(2)
    assert.isTrue(liqTxBC.receipt.status)
    assert.isFalse(await sortedShieldedTroves.contains(B))
    assert.isTrue(await sortedShieldedTroves.contains(C))
    assert.isTrue(await sortedShieldedTroves.contains(D))
    assert.isTrue(await sortedShieldedTroves.contains(E))

    // // All remaining troves D and E repay a little debt, applying their pending rewards
    assert.isTrue((await sortedShieldedTroves.getSize()).eq(toBN('3')))
    await borrowerOperations.repayLUSD(dec(1, 18), D, D, {from: D})
    await borrowerOperations.repayLUSD(dec(1, 18), E, E, {from: E})

    // Check C is the only trove that has pending rewards
    assert.isTrue(await rewards.hasPendingRewards(C))
    assert.isFalse(await rewards.hasPendingRewards(D))
    assert.isFalse(await rewards.hasPendingRewards(E))

    // Check C's pending coll and debt rewards are <= the coll and debt in the DefaultPool
    const pendingCollateral_C = await rewards.getPendingCollateralReward(C)
    const pendingLUSDDebt_C = await rewards.getPendingLUSDDebtReward(C)
    const defaultPoolCollateral = await defaultPool.getCollateral()
    const defaultPoolLUSDDebt = await defaultPool.getLUSDDebt()

    console.log("pendingCollateral_C", pendingCollateral_C.toString())
    console.log("defaultPoolCollateral", defaultPoolCollateral.toString())
    console.log("pendingLUSDDebt_C", pendingLUSDDebt_C.toString())
    console.log("defaultPoolLUSDDebt", defaultPoolLUSDDebt.toString())
    
    assert.isTrue(pendingCollateral_C.lte(defaultPoolCollateral))
    assert.isTrue(pendingLUSDDebt_C.lte(defaultPoolLUSDDebt))

    //Check only difference is dust
    assert.isAtMost(th.getDifference(pendingCollateral_C, defaultPoolCollateral), 1000)
    assert.isAtMost(th.getDifference(pendingLUSDDebt_C, defaultPoolLUSDDebt), 1000)
    assert.isTrue(await th.checkRecoveryMode(contracts))

    // D and E fill the Stability Pool, enough to completely absorb C's debt of 70
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, {from: D})
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, {from: E})

    await priceFeed.setPrice(dec(50, 18))

    // Try to liquidate C again. Check it succeeds and closes C's trove
    const liqTx2 = await liquidations.liquidateTroves(2)
    assert.isTrue(liqTx2.receipt.status)
    assert.isFalse(await sortedShieldedTroves.contains(C))
    assert.isFalse(await sortedShieldedTroves.contains(D))
    assert.isTrue(await sortedShieldedTroves.contains(E))
    assert.isTrue((await sortedShieldedTroves.getSize()).eq(toBN('1')))
  })

  it('liquidateTroves(): closes every Trove with ICR < MCR, when n > number of undercollateralized troves', async () => {
    // --- SETUP ---
    HCR = await troveManager.HCR()
    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

    // create 5 Troves with varying ICRs
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: erin } })
    await openShieldedTrove({ ICR: HCR.add(toBN(dec(10, 16))), extraParams: { from: flyn } })

    // G,H, I open high-ICR troves
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: graham } })
    await openShieldedTrove({ ICR: toBN(dec(90, 18)), extraParams: { from: harriet } })
    await openShieldedTrove({ ICR: toBN(dec(80, 18)), extraParams: { from: ida } })

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(300, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing Bob and Carol's ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Confirm troves A-E are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).lte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(flyn, price)).lte(mv._MCR))

    // Confirm troves G, H, I are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(graham, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(harriet, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(ida, price)).gte(mv._MCR))

    // Confirm Whale is ICR > 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    // Liquidate 5 troves
    await liquidations.liquidateTroves(5);

    // Confirm troves A-E have been removed from the system
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))
    assert.isFalse(await sortedShieldedTroves.contains(carol))
    assert.isFalse(await sortedShieldedTroves.contains(erin))
    assert.isFalse(await sortedShieldedTroves.contains(flyn))

    // Check all troves A-E are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
    assert.equal((await troveManager.Troves(erin))[3].toString(), '3')
    assert.equal((await troveManager.Troves(flyn))[3].toString(), '3')

    // Check sorted list has been reduced to length 4 
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '4')
  })

  it('liquidateTroves(): liquidates  up to the requested number of undercollateralized troves', async () => {
    // --- SETUP --- 
    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol, Dennis, Erin open troves with consecutively decreasing collateral ratio
    await openShieldedTrove({ ICR: toBN(dec(202, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(204, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(206, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(208, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: erin } })

    // --- TEST --- 

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    assert.isFalse(await th.checkRecoveryMode(contracts))

    await liquidations.liquidateTroves(3)

    const TroveOwnersArrayLength = await troveManager.getShieldedTroveOwnersCount()
    assert.equal(TroveOwnersArrayLength, '3')

    // Check Alice, Bob, Carol troves have been closed
    const aliceTroveStatus = (await troveManager.getTroveStatus(alice)).toString()
    const bobTroveStatus = (await troveManager.getTroveStatus(bob)).toString()
    const carolTroveStatus = (await troveManager.getTroveStatus(carol)).toString()

    assert.equal(aliceTroveStatus, '3')
    assert.equal(bobTroveStatus, '3')
    assert.equal(carolTroveStatus, '3')

    //  Check Alice, Bob, and Carol's trove are no longer in the sorted list
    const alice_isInSortedList = await sortedShieldedTroves.contains(alice)
    const bob_isInSortedList = await sortedShieldedTroves.contains(bob)
    const carol_isInSortedList = await sortedShieldedTroves.contains(carol)

    assert.isFalse(alice_isInSortedList)
    assert.isFalse(bob_isInSortedList)
    assert.isFalse(carol_isInSortedList)

    // Check Dennis, Erin still have active troves
    const dennisTroveStatus = (await troveManager.getTroveStatus(dennis)).toString()
    const erinTroveStatus = (await troveManager.getTroveStatus(erin)).toString()

    assert.equal(dennisTroveStatus, '1')
    assert.equal(erinTroveStatus, '1')

    // Check Dennis, Erin still in sorted list
    const dennis_isInSortedList = await sortedShieldedTroves.contains(dennis)
    const erin_isInSortedList = await sortedShieldedTroves.contains(erin)

    assert.isTrue(dennis_isInSortedList)
    assert.isTrue(erin_isInSortedList)
  })

  it('liquidateTroves(): does nothing if all troves have ICR > 110%', async () => {
    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openShieldedTrove({ ICR: toBN(dec(222, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(222, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(222, 16)), extraParams: { from: carol } })

    // Price drops, but all troves remain active at 111% ICR
    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    assert.isTrue((await sortedShieldedTroves.contains(whale)))
    assert.isTrue((await sortedShieldedTroves.contains(alice)))
    assert.isTrue((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(carol)))

    const TCR_Before = await th.getTCR(contracts)
    const listSize_Before = (await sortedShieldedTroves.getSize()).toString()

    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).gte(mv._MCR))
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Attempt liqudation sequence
    await assertRevert(liquidations.liquidateTroves(10), "Liquidations: nothing to liquidate")

    // Check all troves remain active
    assert.isTrue((await sortedShieldedTroves.contains(whale)))
    assert.isTrue((await sortedShieldedTroves.contains(alice)))
    assert.isTrue((await sortedShieldedTroves.contains(bob)))
    assert.isTrue((await sortedShieldedTroves.contains(carol)))

    const TCR_After = (await th.getTCR(contracts)).toString()
    const listSize_After = (await sortedShieldedTroves.getSize()).toString()

    assert.equal(TCR_Before, TCR_After)
    assert.equal(listSize_Before, listSize_After)
  })

  
  it("liquidateTroves(): liquidates based on entire/collateral debt (including pending rewards), not raw collateral/debt", async () => {
    await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(221, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_1 } })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    const alice_ICR_Before = await troveManager.getCurrentICR(alice, price)
    const bob_ICR_Before = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_Before = await troveManager.getCurrentICR(carol, price)

    /* Before liquidation: 
    Alice ICR: = (2 * 100 / 100) = 200%
    Bob ICR: (1 * 100 / 90.5) = 110.5%
    Carol ICR: (1 * 100 / 100 ) =  100%

    Therefore Alice and Bob above the MCR, Carol is below */
    assert.isTrue(alice_ICR_Before.gte(mv._MCR))
    assert.isTrue(bob_ICR_Before.gte(mv._MCR))
    assert.isTrue(carol_ICR_Before.lte(mv._MCR))

    // Liquidate defaulter. 30 LUSD and 0.3 ETH is distributed uniformly between A, B and C. Each receive 10 LUSD, 0.1 ETH
    await liquidations.liquidate(defaulter_1)

    const alice_ICR_After = await troveManager.getCurrentICR(alice, price)
    const bob_ICR_After = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_After = await troveManager.getCurrentICR(carol, price)

    /* After liquidation: 

    Alice ICR: (1.0995 * 100 / 60) = 183.25%
    Bob ICR:(1.0995 * 100 / 100.5) =  109.40%
    Carol ICR: (1.0995 * 100 / 110 ) 99.95%

    Check Alice is above MCR, Bob below, Carol below. */
    assert.isTrue(alice_ICR_After.gte(mv._MCR))
    assert.isTrue(bob_ICR_After.lte(mv._MCR))
    assert.isTrue(carol_ICR_After.lte(mv._MCR))

    /* Though Bob's true ICR (including pending rewards) is below the MCR, check that Bob's raw coll and debt has not changed */
    const bob_Coll = (await troveManager.Troves(bob))[1]
    const bob_Debt = (await troveManager.Troves(bob))[0]

    const bob_rawICR = bob_Coll.mul(toBN(dec(100, 18))).div(bob_Debt)
    assert.isTrue(bob_rawICR.gte(mv._MCR))

    // Whale enters system, pulling it into Normal Mode
    await openShieldedTrove({ ICR: toBN(dec(10, 18)), extraLUSDAmount: dec(1, 24), extraParams: { from: whale } })
    assert.isFalse(await th.checkRecoveryMode(contracts))

    //liquidate A, B, C
    await liquidations.liquidateTroves(10)

    // Check A stays active, B and C get liquidated
    assert.isTrue(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))
    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // check trove statuses - A active (1),  B and C closed by liquidation (3)
    assert.equal((await troveManager.Troves(alice))[3].toString(), '1')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
  })

  it("liquidateTroves(): reverts if n = 0", async () => {
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
    await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(206, 16)), extraParams: { from: carol } })

    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    const TCR_Before = (await th.getTCR(contracts)).toString()

    // Confirm A, B, C ICRs are below 110%
    const alice_ICR = await troveManager.getCurrentICR(alice, price)
    const bob_ICR = await troveManager.getCurrentICR(bob, price)
    const carol_ICR = await troveManager.getCurrentICR(carol, price)
    assert.isTrue(alice_ICR.lte(mv._MCR))
    assert.isTrue(bob_ICR.lte(mv._MCR))
    assert.isTrue(carol_ICR.lte(mv._MCR))

    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidation with n = 0
    await assertRevert(liquidations.liquidateTroves(0), "Liquidations: nothing to liquidate")

    // Check all troves are still in the system
    assert.isTrue(await sortedShieldedTroves.contains(whale))
    assert.isTrue(await sortedShieldedTroves.contains(alice))
    assert.isTrue(await sortedShieldedTroves.contains(bob))
    assert.isTrue(await sortedShieldedTroves.contains(carol))

    const TCR_After = (await th.getTCR(contracts)).toString()

    // Check TCR has not changed after liquidation
    assert.equal(TCR_Before, TCR_After)
  })

  it("liquidateTroves():  liquidates troves with ICR < MCR", async () => {
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // A, B, C open troves that will remain active when price drops to 100
    await openShieldedTrove({ ICR: toBN(dec(220, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(230, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(240, 16)), extraParams: { from: carol } })

    // D, E, F open troves that will fall below MCR when price drops to 100
    await openShieldedTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(216, 16)), extraParams: { from: erin } })
    await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: flyn } })

    // Check list size is 7
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '7')

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    const alice_ICR = await troveManager.getCurrentICR(alice, price)
    const bob_ICR = await troveManager.getCurrentICR(bob, price)
    const carol_ICR = await troveManager.getCurrentICR(carol, price)
    const dennis_ICR = await troveManager.getCurrentICR(dennis, price)
    const erin_ICR = await troveManager.getCurrentICR(erin, price)
    const flyn_ICR = await troveManager.getCurrentICR(flyn, price)

    // Check A, B, C have ICR above MCR
    assert.isTrue(alice_ICR.gte(mv._MCR))
    assert.isTrue(bob_ICR.gte(mv._MCR))
    assert.isTrue(carol_ICR.gte(mv._MCR))

    // Check D, E, F have ICR below MCR
    assert.isTrue(dennis_ICR.lte(mv._MCR))
    assert.isTrue(erin_ICR.lte(mv._MCR))
    assert.isTrue(flyn_ICR.lte(mv._MCR))

    assert.isFalse(await th.checkRecoveryMode(contracts))

    // This fails
    //await liquidations.liquidate(alice)
    //Liquidate sequence
    await liquidations.liquidateTroves(10)

    // check list size reduced to 4
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '4')

    // Check Whale and A, B, C remain in the system
    assert.isTrue(await sortedShieldedTroves.contains(whale))
    assert.isTrue(await sortedShieldedTroves.contains(alice))
    assert.isTrue(await sortedShieldedTroves.contains(bob))
    assert.isTrue(await sortedShieldedTroves.contains(carol))

    // Check D, E, F have been removed
    assert.isFalse(await sortedShieldedTroves.contains(dennis))
    assert.isFalse(await sortedShieldedTroves.contains(erin))
    assert.isFalse(await sortedShieldedTroves.contains(flyn))
  })

  it("liquidateTroves(): does not affect the liquidated user's token balances", async () => {
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // D, E, F open troves that will fall below MCR when price drops to 100
    await openShieldedTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(216, 16)), extraParams: { from: erin } })
    await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: flyn } })

    const D_balanceBefore = await lusdToken.balanceOf(dennis)
    const E_balanceBefore = await lusdToken.balanceOf(erin)
    const F_balanceBefore = await lusdToken.balanceOf(flyn)

    // Check list size is 4
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '4')

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    const price = await priceFeed.getPrice()

    assert.isFalse(await th.checkRecoveryMode(contracts))

    //Liquidate sequence
    await liquidations.liquidateTroves(10)

    // check list size reduced to 1
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '1')

    // Check Whale remains in the system
    assert.isTrue(await sortedShieldedTroves.contains(whale))

    // Check D, E, F have been removed
    assert.isFalse(await sortedShieldedTroves.contains(dennis))
    assert.isFalse(await sortedShieldedTroves.contains(erin))
    assert.isFalse(await sortedShieldedTroves.contains(flyn))

    // Check token balances of users whose troves were liquidated, have not changed
    assert.equal((await lusdToken.balanceOf(dennis)).toString(), D_balanceBefore)
    assert.equal((await lusdToken.balanceOf(erin)).toString(), E_balanceBefore)
    assert.equal((await lusdToken.balanceOf(flyn)).toString(), F_balanceBefore)
  })

  it("liquidateTroves(): A liquidation sequence containing Pool offsets increases the TCR", async () => {
    // Whale provides 500 LUSD to SP
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: toBN(dec(500, 18)), extraParams: { from: whale } })
    await stabilityPool.provideToSP(dec(500, 18), ZERO_ADDRESS, { from: whale })

    // openTrove calls drip() and thus increase SP balances
    lusdTotal = toBN('0')
    var {tx} = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    lusdTotal = lusdTotal.add(toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest")));
    var {tx} = await openShieldedTrove({ ICR: toBN(dec(28, 18)), extraParams: { from: bob } })
    lusdTotal = lusdTotal.add(toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest")));
    var {tx} = await openShieldedTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: carol } })
    lusdTotal = lusdTotal.add(toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest")));
    var {tx} = await openShieldedTrove({ ICR: toBN(dec(80, 18)), extraParams: { from: dennis } })
    lusdTotal = lusdTotal.add(toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest")));

    var {tx} = await openShieldedTrove({ ICR: toBN(dec(199, 16)), extraParams: { from: defaulter_1 } })
    lusdTotal = lusdTotal.add(toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest")));
    var {tx} = await openShieldedTrove({ ICR: toBN(dec(156, 16)), extraParams: { from: defaulter_2 } })
    lusdTotal = lusdTotal.add(toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest")));
    var {tx} = await openShieldedTrove({ ICR: toBN(dec(183, 16)), extraParams: { from: defaulter_3 } })
    lusdTotal = lusdTotal.add(toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest")));
    var {tx} = await openShieldedTrove({ ICR: toBN(dec(166, 16)), extraParams: { from: defaulter_4 } })
    lusdTotal = lusdTotal.add(toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest")));

    assert.isTrue((await sortedShieldedTroves.contains(defaulter_1)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_2)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_3)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_4)))

    assert.equal((await sortedShieldedTroves.getSize()).toString(), '9')

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue(await troveManager.getCurrentICR(defaulter_1, dec(100, 18)) > dec(1, 18))
    assert.isTrue(await troveManager.getCurrentICR(defaulter_2, dec(100, 18)) > dec(1, 18))
    assert.isTrue(await troveManager.getCurrentICR(defaulter_3, dec(100, 18)) > dec(1, 18))
    assert.isTrue(await troveManager.getCurrentICR(defaulter_4, dec(100, 18)) > dec(1, 18))

    const TCR_Before = await th.getTCR(contracts)

    // Check pool has 500 LUSD
    assert.isTrue((await stabilityPool.getTotalLUSDDeposits()).eq(toBN(lusdTotal).add(toBN(dec(500, 18)))))
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate troves
    tx = await liquidations.liquidateTroves(10)
    const lusdGain = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "DistributeToSP", "lusdGain"));
    liquidatedDebt = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "Offset", "debtToOffset"));
    //maxActualOffset = toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Offset", "_maxActualOffset"));

    // Check pool has been almost emptied by the liquidations
    //assert.equal((await stabilityPool.getTotalLUSDDeposits()).toString(), dec(1, 18))
    // TODO is off by one ok
    assert.isAtMost(th.getDifference(await stabilityPool.getTotalLUSDDeposits(), toBN(dec(1, 18))), 1)

    // Check all defaulters have been liquidated
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_1)))
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_2)))
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_3)))
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_4)))

    // check system sized reduced to 5 troves
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '5')

    // Check that the liquidation sequence has improved the TCR
    const TCR_After = await th.getTCR(contracts)
    assert.isTrue(TCR_After.gte(TCR_Before))
  })

  it("liquidateTroves(): A liquidation sequence of pure redistributions decreases the TCR, due to gas compensation, but up to 0.5%", async () => {
    const { collateral: W_coll, totalDebt: W_debt } = await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })
    const { collateral: A_coll, totalDebt: A_debt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    const { collateral: B_coll, totalDebt: B_debt } = await openShieldedTrove({ ICR: toBN(dec(28, 18)), extraParams: { from: bob } })
    const { collateral: C_coll, totalDebt: C_debt } = await openShieldedTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_debt } = await openShieldedTrove({ ICR: toBN(dec(80, 18)), extraParams: { from: dennis } })

    const { collateral: d1_coll, totalDebt: d1_debt } = await openShieldedTrove({ ICR: toBN(dec(199, 16)), extraParams: { from: defaulter_1 } })
    const { collateral: d2_coll, totalDebt: d2_debt } = await openShieldedTrove({ ICR: toBN(dec(156, 16)), extraParams: { from: defaulter_2 } })
    const { collateral: d3_coll, totalDebt: d3_debt } = await openShieldedTrove({ ICR: toBN(dec(183, 16)), extraParams: { from: defaulter_3 } })
    const { collateral: d4_coll, totalDebt: d4_debt } = await openShieldedTrove({ ICR: toBN(dec(166, 16)), extraParams: { from: defaulter_4 } })

    const totalCollNonDefaulters = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)
    const totalCollDefaulters = d1_coll.add(d2_coll).add(d3_coll).add(d4_coll)
    const totalColl = totalCollNonDefaulters.add(totalCollDefaulters)
    const totalDebt = W_debt.add(A_debt).add(B_debt).add(C_debt).add(D_debt).add(d1_debt).add(d2_debt).add(d3_debt).add(d4_debt)

    assert.isTrue((await sortedShieldedTroves.contains(defaulter_1)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_2)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_3)))
    assert.isTrue((await sortedShieldedTroves.contains(defaulter_4)))

    assert.equal((await sortedShieldedTroves.getSize()).toString(), '9')

    // Price drops
    const price = toBN(dec(100, 18))
    await priceFeed.setPrice(price)

    const TCR_Before = await th.getTCR(contracts)
    assert.isAtMost(th.getDifference(TCR_Before, totalColl.mul(price).div(totalDebt)), 1000)

    // Check pool is empty before liquidation
    assert.equal((await stabilityPool.getTotalLUSDDeposits()).toString(), '0')
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate
    await liquidations.liquidateTroves(10)

    // Check all defaulters have been liquidated
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_1)))
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_2)))
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_3)))
    assert.isFalse((await sortedShieldedTroves.contains(defaulter_4)))

    // check system sized reduced to 5 troves
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '5')

    // Check that the liquidation sequence has reduced the TCR
    const TCR_After = await th.getTCR(contracts)
    // ((100+1+7+2+20)+(1+2+3+4)*0.995)*100/(2050+50+50+50+50+101+257+328+480)
    assert.isAtMost(th.getDifference(TCR_After, totalCollNonDefaulters.add(th.applyLiquidationFee(totalCollDefaulters)).mul(price).div(totalDebt)), 1000)
    assert.isTrue(TCR_Before.gte(TCR_After))
    assert.isTrue(TCR_After.gte(TCR_Before.mul(toBN(995)).div(toBN(1000))))
  })

  it("liquidateTroves(): Liquidating troves with SP deposits correctly impacts their SP deposit and Collateral gain", async () => {
    // Whale provides 400 LUSD to the SP
    const whaleDeposit = toBN(dec(40000, 18))
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: whaleDeposit, extraParams: { from: whale } })

    const A_deposit = toBN(dec(10000, 18))
    const B_deposit = toBN(dec(30000, 18))
    const { collateral: A_coll, totalDebt: A_debt } = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: A_deposit, extraParams: { from: alice } })
    const { collateral: B_coll, totalDebt: B_debt } = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: B_deposit, extraParams: { from: bob } })
    const { collateral: C_coll, totalDebt: C_debt } = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

    await stabilityPool.provideToSP(whaleDeposit, ZERO_ADDRESS, { from: whale })

    const liquidatedColl = A_coll.add(B_coll).add(C_coll)
    //const liquidatedDebt = A_debt.add(B_debt).add(C_debt)

    // A, B provide 100, 300 to the SP
    await stabilityPool.provideToSP(A_deposit, ZERO_ADDRESS, { from: alice })
    await stabilityPool.provideToSP(B_deposit, ZERO_ADDRESS, { from: bob })

    assert.equal((await sortedShieldedTroves.getSize()).toString(), '4')

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    // Check eq 800 LUSD in Pool.
    // no drips after provide so should be eq
    const totalDeposits = whaleDeposit.add(A_deposit).add(B_deposit)
    assert.isTrue((await stabilityPool.getTotalLUSDDeposits()).eq(totalDeposits))

    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate
    tx = await liquidations.liquidateTroves(10)
    const lusdGain = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "DistributeToSP", "lusdGain"));
    liquidatedDebt = toBN(th.getRawEventArgByName(tx, stabilityPoolInterface, stabilityPool.address, "Offset", "debtToOffset"));
    /*
    console.log("lusdGain", lusdGain.toString())
    console.log("debtOffset", debtOffset.toString())
    console.log("totalDeposits", totalDeposits.toString())
    */
    const newTotalDeposits = totalDeposits.add(lusdGain);
    //console.log("totalDeposits", totalDeposits.toString())

    // Check all defaulters have been liquidated
    assert.isFalse((await sortedShieldedTroves.contains(alice)))
    assert.isFalse((await sortedShieldedTroves.contains(bob)))
    assert.isFalse((await sortedShieldedTroves.contains(carol)))

    // check system sized reduced to 1 troves
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '1')

    /* Prior to liquidation, SP deposits were:
    Whale: 400 LUSD
    Alice: 100 LUSD
    Bob:   300 LUSD
    Carol: 0 LUSD

    Total LUSD in Pool: 800 LUSD

    Then, liquidation hits A,B,C: 

    Total liquidated debt = 150 + 350 + 150 = 650 LUSD
    Total liquidated Collateral = 1.1 + 3.1 + 1.1 = 5.3 Collateral

    whale lusd loss: 650 * (400/800) = 325 lusd
    alice lusd loss:  650 *(100/800) = 81.25 lusd
    bob lusd loss: 650 * (300/800) = 243.75 lusd

    whale remaining deposit: (400 - 325) = 75 lusd
    alice remaining deposit: (100 - 81.25) = 18.75 lusd
    bob remaining deposit: (300 - 243.75) = 56.25 lusd

    whale eth gain: 5*0.995 * (400/800) = 2.4875 eth
    alice eth gain: 5*0.995 *(100/800) = 0.621875 eth
    bob eth gain: 5*0.995 * (300/800) = 1.865625 eth

    Total remaining deposits: 150 LUSD
    Total Collateral gain: 4.975 Collateral */

    // Check remaining LUSD Deposits and Collateral gain, for whale and depositors whose troves were liquidated
    const whale_Deposit_After = await stabilityPool.getCompoundedLUSDDeposit(whale)
    const alice_Deposit_After = await stabilityPool.getCompoundedLUSDDeposit(alice)
    const bob_Deposit_After = await stabilityPool.getCompoundedLUSDDeposit(bob)

    const whale_CollateralGain = await stabilityPool.getDepositorCollateralGain(whale)
    const alice_CollateralGain = await stabilityPool.getDepositorCollateralGain(alice)
    const bob_CollateralGain = await stabilityPool.getDepositorCollateralGain(bob)

    const newWhaleDeposit = whaleDeposit.add(lusdGain.mul(whaleDeposit).div(totalDeposits))
    const newA_deposit = A_deposit.add(lusdGain.mul(A_deposit).div(totalDeposits))
    const newB_deposit = B_deposit.add(lusdGain.mul(B_deposit).div(totalDeposits))

    /*
    assert.isAtMost(th.getDifference(whale_Deposit_After, whaleDeposit.sub(liquidatedDebt.mul(whaleDeposit).div(totalDeposits))), 100000)
    assert.isAtMost(th.getDifference(alice_Deposit_After, A_deposit.sub(liquidatedDebt.mul(A_deposit).div(totalDeposits))), 100000)
    assert.isAtMost(th.getDifference(bob_Deposit_After, B_deposit.sub(liquidatedDebt.mul(B_deposit).div(totalDeposits))), 100000)
    */

    assert.isAtMost(th.getDifference(whale_Deposit_After, newWhaleDeposit.sub(liquidatedDebt.mul(newWhaleDeposit).div(newTotalDeposits))), 100000)
    assert.isAtMost(th.getDifference(alice_Deposit_After, newA_deposit.sub(liquidatedDebt.mul(newA_deposit).div(newTotalDeposits))), 100000)
    assert.isAtMost(th.getDifference(bob_Deposit_After, newB_deposit.sub(liquidatedDebt.mul(newB_deposit).div(newTotalDeposits))), 100000)

    assert.isAtMost(th.getDifference(whale_CollateralGain, th.applyLiquidationFee(liquidatedColl).mul(newWhaleDeposit).div(newTotalDeposits)), 100000)
    assert.isAtMost(th.getDifference(alice_CollateralGain, th.applyLiquidationFee(liquidatedColl).mul(newA_deposit).div(newTotalDeposits)), 100000)
    assert.isAtMost(th.getDifference(bob_CollateralGain, th.applyLiquidationFee(liquidatedColl).mul(newB_deposit).div(newTotalDeposits)), 100000)

    // Check total remaining deposits and Collateral gain in Stability Pool
    const total_LUSDinSP = (await stabilityPool.getTotalLUSDDeposits()).toString()
    const total_CollateralinSP = (await stabilityPool.getCollateral()).toString()

    assert.isAtMost(th.getDifference(total_LUSDinSP, newTotalDeposits.sub(liquidatedDebt)), 1000)
    assert.isAtMost(th.getDifference(total_CollateralinSP, th.applyLiquidationFee(liquidatedColl)), 1000)
  })

  it("liquidateTroves(): when SP > 0, triggers LQTY reward event - increases the sum G", async () => {
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    await openShieldedTrove({ ICR: toBN(dec(219, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(213, 16)), extraParams: { from: defaulter_2 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })
    assert.equal(await stabilityPool.getTotalLUSDDeposits(), dec(100, 18))

    const G_Before = await stabilityPool.scaleToG(0)

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // Price drops to 1Collateral:100LUSD, reducing defaulters to below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate troves
    await liquidations.liquidateTroves(2)
    assert.isFalse(await sortedShieldedTroves.contains(defaulter_1))
    assert.isFalse(await sortedShieldedTroves.contains(defaulter_2))

    const G_After = await stabilityPool.scaleToG(0)

    // Expect G has increased from the LQTY reward event triggered
    assert.isTrue(G_After.gt(G_Before))
  })

  it("liquidateTroves(): SP cannot be emptied by withdrawing", async () => {
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves
    await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: toBN(dec(100, 18)), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    await openShieldedTrove({ ICR: toBN(dec(219, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(213, 16)), extraParams: { from: defaulter_2 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // B tries to fully withdraw
    await assertRevert(stabilityPool.withdrawFromSP(dec(100, 18), { from: B }), "Withdrawal must leave totalBoldDeposits >= MIN_LUSD_IN_SP")

    // Check SP is not empty
    assert.isTrue((await stabilityPool.getTotalLUSDDeposits()).gt(toBN('0')))
  })


  // --- batchLiquidate() ---

  it('batchLiquidate(): liquidates a Trove that a) was skipped in a previous liquidation and b) has pending rewards', async () => {
    // A, B, C, D, E open troves 
    /*
    await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraParams: { from: C } })
    await openShieldedTrove({ ICR: toBN(dec(364, 16)), extraParams: { from: D } })
    await openShieldedTrove({ ICR: toBN(dec(364, 16)), extraParams: { from: E } })
    await openShieldedTrove({ ICR: toBN(dec(140, 16)), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })
    */

    await openShieldedTrove({ ICR: toBN(dec(333, 16)), extraParams: { from: D } })
    await openShieldedTrove({ ICR: toBN(dec(333, 16)), extraParams: { from: E } })
    await openShieldedTrove({ ICR: toBN(dec(140, 16)), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: C } })

    // Price drops
    await priceFeed.setPrice(dec(150, 18))
    let price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))
    
    // A gets liquidated, creates pending rewards for all
    const liqTxA = await liquidations.liquidate(A)
    assert.isTrue(liqTxA.receipt.status)
    assert.isFalse(await sortedShieldedTroves.contains(A))

    // A adds 10 LUSD to the SP, but less than C's debt
    await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, {from: A})

    // Price drops
    await priceFeed.setPrice(dec(100, 18))
    price = await priceFeed.getPrice()
    assert.isTrue(await th.checkRecoveryMode(contracts))

    // Confirm C has ICR > TCR
    const TCR = await troveManager.getTCR(price)
    const ICR_C = await troveManager.getCurrentICR(C, price)
  
    assert.isTrue(ICR_C.gt(TCR))

    // Attempt to liquidate B and C, which skips C in the liquidation since it is immune
    const liqTxBC = await liquidations.liquidateTroves(2)
    assert.isTrue(liqTxBC.receipt.status)
    assert.isFalse(await sortedShieldedTroves.contains(B))
    assert.isTrue(await sortedShieldedTroves.contains(C))
    assert.isTrue(await sortedShieldedTroves.contains(D))
    assert.isTrue(await sortedShieldedTroves.contains(E))

    // // All remaining troves D and E repay a little debt, applying their pending rewards
    assert.isTrue((await sortedShieldedTroves.getSize()).eq(toBN('3')))
    await borrowerOperations.repayLUSD(dec(1, 18), D, D, {from: D})
    await borrowerOperations.repayLUSD(dec(1, 18), E, E, {from: E})

    // Check C is the only trove that has pending rewards
    assert.isTrue(await rewards.hasPendingRewards(C))
    assert.isFalse(await rewards.hasPendingRewards(D))
    assert.isFalse(await rewards.hasPendingRewards(E))

    // Check C's pending coll and debt rewards are <= the coll and debt in the DefaultPool
    const pendingCollateral_C = await rewards.getPendingCollateralReward(C)
    const pendingLUSDDebt_C = await rewards.getPendingLUSDDebtReward(C)
    const defaultPoolCollateral = await defaultPool.getCollateral()
    const defaultPoolLUSDDebt = await defaultPool.getLUSDDebt()
    assert.isTrue(pendingCollateral_C.lte(defaultPoolCollateral))
    assert.isTrue(pendingLUSDDebt_C.lte(defaultPoolLUSDDebt))
    //Check only difference is dust
    assert.isAtMost(th.getDifference(pendingCollateral_C, defaultPoolCollateral), 1000)
    assert.isAtMost(th.getDifference(pendingLUSDDebt_C, defaultPoolLUSDDebt), 1000)
    assert.isTrue(await th.checkRecoveryMode(contracts))

    // D and E fill the Stability Pool, enough to completely absorb C's debt of 70
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, {from: D})
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, {from: E})

    await priceFeed.setPrice(dec(50, 18))

    // Try to liquidate C again. Check it succeeds and closes C's trove
    const liqTx2 = await liquidations.batchLiquidate([C,D])
    assert.isTrue(liqTx2.receipt.status)
    assert.isFalse(await sortedShieldedTroves.contains(C))
    assert.isFalse(await sortedShieldedTroves.contains(D))
    assert.isTrue(await sortedShieldedTroves.contains(E))
    assert.isTrue((await sortedShieldedTroves.getSize()).eq(toBN('1')))
  })

  it('batchLiquidate(): closes every trove with ICR < MCR in the given array', async () => {
    // --- SETUP ---
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    // Check full sorted list size is 6
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '6')

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(300, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Confirm troves A-C are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mv._MCR))

    // Confirm D-E are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR >= 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    liquidationArray = [alice, bob, carol, dennis, erin]
    await liquidations.batchLiquidate(liquidationArray);

    // Confirm troves A-C have been removed from the system
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))
    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // Check all troves A-C are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
    // Check sorted list has been reduced to length 3
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '3')
  })

  it('batchLiquidate(): succeeds if passed inactive trove', async () => {
  // --- SETUP ---
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })
  
    // Check full sorted list size is 6
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '6')

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(300, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Confirm troves A-C are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mv._MCR))

    // Confirm D-E are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR >= 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    await liquidations.liquidate(alice)
    assert.isFalse(await sortedShieldedTroves.contains(alice))

    liquidationArray = [alice, bob, carol, dennis, erin]
    await liquidations.batchLiquidate(liquidationArray);

    // Confirm troves A-C have been removed from the system
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))
    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // Check all troves A-C are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
    // Check sorted list has been reduced to length 3
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '3')
  })

  it('batchLiquidate(): succeeds if passed inactive trove', async () => {
  // --- SETUP ---
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    // Check full sorted list size is 6
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '6')

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(300, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Confirm troves A-C are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mv._MCR))

    // Confirm D-E are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR >= 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    await liquidations.liquidate(alice)
    assert.isFalse(await sortedShieldedTroves.contains(alice))

  liquidationArray = [alice, bob, carol, dennis, erin]
    await liquidations.batchLiquidate(liquidationArray);

    // Confirm troves A-C have been removed from the system
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))
    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // Check all troves A-C are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
    // Check sorted list has been reduced to length 3
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '3')
  })

  it('batchLiquidate(): succeeds if passed inactive trove', async () => {
    // --- SETUP ---
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })
  
    // Check full sorted list size is 6
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '6')

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(300, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Confirm troves A-C are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mv._MCR))

    // Confirm D-E are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR >= 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    await liquidations.liquidate(alice)
    assert.isFalse(await sortedShieldedTroves.contains(alice))

    liquidationArray = [alice, bob, carol, dennis, erin]
    await liquidations.batchLiquidate(liquidationArray);

    // Confirm troves A-C have been removed from the system
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))
    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // Check all troves A-C are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')
    // Check sorted list has been reduced to length 3
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '3')
  })

  it('batchLiquidate(): succeeds if passed inactive trove', async () => {
  // --- SETUP ---
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    // Check full sorted list size is 6
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '6')

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(300, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Confirm troves A-C are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mv._MCR))

    // Confirm D-E are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR >= 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    await liquidations.liquidate(alice)
    assert.isFalse(await sortedShieldedTroves.contains(alice))

    liquidationArray = [alice, bob, carol, dennis, erin]
    await liquidations.batchLiquidate(liquidationArray);

    // Confirm troves A-C have been removed from the system
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))
    assert.isFalse(await sortedShieldedTroves.contains(carol))

    // Check all troves A-C are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    assert.equal((await troveManager.Troves(carol))[3].toString(), '3')

    // Check sorted list has been reduced to length 3
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '3')
  })

  it('batchLiquidate(): does not liquidate troves that are not in the given array', async () => {
    // --- SETUP ---
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: toBN(dec(500, 18)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: toBN(dec(500, 18)), extraParams: { from: erin } })

    // Check full sorted list size is 6
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '6')

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(300, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Confirm troves A-E are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).lt(mv._MCR))

    liquidationArray = [alice, bob]  // C-E not included
    await liquidations.batchLiquidate(liquidationArray);

    // Confirm troves A-B have been removed from the system
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))

    // Check all troves A-B are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')

    // Confirm troves C-E remain in the system
    assert.isTrue(await sortedShieldedTroves.contains(carol))
    assert.isTrue(await sortedShieldedTroves.contains(dennis))
    assert.isTrue(await sortedShieldedTroves.contains(erin))

    // Check all troves C-E are still active
    assert.equal((await troveManager.Troves(carol))[3].toString(), '1')
    assert.equal((await troveManager.Troves(dennis))[3].toString(), '1')
    assert.equal((await troveManager.Troves(erin))[3].toString(), '1')

    // Check sorted list has been reduced to length 4
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '4')
  })

  it('batchLiquidate(): does not close troves with ICR >= MCR in the given array', async () => {
    // --- SETUP ---
    HCR = await troveManager.HCR()
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: HCR.add(toBN(dec(10, 16))), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    // Check full sorted list size is 6
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '6')

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(300, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Confirm troves A-C are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mv._MCR))

    // Confirm D-E are ICR >= 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR > 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    liquidationArray = [alice, bob, carol, dennis, erin]
    await liquidations.batchLiquidate(liquidationArray);

    // Confirm troves D-E and whale remain in the system
    assert.isTrue(await sortedShieldedTroves.contains(dennis))
    assert.isTrue(await sortedShieldedTroves.contains(erin))
    assert.isTrue(await sortedShieldedTroves.contains(whale))

    // Check all troves D-E and whale remain active
    assert.equal((await troveManager.Troves(dennis))[3].toString(), '1')
    assert.equal((await troveManager.Troves(erin))[3].toString(), '1')
    assert.isTrue(await sortedShieldedTroves.contains(whale))

    // Check sorted list has been reduced to length 3
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '3')
  })

  it('batchLiquidate(): reverts if array is empty', async () => {
    // --- SETUP ---
    HCR = await troveManager.HCR()
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: HCR.add(toBN(dec(10, 16))), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    // Check full sorted list size is 6
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '6')

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(dec(300, 18), ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    liquidationArray = []
    try {
      const tx = await liquidations.batchLiquidate(liquidationArray);
      assert.isFalse(tx.receipt.status)
    } catch (error) {
      assert.include(error.message, "Liquidations: address array must not be empty")
    }
  })

  it("batchLiquidate(): skips if trove is non-existent", async () => {
    // --- SETUP ---
    HCR = await troveManager.HCR()
    const spDeposit = toBN(dec(500000, 18))
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })

    const { totalDebt: A_debt } = await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: alice } })
    const { totalDebt: B_debt } = await openShieldedTrove({ ICR: HCR.add(toBN(dec(10, 16))), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    assert.equal(await troveManager.getTroveStatus(carol), 0) // check trove non-existent

    // Check full sorted list size is 6
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '5')

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Confirm troves A-B are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))

    // Confirm D-E are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR >= 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    // Liquidate - trove C in between the ones to be liquidated!
    const liquidationArray = [alice, carol, bob, dennis, erin]
    tx = await liquidations.batchLiquidate(liquidationArray);
    lusdGainLiq = toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest"))

    // actual liquidated debt includes interest
    liqDebt = toBN(th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Liquidation", "_liquidatedDebt"))

    // SP gained funds from drip
    totalSp = spDeposit.add(lusdGainLiq)

    // Confirm troves A-B have been removed from the system
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))

    // Check all troves A-B are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')

    // Check sorted list has been reduced to length 3
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '3')

    // Confirm trove C non-existent
    assert.isFalse(await sortedShieldedTroves.contains(carol))
    assert.equal((await troveManager.Troves(carol))[3].toString(), '0')

    // Check Stability pool has only been reduced by A-B
    th.assertIsApproximatelyEqual((await stabilityPool.getTotalLUSDDeposits()).toString(), totalSp.sub(liqDebt))

    assert.isFalse(await th.checkRecoveryMode(contracts))
  })

  it("batchLiquidate(): skips if a trove has been closed", async () => {
    // --- SETUP ---
    HCR = await troveManager.HCR()
    const spDeposit = toBN(dec(500000, 18))
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })

    const { totalDebt: A_debt } = await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: alice } })
    const { totalDebt: B_debt } = await openShieldedTrove({ ICR: HCR.add(toBN(dec(10, 16))), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(2000, 16)), extraParams: { from: dennis } })
    await openShieldedTrove({ ICR: toBN(dec(1800, 16)), extraParams: { from: erin } })

    assert.isTrue(await sortedShieldedTroves.contains(carol))

    // Check full sorted list size is 6
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '6')

    // Whale puts some tokens in Stability Pool
    await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

    // Whale transfers to Carol so she can close her trove
    await lusdToken.transfer(carol, dec(100, 18), { from: whale })

    // --- TEST ---

    // Price drops to 1Collateral:100LUSD, reducing A, B, C ICR below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()

    // Carol liquidated, and her trove is closed
    const txCarolClose = await borrowerOperations.closeTrove({ from: carol })
    lusdGainClose = toBN(th.getRawEventArgByName(txCarolClose, troveManagerInterface, troveManager.address, "Drip", "_spInterest"))
    assert.isTrue(txCarolClose.receipt.status)

    assert.isFalse(await sortedShieldedTroves.contains(carol))

    assert.equal(await troveManager.getTroveStatus(carol), 2)  // check trove closed
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Confirm troves A-B are ICR < 110%
    assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mv._MCR))

    // Confirm D-E are ICR > 110%
    assert.isTrue((await troveManager.getCurrentICR(dennis, price)).gte(mv._MCR))
    assert.isTrue((await troveManager.getCurrentICR(erin, price)).gte(mv._MCR))

    // Confirm Whale is ICR >= 110% 
    assert.isTrue((await troveManager.getCurrentICR(whale, price)).gte(mv._MCR))

    // Liquidate - trove C in between the ones to be liquidated!
    const liquidationArray = [alice, carol, bob, dennis, erin]
    tx = await liquidations.batchLiquidate(liquidationArray);
    lusdGainLiq = toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest"))
    lusdGain = lusdGainClose.add(lusdGainLiq)

    // actual liquidated debt includes interest
    liqDebt = toBN(th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Liquidation", "_liquidatedDebt"))

    // SP gained funds from drip
    totalSp = spDeposit.add(lusdGain)

    // Confirm troves A-B have been removed from the system
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    assert.isFalse(await sortedShieldedTroves.contains(bob))

    // Check all troves A-B are now closed by liquidation
    assert.equal((await troveManager.Troves(alice))[3].toString(), '3')
    assert.equal((await troveManager.Troves(bob))[3].toString(), '3')
    // Trove C still closed by user
    assert.equal((await troveManager.Troves(carol))[3].toString(), '2')

    // Check sorted list has been reduced to length 3
    assert.equal((await sortedShieldedTroves.getSize()).toString(), '3')

    //console.log((await stabilityPool.getTotalLUSDDeposits()).toString())
    //console.log(spDeposit.sub(A_debt).sub(B_debt).toString())
    // Check Stability pool has only been reduced by A-B
    th.assertIsApproximatelyEqual((await stabilityPool.getTotalLUSDDeposits()).toString(), totalSp.sub(liqDebt))

    assert.isFalse(await th.checkRecoveryMode(contracts))
  })

  it("batchLiquidate: when SP > 0, triggers LQTY reward event - increases the sum G", async () => {
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(167, 16)), extraParams: { from: C } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_2 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })
    assert.equal(await stabilityPool.getTotalLUSDDeposits(), dec(100, 18))

    const G_Before = await stabilityPool.scaleToG(0)

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // Price drops to 1Collateral:100LUSD, reducing defaulters to below MCR
    await priceFeed.setPrice(dec(100, 18));
    const price = await priceFeed.getPrice()
    assert.isFalse(await th.checkRecoveryMode(contracts))

    // Liquidate troves
    await liquidations.batchLiquidate([defaulter_1, defaulter_2])
    assert.isFalse(await sortedShieldedTroves.contains(defaulter_1))
    assert.isFalse(await sortedShieldedTroves.contains(defaulter_2))

    const G_After = await stabilityPool.scaleToG(0)

    // Expect G has increased from the LQTY reward event triggered
    assert.isTrue(G_After.gt(G_Before))
  })

  it("batchLiquidate(): SP cannot be emptied by withdrawing", async () => {
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // A, B, C open troves
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(133, 16)), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(167, 16)), extraParams: { from: C } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_1 } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: defaulter_2 } })

    // B provides to SP
    await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: B })

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

    // B tries to fully withdraw
    await assertRevert(stabilityPool.withdrawFromSP(dec(100, 18), { from: B }), "Withdrawal must leave totalBoldDeposits >= MIN_LUSD_IN_SP")

    // Check SP is not empty
    assert.isTrue((await stabilityPool.getTotalLUSDDeposits()).gt(toBN('0')))
  })

  // --- redemptions ---


  it('getRedemptionHints(): gets the address of the first Trove and the final ICR of the last Trove involved in a redemption', async () => {
    // --- SETUP ---
    HCR = await troveManager.HCR()
    const partialRedemptionAmount = toBN(dec(100, 18))

    const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: partialRedemptionAmount, extraParams: { from: alice } })
    const { netDebt: B_debt } = await openTrove({ ICR: toBN(dec(290, 16)), extraParams: { from: bob } })

    const { netDebt: C_debt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraParams: { from: carol } })

    // Dennis' Trove should be untouched by redemption, because its ICR will be < 110% after the price drop
    await openShieldedTrove({ ICR: HCR.add(toBN(dec(10, 16))), extraParams: { from: dennis } })

    assert.isTrue((await troveManager.getTroveOwnersCount()).eq(toBN('2')))
    assert.isTrue((await troveManager.getShieldedTroveOwnersCount()).eq(toBN('2')))
    assert.isTrue((await sortedTroves.getSize()).eq(toBN('2')))
    assert.isTrue((await sortedShieldedTroves.getSize()).eq(toBN('2')))

    assert((await sortedTroves.getLast()) == bob)
    assert((await sortedTroves.getFirst()) == alice)
    assert((await sortedShieldedTroves.getLast()) == dennis)
    assert((await sortedShieldedTroves.getFirst()) == carol)


    // Drop the price
    const price = toBN(dec(100, 18))
    await priceFeed.setPrice(price);
    const totalSystemDebt = await th.getEntireSystemDebt(contracts)
    const par = await relayer.par()

    // console.log("bob icr", (await troveManager.getCurrentICR(bob, price)).toString())
    // console.log("alice icr", (await troveManager.getCurrentICR(alice, price)).toString())
    // console.log("dennis icr", (await troveManager.getCurrentICR(dennis, price)).toString())
    // console.log("carol icr", (await troveManager.getCurrentICR(carol, price)).toString())

    // --- TEST ---
    const redemptionAmount = C_debt.add(B_debt).add(partialRedemptionAmount)
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)

    assert.equal(firstRedemptionHint, carol)

    

    const redemptionRate = await aggregator.calcRateForRedemption(redemptionAmount, totalSystemDebt)
    const grossCollateralDrawn = partialRedemptionAmount.mul(par).div(price)
    const fee = grossCollateralDrawn.mul(redemptionRate).div(toBN(dec(1, 18)))
    const netCollateralRemoved = grossCollateralDrawn.sub(fee)

    const expectedICR = A_coll.sub(netCollateralRemoved).mul(price).div(A_totalDebt.sub(partialRedemptionAmount))

    th.assertIsApproximatelyEqual(partialRedemptionHintNICR, expectedICR)
  });

  it('getRedemptionHints(): returns 0 as partialRedemptionHintNICR when reaching _maxIterations', async () => {
    // This original test is broken in Liquity V1
    // as it doesn't actually test the intended description
    // partialNICR is zero because all troves are at MIN_NET_DEBT
    const { lusdAmount, netDebt, totalDebt } = await openShieldedTrove({ ICR: toBN(dec(310, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(309, 16)), extraLUSDAmount: dec(30, 18), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(308, 16)), extraLUSDAmount: dec(30, 18), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(307, 16)), extraLUSDAmount: dec(170, 18), extraParams: { from: dennis } })

    /*
    await openTrove({ ICR: toBN(dec(290, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(250, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraParams: { from: dennis } })
    */

    //const price = await priceFeed.getPrice();
    price = dec(80, 18)

    // Shielded Troves ICR must be MCR < ICR < HCR
    // to be redeemable
    MCR = await troveManager.MCR()
    HCR = await troveManager.HCR()

    aliceICR = await troveManager.getCurrentICR(alice, price)
    bobICR = await troveManager.getCurrentICR(bob, price)
    carolICR = await troveManager.getCurrentICR(carol, price)
    dennisICR = await troveManager.getCurrentICR(dennis, price)

    assert(aliceICR.gt(MCR))
    assert(aliceICR.lt(HCR))
    assert(bobICR.gt(MCR))
    assert(bobICR.lt(HCR))
    assert(carolICR.gt(MCR))
    assert(carolICR.lt(HCR))
    assert(dennisICR.gt(MCR))
    assert(dennisICR.lt(HCR))

    const MIN_NET_DEBT = await borrowerOperations.MIN_NET_DEBT()
    const aliceNetDebt = (await troveManager.getTroveDebt(alice)).sub(await troveManager.LUSD_GAS_COMPENSATION())
    const bobNetDebt = (await troveManager.getTroveDebt(bob)).sub(await troveManager.LUSD_GAS_COMPENSATION())
    const carolNetDebt = (await troveManager.getTroveDebt(carol)).sub(await troveManager.LUSD_GAS_COMPENSATION())
    const dennisNetDebt = (await troveManager.getTroveDebt(dennis)).sub(await troveManager.LUSD_GAS_COMPENSATION())
    console.log("MIN_NET_DEBT", MIN_NET_DEBT.toString())
    console.log("aliceNetDebt", aliceNetDebt.toString())
    console.log("bobNetDebt", bobNetDebt.toString())
    console.log("carolNetDebt", carolNetDebt.toString())
    console.log("dennisNetDebt", dennisNetDebt.toString())

    assert.isTrue(aliceNetDebt.eq(MIN_NET_DEBT))
    console.log("bobNetDebt", bobNetDebt.toString())
    console.log("carolNetDebt", carolNetDebt.toString())
    console.log("dennisNetDebt", dennisNetDebt.toString())

    extra = toBN(dec(20, 18))

    requestedAmount = dennisNetDebt.add(carolNetDebt).add(extra)
    expAmount = requestedAmount.sub(extra)

    // --- TEST ---

    // Get hints for a redemption of 170 + 30 + some extra LUSD. At least 3 iterations are needed
    // for total redemption of the given amount.
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR,
      truncatedLUSDamount
    } = await hintHelpers.getRedemptionHints(requestedAmount, price, 2) // limit _maxIterations to 2

    //assert.equal(partialRedemptionHintNICR, '0')
    console.log("firstRedemptionHint", firstRedemptionHint.toString())
    console.log("partialRedemptionHintNICR", partialRedemptionHintNICR.toString())
    console.log("truncatedLUSDamount", truncatedLUSDamount.toString())

    assert.isTrue(partialRedemptionHintNICR.eq(toBN('0')))      // 
    console.log("requestedAmount", requestedAmount.toString())
    console.log("truncatedLUSDamount", truncatedLUSDamount.toString())
    console.log("expAmount", expAmount.toString())
    assert.isTrue(truncatedLUSDamount.eq(requestedAmount.sub(extra)))

  });

  it('redeemCollateral(): cancels the provided LUSD with debt from Troves with the lowest ICRs and sends an equivalent amount of Collateral', async () => {
    // --- SETUP ---
    /*
    const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    */
    const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(255, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(251, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_CollateralBalance_Before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_Before = await lusdToken.balanceOf(dennis)

    price = toBN(dec(100, 18))
    await priceFeed.setPrice(price)


    // --- TEST ---

    // Find hints for redeeming 20 LUSD
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)

    // We don't need to use getApproxHint for this test, since it's not the subject of this
    // test case, and the list is very small, so the correct position is quickly found
    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    const redemptionTx = await troveManager.redeemCollateral(
      redemptionAmount,
      firstRedemptionHint,
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_Trove_After = await troveManager.Troves(alice)
    const bob_Trove_After = await troveManager.Troves(bob)
    const carol_Trove_After = await troveManager.Troves(carol)

    const alice_debt_After = alice_Trove_After[0].toString()
    const bob_debt_After = bob_Trove_After[0].toString()
    const carol_debt_After = carol_Trove_After[0].toString()

    /* check that Dennis' redeemed 20 LUSD has been cancelled with debt from Bobs's Trove (8) and Carol's Trove (10).
    The remaining lot (2) is sent to Alice's Trove, who had the best ICR.
    It leaves her with (3) LUSD debt + 50 for gas compensation. */
    th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))
    assert.equal(bob_debt_After, '0')
    assert.equal(carol_debt_After, '0')

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_Before)
    const par = await relayer.par()
    const expectedTotalCollateralDrawn = redemptionAmount.mul(par).div(price) // convert redemptionAmount * par / collateral price, at Collateral:USD price 200
    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(toBN(CollateralFee))// gas is not removed from erc20 collateral // .sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received Collateral


    /*
    console.log("*********************************************************************************")
    console.log("CollateralFee: " + CollateralFee)
    console.log("dennis_CollateralBalance_Before: " + dennis_CollateralBalance_Before)
    console.log("GAS_USED: " + th.gasUsed(redemptionTx))
    console.log("dennis_CollateralBalance_After: " + dennis_CollateralBalance_After)
    console.log("expectedTotalCollateralDrawn: " + expectedTotalCollateralDrawn)
    console.log("received  : " + receivedCollateral)
    console.log("expected : " + expectedReceivedCollateral)
    console.log("*********************************************************************************")
    */
    // Check the redeemed fraction calculation

    th.assertIsApproximatelyEqual(expectedReceivedCollateral, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_Before.sub(redemptionAmount))

    debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
    supply = await contracts.lusdToken.totalSupply()
    // console.log("debt", debt.toString())
    // console.log("supply", supply.toString())
    // console.log("supply - debt", supply.sub(debt).toString())
    assert.isTrue(supply.eq(debt))
  })

  it('redeemCollateral(): with invalid first hint, zero address', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(255, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(252, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_CollateralBalance_Before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_Before = await lusdToken.balanceOf(dennis)

    // drop troves below HCR
    price = toBN(dec(100, 18))
    await priceFeed.setPrice(price)

    // --- TEST ---

    // Find hints for redeeming 20 LUSD
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)

    // We don't need to use getApproxHint for this test, since it's not the subject of this
    // test case, and the list is very small, so the correct position is quickly found
    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    const redemptionTx = await troveManager.redeemCollateral(
      redemptionAmount,
      ZERO_ADDRESS, // invalid first hint
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE 
      }
    )

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_Trove_After = await troveManager.Troves(alice)
    const bob_Trove_After = await troveManager.Troves(bob)
    const carol_Trove_After = await troveManager.Troves(carol)

    const alice_debt_After = alice_Trove_After[0].toString()
    const bob_debt_After = bob_Trove_After[0].toString()
    const carol_debt_After = carol_Trove_After[0].toString()

    /* check that Dennis' redeemed 20 LUSD has been cancelled with debt from Bobs's Trove (8) and Carol's Trove (10).
    The remaining lot (2) is sent to Alice's Trove, who had the best ICR.
    It leaves her with (3) LUSD debt + 50 for gas compensation. */
    th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))
    assert.equal(bob_debt_After, '0')
    assert.equal(carol_debt_After, '0')

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_Before)
    const par = await relayer.par()
    const expectedTotalCollateralDrawn = redemptionAmount.mul(par).div(price) // convert redemptionAmount * par / collateral price, at Collateral:USD price 200
    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(toBN(CollateralFee))// gas is not removed from erc20 collateral // .sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received Collateral

    th.assertIsApproximatelyEqual(expectedReceivedCollateral, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_Before.sub(redemptionAmount))
  })

  it('redeemCollateral(): with invalid first hint, non-existent trove', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(253, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(251, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_CollateralBalance_Before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_Before = await lusdToken.balanceOf(dennis)

    // drop troves below HCR
    const price = toBN(dec(100, 18))
    await priceFeed.setPrice(price)

    // --- TEST ---

    // Find hints for redeeming 20 LUSD
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)

    // We don't need to use getApproxHint for this test, since it's not the subject of this
    // test case, and the list is very small, so the correct position is quickly found
    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    const redemptionTx = await troveManager.redeemCollateral(
      redemptionAmount,
      erin, // invalid first hint, it doesn't have a trove
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_Trove_After = await troveManager.Troves(alice)
    const bob_Trove_After = await troveManager.Troves(bob)
    const carol_Trove_After = await troveManager.Troves(carol)

    const alice_debt_After = alice_Trove_After[0].toString()
    const bob_debt_After = bob_Trove_After[0].toString()
    const carol_debt_After = carol_Trove_After[0].toString()

    /* check that Dennis' redeemed 20 LUSD has been cancelled with debt from Bobs's Trove (8) and Carol's Trove (10).
    The remaining lot (2) is sent to Alice's Trove, who had the best ICR.
    It leaves her with (3) LUSD debt + 50 for gas compensation. */
    th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))
    assert.equal(bob_debt_After, '0')
    assert.equal(carol_debt_After, '0')

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_Before)
    // get par after redemption
    const par = await relayer.par()
    const expectedTotalCollateralDrawn = redemptionAmount.mul(par).div(price) // convert redemptionAmount * par / collateral price, at Collateral:USD price 200
    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(toBN(CollateralFee))// gas is not removed from erc20 collateral // .sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received Collateral

    th.assertIsApproximatelyEqual(expectedReceivedCollateral, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_Before.sub(redemptionAmount))
  })

  it('redeemCollateral(): with invalid first hint, trove below MCR', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(253, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(251, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_CollateralBalance_Before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_Before = await lusdToken.balanceOf(dennis)

    // drop troves below HCR
    const price = toBN(dec(100, 18))
    await priceFeed.setPrice(price)

    // Increase price to start Erin, and decrease it again so its ICR is under MCR
    await priceFeed.setPrice(price.mul(toBN(2)))
    await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: erin } })
    await priceFeed.setPrice(price)


    // --- TEST ---

    // Find hints for redeeming 20 LUSD
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)

    // We don't need to use getApproxHint for this test, since it's not the subject of this
    // test case, and the list is very small, so the correct position is quickly found
    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    const redemptionTx = await troveManager.redeemCollateral(
      redemptionAmount,
      erin, // invalid trove, below MCR
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_Trove_After = await troveManager.Troves(alice)
    const bob_Trove_After = await troveManager.Troves(bob)
    const carol_Trove_After = await troveManager.Troves(carol)

    const alice_debt_After = alice_Trove_After[0].toString()
    const bob_debt_After = bob_Trove_After[0].toString()
    const carol_debt_After = carol_Trove_After[0].toString()

    /* check that Dennis' redeemed 20 LUSD has been cancelled with debt from Bobs's Trove (8) and Carol's Trove (10).
    The remaining lot (2) is sent to Alice's Trove, who had the best ICR.
    It leaves her with (3) LUSD debt + 50 for gas compensation. */
    th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))
    assert.equal(bob_debt_After, '0')
    assert.equal(carol_debt_After, '0')

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_Before)
    // get par after redemption
    const par = await relayer.par()
    
    const expectedTotalCollateralDrawn = redemptionAmount.mul(par).div(price) // convert redemptionAmount * par / collateral price, at Collateral:USD price 200
    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(toBN(CollateralFee))// gas is not removed from erc20 collateral // .sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received Collateral

    th.assertIsApproximatelyEqual(expectedReceivedCollateral, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_Before.sub(redemptionAmount))
  })

  it('redeemCollateral(): ends the redemption sequence when the token redemption request has been filled', async () => {
    // --- SETUP --- 
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol, Dennis, Erin open troves
    const { netDebt: A_debt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
    const { netDebt: B_debt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
    const { netDebt: C_debt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
    const redemptionAmount = A_debt.add(B_debt).add(C_debt)
    const { totalDebt: D_totalDebt, collateral: D_coll } = await openShieldedTrove({ ICR: toBN(dec(255, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: dennis } })
    const { totalDebt: E_totalDebt, collateral: E_coll } = await openShieldedTrove({ ICR: toBN(dec(255, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: erin } })

    // drop troves below HCR
    price = toBN(dec(100, 18))
    await priceFeed.setPrice(price)

    // --- TEST --- 

    // open trove from redeemer.  Redeemer has highest ICR (100Collateral, 100 LUSD), 20000%
    const { lusdAmount: F_lusdAmount } = await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount.mul(toBN(2)), extraParams: { from: flyn } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Flyn redeems collateral
    await troveManager.redeemCollateral(redemptionAmount, alice, alice, alice, alice, alice, 0, 0, th._100pct, { from: flyn })

    // Check Flyn's redemption has reduced his balance from 100 to (100-60) = 40 LUSD
    const flynBalance = await lusdToken.balanceOf(flyn)
    th.assertIsApproximatelyEqual(flynBalance, F_lusdAmount.sub(redemptionAmount))

    // Check debt of Alice, Bob, Carol
    const alice_Debt = await troveManager.getTroveDebt(alice)
    const bob_Debt = await troveManager.getTroveDebt(bob)
    const carol_Debt = await troveManager.getTroveDebt(carol)

    assert.equal(alice_Debt, 0)
    assert.equal(bob_Debt, 0)
    assert.equal(carol_Debt, 0)

    // check Alice, Bob and Carol troves are closed by redemption
    const alice_Status = await troveManager.getTroveStatus(alice)
    const bob_Status = await troveManager.getTroveStatus(bob)
    const carol_Status = await troveManager.getTroveStatus(carol)
    assert.equal(alice_Status, 4)
    assert.equal(bob_Status, 4)
    assert.equal(carol_Status, 4)

    // check debt and coll of Dennis, Erin has not been impacted by redemption
    const dennis_Debt = await troveManager.getTroveDebt(dennis)
    const erin_Debt = await troveManager.getTroveDebt(erin)

    th.assertIsApproximatelyEqual(dennis_Debt, D_totalDebt)
    th.assertIsApproximatelyEqual(erin_Debt, E_totalDebt)

    const dennis_Coll = await troveManager.getTroveColl(dennis)
    const erin_Coll = await troveManager.getTroveColl(erin)

    assert.equal(dennis_Coll.toString(), D_coll.toString())
    assert.equal(erin_Coll.toString(), E_coll.toString())
  })

  it('redeemCollateral(): ends the redemption sequence when max iterations have been reached', async () => {
    // --- SETUP --- 
    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol open troves with equal collateral ratio
    const { netDebt: A_debt } = await openShieldedTrove({ ICR: toBN(dec(256, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
    const { netDebt: B_debt } = await openShieldedTrove({ ICR: toBN(dec(256, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
    const { netDebt: C_debt, totalDebt: C_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(256, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
    const redemptionAmount = A_debt.add(B_debt)
    const attemptedRedemptionAmount = redemptionAmount.add(C_debt)
0
    // drop troves below HCR
    price = toBN(dec(100, 18))
    await priceFeed.setPrice(price)

    // --- TEST --- 

    // open trove from redeemer.  Redeemer has highest ICR (100Collateral, 100 LUSD), 20000%
    const { lusdAmount: F_lusdAmount } = await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount.mul(toBN(2)), extraParams: { from: flyn } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Flyn redeems collateral with only two iterations
    await troveManager.redeemCollateral(attemptedRedemptionAmount, alice, alice, alice, alice, alice, 0, 2, th._100pct, { from: flyn })

    // Check Flyn's redemption has reduced his balance from 100 to (100-40) = 60 LUSD
    const flynBalance = (await lusdToken.balanceOf(flyn)).toString()
    th.assertIsApproximatelyEqual(flynBalance, F_lusdAmount.sub(redemptionAmount))

    // Check debt of Alice, Bob, Carol
    const alice_Debt = await troveManager.getTroveDebt(alice)
    const bob_Debt = await troveManager.getTroveDebt(bob)
    const carol_Debt = await troveManager.getTroveDebt(carol)

    assert.equal(alice_Debt, 0)
    assert.equal(bob_Debt, 0)
    th.assertIsApproximatelyEqual(carol_Debt, C_totalDebt)

    // check Alice and Bob troves are closed, but Carol is not
    const alice_Status = await troveManager.getTroveStatus(alice)
    const bob_Status = await troveManager.getTroveStatus(bob)
    const carol_Status = await troveManager.getTroveStatus(carol)
    assert.equal(alice_Status, 4)
    assert.equal(bob_Status, 4)
    assert.equal(carol_Status, 1)
  })

  it("redeemCollateral(): performs partial redemption if resultant debt is > minimum net debt", async () => {
    const collateralAmount = dec(200, 'ether')
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: A })
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: B })
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: C })

    /*
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, true, { from: A })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, true, { from: B })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, true, { from: C })
    */
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, true, { from: A })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10100, 18)), B, B, true, { from: B })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10200, 18)), C, C, true, { from: C })


    // drop troves below HCR
    price = toBN(dec(60, 18))
    await priceFeed.setPrice(price)

    console.log("A_icr", (await troveManager.getCurrentICR(A, price)).toString())
    console.log("B_icr", (await troveManager.getCurrentICR(B, price)).toString())
    console.log("C_icr", (await troveManager.getCurrentICR(C, price)).toString())


    // A and C send all their tokens to B
    await lusdToken.transfer(B, await lusdToken.balanceOf(A), {from: A})
    await lusdToken.transfer(B, await lusdToken.balanceOf(C), {from: C})
    
    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Before redemption

    // LUSD redemption is 55000 US
    ///const LUSDRedemption = dec(55000, 18)
    const LUSDRedemption = dec(25300, 18)

    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, th._100pct)

    // Check B, C closed and A remains active
    assert.isTrue(await sortedShieldedTroves.contains(A))
    assert.isFalse(await sortedShieldedTroves.contains(B))
    assert.isFalse(await sortedShieldedTroves.contains(C))

    const expectedDebt = toBN(dec(4600, 18))//.mul(par).div(toBN(dec(1, 18)))
    // A's remaining debt = 10000 + 9900 + 9800 + 200 - 25300 = 4600
    const A_debt = await troveManager.getTroveDebt(A)
    th.assertIsApproximatelyEqual(A_debt, expectedDebt, 1000)
  })

  it("redeemCollateral(): doesn't perform partial redemption if resultant debt would be < minimum net debt", async () => {
    const collateralAmount = dec(200, 'ether')
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: A })
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: B })
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: C })  
    /*
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount(dec(6000, 18)), A, A, true, { from: A })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount(dec(20000, 18)), B, B, true, { from: B })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount(dec(30000, 18)), C, C, true, { from: C })
    */

    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount(dec(10000, 18)), A, A, true, { from: A })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount(dec(10100, 18)), B, B, true, { from: B })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount(dec(10200, 18)), C, C, true, { from: C })

    // drop troves below HCR
    price = toBN(dec(60, 18))
    await priceFeed.setPrice(price)

    // A and C send all their tokens to B
    await lusdToken.transfer(B, await lusdToken.balanceOf(A), {from: A})
    await lusdToken.transfer(B, await lusdToken.balanceOf(C), {from: C})

    await aggregator.setBaseRate(0) 

    // Skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption is 55000 LUSD
    const LUSDRedemption = dec(28990, 18)
    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, th._100pct)
    
    // Check B, C closed and A remains active
    assert.isTrue(await sortedShieldedTroves.contains(A))
    assert.isFalse(await sortedShieldedTroves.contains(B))
    assert.isFalse(await sortedShieldedTroves.contains(C))

    // A's remaining debt would be 29950 + 19950 + 5950 + 50 - 55000 = 900.
    // A's remaining debt would be 10000 + 9990 + 9800 + 200 - 28990 = 1000.
    // Since this is below the min net debt of 1800, A should be skipped and untouched by the redemption
    const A_debt = await troveManager.getTroveDebt(A)
    await th.assertIsApproximatelyEqual(A_debt, dec(10000, 18))
  })

  it('redeemCollateral(): doesnt perform the final partial redemption in the sequence if the hint is out-of-date', async () => {
    // TODO COME BACK TO THIS
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(253, 16)), extraLUSDAmount: dec(5, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(251, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })

    const partialRedemptionAmount = toBN(2)
    const fullfilledRedemptionAmount = C_netDebt.add(B_netDebt)
    const redemptionAmount = fullfilledRedemptionAmount.add(partialRedemptionAmount)

    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_CollateralBalance_Before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_Before = await lusdToken.balanceOf(dennis)

    // drop troves below HCR
    price = toBN(dec(100, 18))
    await priceFeed.setPrice(price)

    // --- TEST --- 

    const {
      firstRedemptionHint,
      partialRedemptionHintNICR,
      truncatedLUSDamount
    } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)

    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    const frontRunRedemption = toBN(dec(1, 18))
    // Oops, another transaction gets in the way
    {
      const {
        firstRedemptionHint,
        partialRedemptionHintNICR,
        truncatedLUSDamount
      } = await hintHelpers.getRedemptionHints(dec(1, 18), price, 0)

      const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        dennis,
        dennis
      )
      const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        dennis,
        dennis
      )

      // skip bootstrapping phase
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

      // Alice redeems 1 LUSD from Carol's Trove
      await troveManager.redeemCollateral(
        frontRunRedemption,
        firstRedemptionHint,
        upperPartialRedemptionHint,
        lowerPartialRedemptionHint,
        upperShieldedPartialRedemptionHint,
        lowerShieldedPartialRedemptionHint,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: alice }
      )
    }
    const parBeforeDennisRedemption = await relayer.par()
    // Dennis tries to redeem 20 LUSD
    const redemptionTx = await troveManager.redeemCollateral(
      redemptionAmount,
      firstRedemptionHint,
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]
    const CollateralDrawn = th.getEmittedRedemptionValues(redemptionTx)[2]
    const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]

    // Since Alice already redeemed 1 LUSD from Carol's Trove, Dennis was  able to redeem:
    //  - 9 LUSD from Carol's
    //  - 8 LUSD from Bob's
    // for a total of 17 LUSD.

    // Dennis calculated his hint for redeeming 2 LUSD from Alice's Trove, but after Alice's transaction
    // got in the way, he would have needed to redeem 3 LUSD to fully complete his redemption of 20 LUSD.
    // This would have required a different hint, therefore he ended up with a partial redemption.

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_Before)

    // Expect only 17 worth of Collateral drawn
    const expectedTotalCollateralDrawn = fullfilledRedemptionAmount.sub(frontRunRedemption).mul(parBeforeDennisRedemption).div(price) // redempted LUSD converted to Collateral, at Collateral:USD price 100
    const redemptionRate2 = await aggregator.getRedemptionRateWithDecay()
    const fee2 = expectedTotalCollateralDrawn.mul(redemptionRate2).div(mv._1e18BN)
    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(CollateralFee)

    th.assertIsApproximatelyEqual(expectedReceivedCollateral, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    th.assertIsApproximatelyEqual(dennis_LUSDBalance_After, dennis_LUSDBalance_Before.sub(fullfilledRedemptionAmount.sub(frontRunRedemption)))
  })

  // active debt cannot be zero, as there's a positive min debt enforced, and at least a trove must exist
  it("redeemCollateral(): can redeem if there is zero active debt but non-zero debt in DefaultPool", async () => {
    // --- SETUP ---

    const amount = await getOpenTroveLUSDAmount(dec(210, 18))
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(133, 16)), extraLUSDAmount: amount, extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: dennis } })

    await lusdToken.transfer(carol, amount, { from: bob })

    const price = dec(125, 18)
    await priceFeed.setPrice(price)

    // Liquidate Bob's Trove
    await liquidations.liquidateTroves(1)

    // --- TEST --- 

    const carol_CollateralBalance_Before = toBN(await collateralToken.balanceOf(carol))
    const nicrHint = await hintHelpers.getRedemptionHints(amount, price, 0)

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    const redemptionTx = await troveManager.redeemCollateral(
      amount,
      alice,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      nicrHint.partialRedemptionHintNICR.toString(),
      0,
      th._100pct,
      {
        from: carol,
        gasPrice: GAS_PRICE
      }
    )

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]
    const par = await relayer.par() // Get current par value

    const carol_CollateralBalance_After = toBN(await collateralToken.balanceOf(carol))

    // Calculate how much collateral should be redeemed for the given LUSD amount
    // CollateralAmount = (LUSDAmount * par) / price
    const expectedTotalCollateralDrawn = toBN(amount).mul(par).div(toBN(price))
    const redemptionRate3 = await aggregator.getRedemptionRateWithDecay()
    const fee3 = expectedTotalCollateralDrawn.mul(redemptionRate3).div(mv._1e18BN)
    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(CollateralFee)

    const receivedCollateral = carol_CollateralBalance_After.sub(carol_CollateralBalance_Before)

    assert.isTrue(expectedReceivedCollateral.eq(receivedCollateral))

    const carol_LUSDBalance_After = (await lusdToken.balanceOf(carol)).toString()
    assert.equal(carol_LUSDBalance_After, '0')
  })

  it("redeemCollateral(): doesn't touch Troves with ICR < 110%", async () => {
    // --- SETUP ---

    const { netDebt: A_debt } = await openShieldedTrove({ ICR: toBN(dec(259, 16)), extraParams: { from: alice } })
    const { lusdAmount: B_lusdAmount, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(209, 16)), extraLUSDAmount: A_debt, extraParams: { from: bob } })

    await lusdToken.transfer(carol, B_lusdAmount, { from: bob })

    // Put Bob's Trove below 110% ICR
    const price = dec(100, 18)
    await priceFeed.setPrice(price)

    // --- TEST --- 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await troveManager.redeemCollateral(
      A_debt,
      alice,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      th._100pct,
      { from: carol }
    );

    // Alice's Trove was cleared of debt
    const { debt: alice_Debt_After } = await troveManager.Troves(alice)
    assert.equal(alice_Debt_After, '0')

    // Bob's Trove was left untouched
    const { debt: bob_Debt_After } = await troveManager.Troves(bob)
    th.assertIsApproximatelyEqual(bob_Debt_After, B_totalDebt)
  });

  it("redeemCollateral(): finds the last Trove with ICR == 110% even if there is more than one", async () => {
    // --- SETUP ---
    const amount1 = toBN(dec(100, 18))
    const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: amount1, extraParams: { from: alice } })
    const { totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: amount1, extraParams: { from: bob } })
    const { totalDebt: C_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: amount1, extraParams: { from: carol } })
    const redemptionAmount = C_totalDebt.add(B_totalDebt).add(A_totalDebt)
    const { totalDebt: D_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    // This will put Dennis slightly below 110%, and everyone else exactly at 110%
    const price = '110' + _18_zeros
    await priceFeed.setPrice(price)

    const orderOfTroves = [];
    let current = await sortedShieldedTroves.getFirst();

    while (current !== '0x0000000000000000000000000000000000000000') {
      orderOfTroves.push(current);
      current = await sortedShieldedTroves.getNext(current);
    }

    assert.deepEqual(orderOfTroves, [carol, bob, alice, dennis]);

    await openShieldedTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: dec(10, 18), extraParams: { from: whale } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const tx = await troveManager.redeemCollateral(
      redemptionAmount,
      carol, // try to trick redeemCollateral by passing a hint that doesn't exactly point to the
      // last Trove with ICR == 110% (which would be Alice's)
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      th._100pct,
      { from: dennis }
    )
    
    const { debt: alice_Debt_After } = await troveManager.Troves(alice)
    assert.equal(alice_Debt_After, '0')

    const { debt: bob_Debt_After } = await troveManager.Troves(bob)
    assert.equal(bob_Debt_After, '0')

    const { debt: carol_Debt_After } = await troveManager.Troves(carol)
    assert.equal(carol_Debt_After, '0')

    const { debt: dennis_Debt_After } = await troveManager.Troves(dennis)
    th.assertIsApproximatelyEqual(dennis_Debt_After, D_totalDebt)
  });

  it("redeemCollateral(): reverts when TCR < MCR", async () => {
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: dennis } })

    // This will put Dennis slightly below 110%, and everyone else exactly at 110%
  
    await priceFeed.setPrice('110' + _18_zeros)
    const price = await priceFeed.getPrice()
    
    const TCR = (await th.getTCR(contracts))
    assert.isTrue(TCR.lt(toBN('1100000000000000000')))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await assertRevert(th.redeemCollateral(carol, contracts, GAS_PRICE, dec(270, 18)), "TroveManager: Cannot redeem when TCR < MCR")
  });

  it("redeemCollateral(): reverts when argument _amount is 0", async () => {
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 500LUSD to Erin, the would-be redeemer
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(500, 18), extraParams: { from: alice } })
    await lusdToken.transfer(erin, dec(500, 18), { from: alice })

    // B, C and D open troves
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: bob } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: dennis } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Erin attempts to redeem with _amount = 0
    const redemptionTxPromise = troveManager.redeemCollateral(0, erin, erin, erin, erin, erin, 0, 0, th._100pct, { from: erin })
    await assertRevert(redemptionTxPromise, "TroveManager: Amount must be greater than zero")
  })

  it("redeemCollateral(): reverts if max fee > 100%", async () => {
    await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(30, 18), extraParams: { from: C } })
    await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: D } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE ,dec(2, 18)), "Max fee percentage must be between 0.5% and 100%")
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE, '1000000000000000001'), "Max fee percentage must be between 0.5% and 100%")
  })

  it("redeemCollateral(): reverts if max fee < 0.5%", async () => { 
    await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(30, 18), extraParams: { from: C } })
    await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: D } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, GAS_PRICE, dec(10, 18), 0), "Max fee percentage must be between 0.5% and 100%")
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, GAS_PRICE, dec(10, 18), 1), "Max fee percentage must be between 0.5% and 100%")
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, GAS_PRICE, dec(10, 18), '4999999999999999'), "Max fee percentage must be between 0.5% and 100%")
  })
  it("redeemCollateral(): reverts if fee exceeds max fee percentage", async () => {
    const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(80, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(90, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const expectedTotalSupply = A_totalDebt.add(B_totalDebt).add(C_totalDebt)

    // Check total LUSD supply
    const totalSupply = await lusdToken.totalSupply()
    th.assertIsApproximatelyEqual(totalSupply, expectedTotalSupply)

    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption is 27 USD: a redemption that incurs a fee of 27/(270 * 2) = 5%
    const attemptedLUSDRedemption = expectedTotalSupply.div(toBN(10))

    // Max fee is <5%
    const lessThan5pct = '49999999999999999'
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, lessThan5pct), "Fee exceeded provided maximum")
  
    await aggregator.setBaseRate(0)  // artificially zero the baseRate
    
    // Max fee is 1%
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, dec(1, 16)), "Fee exceeded provided maximum")
  
    await aggregator.setBaseRate(0)

     // Max fee is 3.754%
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, dec(3754, 13)), "Fee exceeded provided maximum")
  
    await aggregator.setBaseRate(0)

    // Max fee is 0.5%
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, dec(5, 15)), "Fee exceeded provided maximum")
  })

  it("redeemCollateral(): succeeds if fee is less than max fee percentage", async () => {
    const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(9500, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(395, 16)), extraLUSDAmount: dec(9000, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(390, 16)), extraLUSDAmount: dec(10000, 18), extraParams: { from: C } })
    const expectedTotalSupply = A_totalDebt.add(B_totalDebt).add(C_totalDebt)

    // drop troves below HCR
    price = toBN(dec(60, 18))
    await priceFeed.setPrice(price)

    // Check total LUSD supply
    const totalSupply = await lusdToken.totalSupply()
    th.assertIsApproximatelyEqual(totalSupply, expectedTotalSupply)

    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption fee with 10% of the supply will be 0.5% + 1/(10*2)
    const attemptedLUSDRedemption = expectedTotalSupply.div(toBN(10))

    // Attempt with maxFee > 5.5%
    const collateralDrawn = attemptedLUSDRedemption.mul(mv._1e18BN).div(price)
    const slightlyMoreThanFee = (await aggregator.getRedemptionFeeWithDecay(collateralDrawn))
    const tx1 = await th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, slightlyMoreThanFee)
    assert.isTrue(tx1.receipt.status)

    await aggregator.setBaseRate(0)  // Artificially zero the baseRate
    
    // Attempt with maxFee = 5.5%
    const exactSameFee = (await aggregator.getRedemptionFeeWithDecay(collateralDrawn))
    const tx2 = await th.redeemCollateralAndGetTxObject(C, contracts, attemptedLUSDRedemption, exactSameFee)
    assert.isTrue(tx2.receipt.status)

    await aggregator.setBaseRate(0)

     // Max fee is 10%
    const tx3 = await th.redeemCollateralAndGetTxObject(B, contracts, attemptedLUSDRedemption, dec(1, 17))
    assert.isTrue(tx3.receipt.status)

    await aggregator.setBaseRate(0)

    // Max fee is 37.659%
    const tx4 = await th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, dec(37659, 13))
    assert.isTrue(tx4.receipt.status)

    await aggregator.setBaseRate(0)

    // Max fee is 100%
    const tx5 = await th.redeemCollateralAndGetTxObject(C, contracts, attemptedLUSDRedemption, dec(1, 18))
    assert.isTrue(tx5.receipt.status)
  })

  it("redeemCollateral(): doesn't affect the Stability Pool deposits or Collateral gain of redeemed-from troves", async () => {
    //contracts.rateControl.setCoBias(0)
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // B, C, D, F open trove
    const { totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: bob } })
    const { totalDebt: C_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraLUSDAmount: dec(200, 18), extraParams: { from: carol } })
    const { totalDebt: D_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: dennis } })
    const { totalDebt: F_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: flyn } })

    const redemptionAmount = B_totalDebt.add(C_totalDebt).add(D_totalDebt).add(F_totalDebt)
    // Alice opens trove and transfers LUSD to Erin, the would-be redeemer
    await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: redemptionAmount, extraParams: { from: alice } })
    await lusdToken.transfer(erin, redemptionAmount, { from: alice })

    // B, C, D deposit some of their tokens to the Stability Pool
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, { from: bob })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: carol })
    await stabilityPool.provideToSP(dec(200, 18), ZERO_ADDRESS, { from: dennis })

    await priceFeed.setPrice(dec(125, 18))

    let price = await priceFeed.getPrice()
    const bob_ICR_before = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_before = await troveManager.getCurrentICR(carol, price)
    const dennis_ICR_before = await troveManager.getCurrentICR(dennis, price)

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue(await sortedShieldedTroves.contains(flyn))

    // Liquidate Flyn
    await liquidations.liquidate(flyn)
    assert.isFalse(await sortedShieldedTroves.contains(flyn))

    // Price bounces back, bringing B, C, D back above MCR
    await priceFeed.setPrice(dec(125, 18))

    const bob_SPDeposit_before = await stabilityPool.getCompoundedLUSDDeposit(bob)
    const carol_SPDeposit_before = await stabilityPool.getCompoundedLUSDDeposit(carol)
    const dennis_SPDeposit_before = await stabilityPool.getCompoundedLUSDDeposit(dennis)

    const bob_CollateralGain_before = await stabilityPool.getDepositorCollateralGain(bob)
    const carol_CollateralGain_before = await stabilityPool.getDepositorCollateralGain(carol)
    const dennis_CollateralGain_before = await stabilityPool.getDepositorCollateralGain(dennis)

    // Check the remaining LUSD and Collateral in Stability Pool after liquidation is non-zero
    const LUSDinSP = await stabilityPool.getTotalLUSDDeposits()
    const CollateralinSP = await stabilityPool.getCollateral()
    assert.isTrue(LUSDinSP.gte(mv._zeroBN))
    assert.isTrue(CollateralinSP.gte(mv._zeroBN))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Erin redeems LUSD
    tx = await th.redeemCollateralAndGetTxObject(erin, contracts, redemptionAmount, th._100pct)

    price = await priceFeed.getPrice()
    const bob_ICR_after = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_after = await troveManager.getCurrentICR(carol, price)
    const dennis_ICR_after = await troveManager.getCurrentICR(dennis, price)

    // Check ICR of B, C and D troves has increased,i.e. they have been hit by redemptions
    assert.isTrue(bob_ICR_after.gte(bob_ICR_before))
    assert.isTrue(carol_ICR_after.gte(carol_ICR_before))
    assert.isTrue(dennis_ICR_after.gte(dennis_ICR_before))

    const bob_SPDeposit_after = await stabilityPool.getCompoundedLUSDDeposit(bob)
    const carol_SPDeposit_after = await stabilityPool.getCompoundedLUSDDeposit(carol)
    const dennis_SPDeposit_after = await stabilityPool.getCompoundedLUSDDeposit(dennis)

    const bob_CollateralGain_after = await stabilityPool.getDepositorCollateralGain(bob)
    const carol_CollateralGain_after = await stabilityPool.getDepositorCollateralGain(carol)
    const dennis_CollateralGain_after = await stabilityPool.getDepositorCollateralGain(dennis)

    // Check B, C, D Stability Pool deposits and Collateral gain have not been affected by redemptions from their troves
    // Note: deposits increase slightly as redemption calls drip(), which distributes to SP
    assert.isTrue(bob_SPDeposit_after.gt(bob_SPDeposit_before))
    th.assertIsApproximatelyEqual(bob_SPDeposit_before, bob_SPDeposit_after, 120000000000000000)
    assert.isTrue(carol_SPDeposit_after.gt(carol_SPDeposit_before))
    th.assertIsApproximatelyEqual(carol_SPDeposit_before, carol_SPDeposit_after, 1200000000000000000)
    assert.isTrue(dennis_SPDeposit_after.gt(dennis_SPDeposit_before))
    th.assertIsApproximatelyEqual(dennis_SPDeposit_before, dennis_SPDeposit_after, 460000000000000000)


    assert.isTrue(bob_CollateralGain_before.eq(bob_CollateralGain_after))
    assert.isTrue(carol_CollateralGain_before.eq(carol_CollateralGain_after))
    assert.isTrue(dennis_CollateralGain_before.eq(dennis_CollateralGain_after))
  })

  it("redeemCollateral(): caller can redeem their entire LUSDToken balance", async () => {
    const { collateral: W_coll, totalDebt: W_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 400 LUSD to Erin, the would-be redeemer
    const { collateral: A_coll, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: alice } })
    await lusdToken.transfer(erin, dec(400, 18), { from: alice })

    // Check Erin's balance before
    const erin_balance_before = await lusdToken.balanceOf(erin)
    assert.equal(erin_balance_before, dec(400, 18))

    // B, C, D open trove
    const { collateral: B_coll, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(590, 18), extraParams: { from: bob } })
    const { collateral: C_coll, totalDebt: C_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(305, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: dennis } })

    // drop troves below HCR
    price = toBN(dec(80, 18))
    await priceFeed.setPrice(price)

    const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt).add(D_totalDebt)
    const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

    // Get active debt and coll before redemption
    const activeShieldedPool_debt_before = await activeShieldedPool.getLUSDDebt()
    const activeShieldedPool_coll_before = await activeShieldedPool.getCollateral()

    th.assertIsApproximatelyEqual(activeShieldedPool_debt_before, totalDebt)
    assert.equal(activeShieldedPool_coll_before.toString(), totalColl)

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    amount = dec(400, 18)
    // Erin attempts to redeem 400 LUSD
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(amount, price, 0)

    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      erin,
      erin
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      erin,
      erin
    )

   const tx = await troveManager.redeemCollateral(
      amount,
      firstRedemptionHint,
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: erin })

      const fee = tx.receipt.logs.filter(log => log.event === "Redemption")[0].args[3]

    // Check activeShieldedPool debt reduced by  400 LUSD
    const activeShieldedPool_debt_after = await activeShieldedPool.getLUSDDebt()
    assert.equal(activeShieldedPool_debt_before.sub(activeShieldedPool_debt_after), amount)

    // Check ActivePool coll reduced by $400 worth of Ether: at Collateral:USD price of $80, this should be 5 Collateral.
    const activeShieldedPool_coll_after = await activeShieldedPool.getCollateral()
    //console.log(`activeShieldedPool_coll_after: ${activeShieldedPool_coll_after}`)
    //console.log(`Exp:  ${activeShieldedPool_coll_before.sub(toBN(dec(5, 18)))}`)
    assert.equal(activeShieldedPool_coll_after.sub(fee).toString(), activeShieldedPool_coll_before.sub(toBN(dec(5, 18))).toString())

    // Check Erin's balance after
    const erin_balance_after = (await lusdToken.balanceOf(erin)).toString()
    assert.equal(erin_balance_after, '0')
  })

  it("redeemCollateral(): reverts when requested redemption amount exceeds caller's LUSD token balance", async () => {
    const { collateral: W_coll, totalDebt: W_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 400 LUSD to Erin, the would-be redeemer
    const { collateral: A_coll, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: alice } })
    await lusdToken.transfer(erin, dec(400, 18), { from: alice })

    // Check Erin's balance before
    const erin_balance_before = await lusdToken.balanceOf(erin)
    assert.equal(erin_balance_before, dec(400, 18))

    // B, C, D open trove
    const { collateral: B_coll, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(590, 18), extraParams: { from: bob } })
    const { collateral: C_coll, totalDebt: C_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(305, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: dennis } })

    // drop troves below HCR
    price = toBN(dec(80, 18))
    await priceFeed.setPrice(price)

    const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt).add(D_totalDebt)
    const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

    // Get active debt and coll before redemption
    const activeShieldedPool_debt_before = await activeShieldedPool.getLUSDDebt()
    const activeShieldedPool_coll_before = (await activeShieldedPool.getCollateral()).toString()

    th.assertIsApproximatelyEqual(activeShieldedPool_debt_before, totalDebt)
    assert.equal(activeShieldedPool_coll_before, totalColl)

    let firstRedemptionHint
    let partialRedemptionHintNICR

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Erin tries to redeem 1000 LUSD
    try {
      ({
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(dec(1000, 18), price, 0))

      const { 0: upperPartialRedemptionHint_1, 1: lowerPartialRedemptionHint_1 } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )
      const { 0: upperShieldedPartialRedemptionHint_1, 1: lowerShieldedPartialRedemptionHint_1 } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )

      const redemptionTx = await troveManager.redeemCollateral(
        dec(1000, 18),
        firstRedemptionHint,
        upperPartialRedemptionHint_1,
        lowerPartialRedemptionHint_1,
        upperShieldedPartialRedemptionHint_1,
        lowerShieldedPartialRedemptionHint_1,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: erin })

      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "Requested redemption amount must be <= user's balance")
    }

    // Erin tries to redeem 401 LUSD
    try {
      ({
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints('401000000000000000000', price, 0))

      const { 0: upperPartialRedemptionHint_2, 1: lowerPartialRedemptionHint_2 } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )
      const { 0: upperShieldedPartialRedemptionHint_2, 1: lowerShieldedPartialRedemptionHint_2 } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )

      const redemptionTx = await troveManager.redeemCollateral(
        '401000000000000000000', firstRedemptionHint,
        upperPartialRedemptionHint_2,
        lowerPartialRedemptionHint_2,
        upperShieldedPartialRedemptionHint_2,
        lowerShieldedPartialRedemptionHint_2,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: erin })
      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "Requested redemption amount must be <= user's balance")
    }

    // Erin tries to redeem 239482309 LUSD
    try {
      ({
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints('239482309000000000000000000', price, 0))

      const { 0: upperPartialRedemptionHint_3, 1: lowerPartialRedemptionHint_3 } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )
      const { 0: upperShieldedPartialRedemptionHint_3, 1: lowerShieldedPartialRedemptionHint_3 } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )

      const redemptionTx = await troveManager.redeemCollateral(
        '239482309000000000000000000', firstRedemptionHint,
        upperPartialRedemptionHint_3,
        lowerPartialRedemptionHint_3,
        upperShieldedPartialRedemptionHint_3,
        lowerShieldedPartialRedemptionHint_3,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: erin })
      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "Requested redemption amount must be <= user's balance")
    }

    // Erin tries to redeem 2^256 - 1 LUSD
    const maxBytes32 = toBN('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')

    try {
      ({
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints('239482309000000000000000000', price, 0))

      const { 0: upperPartialRedemptionHint_4, 1: lowerPartialRedemptionHint_4 } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )
      const { 0: upperShieldedPartialRedemptionHint_4, 1: lowerShieldedPartialRedemptionHint_4 } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )

      const redemptionTx = await troveManager.redeemCollateral(
        maxBytes32, firstRedemptionHint,
        upperPartialRedemptionHint_4,
        lowerPartialRedemptionHint_4,
        upperShieldedPartialRedemptionHint_4,
        lowerShieldedPartialRedemptionHint_4,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: erin })
      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "Requested redemption amount must be <= user's balance")
    }
  })

  it("redeemCollateral(): value of issued Collateral == face value of redeemed LUSD when par equal $1", async () => {
    const { collateral: W_coll } = await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 1000 LUSD each to Erin, Flyn, Graham
    const { collateral: A_coll, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(4990, 18), extraParams: { from: alice } })
    await lusdToken.transfer(erin, dec(1000, 18), { from: alice })
    await lusdToken.transfer(flyn, dec(1000, 18), { from: alice })
    await lusdToken.transfer(graham, dec(1000, 18), { from: alice })

    // B, C, D open trove
    /*
    const { collateral: B_coll } = await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(1590, 18), extraParams: { from: bob } })
    const { collateral: C_coll } = await openShieldedTrove({ ICR: toBN(dec(600, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: carol } })
    const { collateral: D_coll } = await openShieldedTrove({ ICR: toBN(dec(800, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: dennis } })
    */
    const { collateral: B_coll } = await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(1590, 18), extraParams: { from: bob } })
    const { collateral: C_coll } = await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: carol } })
    const { collateral: D_coll } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: dennis } })

    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

    const _120_LUSD = '120000000000000000000'
    const _373_LUSD = '373000000000000000000'
    const _950_LUSD = '950000000000000000000'

    // Check Ether in activeShieldedPool
    const activeCollateral_0 = await activeShieldedPool.getCollateral()
    assert.equal(activeCollateral_0, totalColl.toString());

    let firstRedemptionHint
    let partialRedemptionHintNICR


    // Erin redeems 120 LUSD
    ({
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(_120_LUSD, price, 0))

    const { 0: upperPartialRedemptionHint_1, 1: lowerPartialRedemptionHint_1 } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      erin,
      erin
    )
    const { 0: upperShieldedPartialRedemptionHint_1, 1: lowerShieldedPartialRedemptionHint_1 } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      erin,
      erin
    )

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const redemption_1 = await troveManager.redeemCollateral(
      _120_LUSD,
      firstRedemptionHint,
      upperPartialRedemptionHint_1,
      lowerPartialRedemptionHint_1,
      upperShieldedPartialRedemptionHint_1,
      lowerShieldedPartialRedemptionHint_1,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: erin })

    assert.isTrue(redemption_1.receipt.status);

    /* 120 LUSD redeemed.  Expect $120 worth of Collateral removed. At Collateral:USD price of $200, 
    Collateral removed = (120/200) = 0.6 Collateral
    Total active Collateral = 280 - 0.6 = 279.4 Collateral */
    const fee = redemption_1.receipt.logs.filter(log => log.event === "Redemption")[0].args[3];
    const activeCollateral_1 = await activeShieldedPool.getCollateral()
    assert.equal(activeCollateral_1.sub(fee).toString(), activeCollateral_0.sub(toBN(_120_LUSD).mul(mv._1e18BN).div(price)).toString());

    // Flyn redeems 373 LUSD
    ({
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(_373_LUSD, price, 0))

    const { 0: upperPartialRedemptionHint_2, 1: lowerPartialRedemptionHint_2 } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      flyn,
      flyn
    )
    const { 0: upperShieldedPartialRedemptionHint_2, 1: lowerShieldedPartialRedemptionHint_2 } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      flyn,
      flyn
    )

    const redemption_2 = await troveManager.redeemCollateral(
      _373_LUSD,
      firstRedemptionHint,
      upperPartialRedemptionHint_2,
      lowerPartialRedemptionHint_2,
      upperShieldedPartialRedemptionHint_2,
      lowerShieldedPartialRedemptionHint_2,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: flyn })

    assert.isTrue(redemption_2.receipt.status);
    const fee2 = redemption_2.receipt.logs.filter(log => log.event === "Redemption")[0].args[3];
    /* 373 LUSD redeemed.  Expect $373 worth of Collateral removed. At Collateral:USD price of $200, 
    Collateral removed = (373/200) = 1.865 Collateral
    Total active Collateral = 279.4 - 1.865 = 277.535 Collateral */
    const activeCollateral_2 = await activeShieldedPool.getCollateral()
    assert.equal(activeCollateral_2.sub(fee2).toString(), activeCollateral_1.sub(toBN(_373_LUSD).mul(mv._1e18BN).div(price)).toString());

    // Graham redeems 950 LUSD
    ({
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(_950_LUSD, price, 0))

    const { 0: upperPartialRedemptionHint_3, 1: lowerPartialRedemptionHint_3 } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      graham,
      graham
    )
    const { 0: upperShieldedPartialRedemptionHint_3, 1: lowerShieldedPartialRedemptionHint_3 } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      graham,
      graham
    )

    const redemption_3 = await troveManager.redeemCollateral(
      _950_LUSD,
      firstRedemptionHint,
      upperPartialRedemptionHint_3,
      lowerPartialRedemptionHint_3,
      upperShieldedPartialRedemptionHint_3,
      lowerShieldedPartialRedemptionHint_3,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: graham })

    assert.isTrue(redemption_3.receipt.status);
    const fee3 = redemption_3.receipt.logs.filter(log => log.event === "Redemption")[0].args[3];
    /* 950 LUSD redeemed.  Expect $950 worth of Collateral removed. At Collateral:USD price of $200, 
    Collateral removed = (950/200) = 4.75 Collateral
    Total active Collateral = 277.535 - 4.75 = 272.785 Collateral */
    const activeCollateral_3 = await activeShieldedPool.getCollateral()
    assert.equal(activeCollateral_3.sub(fee3).toString(), activeCollateral_2.sub(toBN(_950_LUSD).mul(mv._1e18BN).div(price)).toString());
  })
  it("redeemCollateral(): value of issued Collateral == face value of redeemed LUSD when par not eq to $1", async () => {
    const { collateral: W_coll } = await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 1000 LUSD each to Erin, Flyn, Graham
    const { collateral: A_coll, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(4990, 18), extraParams: { from: alice } })
    await lusdToken.transfer(erin, dec(1000, 18), { from: alice })
    await lusdToken.transfer(flyn, dec(1000, 18), { from: alice })
    await lusdToken.transfer(graham, dec(1000, 18), { from: alice })

    // B, C, D open trove
    /*
    const { collateral: B_coll } = await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(1590, 18), extraParams: { from: bob } })
    const { collateral: C_coll } = await openShieldedTrove({ ICR: toBN(dec(600, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: carol } })
    const { collateral: D_coll } = await openShieldedTrove({ ICR: toBN(dec(800, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: dennis } })
    */
    const { collateral: B_coll } = await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(1590, 18), extraParams: { from: bob } })
    const { collateral: C_coll } = await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: carol } })
    const { collateral: D_coll } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: dennis } })

    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(1).mul(ONE_CENT)));
    await relayer.updatePar();

    const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

    const _120_LUSD = '120000000000000000000'
    const _373_LUSD = '373000000000000000000'
    const _950_LUSD = '950000000000000000000'

    // Check Ether in activeShieldedPool
    const activeCollateral_0 = await activeShieldedPool.getCollateral()
    assert.equal(activeCollateral_0, totalColl.toString());

    let firstRedemptionHint
    let partialRedemptionHintNICR

    // Erin redeems 120 LUSD
    ({
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(_120_LUSD, price, 0))

    const { 0: upperPartialRedemptionHint_1, 1: lowerPartialRedemptionHint_1 } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      erin,
      erin
    )
    const { 0: upperShieldedPartialRedemptionHint_1, 1: lowerShieldedPartialRedemptionHint_1 } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      erin,
      erin
    )
    console.log("partialRedemptionHintNICR " + partialRedemptionHintNICR)



    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    /*
    await relayer.updatePar();
    par = await relayer.par()
    assert.isTrue((await relayer.par()).lt(ONE_DOLLAR));
    */

    //await marketOracle.setPrice(ONE_DOLLAR.add(toBN(1).mul(ONE_CENT)));
    //await relayer.updatePar();
    const par = await relayer.par()

    await troveManager.drip()
    console.log("bob icr " +  await troveManager.getCurrentICR(bob, price))
    console.log("carol icr " +  await troveManager.getCurrentICR(carol, price))
    console.log("dennis icr " +  await troveManager.getCurrentICR(dennis, price))


    const redemption_1 = await troveManager.redeemCollateral(
      _120_LUSD,
      firstRedemptionHint,
      upperPartialRedemptionHint_1,
      lowerPartialRedemptionHint_1,
      upperShieldedPartialRedemptionHint_1,
      lowerShieldedPartialRedemptionHint_1,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: erin })

    assert.isTrue(redemption_1.receipt.status);
    const fee1 = redemption_1.receipt.logs.filter(log => log.event === "Redemption")[0].args[3];
    //const value = toBN(th.getRawEventArgByName(redemption_1, troveManagerInterface, troveManager.address, "Value", "value"));
    //console.log("value " + value)

    /* 120 LUSD redeemed.  Expect $120 worth of Collateral removed. At Collateral:USD price of $200, 
    Collateral removed = (120/200) = 0.6 Collateral
    Total active Collateral = 280 - 0.6 = 279.4 Collateral */

    const activeCollateral_1 = await activeShieldedPool.getCollateral()
    assert.equal(activeCollateral_1.sub(fee1).toString(), activeCollateral_0.sub(toBN(_120_LUSD).mul(par).div(price)).toString());


    // redemptiojns update par at the end, so need to get latest for valuation check
    const par2 = await relayer.par();

    // Flyn redeems 373 LUSD
    ({
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(_373_LUSD, price, 0))

    const { 0: upperPartialRedemptionHint_2, 1: lowerPartialRedemptionHint_2 } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      flyn,
      flyn
    )
    const { 0: upperShieldedPartialRedemptionHint_2, 1: lowerShieldedPartialRedemptionHint_2 } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      flyn,
      flyn
    )

    const redemption_2 = await troveManager.redeemCollateral(
      _373_LUSD,
      firstRedemptionHint,
      upperPartialRedemptionHint_2,
      lowerPartialRedemptionHint_2,
      upperShieldedPartialRedemptionHint_2,
      lowerShieldedPartialRedemptionHint_2,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: flyn })

    assert.isTrue(redemption_2.receipt.status);
    const fee2 = redemption_2.receipt.logs.filter(log => log.event === "Redemption")[0].args[3];
    /* 373 LUSD redeemed.  Expect $373 worth of Collateral removed. At Collateral:USD price of $200, 
    Collateral removed = (373/200) = 1.865 Collateral
    Total active Collateral = 279.4 - 1.865 = 277.535 Collateral */
    const activeCollateral_2 = await activeShieldedPool.getCollateral()
    assert.equal(activeCollateral_2.sub(fee2).toString(), activeCollateral_1.sub(toBN(_373_LUSD).mul(par2).div(price)).toString());

    // redemptiojns update par at the end, so need to get latest for valuation check
    const par3 = await contracts.relayer.par();

    // Graham redeems 950 LUSD
    ({
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(_950_LUSD, price, 0))

    const { 0: upperPartialRedemptionHint_3, 1: lowerPartialRedemptionHint_3 } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      graham,
      graham
    )
    const { 0: upperShieldedPartialRedemptionHint_3, 1: lowerShieldedPartialRedemptionHint_3 } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      graham,
      graham
    )

    const redemption_3 = await troveManager.redeemCollateral(
      _950_LUSD,
      firstRedemptionHint,
      upperPartialRedemptionHint_3,
      lowerPartialRedemptionHint_3,
      upperShieldedPartialRedemptionHint_3,
      lowerShieldedPartialRedemptionHint_3,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: graham })

    assert.isTrue(redemption_3.receipt.status);
    const fee3 = redemption_3.receipt.logs.filter(log => log.event === "Redemption")[0].args[3];
    /* 950 LUSD redeemed.  Expect $950 worth of Collateral removed. At Collateral:USD price of $200, 
    Collateral removed = (950/200) = 4.75 Collateral
    Total active Collateral = 277.535 - 4.75 = 272.785 Collateral */
    const activeCollateral_3 = await activeShieldedPool.getCollateral()
    assert.equal(activeCollateral_3.sub(fee3).toString(), activeCollateral_2.sub(toBN(_950_LUSD).mul(par3).div(price)).toString());
  })

  // it doesn't make much sense as there's now min debt enforced and at least one trove must remain active
  // the only way to test it is before any trove is opened
  it("redeemCollateral(): reverts if there is zero outstanding system debt", async () => {
    // --- SETUP --- illegally mint LUSD to Bob
    await lusdToken.unprotectedMint(bob, dec(100, 18))

    assert.equal((await lusdToken.balanceOf(bob)), dec(100, 18))

    const price = await priceFeed.getPrice()

    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(dec(100, 18), price, 0)

    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      bob,
      bob
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      bob,
      bob
    )

    // Bob tries to redeem his illegally obtained LUSD
    try {
      const redemptionTx = await troveManager.redeemCollateral(
        dec(100, 18),
        firstRedemptionHint,
        upperPartialRedemptionHint,
        lowerPartialRedemptionHint,
        upperShieldedPartialRedemptionHint,
        lowerShieldedPartialRedemptionHint,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: bob })
    } catch (error) {
      assert.include(error.message, "VM Exception while processing transaction")
    }

    //assert.isFalse(redemptionTx.receipt.status);
    debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
    supply = await contracts.lusdToken.totalSupply()
    // console.log("debt", debt.toString())
    // console.log("supply", supply.toString())
    // console.log("supply - debt", supply.sub(debt).toString())
  })
  it("redeemCollateral(): reverts if caller's tries to redeem more than the outstanding system debt", async () => {
    // --- SETUP --- illegally mint LUSD to Bob
    await lusdToken.unprotectedMint(bob, '101000000000000000000')

    assert.equal((await lusdToken.balanceOf(bob)), '101000000000000000000')

    const { collateral: C_coll, totalDebt: C_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(1000, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(1000, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: dennis } })

    const totalDebt = C_totalDebt.add(D_totalDebt)
    th.assertIsApproximatelyEqual((await activeShieldedPool.getLUSDDebt()).toString(), totalDebt)

    const price = await priceFeed.getPrice()
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints('101000000000000000000', price, 0)

    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      bob,
      bob
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      bob,
      bob
    )

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Bob attempts to redeem his ill-gotten 101 LUSD, from a system that has 100 LUSD outstanding debt
    try {
      const redemptionTx = await troveManager.redeemCollateral(
        totalDebt.add(toBN(dec(100, 18))),
        firstRedemptionHint,
        upperPartialRedemptionHint,
        lowerPartialRedemptionHint,
        upperShieldedPartialRedemptionHint,
        lowerShieldedPartialRedemptionHint,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: bob })
    } catch (error) {
      assert.include(error.message, "VM Exception while processing transaction")
    }
    const debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
    const supply = await contracts.lusdToken.totalSupply()
    // console.log("debt", debt.toString())
    // console.log("supply", supply.toString())
  })

  // Redemption fees 
  it("redeemCollateral(): a redemption made when base rate is zero increases the base rate", async () => {
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const A_balanceBefore = await lusdToken.balanceOf(A)

    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    assert.isTrue((await aggregator.baseRate()).gt(toBN('0')))
  })

  it("redeemCollateral(): a redemption made when base rate is non-zero increases the base rate, for negligible time passed", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    const A_balanceBefore = await lusdToken.balanceOf(A)
    const B_balanceBefore = await lusdToken.balanceOf(B)

    // A redeems 10 LUSD
    const redemptionTx_A = await th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE)
    const timeStamp_A = await th.getTimestampFromTx(redemptionTx_A, web3)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // B redeems 10 LUSD
    const redemptionTx_B = await th.redeemCollateralAndGetTxObject(B, contracts, dec(10, 18), GAS_PRICE)
    const timeStamp_B = await th.getTimestampFromTx(redemptionTx_B, web3)

    // Check B's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check negligible time difference (< 1 minute) between txs
    assert.isTrue(Number(timeStamp_B) - Number(timeStamp_A) < 60)

    const baseRate_2 = await aggregator.baseRate()

    // Check baseRate has again increased
    assert.isTrue(baseRate_2.gt(baseRate_1))
  })

  it("redeemCollateral(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation [ @skip-on-coverage ]", async () => {
    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const A_balanceBefore = await lusdToken.balanceOf(A)

    // A redeems 10 LUSD
    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(A_balanceBefore.sub(await lusdToken.balanceOf(A)), dec(10, 18))

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    const lastFeeOpTime_1 = await aggregator.lastFeeOperationTime()

    // 45 seconds pass
    th.fastForwardTime(45, web3.currentProvider)

    // Borrower A triggers a fee
    await th.redeemCollateral(A, contracts, dec(1, 18), GAS_PRICE)

    const lastFeeOpTime_2 = await aggregator.lastFeeOperationTime()

    // Check that the last fee operation time did not update, as borrower A's 2nd redemption occured
    // since before minimum interval had passed 
    assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1))

    // 15 seconds passes
    th.fastForwardTime(15, web3.currentProvider)

    // Check that now, at least one hour has passed since lastFeeOpTime_1
    const timeNow = await th.getLatestBlockTimestamp(web3)
    assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(3600))

    // Borrower A triggers a fee
    await th.redeemCollateral(A, contracts, dec(1, 18), GAS_PRICE)

    const lastFeeOpTime_3 = await aggregator.lastFeeOperationTime()

    // Check that the last fee operation time DID update, as A's 2rd redemption occured
    // after minimum interval had passed 
    assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1))
  })

  it.skip("redeemCollateral(): a redemption made at zero base rate send a non-zero CollateralFee to LQTY staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    // Check LQTY Staking contract balance before is zero
    const lqtyStakingBalance_Before = await collateralToken.balanceOf(lqtyStaking.address)
    assert.equal(lqtyStakingBalance_Before, '0')

    const A_balanceBefore = await lusdToken.balanceOf(A)

    // A redeems 10 LUSD
    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // Check LQTY Staking contract balance after is non-zero
    const lqtyStakingBalance_After = toBN(await collateralToken.balanceOf(lqtyStaking.address))
    assert.isTrue(lqtyStakingBalance_After.gt(toBN('0')))
  })

  it.skip("redeemCollateral(): a redemption made at zero base increases the Collateral-fees-per-LQTY-staked in LQTY Staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    // Check LQTY Staking Collateral-fees-per-LQTY-staked before is zero
    const F_Coll_Before = await lqtyStaking.F_Collateral()
    assert.equal(F_Coll_Before, '0')

    const A_balanceBefore = await lusdToken.balanceOf(A)

    // A redeems 10 LUSD
    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // Check LQTY Staking Collateral-fees-per-LQTY-staked after is non-zero
    const F_Collateral_After = await lqtyStaking.F_Collateral()
    assert.isTrue(F_Collateral_After.gt('0'))
  })

  it.skip("redeemCollateral(): a redemption made at a non-zero base rate send a non-zero CollateralFee to LQTY staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    const A_balanceBefore = await lusdToken.balanceOf(A)
    const B_balanceBefore = await lusdToken.balanceOf(B)

    // A redeems 10 LUSD
    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    const lqtyStakingBalance_Before = toBN(await collateralToken.balanceOf(lqtyStaking.address))

    // B redeems 10 LUSD
    await th.redeemCollateral(B, contracts, dec(10, 18), GAS_PRICE)

    // Check B's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

    const lqtyStakingBalance_After = toBN(await collateralToken.balanceOf(lqtyStaking.address))

    // check LQTY Staking balance has increased
    assert.isTrue(lqtyStakingBalance_After.gt(lqtyStakingBalance_Before))
  })

  it.skip("redeemCollateral(): a redemption made at a non-zero base rate increases Collateral-per-LQTY-staked in the staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    const A_balanceBefore = await lusdToken.balanceOf(A)
    const B_balanceBefore = await lusdToken.balanceOf(B)

    // A redeems 10 LUSD
    await th.redeemCollateral(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // Check LQTY Staking Collateral-fees-per-LQTY-staked before is zero
    const F_Collateral_Before = await lqtyStaking.F_Collateral()

    // B redeems 10 LUSD
    await th.redeemCollateral(B, contracts, dec(10, 18), GAS_PRICE)

    // Check B's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

    const F_Collateral_After = await lqtyStaking.F_Collateral()

    // check LQTY Staking balance has increased
    assert.isTrue(F_Collateral_After.gt(F_Collateral_Before))
  })

  it("redeemCollateral(): a redemption sends the Collateral remainder (CollateralDrawn - CollateralFee) to the redeemer", async () => {
    const redemptionRateAtStart = await aggregator.getRedemptionRateWithDecay();
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    const { totalDebt: W_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt)

    const A_balanceBefore = toBN(await collateralToken.balanceOf(A))

    // drop troves below HCR
    let price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    // Confirm baseRate before redemption is 0
    const baseRate = await aggregator.baseRate()
    assert.equal(baseRate, '0')

    // Check total LUSD supply
    const activeLUSD = await activeShieldedPool.getLUSDDebt()
    const defaultLUSD = await defaultPool.getLUSDDebt()

    const totalLUSDSupply = activeLUSD.add(defaultLUSD)
    th.assertIsApproximatelyEqual(totalLUSDSupply, totalDebt)

    // A redeems 9 LUSD
    const redemptionAmount = toBN(dec(9, 18))
    const totalSystemDebt = await th.getEntireSystemDebt(contracts)
    const redemptionRate = await aggregator.calcRateForRedemption(redemptionAmount, totalSystemDebt)
    const gasUsed = await th.redeemCollateral(A, contracts, redemptionAmount, GAS_PRICE)

    /*
    At Collateral:USD price of 200:
    CollateralDrawn = (9 / 200) = 0.045 Collateral
    Collateralfee = (0.005 + (1/2) *( 9/260)) * CollateralDrawn = 0.00100384615385 Collateral
    CollateralRemainder = 0.045 - 0.001003... = 0.0439961538462
    */

    const A_balanceAfter = toBN(await collateralToken.balanceOf(A))

    const par = await relayer.par()
    const collateralDrawn = redemptionAmount.mul(par).div(price)

// calculate fee
const fee = await th.calculateCollateralFee(collateralDrawn, redemptionRate)

// The redeemer receives the gross collateral drawn minus the fee
const expectedCollateralReceived = collateralDrawn.sub(fee)

    th.assertIsApproximatelyEqual(
      A_balanceAfter.sub(A_balanceBefore),
      expectedCollateralReceived,
      100000
    )
  })

  it("redeemCollateral(): a full redemption (leaving trove with 0 debt), closes the trove", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    const { netDebt: W_netDebt } = await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: dec(10000, 18), extraParams: { from: whale } })

    const { netDebt: A_netDebt } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const { netDebt: D_netDebt } = await openShieldedTrove({ ICR: toBN(dec(201, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: D } })
    const redemptionAmount = A_netDebt.add(B_netDebt).add(C_netDebt).add(toBN(dec(10, 18)))

    // drop troves below HCR
    price = toBN(dec(125, 18))

    await priceFeed.setPrice(price)
    const A_balanceBefore = toBN(await collateralToken.balanceOf(A))
    const B_balanceBefore = toBN(await collateralToken.balanceOf(B))
    const C_balanceBefore = toBN(await collateralToken.balanceOf(C))

    // whale redeems 360 LUSD.  Expect this to fully redeem A, B, C, and partially redeem D.
    await th.redeemCollateral(whale, contracts, redemptionAmount, GAS_PRICE)

    // Check A, B, C have been closed
    assert.isFalse(await sortedShieldedTroves.contains(A))
    assert.isFalse(await sortedShieldedTroves.contains(B))
    assert.isFalse(await sortedShieldedTroves.contains(C))

    // Check D remains active
    assert.isTrue(await sortedShieldedTroves.contains(D))
  })

  const redeemCollateral3Full1Partial = async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    const { netDebt: W_netDebt } = await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: dec(10000, 18), extraParams: { from: whale } })

    const { netDebt: A_netDebt, collateral: A_coll } = await openShieldedTrove({ ICR: toBN(dec(182, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { netDebt: B_netDebt, collateral: B_coll } = await openShieldedTrove({ ICR: toBN(dec(181, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { netDebt: C_netDebt, collateral: C_coll } = await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const { netDebt: D_netDebt } = await openShieldedTrove({ ICR: toBN(dec(185, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: D } })

    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)
    const redemptionAmount = A_netDebt.add(B_netDebt).add(C_netDebt).add(toBN(dec(10, 18)))

    const A_balanceBefore = toBN(await collateralToken.balanceOf(A))
    const B_balanceBefore = toBN(await collateralToken.balanceOf(B))
    const C_balanceBefore = toBN(await collateralToken.balanceOf(C))
    const D_balanceBefore = toBN(await collateralToken.balanceOf(D))

    const A_collBefore = await troveManager.getTroveColl(A)
    const B_collBefore = await troveManager.getTroveColl(B)
    const C_collBefore = await troveManager.getTroveColl(C)
    const D_collBefore = await troveManager.getTroveColl(D)

    // Confirm baseRate before redemption is 0
    const baseRate = await aggregator.baseRate()
    assert.equal(baseRate, '0')
    const totalSystemDebt = await th.getEntireSystemDebt(contracts)
    const expectedRedemptionRate = await aggregator.calcRateForRedemption(redemptionAmount, totalSystemDebt)
    // whale redeems LUSD.  Expect this to fully redeem A, B, C, and partially redeem D.
    await th.redeemCollateral(whale, contracts, redemptionAmount, GAS_PRICE)

    // Check A, B, C have been closed
    assert.isFalse(await sortedShieldedTroves.contains(A))
    assert.isFalse(await sortedShieldedTroves.contains(B))
    assert.isFalse(await sortedShieldedTroves.contains(C))
    assert.isTrue(await troveManager.getTroveStatus(A) == 4 )
    assert.isTrue(await troveManager.getTroveStatus(B) == 4 )
    assert.isTrue(await troveManager.getTroveStatus(C) == 4 )

    // Check D stays active
    assert.isTrue(await sortedShieldedTroves.contains(D))
    
    /*
    At Collateral:USD price of 200, with full redemptions from A, B, C:

    CollateralDrawn from A = 100/200 = 0.5 Collateral --> Surplus = (1-0.5) = 0.5
    CollateralDrawn from B = 120/200 = 0.6 Collateral --> Surplus = (1-0.6) = 0.4
    CollateralDrawn from C = 130/200 = 0.65 Collateral --> Surplus = (2-0.65) = 1.35
    */

    const A_balanceAfter = toBN(await collateralToken.balanceOf(A))
    const B_balanceAfter = toBN(await collateralToken.balanceOf(B))
    const C_balanceAfter = toBN(await collateralToken.balanceOf(C))
    const D_balanceAfter = toBN(await collateralToken.balanceOf(D))

    // Check A, B, C's trove collateral balance is zero (fully redeemed-from troves)
    const A_collAfter = await troveManager.getTroveColl(A)
    const B_collAfter = await troveManager.getTroveColl(B)
    const C_collAfter = await troveManager.getTroveColl(C)
    assert.isTrue(A_collAfter.eq(toBN(0)))
    assert.isTrue(B_collAfter.eq(toBN(0)))
    assert.isTrue(C_collAfter.eq(toBN(0)))

    // check D's trove collateral balances have decreased (the partially redeemed-from trove)
    const D_collAfter = await troveManager.getTroveColl(D)
    assert.isTrue(D_collAfter.lt(D_collBefore))

    // Check A, B, C (fully redeemed-from troves), and D's (the partially redeemed-from trove) balance has not changed
    assert.isTrue(A_balanceAfter.eq(A_balanceBefore))
    assert.isTrue(B_balanceAfter.eq(B_balanceBefore))
    assert.isTrue(C_balanceAfter.eq(C_balanceBefore))
    assert.isTrue(D_balanceAfter.eq(D_balanceBefore))

    // D is not closed, so cannot open trove
    await assertRevert(borrowerOperations.openTrove(dec(10, 18), 0, ZERO_ADDRESS, ZERO_ADDRESS, true, { from: D }), 'BorrowerOps: Trove is active')

    return {
      A_netDebt, A_coll,
      B_netDebt, B_coll,
      C_netDebt, C_coll,
      expectedRedemptionRate
    }
  }

  it("redeemCollateral(): emits correct debt and coll values in each redeemed trove's TroveUpdated event", async () => {
    
    const { netDebt: W_netDebt } = await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: dec(10000, 18), extraParams: { from: whale } })

    const { netDebt: A_netDebt } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const { totalDebt: D_totalDebt, collateral: D_coll } = await openShieldedTrove({ ICR: toBN(dec(201, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: D } })
  
    // drop troves below HCR
    price = toBN(dec(125, 18))
    await priceFeed.setPrice(price)

    const partialAmount = toBN(dec(15, 18))
    const redemptionAmount = A_netDebt.add(B_netDebt).add(C_netDebt).add(partialAmount)
    const totalSystemDebt = await th.getEntireSystemDebt(contracts)
    const redemptionRateAtStart = await aggregator.calcRateForRedemption(redemptionAmount, totalSystemDebt)
    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems LUSD.  Expect this to fully redeem A, B, C, and partially redeem 15 LUSD from D.
    const redemptionTx = await th.redeemCollateralAndGetTxObject(whale, contracts, redemptionAmount, GAS_PRICE, th._100pct)

    // Check A, B, C have been closed
    assert.isFalse(await sortedShieldedTroves.contains(A))
    assert.isFalse(await sortedShieldedTroves.contains(B))
    assert.isFalse(await sortedShieldedTroves.contains(C))

    // Check D stays active
    assert.isTrue(await sortedShieldedTroves.contains(D))

    const troveUpdatedEvents = th.getAllEventsByName(redemptionTx, "TroveUpdated")

    // Get each trove's emitted debt and coll 
    const [A_emittedDebt, A_emittedColl] = th.getDebtAndCollFromTroveUpdatedEvents(troveUpdatedEvents, A)
    const [B_emittedDebt, B_emittedColl] = th.getDebtAndCollFromTroveUpdatedEvents(troveUpdatedEvents, B)
    const [C_emittedDebt, C_emittedColl] = th.getDebtAndCollFromTroveUpdatedEvents(troveUpdatedEvents, C)
    const [D_emittedDebt, D_emittedColl] = th.getDebtAndCollFromTroveUpdatedEvents(troveUpdatedEvents, D)

    // Expect A, B, C to have 0 emitted debt and coll, since they were closed
    assert.equal(A_emittedDebt, '0')
    assert.equal(A_emittedColl, '0')
    assert.equal(B_emittedDebt, '0')
    assert.equal(B_emittedColl, '0')
    assert.equal(C_emittedDebt, '0')
    assert.equal(C_emittedColl, '0')
    const collateralDrawn = partialAmount.mul(mv._1e18BN).div(price)
    const fee = await th.calculateCollateralFee(collateralDrawn, redemptionRateAtStart)
    /* Expect D to have lost 15 debt and (at Collateral price of 125) 15/125 = 0.12 collateral.
    Fee is taken from the collateral sent to the redeemer, so it remains in the trove.
    Expect remaining debt = (85 - 15) = 70, and remaining collateral = D_coll - collateralDrawn + fee. */
    th.assertIsApproximatelyEqual(D_emittedDebt, D_totalDebt.sub(partialAmount))
    th.assertIsApproximatelyEqual(D_emittedColl, D_coll.sub(collateralDrawn).add(fee))
  })

  it("redeemCollateral(): a redemption that closes a trove leaves the trove's Collateral surplus (collateral - Collateral drawn) available for the trove owner to claim", async () => {

    const {
      A_netDebt, A_coll,
      B_netDebt, B_coll,
      C_netDebt, C_coll,
      expectedRedemptionRate
    } = await redeemCollateral3Full1Partial()

    const A_balanceBefore = toBN(await collateralToken.balanceOf(A))
    const B_balanceBefore = toBN(await collateralToken.balanceOf(B))
    const C_balanceBefore = toBN(await collateralToken.balanceOf(C))

    // CollSurplusPool endpoint cannot be called directly
    await assertRevert(collSurplusPool.claimColl(A), 'CollSurplusPool: Caller is not Borrower Operations')

    await borrowerOperations.claimCollateral({ from: A, gasPrice: GAS_PRICE  })
    await borrowerOperations.claimCollateral({ from: B, gasPrice: GAS_PRICE  })
    await borrowerOperations.claimCollateral({ from: C, gasPrice: GAS_PRICE  })

    const price = toBN(await priceFeed.getPrice())
    const A_gross = A_netDebt.mul(mv._1e18BN).div(price)
    const A_fee = await th.calculateCollateralFee(A_gross, expectedRedemptionRate)
    const A_ExpectedRedemptionAmount = A_gross.sub(A_fee)

    const B_gross = B_netDebt.mul(mv._1e18BN).div(price)
    const B_fee = await th.calculateCollateralFee(B_gross, expectedRedemptionRate)
    const B_ExpectedRedemptionAmount = B_gross.sub(B_fee)

    const C_gross = C_netDebt.mul(mv._1e18BN).div(price)
    const C_fee = await th.calculateCollateralFee(C_gross, expectedRedemptionRate)
    const C_ExpectedRedemptionAmount = C_gross.sub(C_fee)

    const A_expectedBalance = A_balanceBefore.add(A_coll.sub(A_ExpectedRedemptionAmount));
    const B_expectedBalance = B_balanceBefore.add(B_coll.sub(B_ExpectedRedemptionAmount));
    const C_expectedBalance = C_balanceBefore.add(C_coll.sub(C_ExpectedRedemptionAmount));

    const A_balanceAfter = toBN(await collateralToken.balanceOf(A))
    const B_balanceAfter = toBN(await collateralToken.balanceOf(B))
    const C_balanceAfter = toBN(await collateralToken.balanceOf(C))

    th.assertIsApproximatelyEqual(A_balanceAfter, A_expectedBalance)
    th.assertIsApproximatelyEqual(B_balanceAfter, B_expectedBalance)
    th.assertIsApproximatelyEqual(C_balanceAfter, C_expectedBalance)
  })

  it("redeemCollateral(): a redemption that closes a trove leaves the trove's Collateral surplus (collateral - Collateral drawn) available for the trove owner after re-opening trove", async () => {

    const {
      A_netDebt, A_coll: A_collBefore,
      B_netDebt, B_coll: B_collBefore,
      C_netDebt, C_coll: C_collBefore,
      expectedRedemptionRate
    } = await redeemCollateral3Full1Partial()

    const price = await priceFeed.getPrice()

    const A_gross = A_netDebt.mul(mv._1e18BN).div(price)
    const B_gross = B_netDebt.mul(mv._1e18BN).div(price)
    const C_gross = C_netDebt.mul(mv._1e18BN).div(price)

    const { collateral: A_coll } = await openShieldedTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { collateral: B_coll } = await openShieldedTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { collateral: C_coll } = await openShieldedTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    const A_collAfter = await troveManager.getTroveColl(A)
    const B_collAfter = await troveManager.getTroveColl(B)
    const C_collAfter = await troveManager.getTroveColl(C)

    assert.isTrue(A_collAfter.eq(A_coll))
    assert.isTrue(B_collAfter.eq(B_coll))
    assert.isTrue(C_collAfter.eq(C_coll))

    const A_fee = th.calculateCollateralFee(A_gross, expectedRedemptionRate)
    const B_fee = th.calculateCollateralFee(B_gross, expectedRedemptionRate)
    const C_fee = th.calculateCollateralFee(C_gross, expectedRedemptionRate)

    const A_surplus = A_collBefore.sub(A_gross).add(A_fee)
    const B_surplus = B_collBefore.sub(B_gross).add(B_fee)
    const C_surplus = C_collBefore.sub(C_gross).add(C_fee)


    // we are getting the surplus from because collSurplusPool.getCollateral(address) is overflowing

    const AsurplusEvents = await collSurplusPool.getPastEvents('CollBalanceUpdated', {
      fromBlock: 0,
      filter: { _account: A }
    })
    const BsurplusEvents = await collSurplusPool.getPastEvents('CollBalanceUpdated', {
      fromBlock: 0,
      filter: { _account: B }
    })
    const CsurplusEvents = await collSurplusPool.getPastEvents('CollBalanceUpdated', {
      fromBlock: 0,
      filter: { _account: C }
    })

    const A_surplus_actual = AsurplusEvents[AsurplusEvents.length - 1].args._newBalance
    const B_surplus_actual = BsurplusEvents[BsurplusEvents.length - 1].args._newBalance
    const C_surplus_actual = CsurplusEvents[CsurplusEvents.length - 1].args._newBalance

    th.assertIsApproximatelyEqual(A_surplus_actual, A_surplus)
    th.assertIsApproximatelyEqual(B_surplus_actual, B_surplus)
    th.assertIsApproximatelyEqual(C_surplus_actual, C_surplus)
  })

  it('redeemCollateral(): reverts if fee eats up all returned collateral', async () => {
    // --- SETUP ---
    const { lusdAmount } = await openShieldedTrove({ ICR: toBN(dec(3000, 16)), extraLUSDAmount: dec(1, 24), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: bob } })

    // drop troves below HCR
    price = toBN(dec(120, 18))
    await priceFeed.setPrice(price)

    // --- TEST ---

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // keep redeeming until we get the base rate to the ceiling of 100%
    // this takes less iter than LiquityV1 since here is no borrowing fee and
    // more debt is redeemed so max fee is it in less iter
    for (let i = 0; i < 1; i++) {
      // Find hints for redeeming
      const {
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(lusdAmount, price, 0)

      // Don't pay for gas, as it makes it easier to calculate the received Ether
      const redemptionTx = await troveManager.redeemCollateral(
        lusdAmount,
        firstRedemptionHint,
        ZERO_ADDRESS,
        alice,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        partialRedemptionHintNICR,
        0, th._100pct,
        {
          from: alice,
          gasPrice: GAS_PRICE
        }
      )
      await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })
      await collateralToken.approve(activeShieldedPool.address, lusdAmount.mul(mv._1e18BN).div(price), { from: alice })
      await borrowerOperations.adjustTrove(lusdAmount.mul(mv._1e18BN).div(price), 0, lusdAmount, true, false, alice, alice, { from: alice })
    }

    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(lusdAmount, price, 0)

    await assertRevert(
      troveManager.redeemCollateral(
        lusdAmount,
        firstRedemptionHint,
        ZERO_ADDRESS,
        alice,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        partialRedemptionHintNICR,
        0, th._100pct,
        {
          from: alice,
          gasPrice: GAS_PRICE
        }
      ),
      'TroveManager: Fee would eat up all returned collateral'
    )
  })
  it("redeemCollateral(): shielded trove is not redeemed against", async () => {
    await rateControl.setCoBias(0)
    const collateralAmount = dec(1000, 'ether')
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: A })
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: B })
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: C })
    tx_a = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, false, { from: A })
    tx_b = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, false, { from: B })
    tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, true, { from: C })

    const A_debt = await troveManager.getTroveDebt(A)
    const B_debt = await troveManager.getTroveDebt(B)
    const C_debt = await troveManager.getTroveDebt(C)

    activeDebt = await activePool.getLUSDDebt()
    activeShieldedDebt = await activeShieldedPool.getLUSDDebt()
    console.log("activeDebt", activeDebt.toString())
    console.log("activeShieldedDebt", activeShieldedDebt.toString())

    assert.isTrue(activeDebt.eq(A_debt.add(B_debt)))
    assert.isTrue(activeShieldedDebt.eq(C_debt))

    const price = await priceFeed.getPrice();

    // shielded trove is above HCR
    assert.isTrue((await troveManager.getCurrentICR(C, price)).gt((await troveManager.HCR())))

    // A and C send all their tokens to B
    await lusdToken.transfer(B, await lusdToken.balanceOf(A), {from: A})
    await lusdToken.transfer(B, await lusdToken.balanceOf(C), {from: C})
    
    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Before redemption

    // LUSD redemption is 55000 US
    const LUSDRedemption = dec(55000, 18)

    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, th._100pct)

    // Check A, B closed and C remains active
    assert.isFalse(await sortedShieldedTroves.contains(A))
    assert.isFalse(await sortedShieldedTroves.contains(B))
    assert.isTrue(await sortedShieldedTroves.contains(C))

    //const expectedDebt_A = toBN(dec(4600, 18))//.mul(par).div(toBN(dec(1, 18)))
    // A's remaining debt = 29800 + 19800 + 9800 + 200 - 55000 = 4600
    const expectedDebt_A = toBN('0')
    const A_final_debt = await troveManager.getTroveDebt(A)
    console.log("A_final_debt", A_final_debt.toString())
    assert.isTrue(A_final_debt.eq(expectedDebt_A))

    // C lost no debt
    const C_final_debt = await troveManager.getTroveDebt(C)
    assert.isTrue(C_final_debt.eq(C_debt))
  })
  it("redeemCollateral(): shielded trove is redeemed against when ICR < HCR", async () => {
    await rateControl.setCoBias(0)
    /*
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: A })
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: B })
    await collateralToken.approve(activeShieldedPool.address, collateralAmount, { from: C })
    */

    const collateralAmount = dec(1000, 'ether')
    tx_a = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, false, { from: A })
    tx_b = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, false, { from: B })
    tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, true, { from: C })

    const A_debt = await troveManager.getTroveDebt(A)
    const B_debt = await troveManager.getTroveDebt(B)
    const C_debt = await troveManager.getTroveDebt(C)

    activeDebt = await activePool.getLUSDDebt()
    activeShieldedDebt = await activeShieldedPool.getLUSDDebt()

    assert.isTrue(activeDebt.eq(A_debt.add(B_debt)))
    assert.isTrue(activeShieldedDebt.eq(C_debt))

    const currentPrice = await priceFeed.getPrice();
    C_ICR = await troveManager.getCurrentICR(C, currentPrice)
    HCR = await troveManager.HCR()

    // new price needs to drop C under HCR
    const price = HCR.mul(currentPrice).div(C_ICR).sub(toBN(dec(1, 18)))
    await priceFeed.setPrice(price)

    // shielded trove is above HCR
    assert.isTrue((await troveManager.getCurrentICR(C, price)).lt((await troveManager.HCR())))

    // A and C send all their tokens to B
    await lusdToken.transfer(B, await lusdToken.balanceOf(A), {from: A})
    await lusdToken.transfer(B, await lusdToken.balanceOf(C), {from: C})
    
    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Before redemption

    // LUSD redemption is 55000 US
    const LUSDRedemption = dec(55000, 18)

    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, th._100pct)

    // Check A, B closed and C is also closed
    assert.isFalse(await sortedShieldedTroves.contains(A))
    assert.isFalse(await sortedShieldedTroves.contains(B))
    assert.isFalse(await sortedShieldedTroves.contains(C))

    //const expectedDebt_A = toBN(dec(4600, 18))//.mul(par).div(toBN(dec(1, 18)))
    // A's remaining debt = 29800 + 19800 + 9800 + 200 - 55000 = 4600
    const expectedDebt_A = toBN(dec(4600, 18))
    const A_final_debt = await troveManager.getTroveDebt(A)
    assert.isTrue(A_final_debt.eq(expectedDebt_A))

    // C lost no debt
    const C_final_debt = await troveManager.getTroveDebt(C)
    const expectedDebt_C = toBN(0)
    assert.isTrue(C_final_debt.eq(expectedDebt_C))
  })
  it("redeemCollateral(): redemptions fail if all troves shielded", async () => {
    const collateralAmount = dec(1000, 'ether')
    tx_a = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, true, { from: A })
    tx_b = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, true, { from: B })
    tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, true, { from: C })

    const price = await priceFeed.getPrice();

    // A and C send all their tokens to D
    await lusdToken.transfer(D, await lusdToken.balanceOf(A), {from: A})
    await lusdToken.transfer(D, await lusdToken.balanceOf(C), {from: C})
    
    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption is 55000 US
    const LUSDRedemption = dec(10000, 18)

    D_balance_before = await lusdToken.balanceOf(D)
    await assertRevert(th.redeemCollateralAndGetTxObject(D, contracts, LUSDRedemption, th._100pct), "TM: Unable to redeem any amount")
    D_balance_after = await lusdToken.balanceOf(D)

    // D has same number of RD
    assert.isTrue(D_balance_before.eq(D_balance_after))

    // Check A, B and C remains active
    assert.isTrue(await sortedShieldedTroves.contains(A))
    assert.isTrue(await sortedShieldedTroves.contains(B))
    assert.isTrue(await sortedShieldedTroves.contains(C))

  })

  it("liquidate: rewards work after zero out of active pool debt", async () => {
    // A, B  open trove
    const { collateral: A_coll } = await openShieldedTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: alice } })
    const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } })

    // Price drops to 1 $/E
    await priceFeed.setPrice(dec(1, 18))
    console.log("bob " + bob)

    // L1: A liquidated
    const txA = await liquidations.liquidate(alice)
    assert.isTrue(txA.receipt.status)
    assert.isFalse(await sortedShieldedTroves.contains(alice))
    console.log("default pool debt " + await defaultPool.getLUSDDebt())
    
    // Price bounces back to 200 $/E
    await priceFeed.setPrice(dec(200, 18))
    // C, opens trove
    const { collateral: C_coll } = await openShieldedTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: carol } })
    
    // Price drops to 100 $/E
    await priceFeed.setPrice(dec(1, 18))
   
    console.log("default pool debt " + await defaultPool.getLUSDDebt())
    // L2: B Liquidated
    const txB = await liquidations.liquidate(bob)

    assert.isTrue((await activePool.getCollateral()).eq(toBN('0')))
    assert.isTrue((await activePool.getLUSDDebt()).eq(toBN('0')))
    assert.equal((await sortedTroves.getSize()).toString(), '0')

    // carol still has pending rewards that came from bob's base trove
    assert.isTrue(await rewards.hasPendingRewards(carol));

    // adjust trove to applyPendingRewards
    await borrowerOperations.adjustTrove(dec(1, 18),  0, 0, false, false, carol, carol, { from: carol })

    // rewards have been applied
    assert.isFalse(await rewards.hasPendingRewards(carol));

    const { collateral: D_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: dennis } })

    assert.isTrue((await activePool.getCollateral()).gt(toBN('0')))
    assert.isTrue((await activePool.getLUSDDebt()).gt(toBN('0')))
    assert.equal((await sortedTroves.getSize()).toString(), '1')

  })
  it("getPendingLUSDDebtReward(): Returns 0 if there is no pending LUSDDebt reward", async () => {
    // Make some troves
    const { totalDebt } = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: dec(100, 18), extraParams: { from: defaulter_1 } })

    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })

    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: totalDebt, extraParams: { from: whale } })
    // add 2 to totalDebt since SP now requires a minimum of 1 being leftover
    await stabilityPool.provideToSP(totalDebt.add(toBN(dec(2, 18))), ZERO_ADDRESS, { from: whale })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    tx = await liquidations.liquidate(defaulter_1)
    const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(tx)

    // Confirm defaulter_1 liquidated
    assert.isFalse(await sortedShieldedTroves.contains(defaulter_1))

    // Confirm there are no pending rewards from liquidation
    const current_L_LUSDDebt = await rewards.L_LUSDDebt()
    assert.equal(current_L_LUSDDebt, 0)

    const carolSnapshot_L_LUSDDebt = (await rewards.rewardSnapshots(carol))[1]
    assert.equal(carolSnapshot_L_LUSDDebt, 0)

    const carol_PendingLUSDDebtReward = await rewards.getPendingLUSDDebtReward(carol)
    assert.equal(carol_PendingLUSDDebtReward, 0)
  })

  it("getPendingCollateralReward(): Returns 0 if there is no pending Collateral reward", async () => {
    // make some troves
    const { totalDebt } = await openShieldedTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: dec(100, 18), extraParams: { from: defaulter_1 } })

    await openShieldedTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })

    await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: totalDebt, extraParams: { from: whale } })
    // add 2 to totalDebt since SP now requires a minimum of 1 being leftover
    await stabilityPool.provideToSP(totalDebt.add(toBN(dec(2, 18))), ZERO_ADDRESS, { from: whale })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    await liquidations.liquidate(defaulter_1)

    // Confirm defaulter_1 liquidated
    assert.isFalse(await sortedShieldedTroves.contains(defaulter_1))

    // Confirm there are no pending rewards from liquidation
    const current_L_Coll = await rewards.L_Coll()
    assert.equal(current_L_Coll, 0)

    const carolSnapshot_L_Coll = (await rewards.rewardSnapshots(carol))[0]
    assert.equal(carolSnapshot_L_Coll, 0)

    const carol_PendingCollateralReward = await rewards.getPendingCollateralReward(carol)
    assert.equal(carol_PendingCollateralReward, 0)
  })

  // --- getCurrentICR ---
//
  it('getCurrentICR(): reports intended ICR', async () => {
    await openShieldedTrove({ ICR: toBN(dec(155, 16)), extraParams: { from: alice } })

    const price = await priceFeed.getPrice()
    const ICR_Before = await troveManager.getCurrentICR(alice, price)

    assert.isTrue(toBN(dec(155, 16)).eq(ICR_Before))
  })

  // --- computeICR ---

  it("computeICR(): Returns 0 if trove's coll is worth 0", async () => {
    const price = 0
    const coll = dec(1, 'ether')
    const debt = dec(100, 18)

    const ICR = (await troveManager.computeICR(coll, debt, price)).toString()

    assert.equal(ICR, 0)
  })

  it("computeICR(): Returns correct ICR for Collateral:USD = 100, coll = 1 Collateral, debt = 100 LUSD", async () => {
    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = dec(100, 18)

    const ICR = (await troveManager.computeICR(coll, debt, price)).toString()

    assert.equal(ICR, dec(1, 18))
  })

  it("computeICR(): returns correct ICR for Collateral:USD = 100, coll = 200 Collateral, debt = 30 LUSD", async () => {
    const price = dec(100, 18)
    const coll = dec(200, 'ether')
    const debt = dec(30, 18)

    const ICR = (await troveManager.computeICR(coll, debt, price)).toString()

    assert.isAtMost(th.getDifference(ICR, '666666666666666666666'), 1000)
  })

  it("computeICR(): returns correct ICR for Collateral:USD = 250, coll = 1350 Collateral, debt = 127 LUSD", async () => {
    const price = '250000000000000000000'
    const coll = '1350000000000000000000'
    const debt = '127000000000000000000'

    const ICR = (await troveManager.computeICR(coll, debt, price))

    assert.isAtMost(th.getDifference(ICR, '2657480314960630000000'), 1000000)
  })

  it("computeICR(): returns correct ICR for Collateral:USD = 100, coll = 1 Collateral, debt = 54321 LUSD", async () => {
    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = '54321000000000000000000'

    const ICR = (await troveManager.computeICR(coll, debt, price)).toString()

    assert.isAtMost(th.getDifference(ICR, '1840908672520756'), 1000)
  })


  it("computeICR(): Returns 2^256-1 if trove has non-zero coll and zero debt", async () => {
    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = 0

    const ICR = web3.utils.toHex(await troveManager.computeICR(coll, debt, price))
    const maxBytes32 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    assert.equal(ICR, maxBytes32)
  })

  // --- checkRecoveryMode ---

  //TCR < 150%
  it("checkRecoveryMode(): Returns true when TCR < 150%", async () => {
    await priceFeed.setPrice(dec(100, 18))

    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

    await priceFeed.setPrice('99999999999999999999')

    const TCR = (await th.getTCR(contracts))

    assert.isTrue(TCR.lte(toBN('1500000000000000000')))

    assert.isTrue(await th.checkRecoveryMode(contracts))
  })

  // TCR == 150%
  it("checkRecoveryMode(): Returns false when TCR == 150%", async () => {
    await priceFeed.setPrice(dec(100, 18))

    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

    const TCR = (await th.getTCR(contracts))

    assert.equal(TCR, '1500000000000000000')

    assert.isFalse(await th.checkRecoveryMode(contracts))
  })

  // > 150%
  it("checkRecoveryMode(): Returns false when TCR > 150%", async () => {
    await priceFeed.setPrice(dec(100, 18))

    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

    await priceFeed.setPrice('100000000000000000001')

    const TCR = (await th.getTCR(contracts))

    assert.isTrue(TCR.gte(toBN('1500000000000000000')))

    assert.isFalse(await th.checkRecoveryMode(contracts))
  })

  // check 0
  it("checkRecoveryMode(): Returns false when TCR == 0", async () => {
    await priceFeed.setPrice(dec(100, 18))

    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: alice } })
    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

    await priceFeed.setPrice(0)

    const TCR = (await th.getTCR(contracts)).toString()

    assert.equal(TCR, 0)

    assert.isTrue(await th.checkRecoveryMode(contracts))
  })

  // --- computeICR w/ non-$1 par---

  it("computeICR(): Returns 0 if trove's coll is worth 0, par < 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    await relayer.updatePar();
    par = await relayer.par()
    assert.isTrue((await relayer.par()).lt(ONE_DOLLAR));

    const price = 0
    const coll = dec(1, 'ether')
    const debt = dec(100, 18)

    const ICR = (await troveManager.computeICR(coll, debt, price)).toString()

    assert.equal(ICR, 0)
    assert.isAtMost(th.getDifference(ICR, toBN(0).mul(toBN(dec(1,18))).div(par)), 1)
  })
  it("computeICR(): Returns 0 if trove's coll is worth 0, par > 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    await relayer.updatePar();
    par = await relayer.par()
    assert.isTrue((await relayer.par()).gt(ONE_DOLLAR));

    const price = 0
    const coll = dec(1, 'ether')
    const debt = dec(100, 18)

    const ICR = (await troveManager.computeICR(coll, debt, price)).toString()

    assert.equal(ICR, 0)
    assert.isAtMost(th.getDifference(ICR, toBN(0).mul(toBN(dec(1,18))).div(par)), 1)
  })

  it("computeICR(): Returns correct ICR for Collateral:USD = 100, coll = 1 Collateral, debt = 100 LUSD, par < 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    await relayer.updatePar();
    par = await relayer.par();
    assert.isTrue(par.lt(ONE_DOLLAR));

    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = dec(100, 18)

    const ICR = await troveManager.computeICR(coll, debt, price)

    const ICRTimesPar = ICR.mul(par).div(toBN(dec(1,18)))
    // rounding error exists
    assert.isAtMost(th.getDifference(ICRTimesPar, dec(1,18)), 1)
    assert.isAtMost(th.getDifference(ICR, toBN(dec(1,18)).mul(toBN(dec(1,18))).div(par)), 1)
  })

  it("computeICR(): Returns correct ICR for Collateral:USD = 100, coll = 1 Collateral, debt = 100 LUSD, par > 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    await relayer.updatePar();
    par = await relayer.par();
    assert.isTrue(par.gt(ONE_DOLLAR));

    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = dec(100, 18)

    const ICR = await troveManager.computeICR(coll, debt, price)

    const ICRTimesPar = ICR.mul(par).div(toBN(dec(1,18)))
    assert.isAtMost(th.getDifference(ICRTimesPar, dec(1,18)), 1)
    assert.isAtMost(th.getDifference(ICR, toBN(dec(1,18)).mul(toBN(dec(1,18))).div(par)), 1)

  })

  it("computeICR(): returns correct ICR for Collateral:USD = 100, coll = 200 Collateral, debt = 30 LUSD, par < 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    await relayer.updatePar();
    par = await relayer.par();

    const price = dec(100, 18)
    const coll = dec(200, 'ether')
    const debt = dec(30, 18)

    const ICR = await troveManager.computeICR(coll, debt, price)
    const ICRTimesPar = ICR.mul(par).div(toBN(dec(1,18)))
    // rounding error exists
    assert.isAtMost(th.getDifference(ICRTimesPar, '666666666666666666666'), 1)
    assert.isAtMost(th.getDifference(ICR, toBN('666666666666666666666').mul(toBN(dec(1,18))).div(par)), 1000)
  })

  it("computeICR(): returns correct ICR for Collateral:USD = 100, coll = 200 Collateral, debt = 30 LUSD, par > 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    par = await relayer.par();

    const price = dec(100, 18)
    const coll = dec(200, 'ether')
    const debt = dec(30, 18)

    const ICR = await troveManager.computeICR(coll, debt, price)
    const ICRTimesPar = ICR.mul(par).div(toBN(dec(1,18)))
    // rounding error exists
    assert.isAtMost(th.getDifference(ICRTimesPar, '666666666666666666666'), 1)
    assert.isAtMost(th.getDifference(ICR, toBN('666666666666666666666').mul(toBN(dec(1,18))).div(par)), 1000)
  })

  it("computeICR(): returns correct ICR for Collateral:USD = 250, coll = 1350 Collateral, debt = 127 LUSD, par < 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    par = await relayer.par();

    const price = '250000000000000000000'
    const coll = '1350000000000000000000'
    const debt = '127000000000000000000'

    const ICR = (await troveManager.computeICR(coll, debt, price))
    const ICRTimesPar = ICR.mul(par).div(toBN(dec(1,18)))
    // rounding error exists
    assert.isAtMost(th.getDifference(ICRTimesPar, '2657480314960630000000'), 1000000)
    assert.isAtMost(th.getDifference(ICR, toBN('2657480314960630000000').mul(toBN(dec(1,18))).div(par)), 1000000)
  })

  it("computeICR(): returns correct ICR for Collateral:USD = 250, coll = 1350 Collateral, debt = 127 LUSD, par < 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    par = await relayer.par();

    const price = '250000000000000000000'
    const coll = '1350000000000000000000'
    const debt = '127000000000000000000'

    const ICR = (await troveManager.computeICR(coll, debt, price))
    const ICRTimesPar = ICR.mul(par).div(toBN(dec(1,18)))
    // rounding error exists
    assert.isAtMost(th.getDifference(ICRTimesPar, '2657480314960630000000'), 1000000)
    assert.isAtMost(th.getDifference(ICR, toBN('2657480314960630000000').mul(toBN(dec(1,18))).div(par)), 1000000)
  })

  it("computeICR(): returns correct ICR for Collateral:USD = 100, coll = 1 Collateral, debt = 54321 LUSD, par < 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    par = await relayer.par();

    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = '54321000000000000000000'

    const ICR = await troveManager.computeICR(coll, debt, price)
    const ICRTimesPar = ICR.mul(par).div(toBN(dec(1,18)))

    // rounding error exists
    assert.isAtMost(th.getDifference(ICRTimesPar, '1840908672520756'), 1000)
    assert.isAtMost(th.getDifference(ICR, toBN('1840908672520756').mul(toBN(dec(1,18))).div(par)), 1000)
  })
  it("computeICR(): returns correct ICR for Collateral:USD = 100, coll = 1 Collateral, debt = 54321 LUSD, par > 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    par = await relayer.par();

    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = '54321000000000000000000'

    const ICR = await troveManager.computeICR(coll, debt, price)
    const ICRTimesPar = ICR.mul(par).div(toBN(dec(1,18)))

    // rounding error exists
    assert.isAtMost(th.getDifference(ICRTimesPar, '1840908672520756'), 1000)
    assert.isAtMost(th.getDifference(ICR, toBN('1840908672520756').mul(toBN(dec(1,18))).div(par)), 1000)
  })

  it("computeICR(): Returns 2^256-1 if trove has non-zero coll and zero debt, par < 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    par = await relayer.par();

    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = 0

    const ICR = web3.utils.toHex(await troveManager.computeICR(coll, debt, price))
    //const ICRTimesPar = ICR.mul(par).div(toBN(dec(1,18)))
    const maxBytes32 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    assert.equal(ICR, maxBytes32)
  })

  it("computeICR(): Returns 2^256-1 if trove has non-zero coll and zero debt, par > 1", async () => {
    await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(10).mul(ONE_CENT)));
    await relayer.updatePar();
    par = await relayer.par();

    const price = dec(100, 18)
    const coll = dec(1, 'ether')
    const debt = 0

    const ICR = web3.utils.toHex(await troveManager.computeICR(coll, debt, price))
    //const ICRTimesPar = ICR.mul(par).div(toBN(dec(1,18)))
    const maxBytes32 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    assert.equal(ICR, maxBytes32)
  })

  // --- Getters ---

  it("getTroveStake(): Returns stake", async () => {
    const { collateral: A_coll } = await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: A } })
    const { collateral: B_coll } = await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })

    const A_Stake = await troveManager.getTroveStake(A)
    const B_Stake = await troveManager.getTroveStake(B)

    assert.equal(A_Stake, A_coll.toString())
    assert.equal(B_Stake, B_coll.toString())
  })

  it("getTroveColl(): Returns coll", async () => {
    const { collateral: A_coll } = await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: A } })
    const { collateral: B_coll } = await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })

    assert.equal(await troveManager.getTroveColl(A), A_coll.toString())
    assert.equal(await troveManager.getTroveColl(B), B_coll.toString())
  })

  it("getTroveDebt(): Returns debt", async () => {
    const { totalDebt: totalDebtA } = await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: A } })
    const { totalDebt: totalDebtB } = await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })

    const A_Debt = await troveManager.getTroveDebt(A)
    const B_Debt = await troveManager.getTroveDebt(B)

    // Expect debt = requested + 0.5% fee + 50 (due to gas comp)

    assert.equal(A_Debt, totalDebtA.toString())
    assert.equal(B_Debt, totalDebtB.toString())
  })

  it("getTroveStatus(): Returns status", async () => {
    const { totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: B } })
    await openShieldedTrove({ ICR: toBN(dec(150, 16)), extraLUSDAmount: B_totalDebt, extraParams: { from: A } })

    // to be able to repay:
    await lusdToken.transfer(B, B_totalDebt, { from: A })
    await borrowerOperations.closeTrove({from: B})

    const A_Status = await troveManager.getTroveStatus(A)
    const B_Status = await troveManager.getTroveStatus(B)
    const C_Status = await troveManager.getTroveStatus(C)

    assert.equal(A_Status, '1')  // active
    assert.equal(B_Status, '2')  // closed by user
    assert.equal(C_Status, '0')  // non-existent
  })

  it("hasPendingRewards(): Returns false it trove is not active", async () => {
    assert.isFalse(await rewards.hasPendingRewards(alice))
  })
})

contract('Reset chain state', async accounts => { })
