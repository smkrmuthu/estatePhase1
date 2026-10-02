/**
 * API CLIENT — talks to the Worker at /api/v1 on the same domain.
 * Keeps the sign-in token in localStorage; any 401 sends the user back to sign-in.
 */
const Api = (() => {
  const BASE = "/api/v1";
  const TOKEN_KEY = "estate:token";
  let onUnauthorized = () => {};

  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
  const setToken = t => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* private mode */ } };

  class ApiError extends Error {
    constructor(message, status, code, field) { super(message); this.status = status; this.code = code; this.field = field; this.userFacing = true; }
  }

  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { "Content-Type": "application/json", ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new ApiError("Can't reach the server. Check your internet connection and try again.", 0, "network");
    }
    const data = await res.json().catch(() => null);
    if (res.status === 401 && path !== "/auth/password") {
      setToken(null);
      onUnauthorized(data && data.error ? data.error.message : "Please sign in again.");
    }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new ApiError(err.message || `Request failed (${res.status})`, res.status, err.code, err.field);
    }
    return data;
  }

  // CSV exports need the auth header, so fetch them and hand the browser a file.
  async function download(path, filename) {
    const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new ApiError("Export failed", res.status);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function login(loginName, password) {
    const r = await request("POST", "/auth/password", { login: loginName, password });
    setToken(r.access);
    return r.user;
  }

  return {
    get: p => request("GET", p),
    post: (p, b) => request("POST", p, b === undefined ? {} : b),
    put: (p, b) => request("PUT", p, b),
    patch: (p, b) => request("PATCH", p, b),
    download, login,
    logout: () => setToken(null),
    hasToken: () => !!getToken(),
    onUnauthorized: fn => { onUnauthorized = fn; }
  };
})();
