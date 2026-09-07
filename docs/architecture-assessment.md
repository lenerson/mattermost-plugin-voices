# Diagnóstico Arquitetural do Plugin

Data da avaliação: 6 de setembro de 2026.

## Escopo e conclusão

Esta avaliação considera arquitetura de software, Clean Code, SOLID, DRY, GRASP, TDD e práticas de engenharia. Micro-otimizações, como memoização, redução de loops ou pequenos ajustes de renderização, estão fora do escopo.

O plugin funciona como um monólito modular pequeno. A divisão entre servidor Go e webapp está correta, mas os limites internos enfraqueceram conforme novas funcionalidades foram adicionadas. A maior dívida está no frontend, onde conexão WebRTC, estado, regras de negócio e renderização estão fortemente acoplados.

A recomendação é uma refatoração evolutiva, protegida por testes de caracterização, e não uma reescrita completa.

## Pontos positivos

- Servidor e webapp possuem responsabilidades claramente separadas.
- Diretório e presença usam operações atômicas no KV Store.
- Autenticação, permissões e validações possuem boa cobertura no servidor.
- APIs, sons e eventos já começaram a ser extraídos para módulos próprios.
- Existem testes de regressão para os comportamentos recentes.
- O baseline está estável:
  - `go test -race ./server/...`: aprovado.
  - Cobertura Go: 81,1% das instruções.
  - Jest: 14 suítes e 99 testes aprovados.
  - Cobertura webapp: 56% das linhas.

## Problemas prioritários

### P0 — Segurança e estabilidade

#### Credenciais TURN aparecem nos logs

O debug está permanentemente habilitado em [`debug.js`](../webapp/src/utils/debug.js#L1). A resposta completa da configuração é registrada em [`actions/index.js`](../webapp/src/actions/index.js#L116), incluindo a credencial TURN. O painel também registra todo o estado e todas as propriedades em [`audio_group_call.jsx`](../webapp/src/components/modals/audio_group_call/audio_group_call.jsx#L1480).

O debug deve ser configurável, sanitizado e desabilitado em produção. Idealmente, as credenciais TURN devem ser temporárias e limitadas.

#### Sinalização sem autorização por tópico

Os endpoints verificam apenas a existência de um usuário autenticado, mas permitem publicar e assinar qualquer tópico em [`signal_handlers.go`](../server/signal_handlers.go#L22). A identidade do remetente também é fornecida pelo cliente.

Por inferência, um usuário autenticado pode tentar assinar sinalizações alheias, injetar mensagens de chamada ou observar SDP e candidatos ICE. A sinalização precisa de sessões criadas pelo servidor, participantes autorizados e identidade derivada de `Mattermost-User-Id`, nunca do payload.

Também devem existir limites para tamanho do corpo, quantidade de tópicos, assinaturas e taxa de publicação.

#### Corrida no broker

O broker copia os canais, libera o lock e depois envia. Paralelamente, `unsubscribe` pode fechar um canal em [`signal_broker.go`](../server/signal_broker.go#L19). A sequência pode causar `send on closed channel` e derrubar o processo do plugin.

É necessário um teste concorrente determinístico e um ciclo de vida seguro para subscribers. Mensagens descartadas por backpressure também precisam de telemetria ou tratamento explícito.

### P1 — Responsabilidades e ciclo de vida

#### `AudioCallPanel` é um God Component

[`audio_group_call.jsx`](../webapp/src/components/modals/audio_group_call/audio_group_call.jsx#L62) possui mais de 2.100 linhas e controla:

- Diretório e CRUD de salas.
- Presença e polling.
- Convites e busca de usuários.
- Permissões de mídia.
- Swarm WebRTC e peers.
- Reprodução de áudio.
- Sons de entrada e saída.
- Menus, estilos e renderização.

Isso viola responsabilidade única, alta coesão e o padrão GRASP Controller. Além disso, `render()` inicia aquisição de mídia e conexão em [`audio_group_call.jsx`](../webapp/src/components/modals/audio_group_call/audio_group_call.jsx#L1492), embora a renderização deva ser pura.

Há ainda um defeito concreto: `userId` é lido do estado em [`audio_group_call.jsx`](../webapp/src/components/modals/audio_group_call/audio_group_call.jsx#L1063), mas nunca é armazenado nele. A sinalização pode transmitir `userId: undefined`.

#### Sessão de chamada distribuída e implícita

[`actions/index.js`](../webapp/src/actions/index.js#L26) mantém `MediaStream`, peer, swarms e hubs em variáveis globais. Ao mesmo tempo, [`reducers/index.js`](../webapp/src/reducers/index.js#L72) representa o ciclo da chamada com diversos booleanos independentes.

Essa combinação permite estados contraditórios e eventos atrasados de uma chamada afetando outra. Objetos como `MediaStream` e peer não devem fazer parte do estado Redux serializável.

A chamada deve usar uma máquina de estados explícita:

```text
idle → outgoing-ringing / incoming-ringing
     → connecting → connected → ending → idle
                              ↘ failed
```

Um `CallSession` deve possuir os recursos WebRTC. O Redux deve manter somente uma projeção serializável para a interface.

Todas as mensagens de aceite, recusa e cancelamento devem carregar e validar o mesmo `callId`. Mensagens recebidas de peers também precisam de parsing e validação seguros antes de alterar estado.

#### Invariantes das salas estão fragmentadas

A presença aceita um `roomId` que não precisa existir em [`voice_presence.go`](../server/voice_presence.go#L158). A exclusão remove somente o diretório em [`voice_rooms.go`](../server/voice_rooms.go#L242), sem coordenar presença, participantes conectados ou convites.

O aceite de convite faz um read-modify-write não atômico e não revalida a existência da sala em [`voice_invites.go`](../server/voice_invites.go#L214). Aceites concorrentes ou convites para uma sala excluída podem produzir estados incoerentes.

Essas regras devem pertencer a um `VoiceRoomService`, e não aos handlers HTTP.

#### Modelo de armazenamento limita evolução e escala

O diretório inteiro e toda a presença são mantidos em dois documentos JSON compartilhados no KV Store. Cada heartbeat reescreve a presença completa, e a listagem resolve individualmente o perfil de cada participante.

Esse modelo é simples e correto para baixa escala, mas cria contenção crescente. A arquitetura deve permitir trocar o armazenamento por chaves por sala, índices explícitos e resolução de usuários em lote sem alterar os casos de uso.

O broker em memória também impede sinalização confiável em uma instalação Mattermost com múltiplos nós.

## Avaliação por princípio

### Clean Architecture e SOLID

- **SRP:** violado principalmente por `AudioCallPanel`, `actions/index.js` e handlers que acumulam transporte, regras e persistência.
- **OCP/DIP:** navegador, Axios, EventSource, Mattermost API e `webrtc-swarm` são acessados diretamente, sem portas substituíveis.
- **ISP:** serviços dependem da API ampla do Mattermost em vez de interfaces pequenas como `RoomRepository`, `UserDirectory` e `EventPublisher`.
- **LSP:** não é um problema relevante atualmente; não existe hierarquia que justifique introduzir abstrações artificiais.

### DRY

- A configuração de CSRF está duplicada em [`mattermostApi.js`](../webapp/src/utils/mattermostApi.js#L6) e [`pluginSignalHub.js`](../webapp/src/utils/pluginSignalHub.js#L17).
- A configuração e os listeners de peers são duplicados entre caller, callee e canais de voz.
- Diretório e presença repetem o protocolo de leitura, serialização e compare-and-set do KV Store.
- O painel e o post de convite mantêm fluxos paralelos para expiração e resposta.

### GRASP

- Componentes visuais atuam como Controllers de aplicação.
- Regras de sala e convite não estão concentradas no Information Expert apropriado.
- Faltam Indirection e Protected Variations nas integrações WebRTC, Mattermost, relógio, timers e mídia do navegador.
- O acoplamento entre interface e infraestrutura dificulta substituir SSE, `webrtc-swarm` ou o armazenamento.

### Clean Code e práticas gerais

- Arquivos muito grandes e regras ESLint desabilitadas indicam responsabilidades acumuladas.
- Nomes centrados em “video” já não representam chamadas de voz e vídeo.
- Strings de protocolo estão espalhadas e não possuem schema ou versão.
- Strings visíveis ao usuário não utilizam a infraestrutura de internacionalização; `webapp/i18n/en.json` está vazio.
- Erros transitórios de configuração e sinalização são apenas registrados, sem estado de erro ou estratégia clara de retry.
- Os checks instalam ferramentas Go com `@latest`, tornando o CI não reproduzível.
- `make test` executa uma correção automática de lint e pode modificar o código durante a etapa de testes.

## Arquitetura-alvo sugerida

### Webapp

```text
React views
    ↓ comandos e view models
CallController / VoiceRoomController
    ↓
CallSession / VoiceSession / máquinas de estado
    ↓ portas
MediaDevice | SignalingTransport | VoiceAPI | Clock | SoundPlayer
```

Organização sugerida:

```text
webapp/src/
  features/
    direct_calls/
      application/
      components/
      state/
    voice_channels/
      application/
      components/
      state/
  shared/
    api/
    media/
    realtime/
```

`CallSession` e `VoiceSession` devem existir fora do ciclo de vida dos componentes visuais. Componentes recebem estado derivado e enviam comandos; não possuem diretamente peers, streams, timers ou conexões SSE.

### Servidor

```text
HTTP handlers → Application services → Domain rules
                         ↓
       RoomRepository | PresenceRepository
       SignalBus | UserDirectory | EventPublisher
                         ↓
            Mattermost KV/API/WebSocket
```

Os handlers devem apenas autenticar, decodificar DTOs, chamar casos de uso e converter erros de domínio em respostas HTTP. `plugin.go` deve ser a composition root que conecta as portas aos adapters do Mattermost.

Uma estrutura pragmática seria:

```text
server/
  internal/
    calls/
    voice/
    signaling/
    platform/
  httpapi/
  plugin.go
  main.go
```

Não é necessário criar uma camada ou interface para cada função. As abstrações devem existir nas fronteiras sujeitas a variação ou que precisam ser isoladas em testes.

## Avaliação de TDD e estratégia de testes

TDD é um processo e não pode ser comprovado apenas pelo estado final do repositório. A suíte atual demonstra boa preocupação com regressões, especialmente no servidor, mas não protege os fluxos de maior risco do frontend.

Os testes de `AudioCallPanel` instanciam a classe diretamente, substituem `setState` e chamam métodos do prototype em [`audio_group_call.test.js`](../webapp/src/components/modals/audio_group_call/audio_group_call.test.js#L78). Eles protegem detalhes da implementação, mas não validam adequadamente integração React, ciclo de vida do navegador ou WebRTC.

Não há cobertura dedicada para:

- O orquestrador principal `actions/index.js`.
- O adaptador SSE `pluginSignalHub.js`.
- O modal de chamada ativa.
- Aquisição e liberação realista de mídia.
- Interação completa entre dois navegadores.
- Autorização dos tópicos de sinalização.
- Concorrência entre publish e unsubscribe.

O Jest utiliza `--forceExit` em [`package.json`](../webapp/package.json#L11), o que pode esconder recursos que não foram encerrados corretamente.

## Sequência recomendada

1. Criar testes falhando para vazamento de credenciais, autorização dos tópicos e corrida do broker.
2. Corrigir os três problemas P0 em mudanças pequenas e isoladas.
3. Definir contratos tipados e versionados para sinalização, sempre com `callId` ou `sessionId`.
4. Introduzir `CallSession` e uma máquina de estados, mantendo a interface atual.
5. Introduzir `VoiceSession` e extrair diretório, convites e componentes visuais do painel.
6. Criar serviços de aplicação e repositories no servidor.
7. Tornar exclusão de sala, presença e convites operações de domínio coerentes.
8. Adicionar testes de contrato entre frontend e servidor e pelo menos um fluxo E2E com dois navegadores.
9. Remover `--forceExit` quando todos os recursos possuírem encerramento determinístico.
10. Separar lint, fix e test, além de fixar versões das ferramentas do pipeline.

Antes de estabelecer um percentual obrigatório, deve-se registrar a cobertura por módulo e impedir regressões. Novos módulos de domínio e aplicação devem nascer com testes de comportamento; adapters devem receber testes de contrato e os fluxos WebRTC críticos devem possuir testes de integração.
