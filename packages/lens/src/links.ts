export const repositoryUrlPattern = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
export const sourceUrlPattern = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/(?:[a-f0-9]{40}|[a-f0-9]{64})\/[^\s<>"'()]+#L[1-9]\d*(?:-L[1-9]\d*)?$/;

export function sourceUrl(repository: string | undefined, revision: string, path: string, start: number, end: number, endColumn: number): string | undefined {
  if (!repository || !repositoryUrlPattern.test(repository) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) return undefined;
  const encoded = path.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  const finalLine = Math.max(start, endColumn === 1 && end > start ? end - 1 : end);
  return `${repository.replace(/\/$/, "")}/blob/${revision}/${encoded}#L${start}${finalLine > start ? `-L${finalLine}` : ""}`;
}
