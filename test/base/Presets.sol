// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Terms} from "../../src/types/CovenantTypes.sol";

/// @notice The three presets from the spec (docs/SPEC.md section 17).
library Presets {
    function conservative() internal pure returns (Terms memory) {
        return Terms({
            supportBps: 5000,
            supportBandTicks: 2000,
            paceBps: 3000,
            epochLength: 1 days,
            guardTicks: 300,
            twapWindow: 30 minutes,
            lockDuration: 180 days,
            vestDuration: 90 days,
            curatorTimelock: 3 days,
            bounty: 0.01 ether,
            curatorFeeBps: 1000
        });
    }

    function standard() internal pure returns (Terms memory) {
        return Terms({
            supportBps: 4000,
            supportBandTicks: 1500,
            paceBps: 5000,
            epochLength: 1 days,
            guardTicks: 300,
            twapWindow: 30 minutes,
            lockDuration: 90 days,
            vestDuration: 30 days,
            curatorTimelock: 2 days,
            bounty: 0.01 ether,
            curatorFeeBps: 1000
        });
    }

    function aggressive() internal pure returns (Terms memory) {
        return Terms({
            supportBps: 3000,
            supportBandTicks: 1000,
            paceBps: 7000,
            epochLength: 12 hours,
            guardTicks: 500,
            twapWindow: 15 minutes,
            lockDuration: 60 days,
            vestDuration: 30 days,
            curatorTimelock: 1 days,
            bounty: 0.01 ether,
            curatorFeeBps: 1000
        });
    }
}
