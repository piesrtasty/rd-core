// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAggregator {
    function drip() external;
    function getOracleDripReward() external view returns (uint256);
    function shouldOracleDrip() external view returns (bool, uint256);
}
