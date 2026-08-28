import type { Agent, AgentRun, Message, SystemInfo } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: (ownerId: string) =>
  request<{ agents: Agent[] }>("/api/agents?ownerId=" + encodeURIComponent(ownerId)),
  createAgent: (body: {
  name: string;
  description: string;
  instructions: string;
  ownerId: string;
}) =>
  request<{ agent: Agent }>("/api/agents", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string, requesterId: string) =>
  request<{ archivedWorkspace: string }>(
    "/api/agents/" + id + "?requesterId=" + encodeURIComponent(requesterId),
    { method: "DELETE" },
  ),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string, requesterId: string) =>
  request<{ run: AgentRun; message: Message }>(
    "/api/agents/" + id + "/messages",
    {
      method: "POST",
      body: JSON.stringify({ content, requesterId }),
    },
  ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  approveRun: (id: string, operatorName?: string, requesterId?: string) =>
  request<{ ok: boolean }>("/api/runs/" + id + "/approve", {
    method: "POST",
    body: JSON.stringify({ operatorName, requesterId }),
  }),
denyRun: (id: string, operatorName?: string, requesterId?: string) =>
  request<{ ok: boolean }>("/api/runs/" + id + "/deny", {
    method: "POST",
    body: JSON.stringify({ operatorName, requesterId }),
  }),
};
