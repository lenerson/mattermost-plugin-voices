# Progresso do Plano Arquitetural

Atualizado em 13 de setembro de 2026. Este documento acompanha o plano em [architecture-execution-plan.md](architecture-execution-plan.md).

## Etapas concluídas

- [x] **Etapa 0 — Documentação e baseline:** diagnóstico e plano arquitetural publicados.
- [x] **Etapa 1 — Logs seguros:** sanitização de diagnósticos WebRTC e logs configuráveis.
- [x] **Etapa 2 — Broker concorrente:** ciclo de vida seguro de subscribers, limpeza de tópicos e testes com race detector.

## Etapa 3 — Sinalização autorizada

### Concluído

- [x] Envelope v1 com `version`, `sessionId`, `callId`, `type`, `payload` e remetente definido no servidor.
- [x] Sessões privadas, inbox autenticada e autorização de publicação e assinatura.
- [x] Migração incremental de chamadas diretas para sessões autorizadas.
- [x] Casos positivos e negativos para envelopes inválidos, falsificação de identidade, sessão incompatível, fallback e cleanup.
- [x] TTL de 30 minutos, limite de cinco sessões por proprietário e encerramento HTTP pelo proprietário.
- [x] Limites de dez assinaturas SSE simultâneas e sessenta operações de sinalização por minuto, por usuário.

### Pendente

- [ ] Migrar os canais de voz para sessões autorizadas.
- [ ] Encerrar ou atualizar sessões quando participantes saírem de salas de voz.
- [ ] Remover endpoints e hubs legados baseados em tópicos arbitrários.
- [ ] Executar fluxo E2E com dois navegadores para a chamada privada completa.

## Próximas etapas

- [ ] **Etapa 4 — Ciclo de vida do frontend:** tornar entrada, troca e cleanup WebRTC idempotentes.
- [ ] **Etapa 5 — CallSession:** extrair chamadas diretas para uma máquina de estados explícita.
- [ ] **Etapa 6 — VoiceSession e componentes:** separar mídia, sinalização, salas, convites e apresentação React.
- [ ] **Etapa 7 — Domínio no servidor:** centralizar invariantes de salas, presença e convites em serviços de domínio.
- [ ] **Etapa 8 — Testes e pipeline:** contratos, E2E, cleanup determinístico e melhorias de pipeline.
