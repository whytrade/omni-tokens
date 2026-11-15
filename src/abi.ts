import { parseAbi } from "viem";

export const escrowAbi = parseAbi([
  "function sink() view returns (address)",
  "function closeTimeout() view returns (uint256)",
  "function operator() view returns (address)",
  "function accepted(address token) view returns (bool)",
  "function tabs(bytes32 tabId) view returns (address owner, address token, uint64 closeRequestedAt, bool finalized, uint256 locked, uint256 charged)",
  "function tabIdFor(address owner, bytes32 salt) pure returns (bytes32)",
  "function open(address token, bytes32 salt, uint256 amount) returns (bytes32 tabId)",
  "function charge(bytes32[] tabIds, uint256[] cumulativeCharged)",
  "function requestClose(bytes32 tabId)",
  "function finalize(bytes32 tabId, uint256 finalCumulativeCharged)",
  "function forceRelease(bytes32 tabId)",
  "function setAccepted(address token, bool isAccepted)",
  "function pendingOperator() view returns (address)",
  "function pendingOperatorReadyAt() view returns (uint256)",
  "function proposeOperator(address nextOperator)",
  "function acceptOperator()",
  "function revokeOperator()",
  "event TabOpened(bytes32 indexed tabId, address indexed owner, address indexed token, uint256 amount)",
  "event TabCharged(bytes32 indexed tabId, uint256 amount, uint256 cumulativeCharged)",
  "event TabCloseRequested(bytes32 indexed tabId, address indexed owner)",
  "event TabFinalized(bytes32 indexed tabId, address indexed owner, uint256 charged, uint256 refunded, bool forced)",
]);

export const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export const v3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);
