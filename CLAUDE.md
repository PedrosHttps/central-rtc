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
  - `Authorization: Bearer PAINEL_TOKEN_REVISAO` só lista `/api/pedidos` e aprova ou recusa. Usado pela tarefa agendada `central-rtc-revisar-pedidos` do Claude Code.
  - Google (opcional, `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `PAINEL_URL`), em `/api/google/entrar` → `/api/google/retorno`:
    - Fluxo de código com PKCE; o `state.verificador` vai num cookie `SameSite=Lax`.
    - Sem conta: o `google_cadastro` leva a `cadastro.html?google=1`. O pedido é gravado sem hash (conta só do Google, que nunca entra por senha) e com `pedido.emailConfirmado`.
    - A volta usa uma página com `meta refresh` em vez de 302, para o cookie `SameSite=Strict` da sessão valer.
    - Os testes trocam `GOOGLE_TOKEN_URL` por um servidor falso.
  - Públicos: `login.html`, `login.js`, `cadastro.html`, `cadastro.js`, `styles.css`, `fontes/`, `/api/acesso`, `/api/entrar`, `/api/cadastro` e `/api/google/*`.
- `painel/cli.js` — comandos `status`, `modelo`, `lote`, `danfse`. Códigos de saída: 0 ok, 1 uso/serviço fora, 2 algum item falhou.
- `painel/public/lib/` — **código compartilhado entre navegador e Node** (ESM puro): `rtc.js` (cliente, montagem das operações, leitura dos resultados, lote), `csv.js`, `formato.js`, `zip.js`. Não use APIs exclusivas do Node aqui.
- `painel/public/app.js` + `index.html` + `styles.css` — interface, JS puro, sem build.
- `painel/dev/mock-servicos.js` — simulador com **dados fictícios** que imita rotas e formatos dos três serviços (marca as respostas com `x-servico-simulado: true`; o painel mostra uma faixa amarela).
- `painel/dev/lib.test.js` — testes com `node:test`.
- `docker/java.Dockerfile` — constrói as duas calculadoras Java a partir do GitHub; gera o banco SQLite uma vez com o Flyway do regime regular e copia para as duas imagens.
- `docker-compose.yml` — sobe os 3 serviços + painel, portas presas a 127.0.0.1.
- `servicos-windows.ps1` — alternativa sem Docker: clona, compila e sobe os 3 serviços no Windows (Java 25 + Go 1.27). Salvo em UTF-8 **com BOM**, senão o PowerShell 5.1 quebra os acentos.
- `docs/` — página do GitHub Pages (HTML único + imagens + fontes).

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
- Identidade visual: campos como células de formulário fiscal (`.ficha` / `.campo`), estado dos itens como carimbo (`.carimbo` com `data-tom` ok/erro/aviso/neutro). Cores e fontes (Barlow, Barlow Semi Condensed, locais em `public/fontes/`) estão em variáveis no topo de `styles.css`.
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

`docker compose up -d --build` também conferido (22/11/2026, Docker 29 no Ubuntu do WSL 2, sem Docker Desktop): os 4 containers sobem, lotes do Simples e do regime geral e o DANFSe em PDF funcionam. No WSL, o Ubuntu desliga quando fica sem janela aberta e derruba os containers; `instanceIdleTimeout=-1` e `vmIdleTimeout=-1` no `.wslconfig` evitam isso.
