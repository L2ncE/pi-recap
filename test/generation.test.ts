import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AssistantMessage, Context, Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import register from "../extensions/recap.ts";

function response(stopReason: AssistantMessage["stopReason"], text = ""): AssistantMessage {
	return {
		role: "assistant", api: "openai-responses", provider: "test", model: "reasoning-model",
		content: text ? [{ type: "text", text }] : [], stopReason, timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

async function setup(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-recap-generation-"));
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ recap: { model: "test/reasoning-model" } }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	const selected: Model<Api> = {
		provider: "test", id: "reasoning-model", name: "Reasoning model", api: "openai-responses",
		baseUrl: "https://example.invalid", reasoning: true, input: ["text"],
		contextWindow: 8192, maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		thinkingLevelMap: { off: null, minimal: null, low: "low" },
	};
	let result = response("stop", "Implementation complete; validation in progress.");
	const calls: { model: Model<Api>; options: Record<string, unknown> }[] = [];
	const notices: string[] = [];
	const saved: unknown[] = [];
	let sessionStart: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const pi = {
		on(name: string, handler: typeof sessionStart) { if (name === "session_start") sessionStart = handler; },
		registerCommand(name: string, value: NonNullable<typeof command>) { if (name === "recap") command = value; },
		appendEntry(_type: string, state: unknown) { saved.push(state); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: dir, hasUI: true, signal: new AbortController().signal,
		model: { provider: "test", id: "session-model" },
		modelRegistry: {
			find(provider: string, id: string) { return provider === selected.provider && id === selected.id ? selected : undefined; },
			hasConfiguredAuth() { return true; },
			complete: async (model: Model<Api>, _context: Context, options: Record<string, unknown>) => {
				calls.push({ model, options });
				return result;
			},
		},
		sessionManager: { getBranch: () => [
			{ type: "message", message: { role: "user", content: "Implement search." } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Implementation is complete; validation is in progress." }] } },
		] },
		ui: { setWidget() {}, notify(message: string) { notices.push(message); } },
	} as unknown as ExtensionCommandContext;
	register(pi);
	assert.ok(sessionStart);
	assert.ok(command);
	await sessionStart({}, ctx);
	const handler = command.handler;
	return { calls, notices, saved, ctx, selected, setResponse: (next: AssistantMessage) => { result = next; }, run: () => handler("", ctx) };
}

test("recap clamps unsupported minimal effort for the configured model", async (t) => {
	const h = await setup(t);
	await h.run();
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].model, h.selected);
	assert.equal(h.calls[0].options.reasoningEffort, "low");
	assert.equal(h.calls[0].options.signal, h.ctx.signal);
	assert.equal(h.calls[0].options.maxTokens, 512);
	assert.equal(h.calls[0].options.cacheRetention, "none");
	assert.equal(h.notices.at(-1), "Recap updated");
	assert.equal(h.saved.length, 1);
});

test("recap leaves supported minimal effort unchanged", async (t) => {
	const h = await setup(t);
	h.selected.thinkingLevelMap = { off: null, minimal: "minimal", low: "low" };
	await h.run();
	assert.equal(h.calls[0].options.reasoningEffort, "minimal");
	assert.equal(h.notices.at(-1), "Recap updated");
});

test("recap omits effort for a non-reasoning model", async (t) => {
	const h = await setup(t);
	h.selected.reasoning = false;
	await h.run();
	assert.equal(h.calls[0].options.reasoningEffort, undefined);
	assert.equal(h.notices.at(-1), "Recap updated");
});

for (const stopReason of ["error", "aborted"] as const) {
	for (const text of ["", "Partial output that must not replace the recap"]) {
		test(`${stopReason} with ${text ? "partial" : "empty"} content preserves the recap and reports its status`, async (t) => {
			const h = await setup(t);
			await h.run();
			const previous = h.saved[0];
			h.setResponse({ ...response(stopReason, text), errorMessage: "private provider response" });
			await h.run();
			assert.equal(h.saved.length, 1);
			assert.equal(h.saved[0], previous);
			assert.equal(h.notices.at(-1), stopReason === "error"
				? "Recap skipped: model request failed (test/reasoning-model)"
				: "Recap skipped: generation aborted");
			assert.ok(h.notices.every((notice) => !notice.includes("private provider response")));
			h.setResponse(response("stop", "Validation complete"));
			await h.run();
			assert.equal(h.notices.at(-1), "Recap updated");
			assert.equal(h.saved.length, 2);
		});
	}
}

for (const [stopReason, text, reason] of [
	["length", "Truncated text", "output truncated"],
	["stop", "", "empty model output"],
] as const) {
	test(`${reason} still preserves the previous recap`, async (t) => {
		const h = await setup(t);
		await h.run();
		h.setResponse(response(stopReason, text));
		await h.run();
		assert.equal(h.saved.length, 1);
		assert.equal(h.notices.at(-1), `Recap skipped: ${reason}`);
	});
}
