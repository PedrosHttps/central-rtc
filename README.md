<div align="center">

# Central RTC

**As calculadoras da Reforma Tributária do Consumo e o gerador de DANFSe da Receita Federal, num painel só.**

[![Versão](https://img.shields.io/github/v/release/PedrosHttps/central-rtc?label=vers%C3%A3o&color=1a2a66)](https://github.com/PedrosHttps/central-rtc/releases/latest)
[![Testes](https://github.com/PedrosHttps/central-rtc/actions/workflows/testes.yml/badge.svg)](https://github.com/PedrosHttps/central-rtc/actions/workflows/testes.yml)
[![Licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-5a2d82)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-15253a)](painel/package.json)
[![Docker Compose](https://img.shields.io/badge/docker-compose-15253a)](docker-compose.yml)

**Disponível online: [central-rtc.taild4c7a5.ts.net](https://central-rtc.taild4c7a5.ts.net)** (peça uma conta na tela de entrada)

[Página do projeto](https://pedroshttps.github.io/central-rtc/) ·
[Versão 1.0](https://github.com/PedrosHttps/central-rtc/releases/latest) ·
[Guia de uso](https://pedroshttps.github.io/central-rtc/guia.html) ([PDF](https://pedroshttps.github.io/central-rtc/guia-central-rtc.pdf)) ·
[Instalar](#como-rodar-com-docker) ·
[Linha de comando](#linha-de-comando) ·
[Planilhas](#planilhas-do-lote)

<img src="docs/img/simples-resultado.png" alt="Resultado de um cálculo do Simples Nacional no painel" width="820">

</div>

Um painel web e uma linha de comando que juntam os três serviços de código aberto da Receita Federal para a reforma tributária:

| Serviço | Repositório oficial | O que faz |
|---|---|---|
| Regime geral | [calculadora-rtc-regime-regular](https://github.com/ReceitaFederal/calculadora-rtc-regime-regular) | CBS, IBS e Imposto Seletivo por item, tabelas oficiais, geração e validação do XML |
| Simples Nacional | [calculadora-rtc-simples-nacional](https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional) | IBS e CBS do Simples (NT 2026.005) e catálogo de atividades × anexos |
| DANFSe | [calculadora-rtc-gerador-danfse](https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse) | PDF do DANFSe a partir do XML da NFS-e |

A Central RTC não recalcula nada por conta própria: ela monta as requisições, chama os serviços oficiais e organiza as respostas.

> [!NOTE]
> Projeto independente, sem vínculo com a Receita Federal. Confira os resultados antes de usá-los em documentos fiscais.

## O que dá para fazer

- **Simples Nacional**: calcular IBS e CBS item a item, ver o estado de cada item (calculado, não calculado, inconsistência) com os códigos `VSN-` explicados, e consultar quais atividades (`cAtivSN`) estão disponíveis para os anexos e o documento da empresa.
- **Regime geral**: calcular CBS, IBS e IS com memória de cálculo, e gerar e validar o XML do grupo de tributação (NF-e, NFC-e, CT-e, BP-e, NF3e).
- **Consultas**: cClassTrib, NCM, NBS, alíquotas de referência e descrição de códigos de erro.
- **DANFSe**: arrastar vários XMLs de NFS-e e baixar todos os PDFs num `.zip`.
- **DANFE**: transformar XMLs de NF-e (modelo 55) no DANFE retrato, montado no próprio navegador, sem certificado digital e sem o XML sair do computador. Para ter o PDF, use "Salvar como PDF" na impressão.
- **Em lote**: processar uma planilha CSV com centenas de itens e baixar o resultado em CSV (abre direto no Excel) e as respostas completas em JSON.

Tudo isso também roda pela linha de comando, para agendar ou encaixar em outros scripts.

## Telas

<table>
  <tr>
    <td width="50%"><img src="docs/img/regime-geral.png" alt="Cálculo do regime geral com CBS, IBS e Imposto Seletivo"><br><sub><b>Regime geral:</b> redução, alíquota efetiva e memória de cálculo por item</sub></td>
    <td width="50%"><img src="docs/img/atividades.png" alt="Tabela de atividades do Simples Nacional"><br><sub><b>Atividades do Simples:</b> o que está disponível para os anexos e o documento</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/img/danfse.png" alt="Geração de DANFSe em lote"><br><sub><b>DANFSe:</b> vários XMLs de uma vez, com o motivo de cada erro</sub></td>
    <td width="50%"><img src="docs/img/danfe.png" alt="Geração de DANFE de NF-e com código de barras da chave de acesso"><br><sub><b>DANFE:</b> NF-e em DANFE no navegador, sem certificado</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/img/lote.png" alt="Processamento de planilha em lote"><br><sub><b>Em lote:</b> planilha entra, planilha sai</sub></td>
  </tr>
</table>

<sub>Capturas feitas com o simulador de desenvolvimento do projeto; os valores são fictícios.</sub>

## Como rodar (com Docker)

Precisa do Docker Desktop (Windows/macOS) ou Docker Engine com o plugin Compose (Linux).

```bash
docker compose up -d --build
```

Depois abra **http://localhost:3000**. As bolinhas no topo do painel ficam verdes quando cada serviço responde.

A primeira subida demora: o Docker baixa o código dos três repositórios, as dependências do Maven e do Go, e gera o banco SQLite com as migrações oficiais. As próximas são rápidas.

| Endereço | O que é |
|---|---|
| http://localhost:3000 | Painel da Central RTC |
| http://localhost:8080/api/swagger-ui.html | Swagger do regime geral |
| http://localhost:8082/api/swagger-ui.html | Swagger do Simples Nacional |
| http://localhost:8081/api/swagger-ui/index.html | Swagger do DANFSe |

As portas ficam presas ao `127.0.0.1`, então só o seu computador acessa.

**Atualizar para a versão mais nova da Receita:** `docker compose build --no-cache && docker compose up -d`.

## Como rodar (sem Docker)

1. Suba os três serviços. Você vai precisar de Java 25 (regime geral e Simples), Go 1.27 (DANFSe) e Git; o Maven não, os repositórios trazem o `mvnw`.
   - **No Windows**, o script faz tudo: clona em `Documents\rfb-servicos`, gera o banco, compila (só na primeira vez) e abre cada serviço numa janela.
     ```powershell
     powershell -ExecutionPolicy Bypass -File servicos-windows.ps1
     ```
   - **Em outro sistema**, siga o README de cada repositório. O Simples Nacional usa o mesmo banco do regime geral: copie `calculadora/db/calculadora-pro.db` gerado no regime geral para a mesma pasta dentro do projeto do Simples. O DANFSe também usa a porta 8080 por padrão: rode com `SERVER_PORT=8081`.
2. Rode o painel (Node 22 ou mais novo, sem `npm install`):

```bash
cd painel
node server.js
```

Se os serviços estiverem em outros endereços, use as variáveis `RG_URL`, `SN_URL` e `DANFSE_URL` (veja abaixo).

## Linha de comando

Fica em `painel/cli.js` e usa o mesmo motor do painel.

```bash
cd painel
node cli.js status                                      # confere se os três serviços respondem
node cli.js modelo simples -o minha-planilha.csv         # planilha de exemplo para preencher
node cli.js lote simples minha-planilha.csv              # gera minha-planilha-resultado.csv
node cli.js lote regime-geral notas.csv --json respostas.json
node cli.js danfse ./xmls -o ./pdfs                      # uma pasta inteira de NFS-e para PDF
node cli.js danfse nota.xml --stc 2 --sem-canhoto        # nota cancelada, sem canhoto
```

Códigos de saída: `0` deu tudo certo, `1` erro de uso ou serviço fora do ar, `2` terminou mas algum item ou nota falhou. Isso facilita agendar:

```bash
# Linux/macOS (crontab): todo dia às 6h, converte os XMLs que chegaram
0 6 * * * cd /caminho/central-rtc/painel && node cli.js danfse ~/notas/entrada -o ~/notas/pdf
```

No Windows, use o Agendador de Tarefas com o programa `node` e os argumentos `cli.js danfse C:\notas\entrada -o C:\notas\pdf`, iniciando na pasta `painel`.

| Variável | Padrão | Para quê |
|---|---|---|
| `RG_URL` | `http://localhost:8080/api` | Regime geral |
| `SN_URL` | `http://localhost:8082/api` | Simples Nacional |
| `DANFSE_URL` | `http://localhost:8081` | Gerador de DANFSe |
| `PORTA` | `3000` | Porta do painel |
| `HOST` | `127.0.0.1` | Interface do painel (`0.0.0.0` só dentro do Docker) |
| `PAINEL_USUARIO` e `PAINEL_SENHA` | vazias (sem login) | Ligam a tela de login. Essa é a conta do administrador, que cadastra as outras pessoas. Obrigatórias antes de deixar o painel acessível por outros aparelhos. A senha precisa ter 12 caracteres ou mais. No Docker, coloque as duas no arquivo `.env` da raiz, que fica fora do Git. |
| `PAINEL_EMAIL_ACESSO` | vazia | E-mail do administrador, usado no "Esqueceu a senha?" quando o envio por e-mail (SMTP) está desligado. O "Contatar suporte" do login leva à seção de contato do aviso de privacidade. |
| `PAINEL_TOKEN_REVISAO` | vazia | Chave (32 caracteres ou mais) da revisão automática de pedidos. Com `Authorization: Bearer <chave>` só dá para `GET /api/pedidos` e `POST /api/usuarios/<e-mail>/aprovar` ou `recusar`. |
| `PAINEL_DADOS` | `painel/dados` | Pasta do `usuarios.json`, com as contas cadastradas (só o hash das senhas). No Docker fica no volume `contas`. |

### Contas de usuário

Com o login ligado, há dois caminhos para alguém ganhar acesso:

- **A pessoa pede sozinha:** em **Criar conta**, na tela de login, ela informa nome, e-mail (que vira o usuário), empresa (opcional) e a senha que escolher. A ferramenta é aberta a todos. A conta nasce **em análise** só para uma checagem contra robôs e spam, que o `vigia-pedidos.ps1` faz em 1 a 2 minutos. O mesmo endereço de internet só consegue fazer 3 pedidos por hora, e o painel aceita no máximo 100 pedidos aguardando análise.
- **O administrador cadastra:** em **Usuários**, ele cria a conta com uma senha provisória. No primeiro acesso, o painel obriga a pessoa a trocar essa senha.

Os pedidos são aprovados ou recusados pelo administrador, também em **Usuários**, ou por uma revisão automática que usa a chave `PAINEL_TOKEN_REVISAO`. Por exemplo, uma tarefa agendada do Claude Code que lê os pedidos e decide seguindo regras escritas. A tela mostra quem decidiu e por quê. Em **Usuários**, o administrador também gera uma senha provisória nova para quem esqueceu e remove o acesso de quem saiu. Quem é removido sai na hora.

**Esqueceu a senha:** com `PAINEL_ENDERECO`, `SMTP_USUARIO` e `SMTP_SENHA` no `.env`, o link "Esqueceu a senha?" do login abre `senha.html`. A pessoa digita o e-mail da conta e recebe um link que vale 30 minutos e uma vez só. Ela cria a senha nova sozinha, e as sessões abertas dela caem. A resposta é a mesma com ou sem conta. Enquanto o link enviado ainda vale, a conta não recebe outro (se o envio falhar, o link é descartado e dá para pedir de novo). Cada conta recebe no máximo 3 e-mails em 24 horas, e cada endereço de internet faz até 5 pedidos por hora. Contas em análise e o administrador não recebem link. No Gmail, `SMTP_SENHA` é uma senha de app (myaccount.google.com/apppasswords, que exige a verificação em duas etapas). Sem essas variáveis, o link abre um e-mail para `PAINEL_EMAIL_ACESSO`: aí o administrador gera uma senha provisória em **Usuários**, e o painel obriga a trocar no primeiro acesso.

Senhas precisam ter 12 caracteres ou mais e pelo menos um caractere especial (como `! @ # $ %`). Cada e-mail, cada nome e cada empresa só podem ter uma conta: maiúsculas, acentos e espaços não contam como diferença, e pedidos recusados não ocupam o nome. Depois de 10 senhas erradas em 15 minutos, o endereço de internet fica sem conseguir entrar por 15 minutos. As sessões duram 12 horas e só existem na memória: reiniciar o painel pede login de novo a todos.

### Monitor do administrador

O administrador tem o botão **Monitor**, que abre `/admin.html`. A página mostra quem está conectado (com IP, aparelho e último uso), todas as contas (com o último acesso) e as 200 tentativas de cadastro mais recentes, inclusive as recusadas pelas regras. Ela se atualiza a cada 20 segundos. Para quem não é administrador, a página volta para o painel e `/api/monitor` responde 403.

### Privacidade (LGPD)

O aviso de privacidade fica em [`docs/privacidade.html`](https://pedroshttps.github.io/central-rtc/privacidade.html), com link no rodapé de todas as telas. Para cumprir os prazos que ele promete:

- pedidos recusados são apagados 30 dias depois da decisão (ao subir o painel e a cada 6 horas);
- sessões, tentativas de cadastro, bloqueios e links de senha nova ficam só na memória;
- o `vigia-pedidos.ps1` grava um registro por mês (`revisao-pedidos-AAAA-MM.log`) e guarda só os 3 últimos;
- as cópias das contas ficam 30 dias.

Se mudar o que é guardado ou por quanto tempo, atualize o aviso.

### Cópia das contas

Uma vez por dia o `vigia-pedidos.ps1` copia o `usuarios.json` do Docker para `copias-contas/usuarios-AAAA-MM-DD.json`, fora do Git, e guarda as 30 últimas. A cópia tem os e-mails e o hash das senhas. Para voltar uma cópia:

```powershell
wsl -e docker cp /mnt/c/Users/pedro/Documents/central-rtc/copias-contas/usuarios-AAAA-MM-DD.json central-rtc-painel-1:/app/dados/usuarios.json
wsl -e docker exec -u root central-rtc-painel-1 chown node:node /app/dados/usuarios.json
wsl -e docker restart central-rtc-painel-1
```

## Planilhas do lote

- Separador `;` ou `,` (detectado sozinho). Decimais com vírgula ou ponto: `1.234,56` e `1234.56` funcionam.
- Datas em `15/03/2027` ou `2027-03-15`. No regime geral, `dhFatoGerador` aceita `10/03/2027 10:00`; sem fuso, usa o do computador.
- Cada linha é um item. Linhas com o mesmo valor em `operacao` viram uma única requisição (uma nota). Os dados da operação (data, documento, CRT…) valem os da primeira linha do grupo.
- O resultado sai com `;` e vírgula decimal, pronto para o Excel em português, com a coluna `linhaPlanilha` apontando de onde veio cada item.

**Simples Nacional:** `operacao, data, tpDoc, CRT, tpRegimeIBSCBS, tpEnteGov, item, cAtivSN, cClassTrib, baseCalculo, valorImpostoSeletivo, pIBSSN, pCBSSN`

**Regime geral:** `operacao, dhFatoGerador, municipio, uf, tpDoc, tpEnteGov, item, ncm, nbs, cst, cClassTrib, baseCalculo, quantidade, unidade, aliqCBS, aliqIBSUF, aliqIBSMun` e, para Imposto Seletivo, `isCst, isClassTrib, isBaseCalculo, isQuantidade, isUnidade, isImpostoInformado, isAdValorem, isAdRem`.

Use `node cli.js modelo <tipo>` ou o botão **Baixar planilha modelo** para começar de um arquivo pronto.

## Regras que vale lembrar

- **Regime geral, a partir de 2027:** as alíquotas nominais são obrigatórias em cada item, e o resultado sai como *cálculo simulado*. Antes de 2027 elas são proibidas, e a calculadora usa as alíquotas de referência de 2026. O painel esconde ou mostra os campos conforme a data.
- **Simples Nacional:** item sem `cAtivSN` (ou com atividade fora de vigência ou não admitida no documento) não é calculado, sem erro. As alíquotas efetivas (`pIBSSN`, `pCBSSN`) vêm da apuração da empresa.
- **DANFSe:** é o documento auxiliar de uma NFS-e já autorizada. Use os XMLs que o emissor devolveu. Para testar ou demonstrar, há uma nota fictícia em `painel/exemplos/nfse-exemplo.xml` (sai com a faixa "sem validade jurídica").
- **DANFE:** é a versão impressa de uma NF-e já autorizada e não precisa de certificado: quem assina é o emissor, na hora de emitir a nota. A Central RTC monta o DANFE (não é um serviço da Receita) no leiaute do Manual de Orientação do Contribuinte, com o quadro de IBS e CBS quando a nota tem esse grupo. XML sem protocolo de autorização, ou emitido em homologação, sai com a faixa "sem valor fiscal". NFC-e (modelo 65) tem outro DANFE, com QR Code, e não entra. Nota fictícia para testar: `painel/exemplos/nfe-exemplo.xml`.

## Desenvolvimento

```bash
cd painel
npm run teste        # testes das bibliotecas (não precisam dos serviços)
npm run simulador    # imita os três serviços com dados FICTÍCIOS, para mexer na interface
npm start            # painel
```

O simulador (`dev/mock-servicos.js`) segue as rotas e os formatos dos serviços reais, mas os números são inventados. Quando ele está ligado, o painel mostra uma faixa amarela avisando.

```
central-rtc/
├── docker-compose.yml
├── docs/                      # página do projeto (GitHub Pages)
├── docker/java.Dockerfile      # constrói as duas calculadoras Java a partir do GitHub
└── painel/
    ├── server.js               # serve a interface e repassa chamadas aos serviços
    ├── cli.js                  # linha de comando
    ├── public/                 # interface (HTML, CSS e JS puros, sem build)
    │   └── lib/                # código compartilhado entre painel e CLI: cliente, lote, CSV, ZIP
    └── dev/                    # testes e simulador
```

## Problemas comuns

- **Bolinha vermelha depois de `docker compose up`:** as calculadoras Java levam alguns segundos para subir. Veja com `docker compose logs -f regime-geral`.
- **Erro ao baixar imagem `maven:3.9-eclipse-temurin-25`:** troque a tag no `docker/java.Dockerfile` por outra disponível no Docker Hub com Java 25 (por exemplo `maven:3-eclipse-temurin-25`).
- **Porta 8080 ocupada:** mude o lado esquerdo do mapeamento no `docker-compose.yml` (ex.: `"127.0.0.1:18080:8080"`). O painel continua funcionando, porque fala com os serviços pela rede interna do Docker.

## Licença

MIT. As fontes Barlow são distribuídas sob a SIL Open Font License (`painel/public/fontes/OFL-LICENSE.txt`). Os serviços da Receita Federal têm suas próprias licenças, nos respectivos repositórios.
