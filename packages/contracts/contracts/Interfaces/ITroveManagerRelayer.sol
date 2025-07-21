// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./ITroveManager.sol";
import "./IRelayer.sol";


// Trove Manager extended with relayer()
interface ITroveManagerRelayer is ITroveManager {
    function relayer() external view returns (IRelayer);
}
