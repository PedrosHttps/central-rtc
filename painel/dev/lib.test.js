// Testes das bibliotecas compartilhadas e do login do painel (rodam sem os serviços): npm run teste
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerCSV, gerarCSV } from '../public/lib/csv.js';
import { decimal, numero, dataISO, dataHoraISO, decimalBR } from '../public/lib/formato.js';
import { criarZip, crc32, nomeUnico } from '../public/lib/zip.js';
import { prepararLote, executarLote, operacaoSimples, operacaoRegimeGeral, itensRegimeGeral } from '../public/lib/rtc.js';

test('CSV: detecta ";" e lida com aspas, BOM e linhas vazias', () => {
  const { linhas, separador } = lerCSV('﻿a;b;c\r\n1;"x;y";"diz ""oi"""\r\n\r\n2;;3\r\n');
  assert.equal(separador, ';');
  assert.deepEqual(linhas, [
    { _linha: 2, a: '1', b: 'x;y', c: 'diz "oi"' },
    { _linha: 4, a: '2', b: '', c: '3' },
  ]);
});

test('CSV: detecta "," e gera de volta com ";"', () => {
  const { linhas } = lerCSV('nome,valor\n"Silva, Ana",10\n');
  assert.equal(linhas[0].nome, 'Silva, Ana');
  assert.equal(gerarCSV(linhas, ['nome', 'valor'], { bom: false }), 'nome;valor\r\nSilva, Ana;10\r\n');
});

test('números no formato brasileiro', () => {
  assert.equal(decimal('1.234,56'), '1234.56');
  assert.equal(decimal('R$ 10'), '10');
  assert.equal(decimal('950.00'), '950.00');
  assert.equal(decimal(''), null);
  assert.equal(decimal('abc'), 'abc');
  assert.equal(numero('8,8'), 8.8);
  assert.equal(decimalBR('1200.00'), '1200,00');
  assert.equal(decimalBR(3.5), '3,50');
  // milhar sem vírgula e formato americano não podem virar valores mil vezes menores
  assert.equal(decimal('1.200'), '1200');
  assert.equal(decimal('-12.345.678'), '-12345678');
  assert.equal(decimal('1,234.56'), '1234.56');
  assert.equal(decimal('0.050'), '0.050');
  assert.equal(decimal('1.25'), '1.25');
  assert.equal(decimalBR(0.0525), '0,0525');
});

test('lote: item "01" aponta a linha certa e serviço fora vira semResposta', async () => {
  const { linhas } = lerCSV('operacao;data;tpDoc;CRT;item;cClassTrib;baseCalculo\nA;2027-03-15;55;1;01;000001;10\nB;2027-03-15;55;1;1;000001;20\n');
  const { operacoes } = prepararLote('simples', linhas);
  const cliente = {
    simplesNacional: {
      calcular: async (op) => {
        if (op.itens[0].baseCalculo === '20') throw Object.assign(new Error('fora'), { status: 502 });
        return { dados: { objetos: [{ nObj: 1, estadoItem: 'CALCULADO', tribCalc: {} }] } };
      },
    },
  };
  const { linhas: saida, resultados } = await executarLote('simples', operacoes, cliente);
  assert.equal(saida[0].linhaPlanilha, 2);
  assert.deepEqual(resultados.map((r) => !!r.semResposta), [false, true]);
});

test('datas', () => {
  assert.equal(dataISO('15/03/2027'), '2027-03-15');
  assert.equal(dataHoraISO('2027-03-10T10:00:00-03:00'), '2027-03-10T10:00:00-03:00');
  assert.equal(dataHoraISO('10/03/2027 10:00', '-04:00'), '2027-03-10T10:00:00-04:00');
  assert.equal(dataHoraISO('2027-03-10', '-04:00'), '2027-03-10T12:00:00-04:00');
  assert.equal(dataHoraISO('2027-03-10T10:00', '-04:00'), '2027-03-10T10:00:00-04:00');
});

test('ZIP: estrutura e CRC32', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const zip = criarZip([{ nome: 'ação.txt', dados: 'olá' }]);
  const v = new DataView(zip.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  assert.equal(v.getUint32(zip.length - 22, true), 0x06054b50);
  const usados = new Set();
  assert.deepEqual(['a.pdf', 'a.pdf', 'a.pdf'].map((n) => nomeUnico(n, usados)), ['a.pdf', 'a (2).pdf', 'a (3).pdf']);
});

test('operação do Simples: texto, cAtivSN com dois dígitos e IS padrão 0.00', () => {
  const op = operacaoSimples({ id: 'x', data: '15/03/2027', tpDoc: 55, CRT: 1, itens: [{ cAtivSN: '1', cClassTrib: '000001', baseCalculo: '950,00', pIBSSN: '1,25', pCBSSN: '2,75' }] });
  assert.deepEqual(op, {
    id: 'x', versao: '2.0.0', data: '2027-03-15', tpDoc: '55', CRT: '1',
    itens: [{ numero: 1, cAtivSN: '01', cClassTrib: '000001', baseCalculo: '950.00', valorImpostoSeletivo: '0.00', pIBSSN: '1.25', pCBSSN: '2.75' }],
  });
});

test('operação do regime geral: sem alíquotas vazias e com IS aninhado', () => {
  const op = operacaoRegimeGeral({
    id: 'y', dhFatoGerador: '2026-06-01T10:00:00-04:00', municipio: '1302603', uf: 'am',
    itens: [
      { ncm: '10063021', cst: '000', cClassTrib: '000001', baseCalculo: '100,00' },
      { ncm: '22030000', cst: '000', cClassTrib: '000001', isCst: '000', isClassTrib: '000001', isBaseCalculo: '150', aliqCBS: '8,8', isAdValorem: '10' },
    ],
  });
  assert.equal(op.uf, 'AM');
  assert.equal(op.municipio, 1302603);
  assert.equal(op.itens[0].aliquotasNominais, undefined);
  assert.deepEqual(op.itens[1].impostoSeletivo, { cst: '000', cClassTrib: '000001', baseCalculo: 150 });
  assert.deepEqual(op.itens[1].aliquotasNominais, { cbs: 8.8, impostoSeletivo: { adValorem: 10 } });
});

test('lote: agrupa por operação, aponta colunas faltando e diferenças entre linhas', () => {
  const { linhas } = lerCSV('operacao;data;tpDoc;CRT;cClassTrib;baseCalculo\nA;2027-03-15;55;1;000001;10\nA;2027-03-16;55;1;000001;20\n;2027-03-15;55;;000001;5\n');
  const { operacoes, problemas } = prepararLote('simples', linhas);
  assert.equal(operacoes.length, 2);
  assert.equal(operacoes[0].requisicao.itens.length, 2);
  assert.deepEqual(problemas.map((p) => [p.linha, !!p.aviso]), [[3, true], [4, false]]);
});

test('lote: falha de rede vira linha FALHA_REQUISICAO e o resto segue', async () => {
  const { linhas } = lerCSV('operacao;dhFatoGerador;municipio;cst;cClassTrib;ncm;baseCalculo\nA;2026-06-01;1302603;000;000001;10063021;100\nB;2026-06-01;1302603;000;000001;10063021;50\n');
  const { operacoes } = prepararLote('regime-geral', linhas);
  const cliente = {
    regimeGeral: {
      calcularComObservabilidade: async (op) => {
        if (op.itens[0].baseCalculo === 50) throw new Error('caiu');
        return { dados: { objetos: [{ nObj: 1, estadoItem: 'CALCULADO', tribCalc: { IBSCBS: { CST: '000', cClassTrib: '000001', gIBSCBS: { vBC: '100.00', gCBS: { pCBS: '0.90', vCBS: '0.90' } } } } }] } };
      },
    },
  };
  const { linhas: saida, resumo } = await executarLote('regime-geral', operacoes, cliente);
  assert.deepEqual(saida.map((l) => [l.operacao, l.estado, l.vCBS ?? l.erros]), [['A', 'CALCULADO', '0.90'], ['B', 'FALHA_REQUISICAO', 'caiu']]);
  assert.deepEqual(resumo, { operacoes: 2, itens: 2, calculados: 1, comErro: 1, outros: 0 });
});

test('leitura do resultado do regime geral (formato da documentação oficial)', () => {
  const [it] = itensRegimeGeral({
    objetos: [{ nObj: 3, estadoItem: 'CALCULO_SIMULADO', tribCalc: { IBSCBS: { CST: '200', cClassTrib: '200028', gIBSCBS: {
      vBC: '1200.00',
      gIBSUF: { pIBSUF: '0.05', gRed: { pRedAliq: '60.00', pAliqEfet: '0.02' }, vIBSUF: '0.24' },
      gIBSMun: { pIBSMun: '0.05', gRed: { pRedAliq: '60.00', pAliqEfet: '0.02' }, vIBSMun: '0.24' },
      vIBS: '0.48',
      gCBS: { pCBS: '8.80', gRed: { pRedAliq: '60.00', pAliqEfet: '3.52' }, vCBS: '42.24' },
    } } } }],
  });
  assert.equal(it.vCBS, '42.24');
  assert.equal(it.pAliqEfetCBS, '3.52');
  assert.equal(it.pRedIBSUF, '60.00');
  assert.equal(it.vIBS, '0.48');
});

const CHAVE_REVISAO = 'chave-de-revisao-de-teste-com-mais-de-32-caracteres';

// Sobe o painel de verdade com login e uma pasta de dados temporária; devolve funções para fazer requisições.
async function subirPainel(t, porta, extras = {}, usuariosIniciais = null) {
  const dados = mkdtempSync(path.join(tmpdir(), 'central-rtc-'));
  if (usuariosIniciais) writeFileSync(path.join(dados, 'usuarios.json'), JSON.stringify(usuariosIniciais));
  const env = {
    ...process.env, PORTA: String(porta), HOST: '127.0.0.1', PAINEL_DADOS: dados,
    PAINEL_USUARIO: 'ana', PAINEL_SENHA: 'senha-de-teste-123', PAINEL_EMAIL_ACESSO: 'acesso@exemplo.com',
    PAINEL_TOKEN_REVISAO: CHAVE_REVISAO, ...extras,
  };
  const filho = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { env });
  t.after(() => {
    filho.kill();
    rmSync(dados, { recursive: true, force: true });
  });
  await new Promise((ok, falha) => {
    filho.stdout.on('data', (d) => String(d).includes('no ar') && ok());
    filho.on('exit', (c) => falha(new Error(`painel saiu com ${c}`)));
  });
  const pedir = (caminho, { metodo = 'GET', corpo, sessao, ip = '10.0.0.1' } = {}) =>
    fetch(`http://127.0.0.1:${porta}${caminho}`, {
      method: metodo,
      redirect: 'manual',
      headers: {
        'x-forwarded-for': ip,
        ...(corpo ? { 'content-type': 'application/json' } : {}),
        ...(sessao ? { cookie: `sessao=${sessao}` } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  const entrar = async (usuario, senha, ip) => {
    const r = await pedir('/api/entrar', { metodo: 'POST', corpo: { usuario, senha }, ip });
    return { status: r.status, sessao: /sessao=([\w-]+)/.exec(r.headers.get('set-cookie') || '')?.[1], dados: await r.json() };
  };
  return { pedir, entrar, dados };
}

test('Painel: login, cadastro de usuários e troca da senha provisória', async (t) => {
  const { pedir, entrar, dados } = await subirPainel(t, 39517);

  // Sem sessão: a página vai para o login, a API recusa, a tela de login e o e-mail de acesso são públicos.
  const inicio = await pedir('/');
  assert.equal(inicio.status, 302);
  assert.equal(inicio.headers.get('location'), '/login.html');
  assert.match(inicio.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  // Arquivos vão comprimidos e, se o navegador já tem a versão atual, nada é baixado de novo.
  const tela = await fetch('http://127.0.0.1:39517/login.html', { headers: { 'accept-encoding': 'br' } });
  assert.equal(tela.headers.get('content-encoding'), 'br');
  assert.match(await tela.text(), /<form id="form-entrar"/);
  const repetida = await fetch(`http://127.0.0.1:39517/login.html`, { headers: { 'if-none-match': tela.headers.get('etag') } });
  assert.equal(repetida.status, 304);
  assert.equal((await pedir('/status')).status, 401);
  assert.equal((await pedir('/svc/rg/versao')).status, 401);
  assert.equal((await pedir('/login.html')).status, 200);
  assert.deepEqual(await (await pedir('/api/acesso')).json(), { email: 'acesso@exemplo.com', redefinir: false });

  assert.equal((await entrar('ana', 'errada')).status, 401);
  assert.equal((await entrar('ninguem', 'senha-de-teste-123')).status, 401);
  const admin = await entrar('ANA', 'senha-de-teste-123');
  assert.equal(admin.status, 200);
  assert.equal(admin.dados.admin, true);
  assert.equal((await pedir('/status', { sessao: admin.sessao })).status, 200);

  // O administrador cadastra; nome repetido, nome inválido e senha curta são recusados.
  const cadastrar = (corpo) => pedir('/api/usuarios', { metodo: 'POST', corpo, sessao: admin.sessao });
  assert.equal((await cadastrar({ usuario: 'maria@empresa.com', senha: 'provisoria-123' })).status, 201);
  assert.equal((await cadastrar({ usuario: 'maria@empresa.com', senha: 'provisoria-456' })).status, 409);
  assert.equal((await cadastrar({ usuario: 'joao', senha: 'curta' })).status, 400);
  assert.equal((await cadastrar({ usuario: 'Nome Com Espaço', senha: 'provisoria-123' })).status, 400);
  const arquivo = readFileSync(path.join(dados, 'usuarios.json'), 'utf8');
  assert.match(arquivo, /maria@empresa\.com/);
  assert.doesNotMatch(arquivo, /provisoria-123/); // só o hash fica gravado

  // Com a senha provisória, a pessoa só consegue trocar a senha.
  const maria = await entrar('maria@empresa.com', 'provisoria-123');
  assert.equal(maria.dados.trocarSenha, true);
  assert.equal((await pedir('/status', { sessao: maria.sessao })).status, 403);
  const trocar = (corpo) => pedir('/api/senha', { metodo: 'POST', corpo, sessao: maria.sessao });
  assert.equal((await trocar({ atual: 'errada-123456', nova: 'minha-senha-nova' })).status, 403);
  assert.equal((await trocar({ atual: 'provisoria-123', nova: 'curta' })).status, 400);
  assert.equal((await trocar({ atual: 'provisoria-123', nova: 'minha-senha-nova' })).status, 200);
  assert.equal((await pedir('/status', { sessao: maria.sessao })).status, 200);
  assert.equal((await entrar('maria@empresa.com', 'provisoria-123')).status, 401);

  // Quem não é administrador não cadastra; removida, a pessoa sai na hora.
  assert.equal((await pedir('/api/usuarios', { sessao: maria.sessao })).status, 403);
  assert.equal((await pedir('/api/usuarios/maria%40empresa.com', { metodo: 'DELETE', sessao: admin.sessao })).status, 200);
  assert.equal((await pedir('/status', { sessao: maria.sessao })).status, 401);

  // Sair encerra a sessão.
  assert.equal((await pedir('/api/sair', { metodo: 'POST', sessao: admin.sessao })).status, 200);
  assert.equal((await pedir('/status', { sessao: admin.sessao })).status, 401);
});

test('Painel: bloqueia o endereço que erra a senha demais', async (t) => {
  const { entrar } = await subirPainel(t, 39518);

  // 10 senhas erradas diferentes bloqueiam o endereço (até com a senha certa); outro endereço segue entrando.
  for (let i = 0; i < 10; i++) assert.equal((await entrar('ana', `errada-${i}`, '10.0.0.2')).status, 401);
  assert.equal((await entrar('ana', 'senha-de-teste-123', '10.0.0.2')).status, 429);
  assert.equal((await entrar('ana', 'senha-de-teste-123', '10.0.0.3')).status, 200);

  // A mesma tentativa repetida não bloqueia.
  for (let i = 0; i < 15; i++) assert.equal((await entrar('ana', 'senha-antiga', '10.0.0.4')).status, 401);
  assert.equal((await entrar('ana', 'senha-de-teste-123', '10.0.0.4')).status, 200);

  // IPv6 conta pelo bloco /64: trocar de endereço dentro do bloco não escapa; outro bloco segue entrando.
  for (let i = 1; i <= 10; i++) assert.equal((await entrar('ana', `errada-${i}`, `2001:db8:1:2::${i}`)).status, 401);
  assert.equal((await entrar('ana', 'senha-de-teste-123', '2001:0db8:0001:0002:ffff::99')).status, 429);
  assert.equal((await entrar('ana', 'senha-de-teste-123', '2001:db8:1:3::1')).status, 200);
});

test('Painel: a pessoa pede acesso sozinha e a revisão aprova ou recusa', async (t) => {
  const { pedir, entrar } = await subirPainel(t, 39519);
  const pedirAcesso = (dados, ip = '10.0.1.1') => pedir('/api/cadastro', { metodo: 'POST', corpo: dados, ip });
  const revisao = (caminho, metodo = 'GET', chave = CHAVE_REVISAO) =>
    fetch(`http://127.0.0.1:39519${caminho}`, {
      method: metodo,
      headers: { authorization: `Bearer ${chave}`, 'content-type': 'application/json', 'x-forwarded-for': '10.0.9.9' },
      body: metodo === 'POST' ? JSON.stringify({ observacao: 'pedido coerente' }) : undefined,
    });
  const bia = { nome: 'Bia Souza', email: 'Bia@Empresa.com.br', empresa: 'Empresa', senha: 'senha-da-bia-123' };

  assert.equal((await pedir('/cadastro.html')).status, 200);
  assert.equal((await pedirAcesso({ ...bia, email: 'sem-arroba' })).status, 400);
  assert.equal((await pedirAcesso({ ...bia, senha: 'curta' })).status, 400);
  assert.equal((await pedirAcesso(bia)).status, 201);

  // Em análise: senha certa não entra; senha errada nem revela a situação.
  const pendente = await entrar('bia@empresa.com.br', 'senha-da-bia-123');
  assert.equal(pendente.status, 403);
  assert.match(pendente.dados.mensagem, /em análise/);
  assert.equal((await entrar('bia@empresa.com.br', 'outra-senha-qualquer')).status, 401);

  // Pedir de novo com o mesmo e-mail responde igual e não troca a senha (não revela quem tem conta).
  assert.equal((await pedirAcesso({ ...bia, senha: 'senha-do-intruso-1' })).status, 201);

  // A chave de revisão lista pedidos e decide; não faz mais nada. Chave errada é recusada.
  assert.equal((await revisao('/api/pedidos', 'GET', 'chave-errada')).status, 401);
  const { pedidos } = await (await revisao('/api/pedidos')).json();
  assert.deepEqual(pedidos.map((p) => [p.usuario, p.nome, p.empresa]), [['bia@empresa.com.br', 'Bia Souza', 'Empresa']]);
  assert.equal((await revisao('/api/usuarios')).status, 403);
  assert.equal((await revisao('/status')).status, 403);
  assert.equal((await revisao('/api/usuarios/bia%40empresa.com.br/aprovar', 'POST')).status, 200);
  assert.equal((await revisao('/api/usuarios/bia%40empresa.com.br/recusar', 'POST')).status, 409); // já decidido
  const bia2 = await entrar('bia@empresa.com.br', 'senha-da-bia-123');
  assert.equal(bia2.status, 200);
  assert.equal(bia2.dados.trocarSenha, false);
  assert.equal((await entrar('bia@empresa.com.br', 'senha-do-intruso-1')).status, 401);

  // Recusado não entra; o administrador vê quem decidiu.
  assert.equal((await pedirAcesso({ ...bia, nome: 'Robô', empresa: 'Spam Ltda', email: 'spam@spam.com' }, '10.0.1.2')).status, 201);
  assert.equal((await revisao('/api/usuarios/spam%40spam.com/recusar', 'POST')).status, 200);
  assert.match((await entrar('spam@spam.com', 'senha-da-bia-123')).dados.mensagem, /recusado/);
  const admin = await entrar('ana', 'senha-de-teste-123');
  const { usuarios } = await (await pedir('/api/usuarios', { sessao: admin.sessao })).json();
  assert.equal(usuarios.find((u) => u.usuario === 'spam@spam.com').decisao.por, 'revisão automática');

  // No máximo 3 pedidos por hora do mesmo endereço, mesmo com 10 conexões abertas juntas que só mandam o corpo depois.
  const pedidoLento = (dados, ip) => new Promise((ok, falha) => {
    const corpo = JSON.stringify(dados);
    const r = http.request({
      host: '127.0.0.1', port: 39519, path: '/api/cadastro', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(corpo), 'x-forwarded-for': ip },
    }, (resposta) => { resposta.resume(); ok(resposta.statusCode); });
    r.on('error', falha);
    r.flushHeaders();
    setTimeout(() => r.end(corpo), 300);
  });
  const simultaneos = await Promise.all(Array.from({ length: 10 }, (_, i) => pedidoLento({ ...bia, nome: `Pessoa ${i}`, empresa: '', email: `p${i}@x.com` }, '10.0.1.3')));
  assert.deepEqual(simultaneos.toSorted(), [201, 201, 201, 429, 429, 429, 429, 429, 429, 429]);
  const pendentes = (await (await revisao('/api/pedidos')).json()).pedidos.filter((p) => p.usuario.endsWith('@x.com'));
  assert.equal(pendentes.length, 3);
  assert.equal((await pedirAcesso({ ...bia, email: 'p99@x.com' }, '10.0.1.3')).status, 429);
});

test('Painel: senha com especial, nome e empresa únicos, monitor do administrador e limpeza de recusados', async (t) => {
  const dias = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const recusado = (nome, n) => ({ status: 'recusado', criadoEm: dias(n), pedido: { nome, empresa: '' }, decisao: { acao: 'recusar', por: 'revisão automática', em: dias(n) } });
  const { pedir, entrar } = await subirPainel(t, 39522, {}, { 'velho@x.com': recusado('Velho Recusado', 40), 'rafa@x.com': recusado('Rafa Lima', 5) });
  const pedirAcesso = (dados, ip) => pedir('/api/cadastro', { metodo: 'POST', corpo: dados, ip });
  const carla = { nome: 'Carla Dias', email: 'carla@x.com', empresa: 'Padaria Sol', senha: 'senha-da-carla-1' };

  // Senha sem caractere especial (espaço não conta) é recusada.
  const semEspecial = await pedirAcesso({ ...carla, senha: 'senhasemespecial 123' }, '10.0.3.9');
  assert.equal(semEspecial.status, 400);
  assert.match((await semEspecial.json()).mensagem, /especial/);
  assert.equal((await pedirAcesso(carla, '10.0.3.1')).status, 201);

  // Nome e empresa não se repetem, nem trocando maiúsculas, acentos ou espaços.
  const mesmoNome = await pedirAcesso({ ...carla, nome: 'carla  días', empresa: '', email: 'outra@x.com' }, '10.0.3.2');
  assert.equal(mesmoNome.status, 409);
  assert.match((await mesmoNome.json()).mensagem, /nome/);
  const mesmaEmpresa = await pedirAcesso({ ...carla, nome: 'Davi Melo', empresa: 'PADARIA SOL', email: 'davi@x.com' }, '10.0.3.3');
  assert.equal(mesmaEmpresa.status, 409);
  assert.match((await mesmaEmpresa.json()).mensagem, /empresa/);
  // O nome de um pedido recusado fica livre.
  assert.equal((await pedirAcesso({ ...carla, nome: 'Rafa Lima', empresa: '', email: 'rafa2@x.com' }, '10.0.3.4')).status, 201);

  // Quem não é administrador não vê o monitor.
  const admin = await entrar('ana', 'senha-de-teste-123');
  assert.equal((await pedir('/api/usuarios/carla%40x.com/aprovar', { metodo: 'POST', corpo: {}, sessao: admin.sessao })).status, 200);
  const sessaoCarla = (await entrar('carla@x.com', 'senha-da-carla-1', '10.0.3.1')).sessao;
  assert.equal((await pedir('/api/monitor', { sessao: sessaoCarla })).status, 403);
  const pagina = await pedir('/admin.html', { sessao: sessaoCarla });
  assert.equal(pagina.status, 302);
  assert.equal(pagina.headers.get('location'), '/');
  assert.equal((await pedir('/admin.html', { sessao: admin.sessao })).status, 200);

  const monitor = await (await pedir('/api/monitor', { sessao: admin.sessao })).json();
  const conectadaCarla = monitor.conectados.find((c) => c.usuario === 'carla@x.com');
  assert.equal(conectadaCarla.ip, '10.0.3.1');
  assert.ok(monitor.contas.find((c) => c.usuario === 'carla@x.com').ultimoAcesso);
  // Recusado há mais de 30 dias foi apagado ao subir; o recente continua.
  assert.deepEqual(monitor.contas.map((c) => c.usuario).toSorted(), ['carla@x.com', 'rafa2@x.com', 'rafa@x.com']);
  // Tentativas, da mais nova para a mais velha, inclusive as recusadas.
  assert.deepEqual(monitor.tentativas.map((t) => [t.email, t.resultado.split(/[.,]/)[0]]), [
    ['rafa2@x.com', 'Conta criada'],
    ['davi@x.com', 'Essa empresa já tem uma conta'],
    ['outra@x.com', 'Já existe uma conta com esse nome'],
    ['carla@x.com', 'Conta criada'],
    ['carla@x.com', 'A senha precisa ter pelo menos um caractere especial'],
  ]);
});

// Servidor de e-mail falso com TLS (certificado do openssl): guarda cada mensagem recebida e recusa falha@x.com.
async function smtpFalso(t) {
  const pasta = mkdtempSync(path.join(tmpdir(), 'central-rtc-smtp-'));
  const [chave, cert] = [path.join(pasta, 'chave.pem'), path.join(pasta, 'cert.pem')];
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', chave, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const recebidas = [];
  const recusadas = [];
  const servidor =tls.createServer({ key: readFileSync(chave), cert: readFileSync(cert) }, (s) => {
    let dados = null;
    s.write('220 falso\r\n');
    s.on('data', (d) => {
      const texto = String(d);
      if (dados !== null) {
        dados += texto;
        if (dados.endsWith('\r\n.\r\n')) recebidas.push(dados), (dados = null), s.write('250 ok\r\n');
      } else if (texto.startsWith('EHLO')) s.write('250-falso\r\n250 AUTH PLAIN\r\n');
      else if (texto.startsWith('AUTH')) s.write('235 ok\r\n');
      else if (texto.startsWith('DATA')) (dados = ''), s.write('354 manda\r\n');
      else if (texto.startsWith('QUIT')) s.end('221 tchau\r\n');
      else if (texto.startsWith('RCPT TO:<falha@x.com>')) recusadas.push(texto), s.write('550 caixa inexistente\r\n');
      else s.write('250 ok\r\n');
    });
  });
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  t.after(() => { servidor.close(); rmSync(pasta, { recursive: true, force: true }); });
  const extras = { SMTP_HOST: 'localhost', SMTP_PORTA: String(servidor.address().port), SMTP_USUARIO: 'painel@x.com', SMTP_SENHA: 'senha-app', PAINEL_ENDERECO: 'https://painel.exemplo/', NODE_EXTRA_CA_CERTS: cert };
  return { extras, recebidas, recusadas };
}

test('Painel: senha esquecida com link por e-mail', async (t) => {
  let temOpenssl = true;
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { temOpenssl = false; }
  if (!temOpenssl) return t.skip('sem openssl para o certificado do servidor de e-mail falso');
  const { extras, recebidas, recusadas } = await smtpFalso(t);
  const ativa = { status: 'ativo', criadoEm: new Date().toISOString(), pedido: { nome: 'Eva Reis', empresa: '' } };
  const { pedir, entrar } = await subirPainel(t, 39523, extras, { 'eva@x.com': ativa, 'pendente@x.com': { ...ativa, status: 'pendente' }, 'falha@x.com': ativa });
  const esqueci = (email, ip = '10.0.4.1') => pedir('/api/esqueci', { metodo: 'POST', corpo: { email }, ip });
  const redefinir = (token, senha) => pedir('/api/redefinir', { metodo: 'POST', corpo: { token, senha } });
  const esperar = async (n) => { for (let i = 0; i < 50 && recebidas.length < n; i++) await new Promise((ok) => setTimeout(ok, 50)); };

  assert.equal((await (await pedir('/api/acesso')).json()).redefinir, true);
  assert.equal((await pedir('/senha.html')).status, 200);

  // Conta que não existe, pendente ou o administrador: mesma resposta e nenhum e-mail.
  const respostas = await Promise.all(['ninguem@x.com', 'pendente@x.com', 'ana'].map(async (e) => [(await esqueci(e)).status, (await (await esqueci(e, '10.0.4.2')).json()).mensagem]));
  const [, generica] = respostas[0];
  for (const [status, mensagem] of respostas) assert.deepEqual([status, mensagem], [200, generica]);

  assert.equal((await esqueci('EVA@x.com')).status, 200);
  await esperar(1);
  // Pedir de novo logo em seguida não manda outro e-mail.
  assert.equal((await esqueci('eva@x.com', '10.0.4.3')).status, 200);
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(recebidas.length, 1);
  const tokenDo = (n) => {
    const corpo = Buffer.from(recebidas[n].split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, ''), 'base64').toString('utf8');
    return /https:\/\/painel\.exemplo\/senha\.html#([\w-]+)/.exec(corpo)?.[1];
  };
  assert.match(recebidas[0], /^To: <eva@x\.com>/m);
  const token = tokenDo(0);
  assert.ok(token);

  const sessaoVelha = (await entrar('eva@x.com', 'qualquer', '10.0.4.9')).sessao;
  assert.equal(sessaoVelha, undefined); // ela não sabe a senha antiga
  assert.equal((await redefinir('token-inventado', 'senha-nova-da-eva!')).status, 400);
  const fraca = await redefinir(token, 'senhasemespecial');
  assert.equal(fraca.status, 400);
  assert.match((await fraca.json()).mensagem, /especial/);
  assert.equal((await redefinir(token, 'senha-nova-da-eva!')).status, 200);
  assert.equal((await entrar('eva@x.com', 'senha-nova-da-eva!', '10.0.4.9')).status, 200);
  // O link só vale uma vez.
  assert.equal((await redefinir(token, 'outra-senha-da-eva!')).status, 400);

  // Link usado libera um novo pedido; enquanto o novo vale, não sai outro; no máximo 3 e-mails por conta no dia.
  assert.equal((await esqueci('eva@x.com', '10.0.4.4')).status, 200);
  await esperar(2);
  assert.equal(recebidas.length, 2);
  await esqueci('eva@x.com', '10.0.4.4');
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(recebidas.length, 2);
  assert.equal((await redefinir(tokenDo(1), 'senha-nova-da-eva-2!')).status, 200);
  await esqueci('eva@x.com', '10.0.4.5');
  await esperar(3);
  assert.equal((await redefinir(tokenDo(2), 'senha-nova-da-eva-3!')).status, 200);
  await esqueci('eva@x.com', '10.0.4.5');
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(recebidas.length, 3);

  // E-mail que não saiu não deixa link valendo nem conta no limite do dia: a 4ª tentativa ainda tenta enviar.
  for (let i = 1; i <= 4; i++) {
    await esqueci('falha@x.com', `10.0.5.${i}`);
    for (let j = 0; j < 50 && recusadas.length < i; j++) await new Promise((ok) => setTimeout(ok, 50));
    await new Promise((ok) => setTimeout(ok, 50)); // deixa o painel tratar a recusa antes do próximo pedido
  }
  assert.equal(recusadas.length, 4);

  // No máximo 5 pedidos por hora do mesmo endereço.
  for (let i = 0; i < 5; i++) await esqueci(`x${i}@x.com`, '10.0.4.7');
  assert.equal((await esqueci('x9@x.com', '10.0.4.7')).status, 429);
});
