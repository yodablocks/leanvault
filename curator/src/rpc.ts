// Thin JSON-RPC client: eth_call, eth_createAccessList and eth_getBlockByNumber.

/** The call executed and reverted. An answer, not a transport failure, so it is never retried. */
export class RevertError extends Error {}

export interface CallOptions {
  from?: string;
  /** Pin to a block; "latest" when absent. */
  block?: bigint;
  /** eth_call state override: storage slots to replace per address. */
  override?: Record<string, { stateDiff: Record<string, string> }>;
}

export interface Rpc {
  call(to: string, data: string, opts?: CallOptions): Promise<string>;
  /** Storage slots the call reads, per address. */
  accessList(to: string, data: string, opts?: CallOptions): Promise<{ address: string; storageKeys: string[] }[]>;
  latestBlock(): Promise<{ number: bigint; timestamp: number }>;
}

// Code 3 is the standard; some nodes answer -32000 with the same message.
function isRevert(e: { code?: number; message?: string }): boolean {
  return e.code === 3 || /execution reverted/i.test(e.message ?? "");
}

export function makeRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  let id = 1;
  // Endpoints drop, hang or rate-limit calls; every request has a timeout,
  // and failures retry with backoff, longer when the answer was a 429.
  async function send(method: string, params: unknown[], attempt = 0): Promise<any> {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`rpc ${method}: http ${res.status}`);
      const json = (await res.json()) as { result?: unknown; error?: { code?: number; message: string } };
      if (json.error && isRevert(json.error)) throw new RevertError(`rpc ${method}: ${json.error.message}`);
      if (json.error) throw new Error(`rpc ${method}: ${json.error.message}`);
      return json.result;
    } catch (err) {
      if (err instanceof RevertError || attempt >= 5) throw err;
      const limited = String(err).includes("429");
      await new Promise((r) => setTimeout(r, (limited ? 2_000 : 500) * 2 ** attempt));
      return send(method, params, attempt + 1);
    }
  }
  const tx = (to: string, data: string, o?: CallOptions) => (o?.from ? { from: o.from, to, data } : { to, data });
  const tag = (o?: CallOptions) => (o?.block === undefined ? "latest" : "0x" + o.block.toString(16));
  return {
    call: (to, data, o) => send("eth_call", [tx(to, data, o), tag(o), ...(o?.override ? [o.override] : [])]),
    async accessList(to, data, o) {
      const r = await send("eth_createAccessList", [tx(to, data, o), tag(o)]);
      return r.accessList;
    },
    async latestBlock() {
      const b = await send("eth_getBlockByNumber", ["latest", false]);
      return { number: BigInt(b.number), timestamp: Number(BigInt(b.timestamp)) };
    },
  };
}
