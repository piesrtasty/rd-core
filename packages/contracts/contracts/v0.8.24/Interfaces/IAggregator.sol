// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAggregator {
    function drip() external;
    function aggDrip(uint256 _interestRate) external;
    function dripIsStale() external view returns (bool);
    function getOracleDripReward() external view returns (uint256);
    function shouldOracleDrip() external returns (bool, uint256);
}
