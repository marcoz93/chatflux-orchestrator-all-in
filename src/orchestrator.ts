// Única class permitida — exigência da Cloudflare
import { DurableObject } from "cloudflare:workers";

interface Env {
  ORCHESTRATOR: DurableObjectNamespace;
}

export class ConversationOrchestrator extends DurableObject<Env> {
  async getState(): Promise<{ status: string }> {
    return { status: "ok" };
  }
}
