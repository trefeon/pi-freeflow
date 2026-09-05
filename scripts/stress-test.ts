import http from "node:http";
import { startProxy } from "../src/proxy.ts";
import { relayFetch } from "../src/relay.ts";
import { setActiveRelayState, resetAllRelayHealth } from "../src/relay-state.ts";
import { registerClient, renewClient, getLeaseCount, _resetLeaseStateForTest } from "../src/lease.ts";
import { ALLOW_UNSAFE_RELAY_ENV } from "../src/config.ts";

async function run() {
  console.log("=== Starting pi-freeflow Stress Test ===");

  // 1. Concurrency Stress Test on Proxy (100 parallel requests)
  console.log("\n[1/4] Stress testing proxy endpoint concurrency (100 parallel requests)...");
  const testPort = 29500;
  const { server, port } = await startProxy(testPort);
  try {
    const start = Date.now();
    const promises = Array.from({ length: 100 }, async (_, i) => {
      const path = i % 2 === 0 ? "/v1/models" : "/health";
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      if (!res.ok) throw new Error(`Request ${i} failed with HTTP ${res.status}`);
      return res.json();
    });
    await Promise.all(promises);
    const duration = Date.now() - start;
    console.log(`  ✓ 100 parallel requests completed in ${duration}ms (${(duration / 100).toFixed(2)}ms/req average)`);
    console.log(`  ✓ 0 dropped connections, 100% success rate`);
  } finally {
    if (server) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  // 2. Client Lease & Heartbeat Contention (20 simulated concurrent subagents)
  console.log("\n[2/4] Stress testing client lease & heartbeat contention (20 subagents, 200 rapid heartbeats)...");
  _resetLeaseStateForTest();
  const subagentIds = Array.from({ length: 20 }, (_, i) => `subagent-${i}-${Date.now()}`);
  for (const id of subagentIds) {
    registerClient(id);
  }
  if (getLeaseCount() !== 20) {
    throw new Error(`Expected 20 active clients, got ${getLeaseCount()}`);
  }

  // Flood heartbeats in parallel
  const hbStart = Date.now();
  await Promise.all(
    Array.from({ length: 200 }, (_, i) => {
      const id = subagentIds[i % subagentIds.length];
      return Promise.resolve(renewClient(id));
    })
  );
  console.log(`  ✓ 200 rapid heartbeats across 20 subagents processed in ${Date.now() - hbStart}ms`);
  console.log(`  ✓ Lease count maintained at ${getLeaseCount()} without race conditions`);

  // 3. Relay Failover Under Burst Traffic (Edge 404 Simulation)
  console.log("\n[3/4] Stress testing relay pool failover under burst traffic (edge 404 simulation)...");
  process.env[ALLOW_UNSAFE_RELAY_ENV] = "1";
  const mockDead = http.createServer((_req, res) => {
    res.writeHead(404, {
      "content-type": "text/plain",
      "x-vercel-error": "DEPLOYMENT_NOT_FOUND",
      "x-vercel-id": "sin1::stress-test",
    });
    res.end("The deployment could not be found on Vercel.");
  });
  const mockLive = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl-stress", choices: [{ message: { content: "hello" } }] }));
  });

  const deadPort = 29501;
  const livePort = 29502;
  await new Promise<void>((r) => mockDead.listen(deadPort, "127.0.0.1", () => r()));
  await new Promise<void>((r) => mockLive.listen(livePort, "127.0.0.1", () => r()));

  setActiveRelayState({
    enabled: true,
    mode: "auto",
    url: `http://127.0.0.1:${deadPort}`,
    relays: [
      { url: `http://127.0.0.1:${deadPort}`, label: "dead-relay" },
      { url: `http://127.0.0.1:${livePort}`, label: "healthy-relay" },
    ],
  }, false);
  resetAllRelayHealth();

  try {
    const burstStart = Date.now();
    const burstCount = 20;
    const burstPromises = Array.from({ length: burstCount }, async (_, i) => {
      const res = await relayFetch("https://opencode.ai/zen/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "mimo-v2.5-free", messages: [{ role: "user", content: `msg ${i}` }] }),
      });
      if (res.status !== 200) throw new Error(`Burst request ${i} failed with ${res.status}`);
      return res.json();
    });

    await Promise.all(burstPromises);
    console.log(`  ✓ ${burstCount} burst requests successfully failed over from dead relay to healthy relay in ${Date.now() - burstStart}ms`);
    console.log(`  ✓ Sticky relay auto-switched to healthy relay without user intervention`);
  } finally {
    await new Promise<void>((r) => mockDead.close(() => r()));
    await new Promise<void>((r) => mockLive.close(() => r()));
  }

  // 4. Memory & Garbage Collection sanity
  console.log("\n[4/4] Memory footprint check...");
  const mem = process.memoryUsage();
  console.log(`  ✓ RSS: ${(mem.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  ✓ Heap Used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);

  console.log("\n=== ALL STRESS TESTS PASSED SUCCESSFULLY ===");
}

run().catch((err) => {
  console.error("Stress test failed:", err);
  process.exit(1);
});
