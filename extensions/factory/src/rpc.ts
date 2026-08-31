/**
 * In-process RPC client for the pi-subagents event-bus RPC
 * (`subagents:rpc:v1:*`).
 *
 * The factory never imports pi-subagents internals: it sends requests on the
 * documented request event, correlates replies by request ID on the per-request
 * reply event, and fails closed on error replies and timeouts.
 */

export const RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

/** Minimal event-bus surface (pi.events satisfies this). */
export interface RpcEventBus {
	on(event: string, handler: (data: unknown) => void): unknown;
	emit(event: string, data: unknown): unknown;
}

export class FactoryRpcError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "FactoryRpcError";
		this.code = code;
	}
}

export interface RpcRequestOptions {
	/** How long to wait for a correlated reply before failing. */
	timeoutMs?: number;
	/** Override the generated request ID (used by tests). */
	requestId?: string;
}

export interface RpcReplyEnvelope {
	version: number;
	requestId: string;
	success: boolean;
	data?: unknown;
	error?: { code: string; message: string };
}

function defaultTimeout(method: string): number {
	return method === "spawn" ? 120_000 : 30_000;
}

/**
 * Send one RPC request and await the correlated reply.
 *
 * Replies are matched strictly by requestId; replies for other requests are
 * ignored. A timeout is a failure, never a success with unknown state.
 */
export function rpcRequest<T = unknown>(
	bus: RpcEventBus,
	method: string,
	params: Record<string, unknown> | undefined,
	options: RpcRequestOptions = {},
): Promise<T> {
	const requestId = options.requestId ?? crypto.randomUUID();
	const timeoutMs = options.timeoutMs ?? defaultTimeout(method);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const unsubscribe = bus.on(`${RPC_REPLY_EVENT_PREFIX}${requestId}`, (raw) => {
			const reply = raw as RpcReplyEnvelope;
			if (!reply || typeof reply !== "object" || reply.requestId !== requestId) return;
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			if (reply.success) {
				resolve(reply.data as T);
			} else {
				const error = reply.error ?? { code: "execution_failed", message: "RPC reply reported failure without details." };
				reject(new FactoryRpcError(error.code, error.message));
			}
		});
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsubscribe?.();
			reject(new FactoryRpcError("timeout", `pi-subagents RPC '${method}' (${requestId}) timed out after ${timeoutMs}ms.`));
		}, timeoutMs);
		bus.emit(RPC_REQUEST_EVENT, {
			version: 1,
			requestId,
			method,
			...(params !== undefined ? { params } : {}),
			source: { extension: "sof-pi.factory" },
		});
	});
}

export interface SubagentsCapabilities {
	methods: string[];
	capabilities: Record<string, unknown>;
	events: Record<string, string>;
}

/**
 * Verify that the installed pi-subagents extension is alive and speaks the
 * expected RPC protocol. Pings with a short timeout, then retries once to
 * tolerate startup ordering (the bridge may register after we load).
 */
export async function rpcPing(bus: RpcEventBus): Promise<SubagentsCapabilities> {
	const attempts = [0, 1] as const;
	let lastError: unknown;
	for (const attempt of attempts) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
		try {
			const data = await rpcRequest<SubagentsCapabilities>(bus, "ping", undefined, { timeoutMs: 5_000 });
			if (!Array.isArray(data?.methods) || !data.methods.includes("spawn")) {
				throw new FactoryRpcError("invalid_state", "pi-subagents RPC is reachable but does not advertise the spawn method.");
			}
			return data;
		} catch (error) {
			lastError = error;
		}
	}
	throw new FactoryRpcError(
		"unavailable",
		`pi-subagents is not responding on the in-process RPC bus. Is the pi-subagents package installed and loaded? Last error: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	);
}
