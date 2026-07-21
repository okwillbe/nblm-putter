// NotebookLM に既に存在するソース名を除外し、新規に追加すべき名前だけを返す。
// 突き合わせは完全一致。uploaded の順序を保つ。
export function filterNewSources(uploaded: string[], existing: string[]): string[] {
  const existingSet = new Set(existing)
  return uploaded.filter(name => !existingSet.has(name))
}
