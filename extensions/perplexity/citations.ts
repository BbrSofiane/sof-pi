/** Provider citations are response-local source IDs, never result-array positions. */
export interface CitationSource { id: string; title: string; url: string }

const MARKER = /\[((?:[a-z][a-z0-9_]*:)?\d+)\]/g;

function lookup(marker: string, sources: Map<string, CitationSource>): CitationSource | undefined {
	// Only documented web aliases are equivalent to fast's numeric IDs.
	return sources.get(marker) ?? (marker.startsWith("web:") ? sources.get(marker.slice(4)) : undefined);
}

export function unresolvedCitationMarkers(content: string, citations: CitationSource[]): string[] {
	const sources = citationRegistry(citations);
	return [...new Set([...content.matchAll(MARKER)].filter((m) => !lookup(m[1], sources)).map((m) => m[0]))];
}

function citationRegistry(citations: CitationSource[]): Map<string, CitationSource> {
	const sources = new Map<string, CitationSource>();
	for (const source of citations) {
		const prior = sources.get(source.id);
		if (prior && (prior.url !== source.url || prior.title !== source.title)) {
			throw new Error("Invalid Perplexity response: conflicting source ID");
		}
		sources.set(source.id, source);
	}
	return sources;
}

/** Validate a model-generated recap against the scoped registry; never infer a turn for [n]. */
export function normalizeRecapCitations(content: string, citations: CitationSource[]): {
	content: string; citations: CitationSource[]; unresolvedCitations: string[];
} {
	const registry = citationRegistry(citations);
	const unknown = new Set<string>();
	const used = new Map<string, CitationSource>();
	const normalized = content.replace(/\[((?:t\d+:)?(?:[a-z][a-z_]*:)?\d+)\]/g, (token, id: string) => {
		const source = registry.get(id);
		if (source) { used.set(id, source); return token; }
		unknown.add(token);
		return `[unresolved:${id}]`;
	});
	return { content: normalized, citations: [...used.values()], unresolvedCitations: [...unknown] };
}

export interface CitationTurn {
	role: "user" | "assistant";
	text: string;
	citations?: CitationSource[];
	responseId?: string;
	unresolvedCitations?: string[];
}

/**
 * Pure recap helper. Uses the 1-based transcript turn index as the namespace,
 * preserving two sources with the same URL but distinct provider IDs/turns.
 * Unknown markers are labelled, never guessed or remapped by position.
 * Feed returned turns AND registry to recap synthesis; recap must preserve IDs.
 */
export function scopeTranscriptCitations<T extends CitationTurn>(turns: T[]): {
	turns: T[]; citations: CitationSource[]; unresolvedCitations: string[];
} {
	const citations: CitationSource[] = [];
	const unresolvedCitations: string[] = [];
	const scoped = turns.map((turn, index) => {
		if (turn.role !== "assistant") return { ...turn };
		const scope = `t${index + 1}`;
		const sources = citationRegistry(turn.citations ?? []);
		const scopedSources = [...sources.values()].map((s) => ({ ...s, id: `${scope}:${s.id}` }));
		citations.push(...scopedSources);
		const unknown = new Set<string>();
		const text = turn.text.replace(MARKER, (token, marker: string) => {
			const source = lookup(marker, sources);
			if (source) return `[${scope}:${source.id}]`;
			unknown.add(`${scope}:${marker}`);
			return `[unresolved:${scope}:${marker}]`;
		});
		// Cancellation can leave markers that have not yet received sources.
		unresolvedCitations.push(...unknown);
		return { ...turn, text, citations: scopedSources, unresolvedCitations: [...unknown] };
	});
	return { turns: scoped, citations, unresolvedCitations };
}
