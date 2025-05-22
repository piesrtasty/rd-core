// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FixedPoint} from "./Vendor/@balancer-labs/v3-solidity-utils/contracts/math/FixedPoint.sol";
import {Arrays} from "./Vendor/@balancer-labs/dependencies/@openzeppelin/contracts/utils/Arrays.sol";
import {Math} from "./Vendor/@balancer-labs/dependencies/@openzeppelin/contracts/utils/math/Math.sol";

import {BaseHooks} from "./Vendor/@balancer-labs/v3-vault/contracts/BaseHooks.sol";

import {IHooks} from "./Vendor/@balancer-labs/v3-interfaces/contracts/vault/IHooks.sol";
import {IVault} from "./Vendor/@balancer-labs/v3-interfaces/contracts/vault/IVault.sol";

import {VaultGuard} from "./Vendor/@balancer-labs/v3-vault/contracts/VaultGuard.sol";
import {HookFlags, TokenConfig, LiquidityManagement, AfterSwapParams} from "./Vendor/@balancer-labs/v3-interfaces/contracts/vault/VaultTypes.sol";

import {BasePoolFactory} from "./Vendor/@balancer-labs/v3-pool-utils/contracts/BasePoolFactory.sol";
import {StablePool, Rounding} from "./Vendor/@balancer-labs/v3-pool-stable/contracts/StablePool.sol";

import {Oracle} from "./Vendor/@uniswap/v3-core/contracts/libraries/Oracle.sol";
import {TickMath} from "./Vendor/@uniswap/v3-core/contracts/libraries/TickMath.sol";

import {IRDOracle} from "./Interfaces/IRDOracle.sol";

// Note: If > 50% of tokens in pool are yield bearing must use rate provider for token
//  https://docs.balancer.fi/partner-onboarding/onboarding-overview/rate-providers.html

contract RDOracle is IRDOracle, BaseHooks, VaultGuard {
    using FixedPoint for uint256;
    using Math for uint256;
    using Arrays for uint256[];
    using Oracle for Oracle.Observation[65535];

    /// @inheritdoc IRDOracle
    OracleState public override oracleState;

    // --- Constants ---

    /**
     * @notice The constant WAD.
     */
    uint256 internal constant _WAD = 1e18;

    /**
     * @notice Minimum age to use in TWAP
     */
    uint32 internal constant _MIN_PRICE_AGE = 60;

    // --- Registry ---

    /// @inheritdoc IRDOracle
    address public pool;

    /// @inheritdoc IRDOracle
    address public vault;

    /// @inheritdoc IRDOracle
    address public rdToken;

    address[] internal _stablecoinBasket;

    /**
     * @notice Getter for the stablecoin basket
     * @inheritdoc IRDOracle
     */
    function stablecoinBasket() external view override returns (address[] memory) {
        return _stablecoinBasket;
    }

    // --- Data ---

    /// @inheritdoc IRDOracle
    uint8 public rdTokenIndex;

    uint8[] internal _stablecoinBasketIndices;

    /**
     * @notice Getter for the stablecoin basket indices
     * @inheritdoc IRDOracle
     */
    function stablecoinBasketIndices() external view override returns (uint8[] memory) {
        return _stablecoinBasketIndices;
    }

    /// @inheritdoc IRDOracle
    Oracle.Observation[65535] public override observations;

    /// @inheritdoc IRDOracle
    uint32 public override quotePeriodSlow;
    uint32 public override quotePeriodFast;

    /// @inheritdoc IRDOracle
    string public override symbol = "RD / USD";

    /// @inheritdoc IRDOracle
    uint32 public override minObservationDelta;

    // --- Init ---

    /**
     * @param  _vault Address of the vault
     * @param  _rdToken Address of the RD token
     * @param  _quotePeriodSlow Length in seconds of the TWAP used to consult the pool
     * @param  _quotePeriodFast Length in seconds of the TWAP used to consult the pool
     * @param  _stablecoins Array of addresses of the stablecoins in the pool
     * @param  _minObservationDelta The minimum observation delta
     */
    constructor(
        address _vault,
        address _rdToken,
        uint32 _quotePeriodFast,
        uint32 _quotePeriodSlow,
        address[] memory _stablecoins,
        uint32 _minObservationDelta
    ) VaultGuard(IVault(_vault)) {
        require(_quotePeriodFast < _quotePeriodSlow, "RDOracle/period-mismatch fast period should be lt slow period");
        vault = _vault;
        rdToken = _rdToken;
        _stablecoinBasket = _stablecoins;
        quotePeriodFast = _quotePeriodFast;
        quotePeriodSlow = _quotePeriodSlow;
        minObservationDelta = _minObservationDelta;
        // Initialize oracle state with price of 1 RD/USD
        _initialize(2 ** 96);
    }

    /// @inheritdoc IHooks
    function onRegister(
        address _factory,
        address _pool,
        TokenConfig[] memory,
        LiquidityManagement calldata
    ) public override onlyVault returns (bool) {
        if (pool != address(0)) {
            revert Oracle_AlreadyRegistered();
        }
        pool = _pool;

        // Check if pool was created by the allowed factory.
        if (!BasePoolFactory(_factory).isPoolFromFactory(_pool)) {
            revert Oracle_PoolNotFromFactory(_pool);
        }
        return true;
    }

    /// @inheritdoc BaseHooks
    function getHookFlags() public pure override returns (HookFlags memory hookFlags_) {
        hookFlags_.shouldCallAfterSwap = true;
        return hookFlags_;
    }

    /// @inheritdoc BaseHooks
    function onAfterSwap(
        AfterSwapParams calldata _params
    ) public override onlyVault returns (bool _success, uint256 _hookAdjustedAmountCalculatedRaw) {
        // If time since last observation > minDelta then update price in observations
        bool _shouldUpdate = true;

        uint16 _observationIndex = oracleState.observationIndex;
        (uint32 _lastUpdateTime, , , ) = this.observations(_observationIndex);

        if (_blockTimestamp() - _lastUpdateTime < minObservationDelta) {
            _shouldUpdate = false;
        }

        if (_shouldUpdate) {
            // Get last balances of all tokens in the pool
            (, , , uint256[] memory _lastBalancesWad) = IVault(vault).getPoolTokenInfo(_params.pool);
            _updateSyntheticRDPrice(_lastBalancesWad);
        }

        return (true, 0);
    }

    // --- Methods ---

    /// @inheritdoc IRDOracle
    function getFastResultWithValidity() public view returns (uint256 _fastResult, bool _fastValidity) {
        // If the pool doesn't have enough history return false

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = quotePeriodFast;
        secondsAgos[1] = _MIN_PRICE_AGE;
        (int56[] memory tickCumulatives, ) = this.observe(secondsAgos);
        int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 arithmeticMeanTick = int24(tickCumulativesDelta / int56(int32(quotePeriodFast)));
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(arithmeticMeanTick);
        _fastResult = _convertSqrtPriceX96ToPrice(sqrtPriceX96);
        _fastValidity = true;
    }

    /// @inheritdoc IRDOracle
    function readFast() external view returns (uint256 _result) {
        (uint256 _fastResult, bool _validity) = this.getFastResultWithValidity();
        if (!_validity) {
            revert Oracle_InvalidResult();
        }
        return _fastResult;
    }

    /// @inheritdoc IRDOracle
    function getSlowResultWithValidity() public view returns (uint256 _result, bool _validity) {
        // If the pool doesn't have enough history return false

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = quotePeriodSlow;
        secondsAgos[1] = _MIN_PRICE_AGE;
        (int56[] memory tickCumulatives, ) = this.observe(secondsAgos);
        int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 arithmeticMeanTick = int24(tickCumulativesDelta / int56(int32(quotePeriodSlow)));
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(arithmeticMeanTick);
        _result = _convertSqrtPriceX96ToPrice(sqrtPriceX96);
        _validity = true;
    }

    /// @inheritdoc IRDOracle
    function readSlow() external view returns (uint256 _result) {
        (uint256 _slowResult, bool _validity) = this.getSlowResultWithValidity();
        if (!_validity) {
            revert Oracle_InvalidResult();
        }
        return _slowResult;
    }

    function getFastSlowResultWithValidity() external view returns (uint256 _fastResult, bool _fastValidity,
                                                                    uint256 _slowResult, bool _slowValidity) {
        // If the pool doesn't have enough history return false

        (_fastResult, _fastValidity) = getFastResultWithValidity(); 
        (_slowResult, _slowValidity) = getSlowResultWithValidity(); 

    }

    /// @inheritdoc IRDOracle
    function readFastSlow() external view returns (uint256 _fastValue, uint256 _slowValue) {
        (uint256 _fastResult, bool _fastValidity) = this.getFastResultWithValidity();
        (uint256 _slowResult, bool _slowValidity) = this.getSlowResultWithValidity();
        if (!_fastValidity || !_slowValidity) {
            revert Oracle_InvalidResult();
        }

        return (_fastResult, _slowResult);
    }

    /// @inheritdoc IRDOracle
    function observe(
        uint32[] calldata _secondsAgos
    )
        external
        view
        override
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        return
            observations.observe(
                _blockTimestamp(),
                _secondsAgos,
                oracleState.tick,
                oracleState.observationIndex,
                0,
                oracleState.observationCardinality
            );
    }

    /**
     * @notice Initialize the oracle
     * @param  _sqrtPriceX96 The sqrtPriceX96 value
     */
    function _initialize(uint160 _sqrtPriceX96) internal {
        if (oracleState.sqrtPriceX96 != 0) {
            revert Oracle_AlreadyInitialized();
        }

        int24 _tick = TickMath.getTickAtSqrtRatio(_sqrtPriceX96);

        (uint16 _cardinality, uint16 _cardinalityNext) = observations.initialize(_blockTimestamp());

        oracleState = OracleState({
            sqrtPriceX96: _sqrtPriceX96,
            tick: _tick,
            observationIndex: 0,
            observationCardinality: _cardinality,
            observationCardinalityNext: _cardinalityNext
        });
    }

    /**
     * @notice Get the number of seconds ago of the oldest stored observation
     * @return _secondsAgo The number of seconds ago of the oldest observation stored for the pool
     */
    function _getOldestObservationSecondsAgo() internal view returns (uint32 _secondsAgo) {
        uint16 _observationIndex = oracleState.observationIndex;
        uint16 _observationCardinality = oracleState.observationCardinality;
        (uint32 _observationTimestamp, , , bool _initialized) = this.observations(
            (_observationIndex + 1) % _observationCardinality
        );

        // The next index might not be initialized if the cardinality is in the process of increasing
        // In this case the oldest observation is always in index 0
        if (!_initialized) {
            (_observationTimestamp, , , ) = this.observations(0);
        }

        _secondsAgo = uint32(block.timestamp) - _observationTimestamp;
    }

    /**
     * @notice Update the synthetic RD price
     * @param  _lastBalancesWad The last balances of the pool
     */
    function _updateSyntheticRDPrice(uint256[] memory _lastBalancesWad) internal {
        // TODO: Implement price update
        uint256 _currentSyntheticRDPriceWad = _calculateInstantaneousSyntheticRDPrice(
            _lastBalancesWad
        );
        uint160 _sqrtPriceX96 = _convertPriceToSqrtPriceX96(_currentSyntheticRDPriceWad);
        int24 _tick = TickMath.getTickAtSqrtRatio(_sqrtPriceX96);

        // If the tick has changed, update the oracle state and write the observation
        if (_tick != oracleState.tick) {
            (uint16 observationIndex, uint16 observationCardinality) = observations.write(
                oracleState.observationIndex,
                _blockTimestamp(),
                oracleState.tick,
                0,
                oracleState.observationCardinality,
                oracleState.observationCardinalityNext
            );
            (
                oracleState.sqrtPriceX96,
                oracleState.tick,
                oracleState.observationIndex,
                oracleState.observationCardinality
            ) = (_sqrtPriceX96, _tick, observationIndex, observationCardinality);
        } else {
            // otherwise just update the sqrtPriceX96
            oracleState.sqrtPriceX96 = _sqrtPriceX96;
        }
    }

    /**
     * @notice Convert a price to a sqrtPriceX96 value
     *
     * @dev
     *
     *         sqrtPriceX96 is a Q64.96 fixed-point number representing the square root of the price
     *         sqrtPriceX96 = sqrt(price) * 2^96
     *
     * @param  _price The price to convert
     * @return _sqrtPriceX96 The sqrtPriceX96 value
     */
    function _convertPriceToSqrtPriceX96(
        uint256 _price
    ) internal pure returns (uint160 _sqrtPriceX96) {
        uint256 _sqrtPrice = Math.sqrt(_price);
        return uint160(_sqrtPrice * 2 ** 96);
    }

    /**
     * @notice Convert a sqrtPriceX96 value to a price
     * @param  _sqrtPriceX96 The sqrtPriceX96 value
     * @return _price The price
     */
    function _convertSqrtPriceX96ToPrice(
        uint160 _sqrtPriceX96
    ) internal pure returns (uint256 _price) {
        // return uint256(_sqrtPriceX96) ** 2 / 2 ** 192;
    }

    /**
     * @notice Get the instantaneous synthetic RD price
     * @param  _lastBalancesWad The last balances of the pool
     * @return _syntheticRDPriceWad The instantaneous synthetic RD price
     */
    function _calculateInstantaneousSyntheticRDPrice(
        uint256[] memory _lastBalancesWad
    ) internal view returns (uint256 _syntheticRDPriceWad) {
        StablePool _pool = StablePool(pool);
        uint256 _numBalances = _lastBalancesWad.length;
        (uint256 _ampValue, , uint256 _ampPrecision) = _pool.getAmplificationParameter();
        uint256 _poolInvariant = _pool.computeInvariant(_lastBalancesWad, Rounding.ROUND_UP);
        uint256 _ampCoefficient = (_numBalances ** _numBalances) * _ampValue;

        uint256 _balancesSum;
        for (uint256 _i = 0; _i < _numBalances; _i++) {
            _balancesSum += _lastBalancesWad[_i];
        }

        // Calculate partial derivative for RD
        uint256 _derivativeRD = _calculatePartialDerivative(
            _lastBalancesWad[rdTokenIndex],
            _ampCoefficient,
            _poolInvariant,
            _balancesSum,
            _ampPrecision
        );

        uint256[] memory _stablePricesInRD = new uint256[](_stablecoinBasket.length);

        for (uint256 _i = 0; _i < _stablecoinBasket.length; _i++) {
            uint8 _stableIndex = _stablecoinBasketIndices[_i];
            uint256 _stableBalanceWad = _lastBalancesWad[_stableIndex];

            // Calculate partial derivative for this stablecoin
            uint256 _derivativeStablecoin = _calculatePartialDerivative(
                _stableBalanceWad,
                _ampCoefficient,
                _poolInvariant,
                _balancesSum,
                _ampPrecision
            );

            if (_derivativeStablecoin == 0) {
                revert Oracle_DivisionByZero();
            }

            // Price of stablecoin _i in terms of RD = _derivativeRD / _derivativeStablecoin
            uint256 _priceStableInRD = _derivativeRD.divDown(_derivativeStablecoin);

            _stablePricesInRD[_i] = _priceStableInRD;
        }

        uint256 _medianBasketPriceInRD = _calculateMedian(_stablePricesInRD);

        if (_medianBasketPriceInRD == 0) {
            revert Oracle_DivisionByZero();
        }

        // Synthetic Price RD/USD = 1 / medianBasketPriceInRD
        // Use WAD * WAD / x for 1/x equivalent, preserves WAD scaling
        _syntheticRDPriceWad = _WAD.mulDown(_WAD).divDown(_medianBasketPriceInRD);

        return _syntheticRDPriceWad;
    }

    /**
     * @notice Returns the block timestamp truncated to 32 bits, i.e. mod 2**32.
     * @return _blockTimestamp The block timestamp
     */
    function _blockTimestamp() internal view virtual returns (uint32) {
        return uint32(block.timestamp); // truncation is desired
    }

    /**
     * @notice Calculates the median of an array of uint256 values.
     * @param _arr An array of WAD-scaled prices.
     * @return The median value. For an even number of elements, returns the lower of the two middle elements.
     */
    function _calculateMedian(uint256[] memory _arr) internal pure returns (uint256) {
        uint256 _n = _arr.length;

        if (_n == 0) {
            revert Oracle_MedianCalculationError();
        }
        if (_n == 1) {
            return _arr[0];
        }

        _arr.sort();

        return _arr[(_n - 1) / 2];
    }

    /**
     * @notice Calculate the partial derivative of the stable pool invariant for a given token
     * @dev    See Balancer v3 Stable Math Resources:
     *
     *         - https://docs.balancer.fi/concepts/explore-available-balancer-pools/stable-pool/stable-math.html#overview
     *         - https://github.com/georgeroman/balancer-v2-pools/blob/main/src/pools/stable/math.ts#L16
     *         - https://berkeley-defi.github.io/assets/material/StableSwap.pdf
     *
     * @dev
     *
     *         D = invariant (a measure of the total value in the pool)
     *         A = amplification coefficient
     *         S = sum of all token balances (x_1 + x_2 + ... + x_n)
     *         P = product of all token balances (x_1 * x_2 * ... * x_n)
     *         n = number of tokens
     *
     *         The StableSwap invariant equation is:
     *
     *         A * n^n * S + D = A * n^n * D + D^(n+1) / (n^n * P)
     *
     *         The derivative formula is:
     *
     *           df                  D^(n+1)                 1
     *         ------ = n^n * A + ------------- = n^n * A + --- * (n^n * A * S + D - n^n * A * D)
     *           dx                n^n * x * P               x
     *
     *         From the StableSwap invariant equation we isolate D^(n+1) / (n^n * P) by moving A * n^n * D to the left
     *         side of the equation, which gives us the following identity:
     *
     *         D^(n+1) / (n^n * P) = A * n^n * S + D - A * n^n * D
     *
     *         We can then rewrite the second term of the derivative formula as:
     *
     *         [ D^(n+1) / (n^n * P) ] * (1/x)
     *
     *         We then substitute the previously derived identity into the second term of the derivative formula:
     *
     *         df/dx = n^n * A + [ A * n^n * S + D - A * n^n * D ] * (1/x)
     *
     *         df/dx = n^n * A + (A * n^n * S + D - A * n^n * D) / x
     *
     *
     * @param  _tokenBalance The balance of the token
     * @param  _ampCoefficient The amplification coefficient (n^n * A)
     * @param  _poolInvariant The pool invariant (D)
     * @param  _balancesSum The sum of the balances of the pool (S)
     * @param  _ampPrecision The precision of the amplification coefficient
     * @return _partialDerivative The partial derivative for the token
     */
    function _calculatePartialDerivative(
        uint256 _tokenBalance,
        uint256 _ampCoefficient,
        uint256 _poolInvariant,
        uint256 _balancesSum,
        uint256 _ampPrecision
    ) internal pure returns (uint256 _partialDerivative) {
        if (_balancesSum == 0) {
            revert Oracle_DivisionByZero();
        }

        // The amplification parameter A is a dimensionless number that controls how
        // closely the pool's behavior mimics a constant-sum invariant (like x+y=k)
        // versus a constant-product invariant (like x*y=k)

        // _ampPrecision is a scaling factor that ensures the amplification coefficient
        // is represented in a fixed-point format (e.g. no decimals)

        // The amplification value stored in the contract is scaled by _ampPrecision
        // so we need to scale it down to WAD precision when calculating the partial
        // derivative
        //
        // True A value = A value in contract / _ampPrecision

        // Term 1 = n^n * A = _ampCoefficient
        // _ampCoefficient * (WAD / _ampPrecision) -> A is scaled to WAD precision
        uint256 term1 = FixedPoint.mulDown(_ampCoefficient, _WAD).divDown(_ampPrecision);

        // Term 2 Total = (A * n^n * S + D - A * n^n * D) / x
        // Term 2 Numerator = A * n^n * S + D - A * n^n * D
        // Term 2 Numerator Part 1 = A * n^n * S
        // Term 2 Numerator Part 2 = D
        // Term 2 Numerator Part 3 = A * n^n * D

        uint256 term2NumPart1 = FixedPoint.mulDown(_ampCoefficient, _balancesSum).divDown(
            _ampPrecision
        );
        uint256 term2NumPart2 = _poolInvariant;
        uint256 term2NumPart3 = FixedPoint.mulDown(_ampCoefficient, _poolInvariant).divDown(
            _ampPrecision
        );

        uint256 term2Numerator = term2NumPart1 + term2NumPart2 - term2NumPart3;

        // Term 2 = term2Numerator / _tokenBalance
        uint256 term2 = term2Numerator.divDown(_tokenBalance);

        return term1 + term2;
    }
}
