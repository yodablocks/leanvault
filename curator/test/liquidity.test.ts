import { describe, expect, test } from "bun:test";
import { probeLiquidity } from "../src/observe";
import { makeRpc, RevertError, type CallOptions, type Rpc } from "../src/rpc";

const VAULT = "0x00000000000000000000000000000000000000aa";
const SLOT = "0x" + "b".repeat(64);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const UNIT = 1_000_000n; // USDC
const TA = 50_000_000n * UNIT;
const SUPPLY = 48_000_000n * 10n ** 18n;

const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const arg = (data: string, i: number) => BigInt("0x" + data.slice(10 + 64 * i, 74 + 64 * i));

// A vault whose withdrawals succeed up to `liquidity` assets for a holder of
// every share, and whose maxWithdraw answers whatever the case needs.
function vault(o: {
  liquidity: bigint;
  maxWithdraw: bigint;
  keys?: string[];
  accessListFails?: boolean;
}): Rpc & { withdrawCalls: number } {
  const rpc = {
    withdrawCalls: 0,
    async call(_to: string, data: string, opts?: CallOptions) {
      const funded = opts?.override?.[VAULT]?.stateDiff?.[SLOT] === word(SUPPLY);
      const sel = data.slice(0, 10);
      if (sel === "0x70a08231") return word(funded ? SUPPLY : 0n);
      if (sel === "0xce96cb77") return word(funded ? o.maxWithdraw : 0n);
      if (sel === "0xb460af94") {
        rpc.withdrawCalls++;
        const assets = arg(data, 0);
        if (!funded || assets === 0n || assets > o.liquidity) throw new RevertError("execution reverted");
        return word(1n);
      }
      throw new Error("unexpected call " + sel);
    },
    async accessList() {
      if (o.accessListFails) throw new Error("rpc eth_createAccessList: method not found");
      return [{ address: VAULT, storageKeys: o.keys ?? [IMPL_SLOT, SLOT] }];
    },
    async latestBlock() {
      return { number: 1n, timestamp: 0 };
    },
  };
  return rpc;
}

const probe = (rpc: Rpc) => probeLiquidity(rpc, VAULT, { totalSupply: SUPPLY, totalAssets: TA, unit: UNIT, block: 1n });

describe("probeLiquidity", () => {
  test("a vault whose maxWithdraw clamps by liquidity is read in three calls, two of them withdrawals", async () => {
    const rpc = vault({ liquidity: (TA * 71n) / 100n, maxWithdraw: (TA * 71n) / 100n });
    expect(await probe(rpc)).toBeCloseTo(0.71, 9);
    expect(rpc.withdrawCalls).toBe(2);
  });

  test("a fully liquid vault is 1", async () => {
    expect(await probe(vault({ liquidity: TA * 2n, maxWithdraw: TA }))).toBe(1);
  });

  test("a vault that answers maxWithdraw with zero but pays out is searched", async () => {
    const r = await probe(vault({ liquidity: (TA * 268n) / 1000n, maxWithdraw: 0n }));
    expect(r).not.toBeNull();
    expect(Math.abs(r! - 0.268)).toBeLessThan(2e-6);
  });

  test("a vault that overstates maxWithdraw is searched", async () => {
    const r = await probe(vault({ liquidity: TA / 2n, maxWithdraw: TA }));
    expect(Math.abs(r! - 0.5)).toBeLessThan(2e-6);
  });

  test("a vault that understates maxWithdraw is searched", async () => {
    const r = await probe(vault({ liquidity: (TA * 6n) / 10n, maxWithdraw: (TA * 3n) / 10n }));
    expect(Math.abs(r! - 0.6)).toBeLessThan(2e-6);
  });

  test("zero only when maxWithdraw says zero and a whole unit cannot leave", async () => {
    expect(await probe(vault({ liquidity: 0n, maxWithdraw: 0n }))).toBe(0);
  });

  test("dust liquidity under one whole unit with maxWithdraw zero is still zero", async () => {
    expect(await probe(vault({ liquidity: UNIT / 2n, maxWithdraw: 0n }))).toBe(0);
  });

  test("maxWithdraw above zero while nothing can leave is a disagreement, reported unknown", async () => {
    expect(await probe(vault({ liquidity: 0n, maxWithdraw: TA / 3n }))).toBeNull();
  });

  test("no storage key that sets the balance is unknown", async () => {
    expect(await probe(vault({ liquidity: TA, maxWithdraw: TA, keys: [IMPL_SLOT] }))).toBeNull();
  });

  test("an endpoint without eth_createAccessList is unknown, not a failed pass", async () => {
    expect(await probe(vault({ liquidity: TA, maxWithdraw: TA, accessListFails: true }))).toBeNull();
  });
});

describe("rpc", () => {
  function fetchReturning(body: object) {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { f, count: () => calls };
  }

  test("a revert is thrown at once as a RevertError, not retried", async () => {
    const { f, count } = fetchReturning({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0xe450d38c" } });
    const rpc = makeRpc("http://x", f);
    await expect(rpc.call(VAULT, "0x")).rejects.toBeInstanceOf(RevertError);
    expect(count()).toBe(1);
  });

  test("a node that reports reverts as -32000 is treated the same", async () => {
    const { f, count } = fetchReturning({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted: ERC4626: withdraw more than max" } });
    await expect(makeRpc("http://x", f).call(VAULT, "0x")).rejects.toBeInstanceOf(RevertError);
    expect(count()).toBe(1);
  });

  test("the block, sender and override reach eth_call", async () => {
    let params: any;
    const f = (async (_u: string, init: RequestInit) => {
      params = JSON.parse(String(init.body)).params;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 });
    }) as unknown as typeof fetch;
    await makeRpc("http://x", f).call(VAULT, "0x12", { from: "0xf", block: 255n, override: { [VAULT]: { stateDiff: { [SLOT]: "0x1" } } } });
    expect(params).toEqual([{ from: "0xf", to: VAULT, data: "0x12" }, "0xff", { [VAULT]: { stateDiff: { [SLOT]: "0x1" } } }]);
  });
});
