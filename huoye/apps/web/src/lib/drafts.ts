const prefix = "huoye:draft:";

export function loadDraft(path: string): string | null {
  try {
    return localStorage.getItem(prefix + path);
  } catch {
    return null;
  }
}

export function saveDraft(path: string, content: string): void {
  try {
    localStorage.setItem(prefix + path, content);
  } catch {
    // ignore quota
  }
}

export function clearDraft(path: string): void {
  try {
    localStorage.removeItem(prefix + path);
  } catch {
    // ignore
  }
}
