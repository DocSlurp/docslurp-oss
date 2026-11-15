/** ECMAScript whitespace and non-whitespace runs, without per-character/word arrays. */
export function countWhitespaceAndWords(text: string): { whitespaceCount: number; words: number } {
  let whitespaceCount = 0;
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const whitespace = code === 32 || (code >= 9 && code <= 13)
      || (code > 127 && /\s/.test(text[i]!));
    if (whitespace) {
      whitespaceCount += 1;
      inWord = false;
    } else {
      if (!inWord) words += 1;
      inWord = true;
    }
  }
  return { whitespaceCount, words };
}
