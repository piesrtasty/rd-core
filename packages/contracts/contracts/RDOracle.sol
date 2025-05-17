// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Arrays} from "./Vendor/@balancer-labs/dependencies/@openzeppelin/contracts/utils/Arrays.sol";

import {BaseHooks} from "./Vendor/@balancer-labs/v3-vault/contracts/BaseHooks.sol";

import {IHooks} from "./Vendor/@balancer-labs/v3-interfaces/contracts/vault/IHooks.sol";
import {IVault} from "./Vendor/@balancer-labs/v3-interfaces/contracts/vault/IVault.sol";

import {VaultGuard} from "./Vendor/@balancer-labs/v3-vault/contracts/VaultGuard.sol";
import {HookFlags, TokenConfig, LiquidityManagement, AfterSwapParams} from "./Vendor/@balancer-labs/v3-interfaces/contracts/vault/VaultTypes.sol";

import {BasePoolFactory} from "./Vendor/@balancer-labs/v3-pool-utils/contracts/BasePoolFactory.sol";
import {StablePool, Rounding} from "./Vendor/@balancer-labs/v3-pool-stable/contracts/StablePool.sol";

import {FixedPoint} from "./Vendor/@balancer-labs/v3-solidity-utils/contracts/math/FixedPoint.sol";
import {IRDOracle} from "./Interfaces/IRDOracle.sol";

// Note: If > 50% of tokens in pool are yield bearing must use rate provider for token
//  https://docs.balancer.fi/partner-onboarding/onboarding-overview/rate-providers.html

contract RDOracle {
    constructor() {
        // TODO: Implement RDOracle constructor
    }
}
