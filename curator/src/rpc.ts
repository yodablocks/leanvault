// Thin JSON-RPC client: eth_call and eth_getBlockByNumber, nothing else.
export interface Rpc {
  call(to: string, data: string): Promise<string>;
  latestBlock(): Promise<{ number: bigint; timestamp: number }>;
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
      const json = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (json.error) throw new Error(`rpc ${method}: ${json.error.message}`);
      return json.result;
    } catch (err) {
      if (attempt >= 5) throw err;
      const limited = String(err).includes("429");
      await new Promise((r) => setTimeout(r, (limited ? 2_000 : 500) * 2 ** attempt));
      return send(method, params, attempt + 1);
    }
  }
  return {
    call: (to, data) => send("eth_call", [{ to, data }, "latest"]),
    async latestBlock() {
      const b = await send("eth_getBlockByNumber", ["latest", false]);
      return { number: BigInt(b.number), timestamp: Number(BigInt(b.timestamp)) };
    },
  };
}
