// ============================================================
// scoutos.live ports & adapters base client
// All persistence goes through /_ports/* with SCOUT_APP_JWT auth
// ============================================================

const TIMEOUT_MS = 8000;

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

export class PortsClient {
  private baseUrl: string;
  private jwt: string;

  constructor() {
    this.baseUrl = process.env.SCOUT_PORTS_URL ?? "http://127.0.0.1:3101/_ports";
    this.jwt = process.env.SCOUT_APP_JWT ?? "";
    if (!this.jwt) {
      console.warn("[ports] SCOUT_APP_JWT not set — port calls will fail auth");
    }
  }

  private get headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.jwt}`,
    };
  }

  async get<T>(path: string): Promise<T> {
    console.log(`[ports] GET ${path}`);
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`Port GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json() as T;
    console.log(`[ports] GET ${path} → ok`);
    return data;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    console.log(`[ports] POST ${path}`);
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Port POST ${path} failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json() as T;
    console.log(`[ports] POST ${path} → ok`);
    return data;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    console.log(`[ports] PATCH ${path}`);
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Port PATCH ${path} failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json() as T;
    console.log(`[ports] PATCH ${path} → ok`);
    return data;
  }

  async delete<T>(path: string): Promise<T> {
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`Port DELETE ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }
}

// Singleton
export const portsClient = new PortsClient();
