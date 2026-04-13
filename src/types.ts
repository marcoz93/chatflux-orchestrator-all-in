import type { z } from "zod";
import type {
  HandoffEventSchema,
  IdentifyEventSchema,
  OrchestratorEventSchema,
  PhoneSchema,
  SwitchEventSchema,
} from "./schemas.js";

export type Phone = z.infer<typeof PhoneSchema>;
export type IdentifyEvent = z.infer<typeof IdentifyEventSchema>;
export type SwitchEvent = z.infer<typeof SwitchEventSchema>;
export type HandoffEvent = z.infer<typeof HandoffEventSchema>;
export type OrchestratorEvent = z.infer<typeof OrchestratorEventSchema>;

export const BOT_IDS = {
  TRI: "TRI",
  QUAL: "QUAL",
  REP: "REP",
  AGD: "AGD",
  ATD: "ATD",
} as const;

export type BotId = (typeof BOT_IDS)[keyof typeof BOT_IDS];

export type PerfilTipo = "lead_novo" | "retorno" | "cliente";

export interface Perfil {
  readonly nome: string | null;
  readonly tipo: PerfilTipo;
  readonly interesse: string | null;
  readonly objecoes: string | null;
  readonly ultimoProcedimento: string | null;
  readonly resumo: string | null;
}

export interface Bilhete {
  readonly versao: 1;
  readonly tipo: "transferencia" | "handoff";
  readonly de: BotId;
  readonly para: BotId | "HUM";
  readonly timestamp: number;
  readonly contexto: Partial<Perfil>;
  readonly pilha: readonly BotId[];
  readonly acao: "PUSH" | "POP" | "CLEAR" | "PEEK";
}
