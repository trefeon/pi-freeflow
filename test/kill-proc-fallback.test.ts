// Forces killPortHolder past lsof/fuser into the /proc fallback by shadowing
// both tools with failing stubs on PATH. Linux-only; skips elsewhere.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

test("killPortHolder reaps via /proc fallback without lsof/fuser", { skip: process.platform !== "linux" ? "needs linux /proc" : undefined }, async () => {
	const { killPortHolder } = await import("../src/proxy.ts");

	const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "pff-notools-"));
	for (const name of ["lsof", "fuser"]) {
		const full = path.join(stubDir, name);
		fs.writeFileSync(full, "#!/bin/sh\nexit 127\n");
		fs.chmodSync(full, 0o755);
	}
	const origPath = process.env.PATH ?? "";
	process.env.PATH = stubDir + path.delimiter + origPath;
	try {
		const child = spawn(process.execPath, ["-e", "require('node:http').createServer().listen(0,'127.0.0.1',function(){console.log('P='+this.address().port)});setInterval(()=>{},1000);"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const dport = await new Promise<number>((res, rej) => {
			let out = "";
			const to = setTimeout(() => rej(new Error("dummy silent")), 10000);
			child.stdout?.on("data", (d: Buffer) => {
				out += String(d);
				const m = out.match(/P=(\d+)/);
				if (m) { clearTimeout(to); res(Number(m[1])); }
			});
			child.on("error", rej);
		});
		try {
			const killed = await killPortHolder(dport);
			assert.equal(killed, true, "proc fallback must reap the holder");
			const exited = await Promise.race([
				new Promise<boolean>((r) => { child.on("exit", () => r(true)); }),
				new Promise<boolean>((r) => setTimeout(() => r(false), 8000)),
			]);
			assert.equal(exited, true, "holder process must exit");
		} finally {
			try { child.kill("SIGKILL"); } catch {}
		}
	} finally {
		process.env.PATH = origPath;
		fs.rmSync(stubDir, { recursive: true, force: true });
	}
});
