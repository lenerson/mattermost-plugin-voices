# Plano de Execução Arquitetural

Este plano transforma o [diagnóstico arquitetural](architecture-assessment.md) em entregas incrementais. A prioridade é corrigir riscos de segurança e estabilidade antes das mudanças estruturais. Micro-otimizações permanecem fora do escopo.

## Estratégia de entrega

- Manter o plugin funcional ao final de cada pull request.
- Usar uma branch por contexto, sempre criada a partir da `main` atualizada.
- Aplicar TDD localmente: teste falhando, implementação mínima e refatoração.
- Manter todos os commits verdes e no padrão `type(context): Message`.
- Preservar compatibilidade durante mudanças de protocolo ou persistência.
- Exigir `make check-style` e `make test` antes de cada merge.
- Não reduzir a cobertura dos módulos alterados.

## Etapa 0 — Documentação e baseline

Concluir a documentação na branch atual, registrando diagnóstico, plano, métricas e decisões iniciais. Depois do merge, cada etapa seguinte deve partir da `main` atualizada.

**Saída:** baseline reproduzível e escopo aprovado, sem alteração de comportamento.

## Etapa 1 — Logs seguros

**Branch:** `bugfix/sensitive-logging-on-main`

Criar um logger configurável, desabilitado por padrão em produção, e sanitizar credenciais TURN, SDP, ICE, estado e propriedades dos componentes.

**Critérios de aceite:** nenhum segredo aparece no console; testes verificam a sanitização; diagnósticos úteis continuam disponíveis quando habilitados.

## Etapa 2 — Broker concorrente

**Branch:** `bugfix/signal-broker-lifecycle-on-main`

Reproduzir deterministicamente a concorrência entre `publish` e `unsubscribe`, corrigir o ciclo de vida dos subscribers, remover tópicos vazios e tornar descartes por backpressure observáveis.

**Critérios de aceite:** nenhum `send on closed channel`; cancelamento SSE libera recursos; `go test -race ./server/... -count=20` passa.

## Etapa 3 — Sinalização autorizada

**Branch:** `feature/authorized-signaling-on-main`

Introduzir um envelope versionado com `version`, `sessionId`, `callId`, `type` e payload. As sessões serão criadas pelo servidor, e a identidade do remetente virá de `Mattermost-User-Id`.

Entregas internas:

1. Contratos e validação de mensagens.
2. Registro e encerramento de sessões.
3. Autorização para publicação e assinatura.
4. Limites de body, tópicos, assinaturas e taxa.
5. Migração do frontend com compatibilidade temporária.

**Critérios de aceite:** participantes externos recebem `403`; o remetente não pode ser falsificado; eventos de outra sessão são ignorados; SDP e ICE ficam restritos aos participantes.

## Etapa 4 — Ciclo de vida do frontend

**Branch:** `bugfix/voice-session-lifecycle-on-main`

Remover efeitos colaterais de `render()`, corrigir a origem de `userId`, validar payloads externos e tornar entrada, troca de sala e encerramento idempotentes. Todo cleanup deve terminar mesmo se o fechamento WebRTC falhar.

**Critério de aceite:** renderizações repetidas não criam mídia, peers, timers ou conexões SSE duplicadas.

## Etapa 5 — `CallSession`

**Branch:** `feature/call-session-state-machine-on-main`

Encapsular chamadas diretas em uma máquina de estados explícita:

```text
idle → ringing → connecting → connected → ending → idle
                                  ↘ failed
```

`CallSession` possuirá peers, mídia, timers e sinalização. Redux manterá somente uma projeção serializável para a interface.

**Critérios de aceite:** remoção dos recursos globais; apenas uma chamada ativa; eventos atrasados são rejeitados pelo `callId`; todas as transições têm testes.

## Etapa 6 — `VoiceSession` e componentes

**Branch:** `feature/voice-session-extraction-on-main`

Extrair responsabilidades do `AudioCallPanel`:

- `VoiceSession`: mídia, swarm, sinalização e cleanup.
- `VoiceRoomController`: diretório, presença e troca de sala.
- `VoiceInviteController`: busca, envio, resposta e expiração.
- Componentes React: apresentação e emissão de comandos.

**Critérios de aceite:** a interface existente permanece funcional; componentes não possuem diretamente peers, streams ou conexões; os controladores têm testes comportamentais.

## Etapa 7 — Domínio no servidor

**Branch:** `feature/voice-domain-services-on-main`

Criar `VoiceRoomService` e interfaces pequenas para repositories e integrações Mattermost. Os handlers devem apenas autenticar, converter DTOs, executar casos de uso e mapear erros.

Invariantes obrigatórios:

- Presença somente em sala existente.
- Um usuário em apenas uma sala.
- Exclusão limpa presença e invalida convites.
- Aceite revalida sala, convite, expiração e participantes.
- Operações concorrentes não deixam estado parcial.

O formato atual do KV permanece inicialmente atrás dos repositories. Uma migração para chaves por sala dependerá de teste de carga ou requisito comprovado de escala.

## Etapa 8 — Testes e pipeline

**Branch:** `feature/architecture-test-pipeline-on-main`

- Adicionar testes de contrato entre frontend e servidor.
- Cobrir ao menos um fluxo E2E com dois navegadores.
- Remover `--forceExit` após garantir cleanup determinístico.
- Separar comandos de lint, correção e teste.
- Fixar versões das ferramentas Go usadas no pipeline.
- Introduzir internacionalização gradualmente.
- Documentar a decisão sobre suporte a clusters Mattermost.

## Marcos de entrega

1. **Seguro:** etapas 1 a 3.
2. **Ciclo de vida confiável:** etapas 4 e 5.
3. **Frontend modular:** etapa 6.
4. **Domínio coerente:** etapa 7.
5. **Pronto para evolução:** etapa 8.

Cada etapa deve resultar em um PR independente, com descrição do impacto arquitetural, testes executados e estratégia de compatibilidade ou rollback quando aplicável.
