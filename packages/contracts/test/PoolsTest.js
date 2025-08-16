const StabilityPool = artifacts.require("./StabilityPool.sol")
const ActivePool = artifacts.require("./ActivePool.sol")
const DefaultPool = artifacts.require("./DefaultPool.sol")
const NonPayable = artifacts.require("./NonPayable.sol")
const CollateralToken = artifacts.require("./TestContracts/CollateralToken.sol")

const testHelpers = require("../utils/testHelpers.js")

const th = testHelpers.TestHelper
const dec = th.dec

const _minus_1_Ether = web3.utils.toWei('-1', 'ether')

contract('StabilityPool', async accounts => {
  /* mock* are EOA’s, temporarily used to call protected functions.
  TODO: Replace with mock contracts, and later complete transactions from EOA
  */
  let stabilityPool
  let collateralToken

  const [owner, alice] = accounts;

  beforeEach(async () => {
    stabilityPool = await StabilityPool.new()
    const mockActivePoolAddress = (await NonPayable.new()).address
    const dumbContractAddress = (await NonPayable.new()).address
    collateralToken = await CollateralToken.new("test", "test")
    await stabilityPool.setAddresses(dumbContractAddress, dumbContractAddress, dumbContractAddress, mockActivePoolAddress, dumbContractAddress, dumbContractAddress, dumbContractAddress, dumbContractAddress, collateralToken.address)
  })

  it('getCollateral(): gets the recorded ETH balance', async () => {
    const recordedETHBalance = await stabilityPool.getCollateral()
    assert.equal(recordedETHBalance, 0)
  })

  it('getTotalLUSDDeposits(): gets the recorded LUSD balance', async () => {
    const recordedETHBalance = await stabilityPool.getTotalLUSDDeposits()
    assert.equal(recordedETHBalance, 0)
  })
})

contract('ActivePool', async accounts => {

  let activePool, mockBorrowerOperations

  const [owner, alice] = accounts;
  beforeEach(async () => {
    activePool = await ActivePool.new()
    mockBorrowerOperations = await NonPayable.new()
    const dumbContractAddress = (await NonPayable.new()).address
    collateralToken = await CollateralToken.new("test", "test")
    await activePool.setAddresses(dumbContractAddress, mockBorrowerOperations.address, dumbContractAddress, dumbContractAddress, dumbContractAddress, dumbContractAddress, collateralToken.address)
  })

  it('getCollateral(): gets the recorded ETH balance', async () => {
    const recordedETHBalance = await activePool.getCollateral()
    assert.equal(recordedETHBalance, 0)
  })

  it('getLUSDDebt(): gets the recorded LUSD balance', async () => {
    const recordedETHBalance = await activePool.getLUSDDebt()
    assert.equal(recordedETHBalance, 0)
  })
 
  it('increaseLUSD(): increases the recorded LUSD balance by the correct amount', async () => {
    const recordedLUSD_balanceBefore = await activePool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceBefore, 0)

    // await activePool.increaseLUSDDebt(100, { from: mockBorrowerOperationsAddress })
    const increaseLUSDDebtData = th.getTransactionData('increaseLUSDDebt(uint256)', ['0x64'])
    const tx = await mockBorrowerOperations.forward(activePool.address, increaseLUSDDebtData)
    assert.isTrue(tx.receipt.status)
    const recordedLUSD_balanceAfter = await activePool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceAfter, 100)
  })
  // Decrease
  it('decreaseLUSD(): decreases the recorded LUSD balance by the correct amount', async () => {
    // start the pool on 100 wei
    //await activePool.increaseLUSDDebt(100, { from: mockBorrowerOperationsAddress })
    const increaseLUSDDebtData = th.getTransactionData('increaseLUSDDebt(uint256)', ['0x64'])
    const tx1 = await mockBorrowerOperations.forward(activePool.address, increaseLUSDDebtData)
    assert.isTrue(tx1.receipt.status)

    const recordedLUSD_balanceBefore = await activePool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceBefore, 100)

    //await activePool.decreaseLUSDDebt(100, { from: mockBorrowerOperationsAddress })
    const decreaseLUSDDebtData = th.getTransactionData('decreaseLUSDDebt(uint256)', ['0x64'])
    const tx2 = await mockBorrowerOperations.forward(activePool.address, decreaseLUSDDebtData)
    assert.isTrue(tx2.receipt.status)
    const recordedLUSD_balanceAfter = await activePool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceAfter, 0)
  })

  // send raw ether
  it('sendCollateral(): decreases the recorded ETH balance by the correct amount', async () => {
    // setup: give pool 2 ether
    const activePool_initialBalance = web3.utils.toBN(await collateralToken.balanceOf(activePool.address))
    assert.equal(activePool_initialBalance, 0)
    // start pool with 2 ether
    //await web3.eth.sendTransaction({ from: mockBorrowerOperationsAddress, to: activePool.address, value: dec(2, 'ether') })
    await collateralToken.mint(owner, dec(2, 'ether'))
    await collateralToken.approve(activePool.address, dec(2, 'ether'))
    const startPoolData = th.getTransactionData('addCollateral(address,uint256)', [owner, web3.utils.toHex(dec(2, 'ether'))])
    const tx1 = await mockBorrowerOperations.forward(activePool.address, startPoolData, { from: owner  })
    assert.isTrue(tx1.receipt.status)

    const activePool_BalanceBeforeTx = web3.utils.toBN(await collateralToken.balanceOf(activePool.address))
    const alice_Balance_BeforeTx = web3.utils.toBN(await collateralToken.balanceOf(alice))

    assert.equal(activePool_BalanceBeforeTx, dec(2, 'ether'))

    // send ether from pool to alice
    //await activePool.sendCollateral(alice, dec(1, 'ether'), { from: mockBorrowerOperationsAddress })
    const sendCollateralData = th.getTransactionData('sendCollateral(address,uint256)', [alice, web3.utils.toHex(dec(1, 'ether'))])
    const tx2 = await mockBorrowerOperations.forward(activePool.address, sendCollateralData, { from: owner })
    assert.isTrue(tx2.receipt.status)

    const activePool_BalanceAfterTx = web3.utils.toBN(await collateralToken.balanceOf(activePool.address))
    const alice_Balance_AfterTx = web3.utils.toBN(await collateralToken.balanceOf(alice))

    const alice_BalanceChange = alice_Balance_AfterTx.sub(alice_Balance_BeforeTx)
    const pool_BalanceChange = activePool_BalanceAfterTx.sub(activePool_BalanceBeforeTx)
    assert.equal(alice_BalanceChange, dec(1, 'ether'))
    assert.equal(pool_BalanceChange, _minus_1_Ether)
  })
})

contract('DefaultPool', async accounts => {
 
  let defaultPool, mockTroveManager, mockActivePool

  const [owner, alice] = accounts;
  beforeEach(async () => {
    defaultPool = await DefaultPool.new()
    mockLiquidations = await NonPayable.new()
    mockTroveManager = await NonPayable.new()
    const dumbContractAddress = (await NonPayable.new()).address
    mockActivePool = await ActivePool.new()
    collateralToken = await CollateralToken.new("test", "test")

    await defaultPool.setAddresses(mockLiquidations.address, mockTroveManager.address, mockActivePool.address, collateralToken.address)
    await mockActivePool.setAddresses(mockLiquidations.address, dumbContractAddress, mockTroveManager.address, dumbContractAddress, defaultPool.address, dumbContractAddress, collateralToken.address)
  })

  it('getCollateral(): gets the recorded LUSD balance', async () => {
    const recordedETHBalance = await defaultPool.getCollateral()
    assert.equal(recordedETHBalance, 0)
  })

  it('getLUSDDebt(): gets the recorded LUSD balance', async () => {
    const recordedETHBalance = await defaultPool.getLUSDDebt()
    assert.equal(recordedETHBalance, 0)
  })
 
  it('increaseLUSD(): increases the recorded LUSD balance by the correct amount', async () => {
    const recordedLUSD_balanceBefore = await defaultPool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceBefore, 0)

    // await defaultPool.increaseLUSDDebt(100, { from: mockTroveManagerAddress })
    const increaseLUSDDebtData = th.getTransactionData('increaseLUSDDebt(uint256)', ['0x64'])
    const tx = await mockTroveManager.forward(defaultPool.address, increaseLUSDDebtData)
    assert.isTrue(tx.receipt.status)

    const recordedLUSD_balanceAfter = await defaultPool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceAfter, 100)
  })
  
  it('decreaseLUSD(): decreases the recorded LUSD balance by the correct amount', async () => {
    // start the pool on 100 wei
    //await defaultPool.increaseLUSDDebt(100, { from: mockTroveManagerAddress })
    const increaseLUSDDebtData = th.getTransactionData('increaseLUSDDebt(uint256)', ['0x64'])
    const tx1 = await mockTroveManager.forward(defaultPool.address, increaseLUSDDebtData)
    assert.isTrue(tx1.receipt.status)

    const recordedLUSD_balanceBefore = await defaultPool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceBefore, 100)

    // await defaultPool.decreaseLUSDDebt(100, { from: mockTroveManagerAddress })
    const decreaseLUSDDebtData = th.getTransactionData('decreaseLUSDDebt(uint256)', ['0x64'])
    const tx2 = await mockTroveManager.forward(defaultPool.address, decreaseLUSDDebtData)
    assert.isTrue(tx2.receipt.status)

    const recordedLUSD_balanceAfter = await defaultPool.getLUSDDebt()
    assert.equal(recordedLUSD_balanceAfter, 0)
  })

  // send raw ether
  it('sendCollateralToActivePool(): decreases the recorded ETH balance by the correct amount', async () => {
    // setup: give pool 2 ether
    const defaultPool_initialBalance = web3.utils.toBN(await collateralToken.balanceOf(defaultPool.address))
    assert.equal(defaultPool_initialBalance, 0)

    // start pool with 2 ether
    //await web3.eth.sendTransaction({ from: mockActivePool.address, to: defaultPool.address, value: dec(2, 'ether') })
    await collateralToken.mint(owner, dec(2, 'ether'))
    await collateralToken.approve(defaultPool.address, dec(2, 'ether'))
    const startPoolData = th.getTransactionData('addCollateral(address,uint256)', [owner, web3.utils.toHex(dec(2, 'ether'))])
    const tx1 = await mockTroveManager.forward(defaultPool.address, startPoolData, { from: owner  })
    assert.isTrue(tx1.receipt.status)

    const defaultPool_BalanceBeforeTx = web3.utils.toBN(await collateralToken.balanceOf(defaultPool.address))
    const activePool_Balance_BeforeTx = web3.utils.toBN(await collateralToken.balanceOf(mockActivePool.address))

    assert.equal(defaultPool_BalanceBeforeTx, dec(2, 'ether'))

    // send ether from pool to alice
    //await defaultPool.sendCollateralToActivePool(dec(1, 'ether'), { from: mockTroveManagerAddress })
    const sendCollateralData = th.getTransactionData('sendCollateralToActivePool(uint256)', [web3.utils.toHex(dec(1, 'ether'))])
    const tx2 = await mockTroveManager.forward(defaultPool.address, sendCollateralData, { from: owner })
    assert.isTrue(tx2.receipt.status)

    const defaultPool_BalanceAfterTx = web3.utils.toBN(await collateralToken.balanceOf(defaultPool.address))
    const activePool_Balance_AfterTx = web3.utils.toBN(await collateralToken.balanceOf(mockActivePool.address))

    const activePool_BalanceChange = activePool_Balance_AfterTx.sub(activePool_Balance_BeforeTx)
    const defaultPool_BalanceChange = defaultPool_BalanceAfterTx.sub(defaultPool_BalanceBeforeTx)
    assert.equal(activePool_BalanceChange, dec(1, 'ether'))
    assert.equal(defaultPool_BalanceChange, _minus_1_Ether)
  })
})

contract('Reset chain state', async accounts => {})
