---
title: "feat: ChatFlux Orchestrator — Actor Machine (XState + Durable Objects)"
type: feat
date: 2026-04-13
---

# ChatFlux Orchestrator — Actor Machine

## Overview

Orquestrador multi-agente para a Estetic Doctor (Isabela) usando XState como motor de
estados e Cloudflare Durable Objects como runtime. Substitui o plano anterior de Worker
stateless + KV por uma arquitetura stateful com persistência SQLite, single-threaded
por conversa, e transições validadas pelo XState.

**Subsunção do actor-kit**: absorvemos o padrão (XState + DO + persistência automática)
mas usamos APIs nativas da Cloudflare (RPC + SQLite) em vez do `@actor-kit/worker`,
que usa o padrão antigo (fetch handler + KV storage).

## Problem Statement

A Isabela atual tem prompt de 15 seções num bot só. O plano multi-agente
(docs/plans/2026-04-13-feat-multiagent-isabela-orchestration-plan.md) define 5 bots +
1 Worker orquestrador. O Worker precisa de:

1. Estado persistente por conversa (perfil, pilha, bot atual)
2. Transições validadas (20 transições válidas, rejeitar inválidas)
3. Side-effects atômicos (trocar bot + enviar bilhete + persistir = 1 transação)
4. Zero race conditions (2 msgs simultâneas não corrompem pilha)

## Inventário de Recursos Existentes

### Cloudflare (já deployados)

| Recurso | ID/Nome | Status | Papel |
|---------|---------|--------|-------|
| D1 `estetic-doctor-state` | `477265d4-...` | 3 conversas teste | Migra → SQLite no DO |
| D1 `crm-verde-api-crm-verde-db-production` | `cedeaa43-...` | 205 endpoints | Referência API agenda |
| KV `crm-verde-api-crm-verde-cache-production` | `efdf408457e3...` | Vazio | Cache ORDS sessions |
| KV `CLINIC_DATA` | `64e1474f5cca...` | Dados clínica | Leitura estática |
| KV `CHATFLUX_LOOKUP` | `757860d50bfd...` | Lookup | Resolve IDs |
| Worker `crm-verde-api` | v3 (07/04) | Ativo | Scouting ORDS (leitura avançada futura) |
| Worker `clinic-config` | `clinic-config.marcus-80b.workers.dev` | **Ativo — testado 2026-04-13** | **API oficial de agendamento** |

### API Oficial de Agendamento — `clinic-config` Worker (PRODUÇÃO)

Worker já deployado e testado em produção (workspace v1pF23). Todos os bots chamam este Worker para agendamento.

```
POST https://clinic-config.marcus-80b.workers.dev/crm/action
Authorization: Bearer clinic-config-secret-2026
Content-Type: application/json
```

| Action | Params obrigatórios | Resposta |
|--------|---------------------|----------|
| `listar_horarios` | `data` (opcional) | `{ success, slots: [{ data, dia, horarios: ["13:00",...] }], say }` |
| `agendar` | `nome, data, horario, telefone` | `{ success, id_agendamento, id_paciente, say }` |
| `cancelar` | `id_agendamento` | `{ success, id_agendamento, say }` |
| `reagendar` | `id_agendamento, ...` | Params TBD |
| `buscar_paciente` | `telefone` | `{ success, found, id_paciente, nome, say }` |

**Separação de responsabilidades:**
- **`clinic-config` Worker** → agendamento, busca de paciente. Usado pelos bots (MiniRacer).
- **`crm-verde-api` Worker** → scouting dos endpoints ORDS do Prontuário Verde. Uso interno/futuro para leituras avançadas (histórico, prontuário). **Não é usado para agendamento.**

### API Prontuário Verde (ORDS) — Scouting Interno (futuro)

```
POST /ords/prontuario/agendaProfissional/buscar
Content-Type: application/x-www-form-urlencoded
Params: cliente_id, unidade_id, profissional_id, validade, checksum, usu_login_id, start, end
Host: app.prontuarioverde.com.br
```

Mapeado via `crm-verde-api` Worker. Não usado no fluxo de agendamento atual.

### D1 estetic-doctor-state — Schema atual (a migrar)

```sql
CREATE TABLE conversation_state (
  phone TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL,       -- JSON XState snapshot
  current_state TEXT NOT NULL,  -- ex: "greeting", "scheduling"
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Referências do Plano Multi-Agente

- 5 bots: TRI, QUAL, REP, AGD, ATD
- 20 transições válidas (FSM completa na PARTE 5 do plano)
- Sistema de bilhetes (comunicação inter-bots via `role: "tool"`)
- ChatFlux API Next: assign-automation, send-assistant-message, toggle-automation-enabled
- ChatFlux API v1: resolver conversation_id por phone

## Decisão Arquitetural: XState nativo + DO nativo (não actor-kit)

### Por que NÃO usar `@actor-kit/worker` diretamente

| Aspecto | actor-kit | CF nativo | Decisão |
|---------|-----------|-----------|---------|
| DO handler | `fetch()` (legado) | RPC methods (moderno) | **RPC** — tipado, sem HTTP boilerplate |
| Storage | KV async (`put`/`get`) | SQLite sync (`sql.exec`) | **SQLite** — atômico, queryável |
| Client | WebSocket + React | HTTP POST (MiniRacer) | **HTTP** — MiniRacer é síncrono |
| Dependência | `@actor-kit/worker` (~1.5k stars) | Zero deps extras | **Nativo** — sem risco de abandono |
| Testes | FakeStorage custom | `@cloudflare/vitest-pool-workers` | **Oficial** — melhor suporte |

### O que pegamos do actor-kit (subsunção conceitual)

1. **XState como motor** — `xstate` como dependência direta
2. **1 DO por entidade** — `getByName(phone)` = 1 instância por conversa
3. **Persistência de snapshots** — salvamos `machine.getPersistedSnapshot()` no SQLite
4. **Eventos tipados com Zod** — validação na entrada do DO
5. **Contexto público/privado** — separação de estado por tipo de caller

### O que NÃO pegamos

1. `createMachineServer` — fazemos o DO nativo com RPC
2. `createActorKitRouter` — nosso fetch handler é simples (3 rotas POST)
3. `@actor-kit/browser` — não temos frontend
4. `fromActorKit` (DO-to-DO) — futuro, se necessário

## Arquitetura

```
WhatsApp → ChatFlux → Bot (MiniRacer) → request("POST /identify")
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │  CF Worker        │
                                    │  fetch handler    │
                                    │                   │
                                    │  POST /identify   │
                                    │  POST /switch     │
                                    │  POST /handoff    │
                                    │  POST /status     │
                                    │  GET  /health     │
                                    └────────┬─────────┘
                                             │ env.ORCHESTRATOR.getByName(phone)
                                             ▼
                                    ┌──────────────────┐
                                    │  Durable Object   │
                                    │  (1 por phone)    │
                                    │                   │
                                    │  XState FSM       │  ← 20 transições
                                    │  SQLite storage   │  ← snapshot persistido
                                    │  RPC methods      │  ← tipados
                                    │                   │
                                    │  Side-effects:    │
                                    │  → ChatFlux API   │  assign-automation
                                    │  → send-assistant  │  send-assistant-message
                                    │  → API v1 ChatFlux  │  resolver conversation_id
                                    └──────────────────┘
```

## Estrutura de Diretórios

```
workers/chatflux-orchestrator/
├── wrangler.jsonc                     # Config DO + SQLite + secrets
├── package.json                       # xstate, zod, deps
├── tsconfig.json
├── vitest.config.ts                   # @cloudflare/vitest-pool-workers
├── biome.json                         # Regras de lint/format
├── .dependency-cruiser.cjs            # Regras de dependência
├── src/
│   ├── index.ts                       # Worker fetch handler (router)
│   ├── orchestrator.ts                # Durable Object class (RPC methods)
│   ├── machine.ts                     # XState machine definition (20 transições)
│   ├── schemas.ts                     # Zod schemas para eventos
│   ├── types.ts                       # TypeScript types
│   ├── migrations.ts                  # SQLite schema migrations
│   └── services/
│       ├── chatflux-api.ts            # JWT login, assign-automation, send-assistant-message
│       ├── clinic-api.ts             # Agendamento via clinic-config Worker (/crm/action)
│       └── crm-verde.ts              # Scouting ORDS Prontuário Verde (uso interno/futuro)
└── tests/
    ├── machine.test.ts                # XState puro — transições, guards, actions
    ├── orchestrator.test.ts           # DO integration — RPC + SQLite persistence
    ├── chatflux-api.test.ts           # Mocks de API
    └── e2e.test.ts                    # End-to-end com wrangler dev
```

## Guardrails de Código

### biome.json — Regras aplicadas

```json
{
  "linter": {
    "rules": {
      "style": {
        "noVar": "error",
        "noParameterAssign": "error"
      },
      "suspicious": {
        "noExplicitAny": "error"
      },
      "complexity": {
        "noForEach": "warn"
      }
    }
  }
}
```

**Nota**: `noEnum` e proibição de `class` são aplicados via hook (abaixo), não via biome (biome não tem regra de enum nativa).

### guard-functional-ts.sh — Hook PostToolUse

Hook que roda após cada edição em `workers/chatflux-orchestrator/src/`. Bloqueia:
- `enum` (usar `const` objects + `as const` em vez de enum TypeScript)
- `class` (exceto em `orchestrator.ts` — DO precisa de class)
- `var` em arquivos `.ts` (permitido apenas em MiniRacer `.js`)
- `any` explícito
- `this.` fora de `orchestrator.ts`

### dependency-cruiser — Regras de camadas

```
machine.ts      ← sem imports de services/ (pura, testável isolada)
services/       ← sem imports de machine.ts (camada de I/O)
orchestrator.ts ← pode importar ambos
index.ts        ← só importa orchestrator.ts e schemas.ts
```

Sem ciclos. Violations bloqueiam CI.

### npm scripts adicionais

```json
"gate:orchestrator": "biome check src/ && tsc --noEmit && vitest run",
"lint:functional":   "bash tools/guard-functional-ts.sh src/",
"lint:deps":         "depcruise src/ --config .dependency-cruiser.cjs"
```

## Fases de Implementação (Vertical Slices)

### Princípio: cada fase é testável end-to-end com o mundo real

```
Fase 0  ── scaffold + health check         ─→ wrangler dev + curl /health ✓
Fase 1  ── XState machine puro             ─→ vitest unit tests ✓
Fase 2  ── DO + SQLite + persistence       ─→ vitest pool-workers ✓
Fase 3  ── ChatFlux API client             ─→ teste real com JWT + API Next ✓
Fase 4  ── Router + rotas completas        ─→ wrangler dev + curl POST ✓
Fase 5  ── Deploy + MiniRacer functions    ─→ npm run test:function ✓
Fase 6  ── E2E com bots reais             ─→ WhatsApp real ✓
```

---

### Fase 0: Scaffold + Health Check

**Objetivo**: Worker deployável com DO vazio. Valida que toda a infra funciona.

**Critério de aceite**: `curl https://chatflux-orchestrator.marcus-80b.workers.dev/health` → `"ok"`

**Teste real**: `wrangler dev` local + `curl localhost:8787/health`

**Tarefas**:

- [ ] `wrangler init workers/chatflux-orchestrator` com template typescript
- [ ] Configurar `wrangler.jsonc`:
  ```jsonc
  {
    "name": "chatflux-orchestrator",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-13",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
      "bindings": [
        { "name": "ORCHESTRATOR", "class_name": "ConversationOrchestrator" }
      ]
    },
    "migrations": [
      { "tag": "v1", "new_sqlite_classes": ["ConversationOrchestrator"] }
    ],
    "observability": {
      "enabled": true,
      "traces": {
        "enabled": true,
        "head_sampling_rate": 1
      }
    }
  }
  ```
- [ ] `src/index.ts` — fetch handler mínimo (health + route pro DO)
- [ ] `src/orchestrator.ts` — DO class vazia que responde `getState()` via RPC
- [ ] `package.json` com `xstate`, `zod`, `@cloudflare/vitest-pool-workers`
- [ ] `vitest.config.ts` com pool-workers e miniflare:
  ```typescript
  export default defineWorkersConfig({
    test: {
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            durableObjects: { ORCHESTRATOR: "ConversationOrchestrator" }
          }
        }
      }
    }
  });
  ```
- [ ] Deploy com `wrangler deploy`
- [ ] Teste: `curl /health` retorna 200

**Referências**:
- CF DO skill: `references/rules.md` (wrangler config, basic pattern)
- actor-kit example: `examples/nextjs-actorkit-todo/src/server.ts` (inspiração router)

---

### Fase 1: XState Machine Pura (sem DO)

**Objetivo**: A FSM das 20 transições rodando em vitest puro. Sem Cloudflare, sem DO.

**Critério de aceite**: Todos os cenários de fluxo passam em vitest:
- Lead novo: triagem → qualificacao → agendamento → triagem
- Lead retorno: triagem → repescagem → agendamento → triagem
- Cliente: triagem → atendimento → agendamento → triagem
- Dúvida no AGD: agendamento → qualificacao → agendamento → triagem (pilha)
- Handoff: qualquer → handoff (final)
- Transição inválida: rejeitada silenciosamente

**Teste real**: `npx vitest run tests/machine.test.ts`

**Tarefas**:

- [ ] `src/machine.ts` — XState machine com `setup()`:
  - States: `triagem`, `qualificacao`, `repescagem`, `agendamento`, `atendimento`, `handoff`
  - Events: `IDENTIFY`, `SWITCH`, `HANDOFF`
  - Context: `phone`, `botAtual`, `pilha[]`, `perfil{}`, `conversationId`, `lastTransition`
  - Guards: `isLeadNovo`, `isRetorno`, `isCliente`, destination guards
  - Actions: `pushPilha`, `popPilha`, `clearPilha`, `setBotAtual`, `updatePerfil`
- [ ] `src/schemas.ts` — Zod schemas:
  - `IdentifyEventSchema` — `{ type: "IDENTIFY" }`
  - `SwitchEventSchema` — `{ type: "SWITCH", destino, contexto?, pilha_push?, pilha_clear? }`
    ```typescript
    destino: z.enum(["TRI", "QUAL", "REP", "AGD", "ATD", "PILHA_POP", "PILHA_PEEK"])
    ```
    `PILHA_POP` desempilha e vai pro estado anterior. `PILHA_PEEK` consulta o topo sem desempilhar.
  - `HandoffEventSchema` — `{ type: "HANDOFF", motivo }`
  - `PerfilSchema` — nome, tipo, interesse, objecoes, ultimoProcedimento, resumo
- [ ] `src/types.ts` — tipos TypeScript derivados dos schemas
- [ ] `tests/machine.test.ts` — 10+ testes:
  1. Estado inicial é `triagem`
  2. IDENTIFY com lead_novo → `qualificacao`
  3. IDENTIFY com retorno → `repescagem`
  4. IDENTIFY com cliente → `atendimento`
  5. SWITCH(AGD) em qualificacao → `agendamento` + pilha push
  6. SWITCH(TRI) em qualificacao → `triagem` + pilha clear
  7. SWITCH(PILHA_POP) em agendamento → volta pro anterior
  8. HANDOFF em qualquer estado → `handoff`
  9. Evento inválido no estado → sem transição
  10. Pilha funciona em sequência: QUAL → AGD → QUAL → AGD → TRI

**Referências**:
- Plano multi-agente: PARTE 5 (20 transições, diagrama de fluxo)
- actor-kit machine: `examples/nextjs-actorkit-todo/src/todo.machine.ts` (setup pattern)
- actor-kit types: `examples/nextjs-actorkit-todo/src/todo.types.ts` (event discriminated unions)

---

### Fase 2: Durable Object + SQLite Persistence

**Objetivo**: DO que roda a máquina XState, persiste snapshots em SQLite, e responde via RPC.

**Critério de aceite**: Teste vitest com pool-workers:
- Cria DO por phone via `getByName()`
- Envia evento IDENTIFY → estado muda
- Reinicia DO (simula cold start) → estado restaurado do SQLite
- Dois DOs com phones diferentes são independentes

**Teste real**: `npx vitest run tests/orchestrator.test.ts`

**Tarefas**:

- [ ] `src/migrations.ts` — schema SQLite (atômico com BEGIN/COMMIT):
  ```sql
  BEGIN;
  CREATE TABLE IF NOT EXISTS conversation (
    phone TEXT PRIMARY KEY,
    machine_snapshot TEXT NOT NULL,  -- JSON: getPersistedSnapshot()
    current_state TEXT NOT NULL,     -- ex: "qualificacao"
    bot_atual TEXT NOT NULL,         -- ex: "QUAL"
    pilha TEXT NOT NULL DEFAULT '[]',
    perfil TEXT NOT NULL DEFAULT '{}',
    conversation_id TEXT,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transition_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT,
    request_id TEXT,                 -- idempotência
    bilhete TEXT,
    api_error TEXT,                  -- erro da ChatFlux API (se ocorreu)
    id_agendamento TEXT,             -- retornado por clinic-config /crm/action agendar
    id_paciente TEXT,                -- retornado por clinic-config /crm/action agendar
    verified BOOLEAN DEFAULT NULL,   -- NULL = não-swap (IDENTIFY sem troca, HANDOFF) | true = swap confirmado | false = falhou
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_tlog_phone_ts ON transition_log(phone, created_at DESC);
  INSERT INTO _migrations (id) VALUES (1);
  COMMIT;
  ```
- [ ] `src/orchestrator.ts` — Durable Object class:
  ```typescript
  export class ConversationOrchestrator extends DurableObject<Env> {
    private machine: Actor<typeof conversationMachine> | null = null;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      ctx.blockConcurrencyWhile(async () => {
        this.migrate();
        this.restoreOrCreateMachine();
      });
    }

    // RPC: identificar perfil e rotear
    async identify(phone: string): Promise<Bilhete> { ... }

    // RPC: trocar bot
    async switchBot(payload: SwitchPayload): Promise<Bilhete> { ... }

    // RPC: handoff pra humano
    async handoff(payload: HandoffPayload): Promise<Bilhete> { ... }

    // RPC: consultar estado atual
    async getState(): Promise<OrchestratorState> { ... }
  }
  ```
- [ ] Persistência: após cada transição XState, seguir **obrigatoriamente** esta ordem:
  ```typescript
  // PADRÃO MANDATÓRIO em todo método RPC (identify, switchBot, handoff)
  machine.send(event);                          // 1. transição XState (síncrono)
  persistSnapshot();                            // 2. SQLite write (síncrono, sem await)
  await chatfluxApi.assignAutomation(...);      // 3. fetch externo (abre input gates OK — estado já salvo)
  ```
  **Nunca inverter a ordem.** O fetch externo abre input gates do DO; se crashar antes do
  `persistSnapshot()`, o estado fica inconsistente. SQLite sync garante atomicidade.
  - `machine.getPersistedSnapshot()` → JSON → SQLite
  - No constructor: restaurar do SQLite → `createActor(machine, { snapshot })`
- [ ] Transition log: toda transição grava em `transition_log` com `request_id` (auditoria + idempotência)
- [ ] **Alarm de inatividade** (7 dias):
  ```typescript
  // Após cada transição bem-sucedida:
  await this.ctx.storage.setAlarm(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Handler do alarm:
  async alarm(): Promise<void> {
    // Arquivar/resetar conversas inativas >7 dias
    this.ctx.storage.sql.exec(
      "UPDATE conversation SET current_state = 'triagem' WHERE updated_at < ?",
      Date.now() - 7 * 24 * 60 * 60 * 1000
    );
    // Log de arquivamento
    console.log("Alarm: conversa arquivada por inatividade");
  }
  ```
- [ ] **Idempotência via request_id**: antes de processar qualquer evento, verificar:
  ```typescript
  const existing = this.ctx.storage.sql
    .exec("SELECT bilhete FROM transition_log WHERE request_id = ?", requestId)
    .one();
  if (existing) return JSON.parse(existing.bilhete as string); // cache hit
  ```
  O `request_id` deve ser enviado pelo caller (MiniRacer function) e gravado no `transition_log`.
- [ ] `tests/orchestrator.test.ts` — 8+ testes:
  1. DO criado com phone via getByName
  2. `identify()` muda estado e persiste
  3. Cold start restaura estado do SQLite
  4. `switchBot()` com pilha funciona
  5. `handoff()` → estado final
  6. `getState()` retorna estado correto
  7. Transition log gravado com request_id
  8. Dois phones diferentes são DOs independentes
  9. request_id duplicado retorna bilhete cacheado (idempotência)
  10. Alarm registrado após transição

**Referências**:
- CF DO skill: `references/rules.md` (SQLite, migrations, blockConcurrencyWhile)
- CF DO skill: `references/testing.md` (vitest-pool-workers, runInDurableObject)
- D1 estetic-doctor-state: schema atual (conversation_state) como ponto de partida
- XState docs: `getPersistedSnapshot()`, `createActor({ snapshot })`

**Gotcha crítico (do learnings-research)**:
- SQLite `sql.exec` é SÍNCRONO — sem await entre writes = atômico
- `blockConcurrencyWhile` SOMENTE no constructor — nunca em requests
- Fetch externo abre input gates (race condition possível) — persistir ANTES de chamar API

---

### Fase 3: ChatFlux API Client + Resolução conversation_id

**Objetivo**: Módulo que fala com a ChatFlux API Next + resolve conversation_id via D1. Testável isoladamente.

**Critério de aceite**: Script de teste local que:
- Faz login JWT e obtém token
- Resolve conversation_id a partir de phone (D1 chatflux-stats)
- Chama assign-automation numa conversa de teste
- Chama send-assistant-message
- Toggle automation-enabled
- Tudo com retry em 401 (JWT expirado → renovar)

**Teste real**: `npx tsx tests/chatflux-api.manual.ts` (script que chama API real do alpha)

**Resolução de conversation_id — Via API v1 ChatFlux (sem MongoDB, sem D1 externo)**:

O ChatFlux tem endpoint de listagem de conversas que retorna `id` (= conversation_id)
+ `phone_number` por conversa. O Worker CLI já usa isso (linha 51 do worker/src/index.js):

```
GET /api/v1/conversations/{workspace}?page={N}
Headers: cookie: {session_cookie}, User-Agent: ..., hx-request: true
Response: [{ id: "69ce6a9b...", phone_number: "5531999990001", ... }, ...]
```

O orchestrator DO resolve conversation_id assim:
1. Chama API v1 `/api/v1/conversations/{workspace}?page=1`
2. Filtra pelo `phone_number` no array retornado
3. Se não achar na page 1, tenta pages 2-5
4. Cacheia no SQLite do DO (TTL 1h)

**Zero dependência extra. Mesma API que o CLI já usa.**

**Tarefas**:

- [ ] `src/services/chatflux-api.ts`:
  - `login(email, password)` → JWT token (cookie `auth_token`)
  - `resolveConversationId(phone, workspace, token)` → busca na API v1 conversations
  - `assignAutomation(conversationId, botId, token)` → troca bot
  - `sendAssistantMessage(conversationId, token)` → trigger novo bot
  - `toggleAutomation(conversationId, enabled, token)` → liga/desliga IA
  - `verifySwap(conversationId, expectedBotName, token)` → confirma que o swap funcionou:
    - Chama `GET /conversation/{id}/status` no ChatFlux CLI Worker
      (endpoint já implementado em `tools/chatflux-cli/worker/src/index.js`)
    - Retorna `{ verified: boolean, organizationName: string, automationEnabled: boolean, lastMessageRole: string, ageSeconds: number }`
    - `verified = true` se TODOS passam: `organizationName === expectedBotName`, `automationEnabled === true`, `lastMessageRole === "assistant"`, `ageSeconds < 30`
    - `verified = false` se qualquer check falhar
  - Cache de JWT: token cacheado no SQLite do DO (sobrevive eviction). Re-login automático se token expirado ou DO reiniciado.
  - Cache de conversation_id: cacheado no SQLite do DO (TTL 1h)
  - Auto-retry: se 401, renovar JWT e retry 1x
- [ ] `src/services/clinic-api.ts` — cliente do `clinic-config` Worker:
  - `listarHorarios(data?)` → `POST /crm/action` com `action: "listar_horarios"`
  - `agendar(nome, data, horario, telefone)` → `action: "agendar"` → retorna `{ id_agendamento, id_paciente, say }`
  - `cancelar(idAgendamento)` → `action: "cancelar"`
  - `buscarPaciente(telefone)` → `action: "buscar_paciente"`
  - Auth: `Authorization: Bearer clinic-config-secret-2026` (secret no wrangler)
  - **Não é stub** — API já funciona em produção

- [ ] `src/services/crm-verde.ts` (leitura avançada futura):
  - `buscarHistorico(params)` → POST ORDS agendaProfissional/buscar
  - Placeholder — não usado no fluxo de agendamento atual

**ATENÇÃO: Base path da API Next é `/api/next/next/` (duplo "next"), NÃO `/api/next/`.**
Verificado empiricamente em 2026-04-13: single `/api/next/` retorna 401 em todos os endpoints.

**Referências**:
- D1 chatflux-stats: tabela conversations (schema verificado 2026-04-13)
  - Colunas: conversation_id, workspace, phone_number, user_name, bot, status, synced_at
  - 2021 registros, workspaces: Dd8F3m, NMLFx0 (v1pF23 será populado quando sync rodar)
- Plano multi-agente: PARTE 8 (endpoints exatos da API Next, verificados via SSH)
  - 8.1: Login JWT (POST /api/next/next/login)
  - 8.5: assign-automation (POST /api/next/next/assign-automation)
  - 8.6: send-assistant-message (POST /api/next/next/send-assistant-message)
  - 8.13: send-assistant-message é SEGURO (não desativa automation)
- Memory: `reference_chatflux_rails_internals.md` (ALL endpoints)
- Learnings: ChatFlux CLI Worker multi-workspace pattern (cookie não é bound a workspace)
- Learnings: automation_enabled é o ÚNICO campo que importa (automation_paused é morto)
- **CLI Worker discovery** (`tools/chatflux-cli/worker/src/index.js`):
  - `GET /bots` — lista todos os bots do workspace (id, uuid, name) via `/api/v1/conversations/{ws}/self_filter`
  - `GET /conversation/{id}/status` — estado atual: bot ativo, automation_enabled, last_message, age_seconds
  - Usado pelo `verifySwap()` — endpoint já implementado, sem necessidade de criar novo
  - Checklist de verificação confirmado: `organization_name`, `automation_enabled`, `last_message.role`, `age_seconds`
  - Incident documentado: `send-assistant-message` disparado no bot errado sem verificação prévia
  - Ref: `docs/solutions/integration-issues/chatflux-worker-api-gaps-20260413.md`

**Gotchas críticos**:
- `send-message` DESATIVA automation_enabled → NUNCA usar sem toggle depois
- `send-assistant-message` NÃO desativa → PREFERIR sempre
- `assign-automation` NÃO altera automation_enabled → seguro
- JWT vem como cookie `auth_token` no Set-Cookie header

---

### Fase 4: Router + Rotas Completas + Bilhetes

**Objetivo**: Worker completo com 5 rotas que despacham pro DO via RPC. Testável com curl.

**Critério de aceite**: Com `wrangler dev` rodando:
```bash
# Health
curl localhost:8787/health → "ok"

# Identify lead novo
curl -X POST localhost:8787/identify \
  -H "Content-Type: application/json" \
  -d '{"phone":"5531999000001"}' \
  → { "success": true, "say": "Oi!...", "bilhete": {...}, "tipo": "lead_novo" }

# Switch pro AGD
curl -X POST localhost:8787/switch \
  -H "Content-Type: application/json" \
  -d '{"phone":"5531999000001","destino":"AGD","pilha_push":"QUAL","contexto":"Quer agendar"}' \
  → { "success": true, "say": "...", "bilhete": {...} }

# Status
curl -X POST localhost:8787/status \
  -d '{"phone":"5531999000001"}' \
  → { "phone": "...", "state": "agendamento", "bot": "AGD", "pilha": ["TRI","QUAL"] }
```

**Teste real**: `wrangler dev` + script curl, COM side-effects reais (API ChatFlux alpha)

**Tarefas**:

- [ ] `src/index.ts` — Router como `WorkerEntrypoint`:
  ```typescript
  import { WorkerEntrypoint } from "cloudflare:workers";

  export default class extends WorkerEntrypoint<Env> {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok");

      // Health check profundo: JWT + ChatFlux API + DO instanciável
      if (url.pathname === "/healthz/deep") { /* ver seção Observabilidade */ }

      // Métricas do transition_log (últimas 24h por estado)
      if (url.pathname === "/metrics") { /* ver seção Observabilidade */ }

      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

      const body = await request.json<{ phone: string }>();

      // Validação Zod ANTES de despachar pro DO
      const parsed = PhoneSchema.safeParse(body.phone);
      if (!parsed.success) return Response.json({ error: "invalid phone" }, { status: 400 });

      const stub = this.env.ORCHESTRATOR.getByName(parsed.data);

      switch (url.pathname) {
        case "/identify": return Response.json(await stub.identify(parsed.data, body.request_id));
        case "/switch":   return Response.json(await stub.switchBot({ ...body, phone: parsed.data }));
        case "/handoff":  return Response.json(await stub.handoff(body));
        case "/status":   return Response.json(await stub.getState());
        default:          return new Response("Not found", { status: 404 });
      }
    }
  }
  ```
  Onde `PhoneSchema = z.string().min(10).max(15).regex(/^\d+$/)` (definido em `schemas.ts`).
- [ ] Integrar ChatFlux API nos side-effects do DO (respeitando **padrão obrigatório** de ordem):
  ```typescript
  // Exemplo em switchBot() — MESMA ordem em identify() e handoff()
  machine.send(event);                              // 1. transição XState (síncrono)
  persistSnapshot();                                // 2. SQLite write (síncrono)
  await chatfluxApi.assignAutomation(...);          // 3. fetch externo (~200ms)
  await chatfluxApi.sendAssistantMessage(...);      // 4. trigger novo bot (~200ms)
  const verification = await chatfluxApi.verifySwap(conversationId, expectedBotName, token); // 5. confirma swap (~200ms)
  // → verified = false: grava api_error no transition_log, retry 1x
  // → retry também falha: grava erro, retorna bilhete com warning
  // → verified = true: grava verified = true no transition_log
  ```
  - `identify()` → resolve tipo → [machine + persist] → assign-automation → send-assistant-message
  - `switchBot()` → gerencia pilha → [machine + persist] → assign-automation → send-assistant-message → **verifySwap** → grava bilhete
  - `handoff()` → [machine + persist] → desativa automação → notifica humanos
- [ ] Rate limit: counter no SQLite do DO (10 req/min por phone)
- [ ] Bilhete JSON completo no retorno (versao, tipo, de, para, timestamp, contexto, pilha, acao)
- [ ] Configuração de variáveis (separar vars de secrets no `wrangler.jsonc`):
  - **`[vars]`** (públicas, em `wrangler.jsonc`): `CHATFLUX_BASE_URL`, `WORKSPACE`
  - **secrets** (via `wrangler secret put`, nunca em código):
    - `CHATFLUX_EMAIL`, `CHATFLUX_PASSWORD`
    - `BOT_TRI`, `BOT_QUAL`, `BOT_REP`, `BOT_AGD`, `BOT_ATD` (IDs numéricos dos bots)
    - `CLINIC_CONFIG_SECRET` = `clinic-config-secret-2026` (auth do `clinic-config` Worker)
- [ ] Deploy + teste com API real do alpha

**Referências**:
- Plano multi-agente: PARTE 3 (rotas, lógica /identify, /switch, /handoff)
- actor-kit example: `server.ts` (router pattern, mesmo que mais simples)
- Learnings: rate limit pattern (KV counter com TTL) → adaptamos pra SQLite

---

### Fase 5: MiniRacer Functions

**Objetivo**: Functions que os bots ChatFlux chamam, apontando pro Worker. Testáveis com `npm run test:function`.

**Critério de aceite**: Cada function:
- Passa no lint MiniRacer (7 regras)
- Retorna `{ success, say, bilhete }` no mock
- Chama o Worker correto quando deployada

**Teste real**: `npm run test:function -- path/to/function.js '{"param":"val"}'`

**Tarefas**:

- [ ] `skills/estetic-doctor/functions/identificar.js` — Bot TRI:
  ```javascript
  var phone = system_props.user.phone;
  if (!phone) return { say: "Um momento..." };
  // request_id para idempotência — DO retorna bilhete cacheado se duplicado
  var requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  var res = request("https://chatflux-orchestrator.marcus-80b.workers.dev/identify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: phone, request_id: requestId })
  });
  if (!res || !res.ok) return { say: "Oi! Que bom falar com você! Me conta, o que te trouxe até aqui?" };
  return res.body;
  ```
- [ ] `skills/estetic-doctor/functions/transferir_agendamento.js` — QUAL, REP, ATD
- [ ] `skills/estetic-doctor/functions/transferir_encerrar.js` — QUAL, REP, AGD, ATD
- [ ] `skills/estetic-doctor/functions/transferir_duvida.js` — AGD
- [ ] `skills/estetic-doctor/functions/transferir_humano.js` — ATD
- [ ] `skills/estetic-doctor/functions/verificar_agenda.js` — AGD (lista horários disponíveis):
  ```javascript
  var CLINIC_URL = "https://clinic-config.marcus-80b.workers.dev";
  var CLINIC_AUTH = "Bearer clinic-config-secret-2026";
  var res = request(CLINIC_URL + "/crm/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": CLINIC_AUTH },
    body: JSON.stringify({ action: "listar_horarios", data: params.data || undefined })
  });
  if (!res || !res.ok) return { success: false, say: "Não consegui consultar os horários agora. Tente novamente em instantes." };
  return res.body;
  ```

- [ ] `skills/estetic-doctor/functions/agendar_avaliacao.js` — AGD (confirma agendamento):
  ```javascript
  var CLINIC_URL = "https://clinic-config.marcus-80b.workers.dev";
  var CLINIC_AUTH = "Bearer clinic-config-secret-2026";
  var res = request(CLINIC_URL + "/crm/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": CLINIC_AUTH },
    body: JSON.stringify({
      action: "agendar",
      nome: params.nome,
      data: params.data,
      horario: params.horario,
      telefone: system_props.user.phone
    })
  });
  if (!res || !res.ok) return { success: false, say: "Não consegui confirmar o agendamento. Tente novamente." };
  // Retorna id_agendamento e id_paciente para o transition_log
  return res.body;
  ```

- [ ] `skills/estetic-doctor/functions/cancelar_avaliacao.js` — AGD:
  ```javascript
  var CLINIC_URL = "https://clinic-config.marcus-80b.workers.dev";
  var CLINIC_AUTH = "Bearer clinic-config-secret-2026";
  var res = request(CLINIC_URL + "/crm/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": CLINIC_AUTH },
    body: JSON.stringify({ action: "cancelar", id_agendamento: params.id_agendamento })
  });
  if (!res || !res.ok) return { success: false, say: "Não consegui cancelar agora. Tente novamente." };
  return res.body;
  ```

- [ ] `skills/estetic-doctor/functions/finalizar_agendamento.js` — AGD (after `agendar_avaliacao`, triggers transition to TRI)
- [ ] Testar cada uma com `npm run test:function`

**Referências**:
- Plano multi-agente: código exato de cada function (PARTE 1)
- CLAUDE.md: MiniRacer globals, request() behavior, lint rules
- Learnings: `request().body` é OBJETO já parsed — NÃO usar JSON.parse
- Learnings: `say` field obrigatório pra evitar verbatim copying
- Learnings: try/catch no tracking — falha não pode bloquear retorno

**Gotchas MiniRacer**:
- `var` não `const/let` (ES5)
- `request()` não `fetch()`
- `params` não `args`
- body retornado já é objeto (não usar `JSON.parse`)
- Sem async/await, sem console.log
- Sempre gerar `request_id` antes do request (idempotência no DO)

---

### Fase 6: End-to-End com Bots Reais

**Objetivo**: Fluxo completo no WhatsApp real. Isabela multi-agente funcionando.

**Critério de aceite**: 7 cenários passam no WhatsApp:
1. Lead novo → TRI (saudação) → QUAL → AGD → TRI
2. Lead retorno → TRI → REP → AGD → TRI
3. Cliente → TRI → ATD → AGD → TRI
4. Dúvida no AGD → QUAL → AGD → TRI (pilha)
5. Stop phrase em cada bot → handoff
6. Rate limit (>10 req/min) → fallback
7. Worker offline → functions retornam fallback

**Teste real**: WhatsApp + trace-conversation.sh + New Relic

**Tarefas**:

- [ ] Criar 5 bots no workspace v1pF23 (clonar Isabela 5.0)
- [ ] Deploy prompts via `chatflux prompt set`
- [ ] Deploy functions via `chatflux functions create`
- [ ] Deploy Q&A via `chatflux qa import`
- [ ] Setar TRI como default da integração WhatsApp
- [ ] Configurar stop phrases em todos os bots
- [ ] Testar cada cenário manualmente no WhatsApp
- [ ] Validar bilhetes no histórico (ChatFlux: role "tool" na message_history)
- [ ] Validar transition_log no SQLite do DO
- [ ] Validar perfis persistidos no DO

**Referências**:
- Plano multi-agente: PARTE 2 (configuração ChatFlux), PARTE 4 (ordem)
- Learnings: `trace-conversation.sh` para validar function calls
- Learnings: New Relic request_id (UUID do início do log, não trace.id)

---

## Observabilidade e Monitoramento

### Tracing nativo (OTLP) — Zero SDK

Cloudflare Workers tem instrumentação OpenTelemetry nativa desde 2025. **Não precisa de SDK.**
Basta adicionar o bloco `observability` no `wrangler.jsonc`:

```jsonc
"observability": {
  "enabled": true,
  "traces": {
    "enabled": true,
    "head_sampling_rate": 1
  }
}
```

O que é instrumentado automaticamente:

- Todos os `fetch()` (ChatFlux API, `clinic-config` Worker) — timing + status code
- Invocações de Durable Objects via RPC — cada método vira um span
- O handler principal do Worker (fetch lifecycle)
- A instância DO é identificada via `$workers.durableObjectId`

Exportação: OTLP para Honeycomb/Grafana/Sentry via CF dashboard (zero código).
Custo: grátis durante beta. Após março 2026: US$0,60/milhão de spans.

### Logging estruturado

Cada método RPC do DO (`identify`, `switchBot`, `handoff`) deve usar o padrão:

```typescript
const t0 = Date.now();
// ... lógica ...
console.log(JSON.stringify({
  trace: requestId,   // reutiliza request_id (já planejado para idempotência)
  phone,
  method: "switchBot",
  from: prevState,
  to: newState,
  duration_ms: Date.now() - t0,
  chatflux_status: apiRes.status
}));
```

**Regras:**
- `requestId` (já planejado para idempotência) é também o trace ID — propagado em TODOS os logs
- Passar `X-Orchestrator-Trace: {requestId}` nas chamadas à ChatFlux API e ao `clinic-config` Worker
- Todo `console.log` usa `JSON.stringify({...})` — nunca string livre

**Cold start detection** no constructor:

```typescript
const hadExistingState = /* resultado do SELECT na migration */;
console.log(JSON.stringify({ event: "do_init", cold_start: !hadExistingState, phone }));
```

### Métricas

**Rota `/metrics`** (Phase 4, `src/index.ts`):

```typescript
case "/metrics": {
  const stub = this.env.ORCHESTRATOR.getByName("__metrics__");
  return Response.json(await stub.getMetrics(Date.now() - 24 * 60 * 60 * 1000));
}
```

Query no `transition_log`:

```sql
SELECT to_state, COUNT(*) as total
FROM transition_log
WHERE created_at > ?
GROUP BY to_state
```

**Index obrigatório** em `migrations.ts` para performance da query acima e auditoria:

```sql
CREATE INDEX idx_tlog_phone_ts ON transition_log(phone, created_at DESC);
```

**DO cold start tracking**: logar `event: "do_init"` + `cold_start: true/false` em todo boot
permite identificar custo de restauração via `wrangler tail | jq`.

### Alertas

**Operações de agendamento no `transition_log`**: toda chamada bem-sucedida ao `clinic-config` Worker que retorna `id_agendamento` e `id_paciente` deve ser gravada nas colunas correspondentes do `transition_log`. Isso garante trilha de auditoria completa:

```sql
-- Encontrar agendamentos criados por telefone:
SELECT phone, id_agendamento, id_paciente, created_at
FROM transition_log
WHERE event_type = 'SWITCH' AND id_agendamento IS NOT NULL
ORDER BY created_at DESC;
```

**Erros da ChatFlux API no `transition_log`**: coluna `api_error TEXT` permite auditar falhas nos side-effects:

```sql
-- Encontrar transições com erro de API:
SELECT phone, event_type, api_error, created_at
FROM transition_log
WHERE api_error IS NOT NULL
ORDER BY created_at DESC;
```

**Conversas travadas**: o alarm handler de 7 dias de inatividade (já planejado na Fase 2) deve TAMBÉM
verificar conversas paradas >24h em estados não-terminais:

```typescript
async alarm(): Promise<void> {
  // Inatividade >7 dias → reset
  this.ctx.storage.sql.exec(
    "UPDATE conversation SET current_state = 'triagem' WHERE updated_at < ?",
    Date.now() - 7 * 24 * 60 * 60 * 1000
  );

  // Conversas travadas >24h em estado não-terminal → alerta
  const stuck = this.ctx.storage.sql
    .exec(
      "SELECT phone, current_state FROM conversation WHERE current_state != 'handoff' AND updated_at < ?",
      Date.now() - 24 * 60 * 60 * 1000
    )
    .toArray();
  for (const row of stuck) {
    console.log(JSON.stringify({ event: "stuck_conversation", phone: row.phone, state: row.current_state }));
  }
}
```

O evento `stuck_conversation` no log permite criar alerta no New Relic.

### Monitoramento de swap verification

A coluna `verified` no `transition_log` permite detectar trocas de bot que falharam silenciosamente (assignAutomation retornou 200 mas o bot não mudou de fato).

**Query de alerta**:

```sql
-- Verificar falhas de swap nas últimas 24h:
SELECT phone, event_type, from_state, to_state, api_error, created_at
FROM transition_log
WHERE verified = false
  AND created_at > (unixepoch() * 1000 - 24 * 60 * 60 * 1000)
ORDER BY created_at DESC;
```

Regra operacional: `COUNT(*) WHERE verified = false > 0` → investigar imediatamente.

**Evento estruturado no log** em toda falha de verificação:

```typescript
console.log(JSON.stringify({
  event: "swap_verification_failed",
  phone,
  expected_bot: expectedBotName,
  actual_bot: verification.organizationName,
  automation_enabled: verification.automationEnabled,
  last_message_role: verification.lastMessageRole,
  age_seconds: verification.ageSeconds,
  trace: requestId
}));
```

**Distribuição de verificações** (operacional):

```sql
SELECT
  verified,
  COUNT(*) as total
FROM transition_log
WHERE event_type = 'SWITCH'
GROUP BY verified;
-- verified = true  → swaps confirmados
-- verified = false → falhas detectadas
-- verified = NULL  → transições sem swap (IDENTIFY tipo-mesmo-bot, HANDOFF)
```

### Health checks

**`GET /health`** — básico (já planejado na Fase 0): retorna `"ok"` se Worker está vivo.

**`GET /healthz/deep`** — verificação completa do pipeline (Fase 4):

```typescript
case "/healthz/deep": {
  const checks: Record<string, boolean> = {};
  // 1. JWT válido (tenta login ou valida token cacheado)
  checks.jwt = await chatfluxApi.validateToken(env);
  // 2. ChatFlux API alcançável
  checks.chatflux_api = await chatfluxApi.ping(env);
  // 3. DO instanciável (getByName + getState sem criar estado)
  try {
    const stub = env.ORCHESTRATOR.getByName("__healthcheck__");
    await stub.getState();
    checks.durable_object = true;
  } catch {
    checks.durable_object = false;
  }
  const ok = Object.values(checks).every(Boolean);
  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
```

### Debug tooling

**Log em tempo real filtrado por phone** (sem precisar de dashboard):

```bash
wrangler tail chatflux-orchestrator --format json \
  | jq 'select(.logs[].message | contains("5531999000001"))'
```

**Histórico de transições por phone** (SQLite direto via wrangler d1 ou RPC):

```sql
SELECT event_type, from_state, to_state, api_error, created_at
FROM transition_log
WHERE phone = '5531999000001'
ORDER BY created_at DESC
LIMIT 20;
```

**Workers Analytics Engine** (futuro): alternativa ao `transition_log` para métricas de alto volume.
Não necessário inicialmente — anotar para evolução.

### LogPush (persistência além do `wrangler tail`)

`wrangler tail` não persiste — os logs somem quando a sessão fecha. Para persistência,
configurar **Logpush** no dashboard da Cloudflare:

```
Analytics & Logs → Logpush → Workers Trace Events → New Relic endpoint
```

Isso garante que todos os eventos (`do_init`, `stuck_conversation`, erros de API) cheguem
ao New Relic para alertas e histórico de longo prazo.

---

## Requisitos Não-Funcionais

### Performance

| Métrica | Target | Como medir |
|---------|--------|------------|
| Latência /identify | < 500ms | wrangler tail + timestamps |
| Latência /switch | < 800ms (incluindo API ChatFlux) | idem |
| Cold start DO | < 100ms | primeiro request após inatividade |
| SQLite query | < 5ms | sql.exec timing |

### Confiabilidade

| Cenário | Comportamento esperado |
|---------|----------------------|
| Worker offline | MiniRacer function retorna fallback ("Um momento...") |
| JWT expirado | Auto-renovação transparente (retry 1x) |
| API v1 não acha phone | Fallback: conversation_id null, log erro, continuar |
| Rate limit excedido | Retorna `{ success: false, say: "Um momento..." }` |
| Transição inválida | XState rejeita silenciosamente, log no transition_log |
| DO evicted | Restaura do SQLite no próximo request (zero data loss) |

### Segurança

- [ ] Secrets NUNCA em código (wrangler secret put)
- [ ] conversation_id cacheado no SQLite do DO (não em memória volátil)
- [ ] Rate limit 10 req/min por phone
- [ ] JWT cacheado com TTL 23h (não 24h — margem)

## Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| `steps_occurred` write-once impede re-uso de QUAL | Alta | Alto | Design sem stepper nos bots receptores (só QUAL tem stepper) |
| JWT login rate limit | Baixa | Médio | Cache 23h + retry com backoff |
| Dois requests simultâneos pro mesmo phone | Média | Alto | DO é single-threaded — resolvido pela arquitetura |
| `clinic-config` Worker fora do ar | Baixa | Alto | MiniRacer functions retornam fallback; Worker é stateless e fácil de reuploar |
| Prontuário Verde ORDS muda (leituras futuras) | Média | Baixo | crm-verde.ts é módulo separado de `clinic-api.ts`; não afeta fluxo de agendamento |

## Dependências Externas

- [ ] **Bot IDs**: criar os 5 bots na ChatFlux ANTES da Fase 4 (precisa dos IDs numéricos)
- [ ] **Cookie/JWT**: garantir que login ChatFlux funciona do Worker (CHATFLUX_EMAIL/PASSWORD como secrets)
- [ ] **Cezar**: números de handoff (HANDOFF_PHONES)
- [ ] **Cezar**: validar Q&As (20 perguntas frequentes)
- [ ] **Cezar**: confirmar endereço, estacionamento, horários
