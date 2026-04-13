/** @type {import('dependency-cruiser').IConfiguration} */
const SRC = "src";

module.exports = {
  forbidden: [
    // ── Zero ciclos ──
    {
      name: "no-circular",
      severity: "error",
      comment: "Dependencias circulares quebram tree-shaking e dificultam testes",
      from: {},
      to: { circular: true },
    },

    // ── services/ nao importa machine.ts (separacao de concerns) ──
    {
      name: "services-cannot-import-machine",
      severity: "error",
      comment: "Services sao funcoes puras de I/O — nao conhecem a FSM",
      from: { path: `${SRC}/services/` },
      to: { path: `${SRC}/machine\\.ts$` },
    },

    // ── services/ nao importa orchestrator.ts (sem dependencia reversa) ──
    {
      name: "services-cannot-import-orchestrator",
      severity: "error",
      comment: "Services nao podem importar o DO — orchestrator importa services, nao o contrario",
      from: { path: `${SRC}/services/` },
      to: { path: `${SRC}/orchestrator\\.ts$` },
    },

    // ── machine.ts so importa types.ts (FSM e pura, sem I/O) ──
    {
      name: "machine-cannot-import-services",
      severity: "error",
      comment: "A maquina XState deve ser pura — sem fetch, sem API calls",
      from: { path: `${SRC}/machine\\.ts$` },
      to: { path: `${SRC}/services/` },
    },

    // ── schemas.ts nao importa nada do src (so zod) ──
    {
      name: "schemas-only-imports-zod",
      severity: "error",
      comment: "Schemas sao definicoes puras — so dependem do Zod",
      from: { path: `${SRC}/schemas\\.ts$` },
      to: {
        path: `${SRC}/`,
        pathNot: `${SRC}/types\\.ts$`,
      },
    },

    // ── types.ts so importa schemas ──
    {
      name: "types-only-imports-schemas",
      severity: "error",
      comment: "Types derivam dos schemas — nenhuma outra dependencia",
      from: { path: `${SRC}/types\\.ts$` },
      to: {
        path: `${SRC}/`,
        pathNot: `${SRC}/schemas\\.ts$`,
      },
    },

    // ── index.ts (router) nao importa services diretamente ──
    {
      name: "router-no-direct-service-import",
      severity: "warn",
      comment: "O router despacha pro DO — side-effects ficam no orchestrator",
      from: { path: `${SRC}/index\\.ts$` },
      to: { path: `${SRC}/services/` },
    },
  ],

  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/([^/]+)",
      },
    },
  },
};
