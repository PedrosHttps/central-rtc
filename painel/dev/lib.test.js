// Testes das bibliotecas compartilhadas e do login do painel (rodam sem os serviços): npm run teste
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

test('Painel: com PAINEL_USUARIO/PAINEL_SENHA, só entra com a senha certa e bloqueia quem erra demais', async (t) => {
  const porta = 39517;
  const env = { ...process.env, PORTA: String(porta), HOST: '127.0.0.1', PAINEL_USUARIO: 'ana', PAINEL_SENHA: 'senha-de-teste-123' };
  const filho = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { env });
  t.after(() => filho.kill());
  await new Promise((ok, falha) => {
    filho.stdout.on('data', (d) => String(d).includes('no ar') && ok());
    filho.on('exit', (c) => falha(new Error(`painel saiu com ${c}`)));
  });
  const pedir = (senha, ip = '10.0.0.1') => fetch(`http://127.0.0.1:${porta}/status`, {
    headers: {
      'x-forwarded-for': ip,
      ...(senha ? { authorization: `Basic ${Buffer.from(`ana:${senha}`).toString('base64')}` } : {}),
    },
  });
  const sem = await pedir();
  assert.equal(sem.status, 401);
  assert.match(sem.headers.get('www-authenticate'), /^Basic/);
  assert.match(sem.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await pedir('errada')).status, 401);
  assert.equal((await pedir('senha-de-teste-123')).status, 200);

  // 10 senhas erradas diferentes do mesmo IP bloqueiam esse IP (até com a senha certa); outro IP segue entrando.
  for (let i = 0; i < 10; i++) assert.equal((await pedir(`errada-${i}`, '10.0.0.2')).status, 401);
  assert.equal((await pedir('senha-de-teste-123', '10.0.0.2')).status, 429);
  assert.equal((await pedir('senha-de-teste-123', '10.0.0.3')).status, 200);

  // A mesma senha antiga repetida (aba aberta depois da troca de senha) não bloqueia.
  for (let i = 0; i < 15; i++) assert.equal((await pedir('senha-antiga', '10.0.0.4')).status, 401);
  assert.equal((await pedir('senha-de-teste-123', '10.0.0.4')).status, 200);

  // IPv6 conta pelo bloco /64: trocar de endereço dentro do bloco não escapa; outro bloco segue entrando.
  for (let i = 1; i <= 10; i++) assert.equal((await pedir(`errada-${i}`, `2001:db8:1:2::${i}`)).status, 401);
  assert.equal((await pedir('senha-de-teste-123', '2001:0db8:0001:0002:ffff::99')).status, 429);
  assert.equal((await pedir('senha-de-teste-123', '2001:db8:1:3::1')).status, 200);
});
