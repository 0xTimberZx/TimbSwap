REMIX DEFAULT WORKSPACE

Remix default workspace is present when:
i. Remix loads for the very first time 
ii. A new workspace is created with 'Default' template
iii. There are no files existing in the File Explorer

This workspace contains 3 directories:

1. 'contracts': Holds three contracts with increasing levels of complexity.
2. 'scripts': Contains four typescript files to deploy a contract. It is explained below.
3. 'tests': Contains one Solidity test file for 'Ballot' contract & one JS test file for 'Storage' contract.

SCRIPTS

The 'scripts' folder has two typescript files which help to deploy the 'Storage' contract using 'ethers.js' libraries.

For the deployment of any other contract, just update the contract name from 'Storage' to the desired contract and provide constructor arguments accordingly 
in the file `deploy_with_ethers.ts`

In the 'tests' folder there is a script containing Mocha-Chai unit tests for 'Storage' contract.

To run a script, right click on file name in the file explorer and click 'Run'. Remember, Solidity file must already be compiled.
Output from script will appear in remix terminal.

Please note, require/import is supported in a limited manner for Remix supported modules.
For now, modules supported by Remix are ethers, swarmgw, chai, multihashes, remix and hardhat only for hardhat.ethers object/plugin.
For unsupported modules, an error like this will be thrown: '<module_name> module require is not supported by Remix IDE' will be shown.



PrizeEscrow:          0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D

TIMBSToken:           0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa

TimbSwapFactory:      0xCCd6d3f0A86042d2B7056eDd381d367126628AF5

TimbSwapRouter:       0xf69ca9Ac2E39aD5f86A8410b10D290A49984e6AB

EligibleTokenRegistry: 0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04

GameRegistry:         0xf6fC4c726071Bd2Ce32826324E52dfC5A24FCb97

TimbPrize:            0x257F3658e29a7026CeebdcB352509d82A0993e4b

TimbStaking:          0xe776c7b700B190ED8248741F9b518B08d8733C8F

TimbFarm:             0xE319E2206F71A5cD8dd2c411C6F29712935f9011

TimbLockVault:        0x0157086E7670D1eFb15DC6b5158eE78279927a41

TimbTreasury:         0x486Fa4D8351EF81136E83340eA1e3aa2272c9955

TimbGovernance:       0x1f4C522E55FfE336eD474e6deAAc3a4bBe3Fd117

TIMBS/ETH Pair:       0x7c5eC3f666F8c0d52BFf85217EEB9aA496838Ef1
0xefFea3C2D1aA32eE9D93Cc0E888647E6A168293f(deprecated) .....game has started 

 I have sent eth. Notified farm with 50000000000000000000 and staking 25000000000000000000 with a second parameter of 2592000. 
