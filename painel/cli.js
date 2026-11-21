#!/usr/bin/env node
// Linha de comando da Central RTC: o mesmo motor do painel, para rodar em lote, em scripts ou no agendador.

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { lerCSV, gerarCSV } from './public/lib/csv.js';
import { criarCliente, prepararLote, executarLote, linhasParaPlanilha, MODELOS, semResposta } from './public/lib/rtc.js';

const AJUDA = `Central RTC — linha de comando

Uso:
  node cli.js status
  node cli.js modelo <simples|regime-geral> [-o modelo.csv]
  node cli.js lote <simples|regime-geral> <planilha.csv> [-o resultado.csv] [--json respostas.json]
  node cli.js danfse <arquivo.xml | pasta> [...] [-o pasta-saida] [--stc 0|1|2] [--sem-canhoto]

Endereços dos serviços (variáveis de ambiente):
  RG_URL      padrão http://localhost:8080/api   (regime geral)
  SN_URL      padrão http://localhost:8082/api   (Simples Nacional)
  DANFSE_URL  padrão http://localhost:8081       (gerador de DANFSe)

Códigos de saída: 0 = tudo certo, 1 = erro de uso ou serviço fora, 2 = terminou, mas algum item ou nota falhou.`;

const cliente = criarCliente({
  rg: (process.env.RG_URL || 'http://localhost:8080/api').replace(/\/$/, ''),
  sn: (process.env.SN_URL || 'http://localhost:8082/api').replace(/\/$/, ''),
  danfse: (process.env.DANFSE_URL || 'http://localhost:8081').replace(/\/$/, ''),
});

function lerOpcoes(args) {
  const posicionais = [];
  const opcoes = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--saida') opcoes.saida = args[++i];
    else if (a === '--json') opcoes.json = args[++i];
    else if (a === '--stc') opcoes.stc = args[++i];
    else if (a === '--sem-canhoto') opcoes.semCanhoto = true;
    else if (a === '-h' || a === '--ajuda' || a === '--help') opcoes.ajuda = true;
    else posicionais.push(a);
  }
  return { posicionais, opcoes };
}

function sair(mensagem, codigo = 1) {
  console.error(mensagem);
  process.exit(codigo);
}

async function comandoStatus() {
  const checagens = [
    ['Regime geral', () => cliente.regimeGeral.versao()],
    ['Simples Nacional', () => cliente.simplesNacional.versao()],
    ['DANFSe', () => cliente.danfse.saude()],
  ];
  let todosOk = true;
  for (const [nome, fn] of checagens) {
    try {
      const r = await fn();
      const versao = r.dados?.versaoApp || r.dados?.versao || '';
      console.log(`✔ ${nome.padEnd(17)} no ar ${versao ? `(versão ${versao})` : ''}`);
    } catch (e) {
      todosOk = false;
      console.log(`✘ ${nome.padEnd(17)} ${e.message}`);
    }
  }
  process.exit(todosOk ? 0 : 1);
}

async function comandoModelo(tipo, opcoes) {
  const modelo = MODELOS[tipo];
  if (!modelo) sair('Informe o tipo: simples ou regime-geral.');
  const csv = gerarCSV(modelo.exemplo, modelo.colunasEntrada);
  const destino = opcoes.saida || `modelo-${tipo}.csv`;
  await writeFile(destino, csv);
  console.log(`Modelo salvo em ${destino}`);
}

async function comandoLote(tipo, arquivo, opcoes) {
  if (!MODELOS[tipo]) sair('Informe o tipo: simples ou regime-geral.');
  if (!arquivo) sair('Informe a planilha CSV de entrada.');
  const { linhas } = lerCSV(await readFile(arquivo, 'utf8'));
  if (!linhas.length) sair('A planilha está vazia.');

  const { operacoes, problemas } = prepararLote(tipo, linhas);
  for (const p of problemas) console.warn(`${p.aviso ? 'Aviso' : 'Problema'} na linha ${p.linha}: ${p.mensagem}`);
  console.log(`${linhas.length} itens em ${operacoes.length} operações. Calculando…`);

  const { linhas: resultado, resultados, resumo } = await executarLote(tipo, operacoes, cliente, {
    aoProgredir: (feitas, total) => process.stdout.write(`\r  ${feitas}/${total} operações`),
  });
  process.stdout.write('\n');

  const destino = opcoes.saida || arquivo.replace(/\.csv$/i, '') + '-resultado.csv';
  await writeFile(destino, gerarCSV(linhasParaPlanilha(tipo, resultado), MODELOS[tipo].colunasSaida));
  if (opcoes.json) {
    const respostas = resultados.map((r) => ({ operacao: r.chave, requisicao: r.requisicao, resposta: r.resposta ?? null, falha: r.falha ?? null }));
    await writeFile(opcoes.json, JSON.stringify(respostas, null, 2));
  }

  console.log(`Calculados: ${resumo.calculados} · Com erro: ${resumo.comErro} · Outros: ${resumo.outros}`);
  console.log(`Resultado salvo em ${destino}`);
  if (resultados.every((r) => r.semResposta)) process.exit(1);
  process.exit(resumo.comErro > 0 ? 2 : 0);
}

async function listarXmls(entradas) {
  const arquivos = [];
  for (const e of entradas) {
    const info = await stat(e).catch(() => null);
    if (!info) sair(`Não encontrei: ${e}`);
    if (info.isDirectory()) {
      for (const nome of (await readdir(e)).sort()) if (nome.toLowerCase().endsWith('.xml')) arquivos.push(path.join(e, nome));
    } else {
      arquivos.push(e);
    }
  }
  return arquivos;
}

async function comandoDanfse(entradas, opcoes) {
  if (!entradas.length) sair('Informe os XMLs das NFS-e ou uma pasta com eles.');
  const stc = Number(opcoes.stc ?? 0);
  if (![0, 1, 2].includes(stc)) sair('--stc aceita 0 (válida), 1 (substituída) ou 2 (cancelada).');
  const arquivos = await listarXmls(entradas);
  if (!arquivos.length) sair('Nenhum arquivo .xml encontrado.');

  const pastaSaida = opcoes.saida || 'danfse';
  await mkdir(pastaSaida, { recursive: true });
  let falhas = 0;
  for (const arq of arquivos) {
    const nomePdf = path.basename(arq).replace(/\.xml$/i, '') + '.pdf';
    try {
      const pdf = await cliente.danfse.gerar(await readFile(arq, 'utf8'), { stc, canhoto: !opcoes.semCanhoto });
      await writeFile(path.join(pastaSaida, nomePdf), pdf);
      console.log(`✔ ${path.basename(arq)} → ${path.join(pastaSaida, nomePdf)}`);
    } catch (e) {
      falhas++;
      console.log(`✘ ${path.basename(arq)}: ${e.message}`);
      if (semResposta(e)) sair('O gerador de DANFSe não está respondendo. Nada mais foi processado.');
    }
  }
  console.log(`${arquivos.length - falhas} de ${arquivos.length} PDFs gerados em ${pastaSaida}/`);
  process.exit(falhas ? 2 : 0);
}

const [comando, ...resto] = process.argv.slice(2);
const { posicionais, opcoes } = lerOpcoes(resto);

if (!comando || opcoes.ajuda || comando === 'ajuda') {
  console.log(AJUDA);
} else if (comando === 'status') {
  await comandoStatus();
} else if (comando === 'modelo') {
  await comandoModelo(posicionais[0], opcoes);
} else if (comando === 'lote') {
  await comandoLote(posicionais[0], posicionais[1], opcoes);
} else if (comando === 'danfse') {
  await comandoDanfse(posicionais, opcoes);
} else {
  sair(`Comando desconhecido: ${comando}\n\n${AJUDA}`);
}
