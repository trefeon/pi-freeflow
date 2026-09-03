// Stress child: attaches to the daemon and holds its lease ~4s so the parent
// can observe N concurrent cross-process clients racing ensureDaemon.
import { ensureDaemon } from "../src/client.ts";

const port = await ensureDaemon();
console.log(`PORT=${port}`);
await new Promise<void>((r) => setTimeout(r, 4000));
