// Minimal ABI encoding for the ERC4626 views the curator reads. Selectors were
// computed with `cast sig`; no keccak dependency at runtime.
export const SEL = {
  totalAssets: "0x01e1d114",
  totalSupply: "0x18160ddd",
  asset: "0x38d52e0f",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  convertToAssets: "0x07a2d13a",
  maxWithdraw: "0xce96cb77",
  maxDeposit: "0x402d267d",
  fee: "0xddca3f43",
} as const;

export function pad32(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, "0");
}

export function encodeUint(n: bigint): string {
  return pad32(n.toString(16));
}

export function encodeAddress(addr: string): string {
  return pad32(addr.toLowerCase().replace(/^0x/, ""));
}

export function decodeUint(hex: string): bigint {
  const h = hex.replace(/^0x/, "");
  if (h.length === 0) return 0n;
  return BigInt("0x" + h.slice(0, 64));
}

export function decodeAddress(hex: string): string {
  const h = hex.replace(/^0x/, "");
  return "0x" + h.slice(24, 64);
}

/** ABI-decodes a single `string` return value. */
export function decodeString(hex: string): string {
  const h = hex.replace(/^0x/, "");
  if (h.length < 128) return "";
  const offset = Number(BigInt("0x" + h.slice(0, 64))) * 2;
  const len = Number(BigInt("0x" + h.slice(offset, offset + 64)));
  const bytes = h.slice(offset + 64, offset + 64 + len * 2);
  return Buffer.from(bytes, "hex").toString("utf8");
}
