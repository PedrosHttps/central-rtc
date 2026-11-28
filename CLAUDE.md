# Central RTC — guia para o Claude Code

Painel web + linha de comando que usam os três serviços de código aberto da Receita Federal para a Reforma Tributária do Consumo. A Central RTC não calcula nada: monta requisições, chama os serviços oficiais e organiza as respostas.

| Serviço | Repositório | Porta local | Base usada pelo painel |
|---|---|---|---|
| Regime geral (Java 25) | ReceitaFederal/calculadora-rtc-regime-regular | 8080 | `RG_URL=http://localhost:8080/api` |
| Simples Nacional (Java 25) | ReceitaFederal/calculadora-rtc-simples-nacional | 8082 | `SN_URL=http://localhost:8082/api` |
| DANFSe (Go 1.27) | ReceitaFederal/calculadora-rtc-gerador-danfse | 8081 | `DANFSE_URL=http://localhost:8081` |

## Estrutura

- `painel/server.js` — servidor Node sem dependências: serve `public/`, repassa `/svc/rg|sn|danfse/*` para os serviços e expõe `/status`. Com `PAINEL_USUARIO` + `PAINEL_SENHA` (no Docker, via `.env`) liga o login: `controlarAcesso` roda antes de tudo. Ele faz o seguinte:
  - Sessão em cookie `HttpOnly` + `SameSite=Strict`, guardada só na memória.
  - Contas em `PAINEL_DADOS/usuarios.json`, com scrypt; a escrita é atômica.
  - O administrador é a conta do `.env`; as rotas `/api/usuarios` são só dele.
  - Senha provisória obriga a trocar em `/api/senha` antes de qualquer consulta.
  - Bloqueio por IP depois de 10 senhas erradas diferentes. O IP vem do último item do `X-Forwarded-For`, e o IPv6 conta pelo bloco /64.
  - Cadastro pela própria pessoa em `/api/cadastro`: a conta nasce com `status: pendente`. E-mail repetido responde igual, sem revelar nada. Limite de 3 pedidos por hora por IP e de 100 pedidos pendentes.
  - `Authorization: Bearer PAINEL_TOKEN_REVISAO` só lista `/api/pedidos` e aprova ou recusa. Usado pelo `vigia-pedidos.ps1`, que roda escondido e sobe no login (atalho `central-rtc-vigia.vbs` na pasta Inicializar). Quando o próprio arquivo muda, ele sobe a versão nova e sai, então não precisa reiniciar à mão depois de atualizar. A cada minuto ele lista a fila sem IA e, quando ela muda, chama `claude -p --tools Bash` com as instruções de `revisao-pedidos.md`. A permissão vale só para `powershell.exe ... revisao-pedidos.ps1 *`, que faz listar, aprovar e recusar, lê a chave sem mostrá-la e é salvo com BOM. A ferramenta PowerShell do Claude recusa abrir outro PowerShell, por isso é Bash. O log fica em `revisao-pedidos-AAAA-MM.log` (um por mês, só os 3 últimos), fora do Git. Uma vez por dia ele também copia o `painel/dados/usuarios.json` para `copias-contas/` (30 últimas, fora do Git). A cada minuto confere as portas 3000, 8080, 8081 e 8082 e, se alguma estiver fechada, roda `servicos-windows.ps1 -Oculto` (no máximo uma vez a cada 5 minutos): é isso que sobe tudo depois de ligar o computador. A tarefa agendada `central-rtc-revisar-pedidos`, de hora em hora, está pausada.
  - Senha: 12+ caracteres e um especial (`/[^\p{L}\p{N}\s]/u`). Nome e empresa únicos entre contas não recusadas (`comparavel` ignora caixa, acento e espaço); e-mail repetido continua com a resposta genérica.
  - Senha esquecida: com `SMTP_USUARIO` + `SMTP_SENHA` + `PAINEL_ENDERECO`, `/api/esqueci` manda por e-mail (cliente SMTP próprio em `enviarEmail`, TLS na porta 465) um link `senha.html#token`. O link vale 30 min e uma vez só, e só o resumo do token fica na memória. `/api/redefinir` troca a senha. Resposta igual exista a conta ou não; envio sem await. O link usa `PAINEL_ENDERECO`, nunca o Host. Teste com SMTP falso + openssl.
  - Monitor: `/admin.html` + `admin.js` lêem `GET /api/monitor` (só admin): sessões (IP, user-agent, vistoEm), contas (ultimoAcesso) e as 200 últimas tentativas de cadastro (memória). `h()` fica em `public/lib/dom.js`.
  - LGPD: recusados somem 30 dias após a decisão (`limparRecusados`). O aviso fica em `docs/privacidade.html`; mantenha-o igual ao que o código guarda.
  - Públicos: `login.html`, `login.js`, `cadastro.html`, `cadastro.js`, `senha.html`, `senha.js`, `styles.css`, `fontes/`, `/api/acesso`, `/api/entrar`, `/api/cadastro`, `/api/esqueci` e `/api/redefinir`.
- `painel/cli.js` — comandos `status`, `modelo`, `lote`, `danfse`. Códigos de saída: 0 ok, 1 uso/serviço fora, 2 algum item falhou.
- `painel/public/lib/` — **código compartilhado entre navegador e Node** (ESM puro): `rtc.js` (cliente, montagem das operações, leitura dos resultados, lote), `csv.js`, `formato.js`, `zip.js`, `danfe.js` (leitor de XML sem DOMParser, `lerNFe` e o Code 128C da chave, conferido contra o ReportLab). Não use APIs exclusivas do Node aqui.
- `painel/public/app.js` + `index.html` + `styles.css` — interface, JS puro, sem build. A seção DANFE não usa serviço: `folhaDanfe` monta a folha A4 em HTML (leiaute retrato do MOC; o cabeçalho fica num `thead` para repetir em cada folha) e o botão chama `print()` com a classe `imprimindo-danfe` no body, que esconde o resto da página.
- `painel/dev/mock-servicos.js` — simulador com **dados fictícios** que imita rotas e formatos dos três serviços (marca as respostas com `x-servico-simulado: true`; o painel mostra uma faixa amarela).
- `painel/dev/lib.test.js` — testes com `node:test`.
- `docker/java.Dockerfile` — constrói as duas calculadoras Java a partir do GitHub; gera o banco SQLite uma vez com o Flyway do regime regular e copia para as duas imagens.
- `docker-compose.yml` — sobe os 3 serviços + painel, portas presas a 127.0.0.1.
- `servicos-windows.ps1` — como a Central RTC roda em produção desde 28/11/2026 (o WSL gastava memória demais): clona, compila e sobe os 3 serviços e o painel no Windows (Java 25 + Go 1.27 + Node), com o `.env` só no processo do painel, `-Xmx384m` em cada Java e o DANFSe no mesmo commit do compose. Só sobe o que não estiver no ar; `-Oculto` roda sem janela, com logs em `Documents\rfb-servicos\logs`. Contas em `painel/dados/usuarios.json`. Salvo em UTF-8 **com BOM** (um só: BOM duplicado faz o PowerShell ignorar o `param`), senão o PowerShell 5.1 quebra os acentos.
- `docs/` — GitHub Pages: `index.html` (página do projeto, com o endereço online), `guia.html` (guia de uso para quem não é da área contábil) e `guia-central-rtc.pdf` (o mesmo guia em PDF, gerado pelo `@media print` de `estilo.css` com o Chromium headless; gere de novo quando mudar o guia), com estilo comum em `estilo.css`, imagens e fontes.

## Comandos

```bash
cd painel
npm run teste       # testes das bibliotecas (não precisam dos serviços)
npm run simulador   # serviços falsos nas portas 8080/8082/8081
npm start           # painel em http://localhost:3000
node cli.js status
```

Com os serviços reais: `docker compose up -d --build` na raiz.

## Regras e convenções

- Sem dependências npm. Node 22+.
- Textos da interface em português, voz ativa, tom natural; botões dizem exatamente o que fazem.
- Identidade visual com as cores da Rede NAF: azul-marinho `#1a2a66` (texto, botões, topo) e verde-limão `#d7ee02` (`--destaque`, só fundo e realce, nunca texto em fundo claro). Não use o logo do NAF/Receita: a ferramenta não é oficial. Campos como células de formulário fiscal (`.ficha` / `.campo`), estado dos itens como carimbo (`.carimbo` com `data-tom` ok/erro/aviso/neutro). Cores e fontes (Barlow, Barlow Semi Condensed, locais em `public/fontes/`) estão em variáveis no topo de `styles.css`.
- Use `trocar(el, ...filhos)` em vez de `replaceChildren` quando houver filhos condicionais (evita "null" na tela).

## Contratos das APIs que importam

- **Simples Nacional** (`POST /api/calculadora/observabilidade/simples-nacional`): todos os valores vão como **texto** (`"950.00"`); `versao: "2.0.0"`; itens com `numero, cAtivSN, cClassTrib, baseCalculo, valorImpostoSeletivo, pIBSSN, pCBSSN`. Resposta: `objetos[].{nObj, estadoItem, tribCalc{vRBSNitem, vBC, vIBSSN, vCBSSN, IS{valor}, totalItem}, erros[]}` e `total`. Item sem `cAtivSN` vira `NAO_CALCULADO` sem erro. Arredondamento HALF_EVEN.
- **Atividades**: `GET /api/calculadora/simples-nacional/atividades?data=&anexos=I,III&tpDoc=&cClassTrib=`.
- **Regime geral** (`POST /api/calculadora/observabilidade/regime-geral`): valores **numéricos**; `dhFatoGerador` com fuso. A partir de 2027 `aliquotasNominais` é obrigatório por item (resultado vira `CALCULO_SIMULADO`); antes de 2027 é proibido. Resposta ROC: `objetos[].tribCalc.IBSCBS.gIBSCBS.{vBC, gIBSUF, gIBSMun, vIBS, gCBS}` com `gRed{pRedAliq, pAliqEfet}`.
- **XML**: `POST /api/calculadora/regime-geral` (sem observabilidade; 422 se algum item tiver erro) → `POST /api/calculadora/xml/generate?tipo=nfe` → `POST /api/calculadora/xml/validate?tipo=nfe&subtipo=grupo`.
- **DANFSe**: `POST /api/danfse?stc=0|1|2&canhoto=true|false` com o XML no corpo (até 5 MiB) → PDF.
- Códigos de documento: 55 NF-e, 65 NFC-e, 91 NFS-e, 57 CT-e, 67 CT-e OS, 63 BP-e, 93 BP-e TM, 62 NFCom.

## Conferido contra os serviços reais (21/11/2026)

Com `servicos-windows.ps1` (regime geral 1.7.2, Simples 1.0.2, banco V0073): `status`, lotes do Simples e do regime geral (com e sem erro), geração e validação de XML, DANFSe em PDF e o painel no navegador. Formatos reais: versão em `versaoApp`; erro do DANFSe em `mensagem`; erro de validação do regime geral é ProblemDetail com `title` + `detail` (sem `errors[]`); erros por item vêm em `objetos[].erros[]` com o código no texto (`REG-004`, `VSN-021`); `xml/validate` responde JSON `true`.

`docker compose up -d --build` também conferido (22/11/2026, Docker 29 no Ubuntu do WSL 2, sem Docker Desktop): os 4 containers sobem, lotes do Simples e do regime geral e o DANFSe em PDF funcionam. Os containers ficaram parados (`docker compose stop`) quando a produção passou para o Windows; não suba os dois juntos, porque disputam as mesmas portas.
