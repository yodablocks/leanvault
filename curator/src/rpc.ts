// Thin JSON-RPC client: eth_call and eth_getBlockByNumber, nothing else.
export interface Rpc {
  call(to: string, data: string): Promise<string>;
  latestBlock(): Promise<{ number: bigint; timestamp: number }>;
}

export function makeRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  let id = 1;
  // Public endpoints drop or rate-limit calls now and then; retry with backoff.
  async function send(method: string, params: unknown[], attempt = 0): Promise<any> {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
      });
      if (!res.ok) throw new Error(`rpc ${method}: http ${res.status}`);
      const json = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (json.error) throw new Error(`rpc ${method}: ${json.error.message}`);
      return json.result;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
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
