import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { FactoryRpcError, rpcPing, rpcRequest } from "../../extensions/factory/src/rpc.ts";
import { piSubagentsCopy } from "./helpers.ts";

interface Bus {
	seen: Array<{ event: string; data: unknown }>;
	handlers: Map<string, Array<(data: unknown) => void>>;
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

function createBus(): Bus {
	const bus: Bus = {
		seen: [],
		handlers: new Map(),
		on(event, handler) {
			const list = bus.handlers.get(event) ?? [];
			list.push(handler);
			bus.handlers.set(event, list);
			return () => {
				const current = bus.handlers.get(event) ?? [];
				bus.handlers.set(event, current.filter((h) => h !== handler));
			};
		},
		emit(event, data) {
			bus.seen.push({ event, data });
			for (const handler of bus.handlers.get(event) ?? []) handler(data);
		},
	};
	return bus;
}

describe("factory RPC client (request/reply correlation)", () => {
	it("correlates replies by request ID and ignores foreign replies", async () => {
		const bus = createBus();
		let requestId = "";
		const pending = rpcRequest(bus, "spawn", { x: 1 }, { requestId: "req-1", timeoutMs: 1_000 }).then((data) => {
			return { data, requestId };
		});
		requestId = "req-1";
		// Emit a reply for a different request first — must be ignored.
		bus.emit("subagents:rpc:v1:reply:req-other", {
			version: 1,
			requestId: "req-other",
			success: true,
			data: { wrong: true },
		});
		bus.emit("subagents:rpc:v1:reply:req-1", {
			version: 1,
			requestId: "req-1",
			success: true,
			data: { runId: "run-9" },
		});
		const { data } = await pending;
		assert.deepEqual(data, { runId: "run-9" });
		// The request was emitted on the documented request event with our source tag.
		const request = bus.seen.find((entry) => entry.event === "subagents:rpc:v1:request");
		assert.ok(request);
		assert.equal((request.data as { version: number }).version, 1);
		assert.equal(((request.data as { source: { extension: string } }).source).extension, "sof-pi.factory");
	});

	it("fails closed on error replies, preserving the error code", async () => {
		const bus = createBus();
		const pending = rpcRequest(bus, "spawn", {}, { requestId: "req-2", timeoutMs: 1_000 });
		bus.emit("subagents:rpc:v1:reply:req-2", {
			version: 1,
			requestId: "req-2",
			success: false,
			error: { code: "invalid_params", message: "bad input" },
		});
		await assert.rejects(pending, (error: FactoryRpcError) => error.code === "invalid_params" && error.message.includes("bad input"));
	});

	it("replies for other requests and wrong-shaped data never break correlation; uncorrelated requests time out", async () => {
		const bus = createBus();
		const pending = rpcRequest(bus, "spawn", {}, { requestId: "req-3", timeoutMs: 50 });
		bus.emit("subagents:rpc:v1:reply:req-3", { version: 1, requestId: "req-3", success: true, data: "late-but-wrong-shape" });
		// First (correlated) reply resolves; a second timeout scenario:
		const pending2 = rpcRequest(bus, "spawn", {}, { requestId: "req-4", timeoutMs: 50 });
		await assert.rejects(pending2, (error: FactoryRpcError) => error.code === "timeout");
		await pending;
	});

	it("late replies after timeout do not resolve anything", async () => {
		const bus = createBus();
		const pending = rpcRequest(bus, "spawn", {}, { requestId: "req-5", timeoutMs: 30 });
		await assert.rejects(pending, (error: FactoryRpcError) => error.code === "timeout");
		bus.emit("subagents:rpc:v1:reply:req-5", { version: 1, requestId: "req-5", success: true, data: { late: true } });
		await new Promise((resolve) => setTimeout(resolve, 10)); // would throw if resolved after settle
	});
});

describe("smoke test against the real installed pi-subagents RPC bridge", () => {
	it("pings, validates spawn params through the real bridge, and rejects invalid requests", async () => {
		const dir = await piSubagentsCopy();
		const { registerSubagentRpcBridge } = await import(`${dir}/src/extension/rpc.ts`);
		const bus = createBus();
		const fakeCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "smoke-session", getSessionFile: () => null } };
		const executed: Array<{ id: string; params: Record<string, unknown> }> = [];
		const bridge = registerSubagentRpcBridge({
			events: bus,
			getContext: () => fakeCtx,
			execute: async (id: string, params: Record<string, unknown>) => {
				executed.push({ id, params });
				return {
					content: [{ type: "text", text: "Async workflow: scout → plan → implement [wf-123]" }],
					details: { mode: "workflow", runId: "wf-123", asyncId: "wf-123", asyncDir: "/tmp/x", results: [] },
				};
			},
		} as Parameters<typeof registerSubagentRpcBridge>[0]);
		bridge.emitReady(null);

		// ping through OUR client against the REAL bridge.
		const caps = await rpcPing(bus);
		assert.ok(caps.methods.includes("spawn"));
		assert.equal((caps.events as { request: string }).request, "subagents:rpc:v1:request");

		// The exact spawn request shape the factory sends passes real validation.
		const spawnParams = {
			workflowScript: 'const scout = await runs.run("scout", { agent: "scout", task: "t" }); return scout.structuredOutput;',
			mission: { title: "Factory build: demo" },
			timeoutMs: 1_800_000,
			globalConcurrencyLimit: 4,
		};
		const reply = await rpcRequest<{ details?: { runId?: string; mode?: string } }>(bus, "spawn", spawnParams, { timeoutMs: 5_000 });
		assert.equal(reply.details?.runId, "wf-123");
		assert.equal(reply.details?.mode, "workflow");
		assert.equal(executed.length, 1);
		// The bridge normalized the launch to detached async.
		assert.equal(executed[0].params.async, true);
		assert.equal(executed[0].params.workflowScript, spawnParams.workflowScript);

		// Invalid requests are rejected by the real boundary before dispatch.
		await assert.rejects(
			rpcRequest(bus, "spawn", { action: "status", id: "x" }, { timeoutMs: 5_000 }),
			(error: FactoryRpcError) => error.code === "invalid_params",
		);
		await assert.rejects(
			rpcRequest(bus, "spawn", { workflowScript: "return 1", async: false }, { timeoutMs: 5_000 }),
			(error: FactoryRpcError) => error.code === "invalid_params",
		);
		await assert.rejects(
			rpcRequest(bus, "spawn", { workflowScript: "return 1", agent: "scout" }, { timeoutMs: 5_000 }),
			(error: FactoryRpcError) => error.code === "invalid_params",
		);
		bridge.dispose();
	});
});
