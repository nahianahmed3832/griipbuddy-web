// Keep useful catalog terms while omitting inputs that resemble contact details,
// links, addresses with long numeric identifiers, or copied access tokens.
export function safeSearchQuery(input: string | undefined) {
  if (!input) return undefined;
  const term = input.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (!term || term.length > 100 || !/^[\p{L}\p{M}\p{N} .+&()'-]+$/u.test(term)) return undefined;
  if (/(?:\p{N}[().+ -]*){7}/u.test(term) || /[a-f0-9]{16,}/i.test(term) || /[a-z\d-]+\.[a-z]{2,}\b/i.test(term)) {
    return undefined;
  }
  return term;
}
