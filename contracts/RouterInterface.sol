// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IRouter {
    function addLiquidityETH(
            address token,
                    uint256 amountTokenDesired,
                            uint256 amountTokenMin,
                                    uint256 amountETHMin,
                                            address to,
                                                    uint256 deadline
                                                        ) external payable returns (uint256, uint256, uint256);
                                                        }