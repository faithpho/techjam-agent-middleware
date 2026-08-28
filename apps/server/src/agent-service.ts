import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
  RunSpan,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { CodexRunError } from "./codex-runner.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(ownerId?: string): Agent[] {
  const all = this.store
    .snapshot()
    .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return ownerId ? all.filter((agent) => agent.ownerId === ownerId) : all;
}

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  private assertOwner(agent: Agent, requesterId: string): void {
    if (agent.ownerId !== requesterId) {
      throw new HttpError(403, "You do not own this Agent");
    }
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerId: input.ownerId,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string, requesterId?: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    if (requesterId) this.assertOwner(agent, requesterId);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  async approveRun(runId: string, operatorName?: string, requesterId?: string): Promise<void> {
    const run = this.getRun(runId);
    if (run.status !== "pending_approval") {
      throw new HttpError(409, "This run is not pending approval");
    }
    const agent = this.getAgent(run.agentId);
    if (requesterId) this.assertOwner(agent, requesterId);
    const who = operatorName?.trim() || "unknown operator";
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      if (storedRun) {
        storedRun.spans = [...(storedRun.spans ?? []), {
          id: randomUUID(),
          category: "human_approval",
          label: "Human decision",
          detail: "Approved by " + who,
          status: "completed",
          createdAt: now(),
        }];
      }
    });
    const execution = this.executeRun(agent, run);
    this.activeExecutions.set(agent.id, execution);
    void execution.finally(() => {
      if (this.activeExecutions.get(agent.id) === execution) {
        this.activeExecutions.delete(agent.id);
      }
    }).catch(() => undefined);
  }

  async denyRun(runId: string, operatorName?: string, requesterId?: string): Promise<void> {
    const run = this.getRun(runId);
    if (requesterId) {
      const agent = this.getAgent(run.agentId);
      this.assertOwner(agent, requesterId);
    }
    const who = operatorName?.trim() || "unknown operator";
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === storedRun?.agentId);
      if (storedRun) {
        storedRun.status = "denied";
        storedRun.completedAt = now();
        storedRun.spans = [...(storedRun.spans ?? []), {
          id: randomUUID(),
          category: "human_approval",
          label: "Human decision",
          detail: "Denied by " + who,
          status: "blocked",
          createdAt: now(),
        }];
      }
      if (agent) agent.status = "ready";
    });
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    requesterId: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const agentCheck = this.getAgent(agentId);
    this.assertOwner(agentCheck, requesterId);

    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      spans: [],
      model: this.config.arkModel || null,
      runtimeProvider: this.config.runtimeProvider || null,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });

    const riskReason = this.getRiskReason(run.prompt);
    const policySpan: RunSpan = {
      id: randomUUID(),
      category: "policy_decision",
      label: "Prompt risk check",
      detail: riskReason ?? "No risky pattern matched — auto-allowed",
      status: riskReason ? "blocked" : "completed",
      createdAt: now(),
    };
    if (riskReason) {
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (storedRun) {
          storedRun.status = "pending_approval";
          storedRun.riskReason = riskReason;
          storedRun.spans = [...(storedRun.spans ?? []), policySpan];
        }
      });
      run.status = "pending_approval";
      run.riskReason = riskReason;
      run.spans = [policySpan];
      return { run, message };
    }

    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) storedRun.spans = [...(storedRun.spans ?? []), policySpan];
    });
    run.spans = [policySpan];

    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        storedRun.spans = [...(storedRun.spans ?? []), ...(result.spans ?? [])];
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      const extraSpans = error instanceof CodexRunError ? error.spans : [];
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          storedRun.spans = [...(storedRun.spans ?? []), ...extraSpans];
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }

  private getRiskReason(prompt: string): string | null {
    const riskyPatterns: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /rm\s+-rf/i, label: "destructive shell command (rm -rf)" },
      { pattern: /delete/i, label: "delete action" },
      { pattern: /drop\s+table/i, label: "database drop command" },
      { pattern: /\.env/i, label: "environment/secrets file access" },
      { pattern: /credentials/i, label: "credentials reference" },
      { pattern: /secret/i, label: "secret reference" },
    ];
    const match = riskyPatterns.find(({ pattern }) => pattern.test(prompt));
    return match ? match.label : null;
  }
}