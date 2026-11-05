import { getAddress, parseAbi } from "viem";

// Pharos Pacific Mainnet. Every address below was read and checked on chain (asset(), symbol(), adapters, POOL()):
// - USDC: official token registry (docs.pharos.xyz/getting-started/token-registry).
// - Morpho: Morpho Blue core + two Morpho Vault V2 (ERC-4626) USDC vaults, found among the largest USDC holders.
// - Avalon: an Aave V3 market; its aToken aPharosUSDC reports POOL() = the pool below.

export const CHAIN_ID = 1672;
export const PACIFIC_RPC = "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";

export const USDC = { symbol: "USDC", address: getAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815"), decimals: 6 };
// FiatToken storage layout (checked: balance slot 9 matches balanceOf for a real holder). Used only for eth_call
// state overrides, so a deposit can be simulated for a wallet that has not approved yet. Nothing is ever written.
export const USDC_SLOTS = { balances: 9n, allowed: 10n };

export const MORPHO_BLUE = getAddress("0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb");

export const VENUES = [
  { id: "rockawayx", protocol: "Morpho", kind: "morpho-vault-v2", name: "RockawayX USDC", symbol: "roxUSDC", address: getAddress("0x047cD0a91E9B92ED979189a6C8A120bf280f02E5") },
  { id: "sharpbyte", protocol: "Morpho", kind: "morpho-vault-v2", name: "SharpByte USDC Pharos Ecosystem", symbol: "sbUSDC-ph-eco", address: getAddress("0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1") },
  { id: "avalon", protocol: "Avalon", kind: "aave-v3", name: "Avalon USDC", symbol: "aPharosUSDC", address: getAddress("0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa"), aToken: getAddress("0xE2ec2F3933aD2f83DE9a9dDa844558354384e87D") },
];

export const ABI = {
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)",
  ]),
  vaultV2: parseAbi([
    "function asset() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function convertToAssets(uint256 shares) view returns (uint256)",
    "function previewRedeem(uint256 shares) view returns (uint256)",
    "function performanceFee() view returns (uint96)",
    "function managementFee() view returns (uint96)",
    "function maxRate() view returns (uint64)",
    "function liquidityAdapter() view returns (address)",
    "function liquidityData() view returns (bytes)",
    "function adaptersLength() view returns (uint256)",
    "function adapters(uint256) view returns (address)",
    "function curator() view returns (address)",
    "function receiveSharesGate() view returns (address)",
    "function sendSharesGate() view returns (address)",
    "function receiveAssetsGate() view returns (address)",
    "function sendAssetsGate() view returns (address)",
    "function deposit(uint256 assets, address onBehalf) returns (uint256 shares)",
    "function withdraw(uint256 assets, address receiver, address onBehalf) returns (uint256 shares)",
    "function redeem(uint256 shares, address receiver, address onBehalf) returns (uint256 assets)",
  ]),
  marketAdapter: parseAbi([
    "function marketIdsLength() view returns (uint256)",
    "function marketIds(uint256) view returns (bytes32)",
    "function realAssets() view returns (uint256)",
  ]),
  morpho: parseAbi([
    "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
    "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
    "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  ]),
  irm: parseAbi([
    "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
  ]),
  aavePool: parseAbi([
    "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
    "function getReserveNormalizedIncome(address asset) view returns (uint256)",
    "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
    "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  ]),
  aaveStrategy: parseAbi([
    "function calculateInterestRates((uint256 unbacked, uint256 liquidityAdded, uint256 liquidityTaken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 averageStableBorrowRate, uint256 reserveFactor, address reserve, address aToken) params) view returns (uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate)",
  ]),
};

export const explorerAddress = (address) => `${EXPLORER}/address/${address}`;
