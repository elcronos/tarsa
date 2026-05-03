/**
 * Extract a 1-2 line brief from a prompt string.
 * Strategy (in order):
 *  1. First markdown H1/H2 heading (## Heading or # Heading)
 *  2. First non-empty line, truncated at 150 chars
 *  3. First sentence ending in period, truncated at 150 chars
 */
export function extractBrief(prompt: string): string {
  const MAX = 150;

  // 1. Check for a leading H1 or H2 heading
  const headingMatch = prompt.match(/^#{1,2}\s+(.+)/m);
  if (headingMatch) {
    return headingMatch[1]!.slice(0, MAX);
  }

  // 2. First non-empty line
  const lines = prompt.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed.slice(0, MAX);
    }
  }

  // 3. First sentence ending in a period
  const sentenceMatch = prompt.match(/([^.!?]+[.!?])/);
  if (sentenceMatch) {
    return sentenceMatch[1]!.trim().slice(0, MAX);
  }

  return prompt.trim().slice(0, MAX);
}
