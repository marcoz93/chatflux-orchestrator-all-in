import { z } from "zod";

export const PhoneSchema = z.string().regex(/^\+?\d{10,15}$/);

export const IdentifyEventSchema = z.object({
  type: z.literal("IDENTIFY"),
});

export const SwitchEventSchema = z.object({
  type: z.literal("SWITCH"),
  destino: z.string(),
  contexto: z.string().optional(),
  pilha_push: z.string().optional(),
  pilha_clear: z.boolean().optional(),
});

export const HandoffEventSchema = z.object({
  type: z.literal("HANDOFF"),
  motivo: z.string(),
});

export const OrchestratorEventSchema = z.discriminatedUnion("type", [
  IdentifyEventSchema,
  SwitchEventSchema,
  HandoffEventSchema,
]);
