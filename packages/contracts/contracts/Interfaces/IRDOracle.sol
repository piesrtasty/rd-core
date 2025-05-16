pragma solidity ^0.8.24;

/**
 * @title  IRDOracle
 * @notice Interface for the RDOracle hook contract
 */
interface IRDOracle {
    // --- Events ---

    // --- Errors ---

    /**
     * @notice Error thrown when trying to register a hook that is already registered.
     */
    error Oracle_AlreadyRegistered();

    /**
     * @notice Error thrown when the pool was not created by the allowed factory.
     * @param pool The address of the pool.
     */
    error Oracle_PoolNotFromFactory(address pool);

    /**
     * @notice Error thrown when trying to divide by zero
     */
    error Oracle_DivisionByZero();

    /**
     * @notice Error thrown when trying to calculate the median of an empty array
     */
    error Oracle_MedianCalculationError();

    // --- Registry ---

    /**
     * @notice Getter for the balancer v3 pool address
     * @return _pool The pool address
     */
    function pool() external view returns (address _pool);

    /**
     * @notice Getter for the balancer v3 vault address
     * @return _vault The vault address
     */
    function vault() external view returns (address _vault);

    /**
     * @notice Getter for the RD token address
     * @return _rdToken The RD token address
     */
    function rdToken() external view returns (address _rdToken);

    // /**
    //  * @notice Getter for the stablecoin basket
    //  * @return _stablecoinBasket The stablecoin basket
    //  */
    // function stablecoinBasket() external view returns (address[] memory _stablecoinBasket);

    // --- Data ---

    /**
     * @notice Getter for the RD token index
     * @return _rdTokenIndex The RD token index
     */
    function rdTokenIndex() external view returns (uint8 _rdTokenIndex);

    //     /**
    //      * @notice Getter for the stablecoin basket indices
    //      * @return _stablecoinBasketIndices The stablecoin basket indices
    //      */
    //     function stablecoinBasketIndices()
    //         external
    //         view
    //         returns (uint8[] memory _stablecoinBasketIndices);
}
