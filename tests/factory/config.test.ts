import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { FACTORY_CONFIG_DEFAULTS, parseFactoryConfig } from "../../extensions/factory/src/config.ts";

describe("factory config validation", () => {
	const valid = {
		version: 1,
		validationCommands: [{ name: "test", command: "pnpm test" }],
	};

	it("accepts a minimal config and fills defaults", () => {
		const result = parseFactoryConfig(valid);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.config.validationCommands, [{ name: "test", command: "pnpm test" }]);
		assert.equal(result.config.timeoutMs, FACTORY_CONFIG_DEFAULTS.timeoutMs);
		assert.equal(result.config.commandTimeoutMs, FACTORY_CONFIG_DEFAULTS.commandTimeoutMs);
		assert.equal(result.config.maxConcurrency, FACTORY_CONFIG_DEFAULTS.maxConcurrency);
		assert.equal(result.config.allowDirtyBaseline, false);
	});

	it("accepts a full explicit config", () => {
		const result = parseFactoryConfig({
			version: 1,
			validationCommands: [
				{ name: "test", command: "pnpm test" },
				{ name: "typecheck", command: "pnpm run typecheck" },
			],
			timeoutMs: 3_600_000,
			commandTimeoutMs: 120_000,
			maxConcurrency: 2,
			allowDirtyBaseline: true,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.config.validationCommands.length, 2);
		assert.equal(result.config.timeoutMs, 3_600_000);
		assert.equal(result.config.maxConcurrency, 2);
		assert.equal(result.config.allowDirtyBaseline, true);
	});

	it("rejects non-object and null input", () => {
		for (const raw of [null, undefined, "x", 42, []]) {
			const result = parseFactoryConfig(raw);
			assert.equal(result.ok, false);
			if (result.ok) return;
			assert.ok(result.errors.length > 0);
		}
	});

	it("fails closed on unknown fields", () => {
		const result = parseFactoryConfig({ ...valid, extra: true, nested: { a: 1 } });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.errors.some((e) => e.includes('"extra"')));
		assert.ok(result.errors.some((e) => e.includes('"nested"')));
	});

	it("fails closed when validationCommands is missing, empty, or not an array", () => {
		for (const commands of [undefined, [], "pnpm test", { name: "t" }]) {
			const result = parseFactoryConfig({ version: 1, validationCommands: commands });
			assert.equal(result.ok, false, `expected failure for ${JSON.stringify(commands)}`);
			if (result.ok) return;
			assert.ok(result.errors.some((e) => e.includes("validationCommands")));
		}
	});

	it("fails closed on malformed command entries", () => {
		const result = parseFactoryConfig({
			version: 1,
			validationCommands: [
				{ name: "ok", command: "pnpm test" },
				{ name: "Bad Name!", command: "pnpm test" },
				{ name: "dupe", command: "a" },
				{ name: "dupe", command: "b" },
				{ name: "nonewline", command: "a\nb" },
				{ name: "noctrl", command: "a\u0000b" },
				{ name: "empty", command: "   " },
				{ name: "missing", extra: "field" },
			],
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		const joined = result.errors.join("\n");
		assert.ok(joined.includes("Bad Name!"));
		assert.ok(joined.includes("duplicated"));
		assert.ok(joined.includes("control characters"));
		assert.ok(joined.includes("non-empty string"));
		assert.ok(joined.includes('exactly "name" and "command"'));
	});

	it("fails closed on wrong version and malformed numeric bounds", () => {
		const result = parseFactoryConfig({
			...valid,
			version: 2,
			timeoutMs: 1000,
			commandTimeoutMs: "soon",
			maxConcurrency: 0,
			allowDirtyBaseline: "yes",
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		const joined = result.errors.join("\n");
		assert.ok(joined.includes("version"));
		assert.ok(joined.includes("timeoutMs"));
		assert.ok(joined.includes("commandTimeoutMs"));
		assert.ok(joined.includes("maxConcurrency"));
		assert.ok(joined.includes("allowDirtyBaseline"));
	});

	it("never validates commands against model output — only exact configured shape", () => {
		// A command containing shell metacharacters is allowed ONLY because the
		// config is human-authored; the parser's job is shape validation.
		const result = parseFactoryConfig({
			version: 1,
			validationCommands: [{ name: "mise", command: "mise run workspace:test -- --strict && pnpm build" }],
		});
		assert.equal(result.ok, true);
	});
});
