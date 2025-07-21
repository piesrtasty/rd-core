// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../RateControl.sol";

contract RateControlTester is RateControl {
    function setCoBias(int _bias) external {
        CO_BIAS = _bias;
        lastOutput = _bias;
    }

}
