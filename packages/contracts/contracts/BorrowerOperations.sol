// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IBorrowerOperations.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IRewards.sol";
import "./Interfaces/ILUSDToken.sol";
import "./Interfaces/ICollSurplusPool.sol";
import "./Interfaces/ISortedTroves.sol";
import "./Dependencies/LiquityBase.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/console.sol";
import "./Dependencies/IERC20.sol";

contract BorrowerOperations is LiquityBase, Ownable, CheckContract, IBorrowerOperations {
    string constant public NAME = "BorrowerOperations";

    // --- Connected contract declarations ---

    ITroveManager public troveManager;

    IRewards public rewards;

    address stabilityPoolAddress;

    address gasPoolAddress;

    ICollSurplusPool collSurplusPool;

    ILUSDToken public lusdToken;

    // A doubly linked list of Troves, sorted by their collateral ratios
    ISortedTroves public sortedTroves;
    ISortedTroves public sortedShieldedTroves;

    IERC20 public override collateralToken;
    
    /* --- Variable container structs  ---

    Used to hold, return and assign variables inside a function, in order to avoid the error:
    "CompilerError: Stack too deep". */

     struct LocalVariables_adjustTrove {
        uint price;
        uint par;
        uint accRate;
        uint accShieldRate;
        uint collChange;
        uint netDebtChange;
        bool isCollIncrease;
        uint debt;
        uint coll;
        uint oldICR;
        uint newICR;
        uint newTCR;
        uint LUSDFee;
        uint newDebt;
        uint newColl;
        uint stake;
        bool shielded;
    }

    struct LocalVariables_openTrove {
        uint price;
        uint par;
        uint accRate;
        uint accShieldRate;
        uint collChange;
        //uint LUSDFee;
        //uint netDebt;
        uint compositeDebt;
        uint ICR;
        uint NICR;
        uint stake;
        uint arrayIndex;
    }

    struct ContractsCache {
        ITroveManager troveManager;
        IRewards rewards;
        IActivePool currentActivePool;
        ILUSDToken lusdToken;
        IERC20 collateralToken;
    }

    enum BorrowerOperation {
        openTrove,
        closeTrove,
        adjustTrove
    }

    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _activePoolAddress);
    event StabilityPoolAddressChanged(address _stabilityPoolAddress);
    event DefaultPoolAddressChanged(address _defaultPoolAddress);
    event GasPoolAddressChanged(address _gasPoolAddress);
    event CollSurplusPoolAddressChanged(address _collSurplusPoolAddress);
    event PriceFeedAddressChanged(address  _newPriceFeedAddress);
    event SortedTrovesAddressChanged(address _sortedTrovesAddress);
    event SortedShieldedTrovesAddressChanged(address _sortedShieldedTrovesAddress);
    event LUSDTokenAddressChanged(address _lusdTokenAddress);
    event RelayerAddressChanged(address _relayerAddress);

    event TroveCreated(address indexed _borrower, uint arrayIndex);
    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint stake, BorrowerOperation operation);

    // --- Dependency setters ---

    function setAddresses(
        address[] memory addresses
    )
        external
        override
        onlyOwner
    {
        // This makes impossible to open a trove with zero withdrawn LUSD
        assert(MIN_NET_DEBT > 0);

        for (uint i = 0; i < addresses.length; i++) {
            checkContract(addresses[i]);
        }

        troveManager = ITroveManager(addresses[0]);
        rewards = IRewards(addresses[1]);
        activePool = IActivePool(addresses[2]);
        activeShieldedPool = IActivePool(addresses[3]);
        defaultPool = IDefaultPool(addresses[4]);
        stabilityPoolAddress = addresses[5];
        gasPoolAddress = addresses[6];
        collSurplusPool = ICollSurplusPool(addresses[7]);
        priceFeed = IPriceFeed(addresses[8]);
        sortedTroves = ISortedTroves(addresses[9]);
        sortedShieldedTroves = ISortedTroves(addresses[10]);
        lusdToken = ILUSDToken(addresses[11]);
        relayer = IRelayer(addresses[12]);
        collateralToken = IERC20(addresses[13]);

        emit TroveManagerAddressChanged(addresses[0]);
        emit RewardsAddressChanged(addresses[1]);
        emit ActivePoolAddressChanged(addresses[2]);
        emit ActiveShieldedPoolAddressChanged(addresses[3]);
        emit DefaultPoolAddressChanged(addresses[4]);
        emit StabilityPoolAddressChanged(addresses[5]);
        emit GasPoolAddressChanged(addresses[6]);
        emit CollSurplusPoolAddressChanged(addresses[7]);
        emit PriceFeedAddressChanged(addresses[8]);
        emit SortedTrovesAddressChanged(addresses[9]);
        emit SortedShieldedTrovesAddressChanged(addresses[10]);
        emit LUSDTokenAddressChanged(addresses[11]);
        emit RelayerAddressChanged(addresses[12]);
        emit CollateralTokenAddressChanged(addresses[13]);

        _renounceOwnership();
    }

    function openTrove(uint256 _collateralAmount, uint _LUSDAmount, address _upperHint, address _lowerHint, bool _redemptionShield) external override {

        ContractsCache memory contractsCache = ContractsCache(troveManager, rewards, activePool, lusdToken, collateralToken);
        LocalVariables_openTrove memory vars;

        if (_redemptionShield) {
            contractsCache.currentActivePool = activeShieldedPool;
        }

        _requireSufficientCollateralBalance(collateralToken, msg.sender, _collateralAmount);

        troveManager.drip();
        vars.par = relayer.getPar();
        vars.accRate = troveManager.accumulatedRate();
        vars.accShieldRate = troveManager.accumulatedShieldRate();
        vars.price = priceFeed.fetchPrice();

        _requireTroveisNotActive(contractsCache.troveManager, msg.sender);
        _requireAtLeastMinNetDebt(_LUSDAmount);

        vars.compositeDebt = _getCompositeDebt(_LUSDAmount);
        //assert(vars.compositeDebt > 0);
        
        vars.ICR = LiquityMath._computeCR(_collateralAmount, vars.compositeDebt, vars.price, vars.par);

        if (_redemptionShield) {
            _requireICRisAboveHCR(vars.ICR);
        } else {
            _requireICRisAboveMCR(vars.ICR);
        }

        uint256 nCompositeDebt = _redemptionShield ? _normalizedDebt(vars.compositeDebt, vars.accShieldRate) : _normalizedDebt(vars.compositeDebt, vars.accRate);
        vars.NICR = LiquityMath._computeNominalCR(_collateralAmount, nCompositeDebt);

        if (_getTCR(vars.price, vars.accRate, vars.accShieldRate) < CCR) {
            _requireICRisAboveCCR(vars.ICR);
        } else {
            uint newTCR = _getNewTCRFromTroveChange(_collateralAmount, true, vars.compositeDebt,
                                                    true, vars.price, vars.par, vars.accRate, vars.accShieldRate);  // bools: coll increase, debt increase
            _requireNewTCRisAboveCCR(newTCR);
        }

        // Create trove on TM
        troveManager.createTrove(msg.sender, vars.NICR, _upperHint, _lowerHint, _redemptionShield);

        emit TroveCreated(msg.sender, vars.arrayIndex);

        // Set the trove struct's properties
        contractsCache.troveManager.setTroveStatus(msg.sender, 1);
        contractsCache.troveManager.increaseTroveColl(msg.sender, _collateralAmount);
        contractsCache.troveManager.increaseTroveDebt(msg.sender, nCompositeDebt); //norm debt

        contractsCache.rewards.updateTroveRewardSnapshots(msg.sender);
        vars.stake = contractsCache.rewards.updateStakeAndTotalStakes(msg.sender);

        // record debt and add collateral in active pool
        contractsCache.currentActivePool.increaseLUSDDebt(nCompositeDebt);
        contractsCache.currentActivePool.addCollateral(msg.sender, _collateralAmount);

        // mint the LUSDAmount to the borrower
        lusdToken.mint(msg.sender, _LUSDAmount);

        // Move the LUSD gas compensation to the Gas Pool
        lusdToken.mint(gasPoolAddress, LUSD_GAS_COMPENSATION);

        emit TroveUpdated(msg.sender, vars.compositeDebt, _collateralAmount, vars.stake, BorrowerOperation.openTrove);
    }

    // Send collateral to a trove
    function addColl(uint256 _collateralToAdd, address _upperHint, address _lowerHint) external override {
        _adjustTrove(msg.sender, _collateralToAdd, 0, 0, false, false, _upperHint, _lowerHint);
    }

    // Send COLL as collateral to a trove. Called by only the Stability Pool.
    function moveCollateralGainToTrove(address _borrower, uint256 _collateralToAdd, address _upperHint, address _lowerHint) external override {
        _requireCallerIsStabilityPool();
        _adjustTrove(_borrower, _collateralToAdd, 0, 0, false, false, _upperHint, _lowerHint);
    }

    // Withdraw collateral from a trove
    function withdrawColl(uint _collWithdrawal, address _upperHint, address _lowerHint) external override {
        _adjustTrove(msg.sender, 0, _collWithdrawal, 0, false, false, _upperHint, _lowerHint);
    }

    // Withdraw LUSD tokens from a trove: mint new LUSD tokens to the owner, and increase the trove's debt accordingly
    function withdrawLUSD(uint _LUSDAmount, address _upperHint, address _lowerHint) external override {
        _adjustTrove(msg.sender, 0, 0, _LUSDAmount, true, false, _upperHint, _lowerHint);
    }

    // Repay LUSD tokens to a Trove: Burn the repaid LUSD tokens, and reduce the trove's debt accordingly
    function repayLUSD(uint _LUSDAmount, address _upperHint, address _lowerHint) external override {
        _adjustTrove(msg.sender, 0, 0, _LUSDAmount, false, false, _upperHint, _lowerHint);
    }

    // Shield Trove
    function shieldTrove(address _upperHint, address _lowerHint) external override {
        // TODO add drip() here. It will break tests
        require(!troveManager.shielded(msg.sender), "Trove is already shielded");
        _adjustTrove(msg.sender, 0, 0, 0, false, true, _upperHint, _lowerHint);
    }
    // un-Shield Trove
    function unShieldTrove(address _upperHint, address _lowerHint) external override {
        // TODO add drip() here. It will break tests
        require(troveManager.shielded(msg.sender), "Trove is already un-shielded");
        _adjustTrove(msg.sender, 0, 0, 0, false, true, _upperHint, _lowerHint);
    }

    function adjustTrove(uint256 _collateralToAdd, uint _collWithdrawal, uint _LUSDChange, bool _isDebtIncrease,
                         bool _toggleShield, address _upperHint, address _lowerHint) external override {
        _adjustTrove(msg.sender, _collateralToAdd, _collWithdrawal, _LUSDChange, _isDebtIncrease, _toggleShield, _upperHint, _lowerHint);
    }

    /*
    * _adjustTrove(): Alongside a debt change, this function can perform either a collateral top-up or a collateral withdrawal. 
    *
    * It therefore expects either a positive msg.value, or a positive _collWithdrawal argument.
    *
    * If both are positive, it will revert.
    */
    function _adjustTrove(address _borrower, uint _collateralToAdd, uint _collWithdrawal, uint _LUSDChange, bool _isDebtIncrease,
                          bool _toggleShield, address _upperHint, address _lowerHint) internal {
        ContractsCache memory contractsCache = ContractsCache(troveManager, rewards, activePool, lusdToken, collateralToken);
        LocalVariables_adjustTrove memory vars;

        // Confirm the operation is either a borrower adjusting their own trove, or a pure Collateral transfer from the Stability Pool to a trove
        assert(msg.sender == _borrower || (msg.sender == stabilityPoolAddress && _collateralToAdd > 0 && _LUSDChange == 0));

        // Pre-adjust checks
        if (_isDebtIncrease) {
            _requireNonZeroDebtChange(_LUSDChange);
        }

        _requireSingularCollChange(_collWithdrawal, _collateralToAdd);
        _requireNonZeroAdjustment(_collWithdrawal, _LUSDChange, _collateralToAdd, _toggleShield);
        _requireTroveisActive(contractsCache.troveManager, _borrower);
        _requireSufficientCollateralBalance(collateralToken, _borrower, _collateralToAdd);

        // TODO add drip() here. It will break tests

        // final shield status
        vars.shielded = troveManager.shielded(_borrower) != _toggleShield;
       
        if (vars.shielded) {
            contractsCache.currentActivePool = activeShieldedPool;
        }

        // switch shielded status in troveManager    
        if (_toggleShield) {
            if (vars.shielded) {
                contractsCache.troveManager.shieldTrove(msg.sender, _upperHint, _lowerHint);
            } else {
                contractsCache.troveManager.unShieldTrove(msg.sender, _upperHint, _lowerHint);
            }
        }

        vars.par = relayer.getPar();
        vars.accRate = troveManager.accumulatedRate();
        vars.accShieldRate = troveManager.accumulatedShieldRate();
        vars.price = priceFeed.fetchPrice();

        contractsCache.rewards.applyPendingRewards(_borrower);

        // Get the collChange based on whether or not Collateral was sent in the transaction
        (vars.collChange, vars.isCollIncrease) = _getCollChange(_collateralToAdd, _collWithdrawal);

        vars.netDebtChange = _LUSDChange;
        uint256 nNetDebtChange = vars.shielded ? _normalizedDebt(_LUSDChange, vars.accShieldRate) : _normalizedDebt(_LUSDChange, vars.accRate);

        vars.debt = contractsCache.troveManager.getTroveDebt(_borrower);
        vars.coll = contractsCache.troveManager.getTroveColl(_borrower);

        uint256 actualDebt = vars.shielded ? _actualDebt(vars.debt, vars.accShieldRate) : _actualDebt(vars.debt, vars.accRate);
        
        // Get the trove's old ICR before the adjustment, and what its new ICR will be after the adjustment
        vars.oldICR = LiquityMath._computeCR(vars.coll, actualDebt, vars.price, vars.par);
        vars.newICR = _getNewICRFromTroveChange(vars.coll, actualDebt, vars.collChange, vars.isCollIncrease,
                                                vars.netDebtChange, _isDebtIncrease, vars.price, vars.par);
        assert(_collWithdrawal <= vars.coll); 
        // Check the adjustment satisfies all conditions for the current system mode
        _requireValidAdjustment(_collWithdrawal, _isDebtIncrease, vars);
            
        // When the adjustment is a debt repayment, check it's a valid amount and that the caller has enough LUSD
        if (!_isDebtIncrease && _LUSDChange > 0) {
            _requireAtLeastMinNetDebt(_getNetDebt(actualDebt).sub(vars.netDebtChange));
            _requireValidLUSDRepayment(actualDebt, vars.netDebtChange);
            _requireSufficientLUSDBalance(contractsCache.lusdToken, _borrower, vars.netDebtChange);
        }

        (vars.newColl, vars.newDebt) = _updateTroveFromAdjustment(contractsCache.troveManager, _borrower, vars.collChange,
                                                                  vars.isCollIncrease, nNetDebtChange, _isDebtIncrease);

        vars.stake = contractsCache.rewards.updateStakeAndTotalStakes(_borrower);

        // Re-insert trove in to the sorted list
        uint newNICR = _getNewNominalICRFromTroveChange(vars.coll, vars.debt, vars.collChange, vars.isCollIncrease,
                                                        nNetDebtChange, _isDebtIncrease);

        if (vars.shielded) {
            sortedShieldedTroves.reInsert(_borrower, newNICR, _upperHint, _lowerHint);
        } else {
            sortedTroves.reInsert(_borrower, newNICR, _upperHint, _lowerHint);
        }

        emit TroveUpdated(_borrower, actualDebt, vars.newColl, vars.stake, BorrowerOperation.adjustTrove);

        // Use the unmodified _LUSDChange here, as we don't send the fee to the user
        _moveTokensAndCollateralfromAdjustment(
            contractsCache.currentActivePool,
            contractsCache.lusdToken,
            msg.sender,
            vars.collChange,
            vars.isCollIncrease,
            _LUSDChange,
            _isDebtIncrease,
            nNetDebtChange
        );
    }

    function closeTrove() external override {
        ITroveManager troveManagerCached = troveManager;
        IRewards rewardsCached = rewards;
        ILUSDToken lusdTokenCached = lusdToken;

        bool shielded = troveManagerCached.shielded(msg.sender);
        IActivePool activePoolCached =  shielded ? activeShieldedPool : activePool;

        _requireTroveisActive(troveManagerCached, msg.sender);

        troveManager.drip();
        uint accRate = shielded ? troveManagerCached.accumulatedShieldRate() : troveManagerCached.accumulatedRate();

        rewardsCached.applyPendingRewards(msg.sender);

        uint coll = troveManagerCached.getTroveColl(msg.sender);
        uint debt = troveManagerCached.getTroveDebt(msg.sender);
        uint actualDebt = _actualDebt(debt, accRate);

        _requireSufficientLUSDBalance(lusdTokenCached, msg.sender, actualDebt.sub(LUSD_GAS_COMPENSATION));

        rewardsCached.removeStake(msg.sender);
        troveManagerCached.closeTrove(msg.sender);

        emit TroveUpdated(msg.sender, 0, 0, 0, BorrowerOperation.closeTrove);

        // splitting the debt, normalizing them, then adding back together can round down
        // rounding down is okay to avoid decrease_lusd_debt() and burn() failures
        uint nGas = _normalizedDebt(LUSD_GAS_COMPENSATION, accRate);
        uint nDebt = _normalizedDebt(actualDebt - LUSD_GAS_COMPENSATION, accRate);


        // Burn the repaid LUSD from the user's balance and the gas compensation from the Gas Pool
        _repayLUSD(activePoolCached, lusdTokenCached, msg.sender, actualDebt.sub(LUSD_GAS_COMPENSATION), nDebt);
        _repayLUSD(activePoolCached, lusdTokenCached, gasPoolAddress, LUSD_GAS_COMPENSATION, nGas);

        // Send the collateral back to the user
        activePoolCached.sendCollateral(msg.sender, coll);
    }

    /**
     * Claim remaining collateral from a redemption or from a liquidation with ICR > MCR in Recovery Mode
     */
    function claimCollateral() external override returns (uint256 collateralClaimed) {
        // send Collateral from CollSurplus Pool to owner
        collateralClaimed = collSurplusPool.claimColl(msg.sender);
    }

    // --- Helper functions ---

    function _getUSDValue(uint _coll, uint _price) internal pure returns (uint) {
        uint usdValue = _price.mul(_coll).div(DECIMAL_PRECISION);

        return usdValue;
    }

    function _getCollChange(
        uint _collReceived,
        uint _requestedCollWithdrawal
    )
        internal
        pure
        returns(uint collChange, bool isCollIncrease)
    {
        if (_collReceived != 0) {
            collChange = _collReceived;
            isCollIncrease = true;
        } else {
            collChange = _requestedCollWithdrawal;
        }
    }

    // Update trove's coll and debt based on whether they increase or decrease
    function _updateTroveFromAdjustment
    (
        ITroveManager _troveManager,
        address _borrower,
        uint _collChange,
        bool _isCollIncrease,
        uint _debtChange, //norm
        bool _isDebtIncrease
    )
        internal
        returns (uint, uint)
    {
        uint newColl = (_isCollIncrease) ? _troveManager.increaseTroveColl(_borrower, _collChange)
                                        : _troveManager.decreaseTroveColl(_borrower, _collChange);
        uint newDebt = (_isDebtIncrease) ? _troveManager.increaseTroveDebt(_borrower, _debtChange)
                                        : _troveManager.decreaseTroveDebt(_borrower, _debtChange);

        return (newColl, newDebt);
    }

    function _moveTokensAndCollateralfromAdjustment
    (
        IActivePool _activePool,
        ILUSDToken _lusdToken,
        address _borrower,
        uint _collChange,
        bool _isCollIncrease,
        uint _LUSDChange, //actual
        bool _isDebtIncrease,
        uint _nNetDebtChange //norm
    )
        internal
    {
        if (_isDebtIncrease) {
            _withdrawLUSD(_activePool, _lusdToken, _borrower, _LUSDChange, _nNetDebtChange);
        } else {
            _repayLUSD(_activePool, _lusdToken, _borrower, _LUSDChange, _nNetDebtChange);
        }

        if (_isCollIncrease) {
            _activePool.addCollateral(msg.sender, _collChange);
        } else {
            _activePool.sendCollateral(_borrower, _collChange);
        }
    }

    // Send Collateral to Active Pool and increase its recorded balance
    function _activePoolAddColl(IActivePool _activePool, uint256 _amount) internal {
        _activePool.addCollateral(msg.sender, _amount);
    }

    // Issue the specified amount of LUSD to _account and increases the total active debt
    function _withdrawLUSD(IActivePool _activePool, ILUSDToken _lusdToken, address _account, uint _LUSDAmount, uint _nNetDebtIncrease) internal {
        _activePool.increaseLUSDDebt(_nNetDebtIncrease);
        _lusdToken.mint(_account, _LUSDAmount); // actual
    }

    // Burn the specified amount of LUSD from _account and decreases the total active debt
    function _repayLUSD(IActivePool _activePool, ILUSDToken _lusdToken, address _account, uint _LUSD, uint _nLUSD) internal {
        _activePool.decreaseLUSDDebt(_nLUSD); // norm
        _lusdToken.burn(_account, _LUSD); // actual
    }

    // --- 'Require' wrapper functions ---

    function _requireSingularCollChange(uint _collWithdrawal, uint _collToAdd) internal pure {
        require(_collWithdrawal == 0 || _collToAdd == 0, "BorrowerOperations: Cannot withdraw and add coll");
    }

    function _requireCallerIsBorrower(address _borrower) internal view {
        require(msg.sender == _borrower, "BorrowerOps: Caller must be the borrower for a withdrawal");
    }

    function _requireNonZeroAdjustment(uint _collWithdrawal, uint _LUSDChange, uint _collateralAmount, bool _toggleShield) internal pure {
        require(_collWithdrawal != 0 || _LUSDChange != 0 || _collateralAmount != 0 || _toggleShield,
                "BorrowerOps: There must be either a collateral change, debt change or shield toggle");
    }

    function _requireTroveisActive(ITroveManager _troveManager, address _borrower) internal view {
        uint status = _troveManager.getTroveStatus(_borrower);
        require(status == 1, "BorrowerOps: Trove does not exist or is closed");
    }

    function _requireTroveisNotActive(ITroveManager _troveManager, address _borrower) internal view {
        uint status = _troveManager.getTroveStatus(_borrower);
        require(status != 1, "BorrowerOps: Trove is active");
    }

    function _requireNonZeroDebtChange(uint _LUSDChange) internal pure {
        require(_LUSDChange > 0, "BorrowerOps: Debt increase requires non-zero debtChange");
    }

    function _requireNoCollWithdrawal(uint _collWithdrawal) internal pure {
        require(_collWithdrawal == 0, "BorrowerOps: Collateral withdrawal not permitted when TCR < CCR");
    }
   
    function _requireValidAdjustment
    (
        uint _collWithdrawal,
        bool _isDebtIncrease, 
        LocalVariables_adjustTrove memory _vars
    ) 
        internal 
        view 
    {
        /* 
        *If TCR < CCR, only allow:
        *
        * - Pure collateral top-up
        * - Pure debt repayment
        * - Collateral top-up with debt repayment
        * - A debt increase combined with a collateral top-up which makes the ICR >= 150% and improves the ICR (and by extension improves the TCR).
        *
        *If TCR >= CCR, ensure:
        *
        * - The new ICR is above MCR
        * - The adjustment won't pull the TCR below CCR
        */        

        // TODO re-visit this entire logic

        // shielded troves can improve their ICR when ICR < MCR
        if (_vars.shielded && !(_vars.newICR > _vars.oldICR)) {
            _requireICRisAboveHCR(_vars.newICR);
        }

        if (_getTCR(_vars.price, _vars.accRate, _vars.accShieldRate) < CCR) {
            _requireNoCollWithdrawal(_collWithdrawal);
            if (_isDebtIncrease) {
                // TODO add this? ->>>>  _requireNewTCRisAboveCCR(_vars.newTCR)
                _requireICRisAboveCCR(_vars.newICR);
                _requireNewICRisAboveOldICR(_vars.newICR, _vars.oldICR);
            }      
        } else { // if Normal Mode
            _requireICRisAboveMCR(_vars.newICR);
            _vars.newTCR = _getNewTCRFromTroveChange(_vars.collChange, _vars.isCollIncrease,
                                                     _vars.netDebtChange, _isDebtIncrease, _vars.price,
                                                    _vars.par, _vars.accRate, _vars.accShieldRate);
            _requireNewTCRisAboveCCR(_vars.newTCR);
        }
    }

    function _requireICRisAboveHCR(uint _newICR) internal pure {
        require(_newICR >= HCR, "BorrowerOps: Opening a shielded trove with ICR < HCR is not permitted");
    }

    function _requireICRisAboveMCR(uint _newICR) internal pure {
        require(_newICR >= MCR, "BorrowerOps: An operation that would result in ICR < MCR is not permitted");
    }

    function _requireICRisAboveCCR(uint _newICR) internal pure {
        require(_newICR >= CCR, "BorrowerOps: Operation must leave trove with ICR >= CCR");
    }

    function _requireNewICRisAboveOldICR(uint _newICR, uint _oldICR) internal pure {
        require(_newICR >= _oldICR, "BorrowerOps: Cannot decrease your Trove's ICR in Recovery Mode");
    }

    function _requireNewTCRisAboveCCR(uint _newTCR) internal pure {
        require(_newTCR >= CCR, "BorrowerOps: An operation that would result in TCR < CCR is not permitted");
    }

    function _requireAtLeastMinNetDebt(uint _netDebt) internal pure {
        require (_netDebt >= MIN_NET_DEBT, "BorrowerOps: Trove's net debt must be greater than minimum");
    }

    function _requireValidLUSDRepayment(uint _currentDebt, uint _debtRepayment) internal pure {
        require(_debtRepayment <= _currentDebt.sub(LUSD_GAS_COMPENSATION), "BorrowerOps: Amount repaid must not be larger than the Trove's debt");
    }

    function _requireCallerIsStabilityPool() internal view {
        require(msg.sender == stabilityPoolAddress, "BorrowerOps: Caller is not Stability Pool");
    }

     function _requireSufficientLUSDBalance(ILUSDToken _lusdToken, address _borrower, uint _debtRepayment) internal view {
        require(_lusdToken.balanceOf(_borrower) >= _debtRepayment, "BorrowerOps: Caller doesnt have enough LUSD to make repayment");
    }

    function _requireSufficientCollateralBalance(IERC20 _collateralToken, address _borrower, uint256 _collateralAmount) internal view {
        require(_collateralToken.balanceOf(_borrower) >= _collateralAmount, "Insufficient collateral balance");
    }

    // --- ICR and TCR getters ---

    // Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
    function _getNewNominalICRFromTroveChange
    (
        uint _coll,
        uint _debt,
        uint _collChange,
        bool _isCollIncrease,
        uint _debtChange,
        bool _isDebtIncrease
    )
        pure
        internal
        returns (uint)
    {
        (uint newColl, uint newDebt) = _getNewTroveAmounts(_coll, _debt, _collChange, _isCollIncrease, _debtChange, _isDebtIncrease);

        uint newNICR = LiquityMath._computeNominalCR(newColl, newDebt);
        return newNICR;
    }

    // Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
    function _getNewICRFromTroveChange
    (
        uint _coll,
        uint _debt,
        uint _collChange,
        bool _isCollIncrease,
        uint _debtChange,
        bool _isDebtIncrease,
        uint _price,
        uint _par
    )
        pure
        internal
        returns (uint)
    {
        (uint newColl, uint newDebt) = _getNewTroveAmounts(_coll, _debt, _collChange, _isCollIncrease, _debtChange, _isDebtIncrease);

        uint newICR = LiquityMath._computeCR(newColl, newDebt,  _price, _par);
        return newICR;
    }

    function _getNewTroveAmounts(
        uint _coll,
        uint _debt,
        uint _collChange,
        bool _isCollIncrease,
        uint _debtChange,
        bool _isDebtIncrease
    )
        internal
        pure
        returns (uint, uint)
    {
        uint newColl = _coll;
        uint newDebt = _debt;

        newColl = _isCollIncrease ? _coll.add(_collChange) :  _coll.sub(_collChange);
        newDebt = _isDebtIncrease ? _debt.add(_debtChange) : _debt.sub(_debtChange);

        return (newColl, newDebt);
    }

    function _getNewTCRFromTroveChange
    (
        uint _collChange,
        bool _isCollIncrease,
        uint _debtChange,
        bool _isDebtIncrease,
        uint _price,
        uint _par,
        uint _accRate,
        uint _accShieldRate
    )
        internal
        view
        returns (uint)
    {
        uint totalColl = getEntireSystemColl();
        uint totalDebt = getEntireSystemDebt(_accRate, _accShieldRate);

        totalColl = _isCollIncrease ? totalColl.add(_collChange) : totalColl.sub(_collChange);
        totalDebt = _isDebtIncrease ? totalDebt.add(_debtChange) : totalDebt.sub(_debtChange);

        uint newTCR = LiquityMath._computeCR(totalColl, totalDebt, _price, _par);
        return newTCR;
    }

    function getCompositeDebt(uint _debt) external pure override returns (uint) {
        return _getCompositeDebt(_debt);
    }
}
