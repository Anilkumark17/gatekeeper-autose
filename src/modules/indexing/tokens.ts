const STOPWORDS = new Set([
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "for",
  "is",
  "on",
  "at",
  "by",
  "a",
  "an",
]);

const PART_RE =
	/[A-Z]+(?=[A-Z][a-z])|[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;

function partsOf(name: string): string[] {
	const out: string[] = [];
	for (const piece of name.split(/[_\-\s]+/)) {
		if (!piece) continue;
		const sub = piece.match(PART_RE);
		if (sub) out.push(...sub);
		else out.push(piece);
	}
	return out;
}

export function tokenize(names: string[]): string[] {
  const tokens = new Set<string>();
  for (const name of names) {
    for (const raw of partsOf(name)) {
      const token = raw.toLowerCase();
      if (token.length < 2) continue;
      if (STOPWORDS.has(token)) continue;
      tokens.add(token);
    }
  }
  return [...tokens].sort();
}