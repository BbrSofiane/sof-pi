/**
 * Strict configuration parsing for the software factory.
 *
 * `.pi/factory.json` is human-authored project configuration. It is the ONLY
 * source of validation commands the factory will ever execute. Everything is
 * validated fail-closed: unknown fields and malformed values are errors, never
 * warnings. Prompts, credentials, secrets, and shell fragments from model
 * output never enter this file — it must be edited by a human.
 */

export const FACTORY_CONFIG_FILENAME = "factory.json";

export interface FactoryValidationCommand {
	name: string;
	command: string;
}

export interface FactoryConfig {
	version: 1;
	validationCommands: FactoryValidationCommand[];
	/** Workflow deadline (ms) for each factory workflow launch. */
	timeoutMs: number;
	/** Per-command timeout (ms) for deterministic validation checks. */
	commandTimeoutMs: number;
	/** Upper bound passed to pi-subagents as globalConcurrencyLimit. */
	maxConcurrency: number;
	/** Allow launching from a dirty git baseline. Default false. */
	allowDirtyBaseline: boolean;
}

export type FactoryConfigResult =
	| { ok: true; config: FactoryConfig }
	| { ok: false; errors: string[] };

export const FACTORY_CONFIG_DEFAULTS = {
	timeoutMs: 30 * 60 * 1000,
	commandTimeoutMs: 5 * 60 * 1000,
	maxConcurrency: 4,
	allowDirtyBaseline: false,
} as const;

const COMMAND_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_COMMANDS = 8;
const MAX_COMMAND_LENGTH = 4096;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlChars(value: string): boolean {
	// eslint-disable-next-line no-control-regex
	return /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
}

function checkInteger(
	value: unknown,
	field: string,
	min: number,
	max: number,
	errors: string[],
): number | undefined {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		errors.push(`${field} must be an integer.`);
		return undefined;
	}
	if (value < min || value > max) {
		errors.push(`${field} must be between ${min} and ${max}.`);
		return undefined;
	}
	return value;
}

/**
 * Parse and strictly validate a factory configuration value.
 * Unknown fields and malformed values fail closed.
 */
export function parseFactoryConfig(raw: unknown): FactoryConfigResult {
	const errors: string[] = [];
	if (!isPlainObject(raw)) {
		return { ok: false, errors: ["factory config must be a JSON object."] };
	}

	const allowedFields = new Set([
		"version",
		"validationCommands",
		"timeoutMs",
		"commandTimeoutMs",
		"maxConcurrency",
		"allowDirtyBaseline",
	]);
	for (const key of Object.keys(raw)) {
		if (!allowedFields.has(key)) {
			errors.push(`unknown field "${key}" — factory config fails closed on unknown fields.`);
		}
	}

	if (raw.version !== 1) {
		errors.push('version must be exactly 1.');
	}

	const validationCommands: FactoryValidationCommand[] = [];
	if (!Array.isArray(raw.validationCommands)) {
		errors.push("validationCommands must be a non-empty array of { name, command } objects.");
	} else if (raw.validationCommands.length === 0) {
		errors.push("validationCommands must contain at least one command. The factory never invents validation commands.");
	} else if (raw.validationCommands.length > MAX_COMMANDS) {
		errors.push(`validationCommands must contain at most ${MAX_COMMANDS} commands.`);
	} else {
		const seenNames = new Set<string>();
		for (const [index, entry] of raw.validationCommands.entries()) {
			if (!isPlainObject(entry)) {
				errors.push(`validationCommands[${index}] must be an object with exactly "name" and "command" string fields.`);
				continue;
			}
			const entryKeys = Object.keys(entry);
			if (entryKeys.length !== 2 || !entryKeys.includes("name") || !entryKeys.includes("command")) {
				errors.push(`validationCommands[${index}] must have exactly "name" and "command" fields.`);
				continue;
			}
			const { name, command } = entry as { name: unknown; command: unknown };
			if (typeof name !== "string" || !COMMAND_NAME_PATTERN.test(name)) {
				errors.push(
					`validationCommands[${index}].name ${JSON.stringify(name ?? null)} must match ${COMMAND_NAME_PATTERN.source} (1-64 chars: letters, digits, ".", "_", "-", starting with a letter or digit).`,
				);
			} else if (seenNames.has(name)) {
				errors.push(`validationCommands[${index}].name "${name}" is duplicated.`);
			} else {
				seenNames.add(name);
			}
			if (typeof command !== "string" || command.trim().length === 0) {
				errors.push(`validationCommands[${index}].command must be a non-empty string.`);
			} else if (command.length > MAX_COMMAND_LENGTH) {
				errors.push(`validationCommands[${index}].command must be at most ${MAX_COMMAND_LENGTH} characters.`);
			} else if (hasControlChars(command)) {
				errors.push(`validationCommands[${index}].command must be a single-line command without control characters.`);
			}
			validationCommands.push({ name: String(name), command: String(command) });
		}
	}

	const timeoutMs = raw.timeoutMs === undefined
		? FACTORY_CONFIG_DEFAULTS.timeoutMs
		: checkInteger(raw.timeoutMs, "timeoutMs", 60_000, 86_400_000, errors);
	const commandTimeoutMs = raw.commandTimeoutMs === undefined
		? FACTORY_CONFIG_DEFAULTS.commandTimeoutMs
		: checkInteger(raw.commandTimeoutMs, "commandTimeoutMs", 1_000, 3_600_000, errors);
	const maxConcurrency = raw.maxConcurrency === undefined
		? FACTORY_CONFIG_DEFAULTS.maxConcurrency
		: checkInteger(raw.maxConcurrency, "maxConcurrency", 1, 16, errors);

	if (raw.allowDirtyBaseline !== undefined && typeof raw.allowDirtyBaseline !== "boolean") {
		errors.push("allowDirtyBaseline must be a boolean.");
	}
	const allowDirtyBaseline = raw.allowDirtyBaseline === undefined
		? FACTORY_CONFIG_DEFAULTS.allowDirtyBaseline
		: (raw.allowDirtyBaseline as boolean);

	if (errors.length > 0) return { ok: false, errors };
	if (timeoutMs === undefined || commandTimeoutMs === undefined || maxConcurrency === undefined) {
		// Unreachable when errors is empty; kept as a fail-closed guard.
		return { ok: false, errors: ["internal: numeric field validation failed."] };
	}

	return {
		ok: true,
		config: {
			version: 1,
			validationCommands,
			timeoutMs,
			commandTimeoutMs,
			maxConcurrency,
			allowDirtyBaseline,
		},
	};
}
