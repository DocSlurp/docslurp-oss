// Diagnostic inverse of the server's alternating front/back presentation order.
// Valid only for a complete response without subsequent pinning/filtering.
export function reconstructRelevanceOrder(results) {
  const restored = [];
  for (let rank = 0; rank < results.length; rank++) {
    restored.push(results[rank % 2 === 0 ? rank / 2 : results.length - 1 - Math.floor(rank / 2)]);
  }
  return restored;
}
