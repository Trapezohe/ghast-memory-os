const QUERY_TERM_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "did",
  "different",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "many",
  "me",
  "mine",
  "much",
  "my",
  "of",
  "on",
  "or",
  "our",
  "ours",
  "she",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "they",
  "this",
  "to",
  "us",
  "user",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
]);

export function queryTerms(query: string, max = 16): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const rawTerm of query
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)) {
    const term = rawTerm.trim();
    if (!term || QUERY_TERM_STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    output.push(term);
    if (output.length >= max) break;
  }
  return output;
}
