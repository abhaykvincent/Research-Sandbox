// Milestone 4 preview: cosine similarity helper for the embedding inspector.
// Kept here now so M2 results can be compared manually in the console.
export function cosineSimilarity(a, b) {
  if (!a?.length || a.length !== b?.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
