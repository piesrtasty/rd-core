// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import './Interfaces/IActivePool.sol';
import "./Dependencies/SafeMath.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/console.sol";
import "./Dependencies/IERC20.sol";
import "./Interfaces/IPool.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IBorrowerOperations.sol";
/*
 * The Active Pool holds the ETH collateral and LUSD debt (but not LUSD tokens) for all active troves.
 *
 * When a trove is liquidated, it's ETH and LUSD debt are transferred from the Active Pool, to either the
 * Stability Pool, the Default Pool, or both, depending on the liquidation conditions.
 *
 */
contract ActivePool is Ownable, CheckContract, IActivePool {
    using SafeMath for uint256;

    string constant public NAME = "ActivePool";
    IERC20 public override collateralToken;
    address public liquidationsAddress;
    address public borrowerOperationsAddress;
    address public troveManagerAddress;
    address public stabilityPoolAddress;
    address public defaultPoolAddress;
    address public collSurplusPoolAddress;
    uint256 internal CT;  // deposited Collateral Token tracker
    uint256 internal LUSDDebt;
    // --- Events ---

    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolLUSDDebtUpdated(uint _LUSDDebt);
    event ActivePoolCollateralBalanceUpdated(uint _COLLATERAL);
    event CollateralSent(address _account, uint _amount);

    // --- Contract setters ---

    function setAddresses(
        address _liquidationsAddress,
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _stabilityPoolAddress,
        address _defaultPoolAddress,
        address _collSurplusPoolAddress,
        address _collateralTokenAddress
    )
        external
        onlyOwner
    {
        checkContract(_liquidationsAddress);
        checkContract(_borrowerOperationsAddress);
        checkContract(_troveManagerAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_defaultPoolAddress);
        checkContract(_collateralTokenAddress);
        checkContract(_collSurplusPoolAddress);

        liquidationsAddress = _liquidationsAddress;
        borrowerOperationsAddress = _borrowerOperationsAddress;
        troveManagerAddress = _troveManagerAddress;
        stabilityPoolAddress = _stabilityPoolAddress;
        defaultPoolAddress = _defaultPoolAddress;
        collateralToken = IERC20(_collateralTokenAddress);
        collSurplusPoolAddress = _collSurplusPoolAddress;

        emit LiquidationsAddressChanged(_liquidationsAddress);
        emit BorrowerOperationsAddressChanged(_borrowerOperationsAddress);
        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit StabilityPoolAddressChanged(_stabilityPoolAddress);
        emit DefaultPoolAddressChanged(_defaultPoolAddress);

        _renounceOwnership();
    }

    // --- Getters for public variables. Required by IPool interface ---

    /*
    * Returns the ETH state variable.
    *
    *Not necessarily equal to the the contract's raw ETH balance - ether can be forcibly sent to contracts.
    */
    function getCollateral() external view override returns (uint) {
        return CT;
    }

    function getLUSDDebt() external view override returns (uint) {
        return LUSDDebt;
    }

    // --- Pool functionality ---

    function sendCollateral(address _account, uint _amount) external override {
        _requireCallerIsBOorTroveMorSP();
        CT = CT.sub(_amount);
        emit ActivePoolCollateralBalanceUpdated(CT);
        emit CollateralSent(_account, _amount);
        
        // transfer collateral to account
        require(
            collateralToken.transfer(_account, _amount),
            "ActivePool: Collateral transfer failed"
        );
        
        // process collateral increase if address is a pool
        if (_isPool(_account)) {
            IPool(_account).processCollateralIncrease(_amount);
        } 
    }

    function processCollateralIncrease(uint _amount) external override {
        _requireCallerIsBOorTroveMorSPorDefaultPool();
        CT = CT.add(_amount);
        emit ActivePoolCollateralBalanceUpdated(CT);
    }

    function addCollateral(address _account, uint _amount) external override {
        _requireCallerIsBOorTroveMorSPorDefaultPool();
        CT = CT.add(_amount);

        require(
            collateralToken.transferFrom(_account, address(this), _amount),
            "ActivePool: Collateral transfer failed"
        );
        emit ActivePoolCollateralBalanceUpdated(CT);
    }

    function increaseLUSDDebt(uint _amount) external override {
        _requireCallerIsBOorTroveM();
        LUSDDebt  = LUSDDebt.add(_amount);
        emit ActivePoolLUSDDebtUpdated(LUSDDebt);
    }

    function decreaseLUSDDebt(uint _amount) external override {
        _requireCallerIsBOorTroveMorSP();
        LUSDDebt = LUSDDebt.sub(_amount);
        emit ActivePoolLUSDDebtUpdated(LUSDDebt);
    }

    function _isPool(address _pool) internal view returns (bool) {
        return _pool == stabilityPoolAddress || _pool == defaultPoolAddress || _pool == collSurplusPoolAddress;
    }

    // --- 'require' functions ---

    function _requireCallerIsBorrowerOperationsOrDefaultPool() internal view {
        require(
            msg.sender == borrowerOperationsAddress ||
            msg.sender == defaultPoolAddress,
            "ActivePool: Caller is neither BO nor Default Pool");
    }

    function _requireCallerIsBOorTroveMorSP() internal view {
        require(
            msg.sender == borrowerOperationsAddress ||
            msg.sender == liquidationsAddress ||
            msg.sender == troveManagerAddress ||
            msg.sender == stabilityPoolAddress,
            "ActivePool: Caller is neither BorrowerOperations nor TroveManager nor StabilityPool");
    }

    function _requireCallerIsBOorTroveMorSPorDefaultPool() internal view {
        require(
            msg.sender == borrowerOperationsAddress ||
            msg.sender == troveManagerAddress ||
            msg.sender == stabilityPoolAddress ||
            msg.sender == defaultPoolAddress,
            "ActivePool: Caller is neither BorrowerOperations nor TroveManager nor StabilityPool nor Default Pool");
    }

    function _requireCallerIsBOorTroveM() internal view {
        require(
            msg.sender == borrowerOperationsAddress ||
            msg.sender == liquidationsAddress ||
            msg.sender == troveManagerAddress,
            "ActivePool: Caller is neither BorrowerOperations nor TroveManager");
    }

    // --- Fallback function ---

    // receive() external payable {
    //     _requireCallerIsBorrowerOperationsOrDefaultPool();
    //     ETH = ETH.add(msg.value);
    //     emit ActivePoolCollateralBalanceUpdated(ETH);
    // }
}
