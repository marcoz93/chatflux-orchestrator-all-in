// Máquina XState — 100% funcional, zero I/O, zero classes
import { assign, setup } from "xstate";

export const BOT_IDS = {
  TRI: "TRI",
  QUAL: "QUAL",
  REP: "REP",
  AGD: "AGD",
  ATD: "ATD",
} as const;

type BotId = (typeof BOT_IDS)[keyof typeof BOT_IDS];
type PerfilTipo = "lead_novo" | "retorno" | "cliente";

// Placeholder — a ser implementado na Fase 1
export const conversationMachine = setup({
  types: {
    context: {} as {
      readonly phone: string;
      readonly botAtual: BotId;
      readonly pilha: readonly BotId[];
      readonly perfilTipo: PerfilTipo;
    },
    events: {} as
      | { readonly type: "IDENTIFY"; readonly perfilTipo: PerfilTipo }
      | {
          readonly type: "SWITCH";
          readonly destino: string;
        }
      | { readonly type: "HANDOFF"; readonly motivo: string },
  },
  actions: {
    setBotAtual: assign({
      botAtual: ({ event }) =>
        event.type === "SWITCH" ? (event.destino as BotId) : "TRI",
    }),
  },
  guards: {
    isLeadNovo: ({ context }) => context.perfilTipo === "lead_novo",
  },
}).createMachine({
  id: "conversation",
  initial: "triagem",
  context: {
    phone: "",
    botAtual: "TRI" as BotId,
    pilha: [] as readonly BotId[],
    perfilTipo: "lead_novo" as PerfilTipo,
  },
  states: {
    triagem: {
      on: {
        IDENTIFY: [
          {
            guard: "isLeadNovo",
            target: "qualificacao",
            actions: "setBotAtual",
          },
        ],
      },
    },
    qualificacao: {},
    repescagem: {},
    agendamento: {},
    atendimento: {},
    handoff: { type: "final" },
  },
});
