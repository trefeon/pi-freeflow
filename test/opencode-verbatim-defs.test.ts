import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BASH_READ_119_PARAM_SCHEMAS, READ_SHELL_V2_DEFS } from "../src/tool-translation.ts";

describe("verbatim upstream defs", () => {
	it("has exact key sets", () => {
		assert.deepEqual(Object.keys(BASH_READ_119_PARAM_SCHEMAS).sort(), ["bash", "read"]);
		assert.deepEqual(Object.keys(READ_SHELL_V2_DEFS).sort(), ["read", "shell"]);
	});
	it("bash 1.19.0 params match capture", () => {
		const expected = `{"type":"object","properties":{"command":{"type":"string","description":"The command to execute"},"timeout":{"type":"integer","description":"Optional timeout in milliseconds"},"workdir":{"type":"string","description":"The working directory to run the command in"}},"required":["command"]}`;
		assert.equal(JSON.stringify(BASH_READ_119_PARAM_SCHEMAS.bash), expected);
	});
	it("read 1.19.0 params match capture", () => {
		const expected = `{"type":"object","properties":{"filePath":{"type":"string","description":"The absolute path to the file or directory to read"},"offset":{"type":"integer","description":"The line number to start reading from (1-indexed)"},"limit":{"type":"integer","description":"The maximum number of lines to read"}},"required":["filePath"]}`;
		assert.equal(JSON.stringify(BASH_READ_119_PARAM_SCHEMAS.read), expected);
	});
	it("read v2 def matches capture", () => {
		assert.equal(READ_SHELL_V2_DEFS.read.description, "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.");
		const expected = `{"type":"object","properties":{"path":{"type":"string","description":"File or directory to read"},"offset":{"type":"integer","minimum":0,"description":"The line or directory entry to start reading from (1-based)"},"limit":{"type":"integer","minimum":0,"description":"The maximum number of lines or directory entries to read (defaults to and capped at 2000)"}},"required":["path"],"additionalProperties":false}`;
		assert.equal(JSON.stringify(READ_SHELL_V2_DEFS.read.parameters), expected);
	});
	it("shell v2 def matches capture", () => {
		assert.equal(READ_SHELL_V2_DEFS.shell.description, "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete. DO NOT poll for completion.");
		const expected = `{"type":"object","properties":{"command":{"type":"string","description":"Shell command string to execute"},"workdir":{"type":"string","description":"Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."},"timeout":{"type":"integer","minimum":0,"description":"Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."},"background":{"type":"boolean","description":"Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using the shell tool. You will be notified when it completes. DO NOT poll for completion."}},"required":["command"],"additionalProperties":false}`;
		assert.equal(JSON.stringify(READ_SHELL_V2_DEFS.shell.parameters), expected);
	});
});
