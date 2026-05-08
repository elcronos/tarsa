const STORAGE_KEY = "tarsa.token";

export function initAuthToken(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (urlToken) {
      sessionStorage.setItem(STORAGE_KEY, urlToken);
      params.delete("token");
      const search = params.toString();
      const newUrl =
        window.location.pathname +
        (search ? `?${search}` : "") +
        window.location.hash;
      window.history.replaceState({}, "", newUrl);
    }
  } catch {
    // sessionStorage / history may be unavailable; remote auth simply won't work
  }
}

export function getAuthToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
