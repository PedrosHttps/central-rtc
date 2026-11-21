// Cliente dos três serviços da Receita Federal e regras do processamento em lote.
// Usado pelo painel (navegador) e pela linha de comando (Node 22+).

import { decimal, numero, inteiro, dataISO, dataHoraISO, decimalBR } from './formato.js';

// ---------------------------------------------------------------------------
// Cliente HTTP
// ---------------------------------------------------------------------------

export class ErroServico extends Error {
  constructor(mensagem, { status = 0, dados = null, servico = '' } = {}) {
    super(mensagem);
    this.status = status;
    this.dados = dados;
    this.servico = servico;
  }
}

/** O serviço não respondeu: erro de rede/timeout (status 0) ou o proxy do painel avisando (502/503/504). */
export const semResposta = (e) => !e?.status || [502, 503, 504].includes(e.status);

/** Extrai uma mensagem legível das respostas de erro dos três serviços. */
export function mensagemDeErro(dados, status) {
  if (!dados) return status ? `O serviço respondeu com HTTP ${status}.` : 'O serviço não respondeu.';
  if (typeof dados === 'string') return dados.slice(0, 500);
  const partes = [];
  if (dados.mensagem) partes.push(dados.mensagem); // DANFSe
  if (dados.message && !dados.mensagem) partes.push(dados.message);
  if (dados.title && dados.title !== 'Bad Request') partes.push(dados.title); // ProblemDetail (Spring)
  if (dados.detail) partes.push(dados.detail);
  const lista = dados.errors || dados.erros || dados.objects;
  if (Array.isArray(lista)) {
    for (const e of lista.slice(0, 10)) {
      const txt = [e.code, e.detail || e.userMessage || e.title || e.message, e.pointer && `(${e.pointer})`]
        .filter(Boolean)
        .join(' ');
      if (txt) partes.push(txt);
    }
  }
  return partes.length ? [...new Set(partes)].join(' — ') : `O serviço respondeu com HTTP ${status}.`;
}

async function requisitar(fetchImpl, servico, url, { metodo = 'GET', corpo, tipo, aceitar, binario = false, timeoutMs = 60000 } = {}) {
  const headers = {};
  if (tipo) headers['Content-Type'] = tipo;
  if (aceitar) headers.Accept = aceitar;
  let resposta;
  try {
    resposta = await fetchImpl(url, {
      method: metodo,
      headers,
      body: corpo,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    const motivo = e?.name === 'TimeoutError' ? 'demorou demais para responder' : 'não está respondendo';
    throw new ErroServico(`O serviço ${servico} ${motivo}. Confira se ele está rodando.`, { servico });
  }

  const tipoResposta = resposta.headers.get('content-type') || '';
  let dados;
  if (binario && resposta.ok) dados = new Uint8Array(await resposta.arrayBuffer());
  else if (tipoResposta.includes('json')) dados = await resposta.json().catch(() => null);
  else dados = await resposta.text();

  if (!resposta.ok) {
    throw new ErroServico(mensagemDeErro(dados, resposta.status), { status: resposta.status, dados, servico });
  }
  return {
    status: resposta.status,
    dados,
    avisoSimulado: resposta.headers.get('x-warning-dados-simulados'),
  };
}

function consulta(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else q.append(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * @param {{rg: string, sn: string, danfse: string, fetchImpl?: typeof fetch}} urls
 *   rg / sn: base que termina em /api; danfse: base do serviço (sem /api).
 */
export function criarCliente({ rg, sn, danfse, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const json = (servico, url, corpo, extra = {}) =>
    requisitar(fetchImpl, servico, url, { metodo: 'POST', corpo: JSON.stringify(corpo), tipo: 'application/json', ...extra });

  return {
    regimeGeral: {
      calcularComObservabilidade: (op) => json('do regime geral', `${rg}/calculadora/observabilidade/regime-geral`, op),
      calcular: (op) => json('do regime geral', `${rg}/calculadora/regime-geral`, op),
      gerarXml: (roc, tipo = 'nfe') =>
        json('do regime geral', `${rg}/calculadora/xml/generate${consulta({ tipo })}`, roc, { aceitar: 'application/xml' }),
      validarXml: (xml, tipo = 'nfe', subtipo = 'grupo') =>
        requisitar(fetchImpl, 'do regime geral', `${rg}/calculadora/xml/validate${consulta({ tipo, subtipo })}`, {
          metodo: 'POST',
          corpo: xml,
          tipo: 'application/xml',
        }),
      dadosAbertos: (caminho, params) =>
        requisitar(fetchImpl, 'do regime geral', `${rg}/calculadora/dados-abertos/${caminho}${consulta(params)}`),
      erro: (codigo) =>
        requisitar(fetchImpl, 'do regime geral', `${rg}/calculadora/observabilidade/erros${consulta({ codigo })}`),
      versao: () => requisitar(fetchImpl, 'do regime geral', `${rg}/calculadora/dados-abertos/versao`, { timeoutMs: 4000 }),
    },
    simplesNacional: {
      calcular: (op) => json('do Simples Nacional', `${sn}/calculadora/observabilidade/simples-nacional`, op),
      atividades: ({ data, anexos, tpDoc, cClassTrib }) =>
        requisitar(
          fetchImpl,
          'do Simples Nacional',
          `${sn}/calculadora/simples-nacional/atividades${consulta({ data, anexos: anexos?.length ? anexos.join(',') : undefined, tpDoc, cClassTrib })}`,
        ),
      erro: (codigo) =>
        requisitar(fetchImpl, 'do Simples Nacional', `${sn}/calculadora/observabilidade/simples-nacional/erros${consulta({ codigo })}`),
      versao: () => requisitar(fetchImpl, 'do Simples Nacional', `${sn}/versao`, { timeoutMs: 4000 }),
    },
    danfse: {
      /** @returns {Promise<Uint8Array>} o PDF */
      gerar: async (xml, { stc = 0, canhoto = true } = {}) => {
        const r = await requisitar(fetchImpl, 'de DANFSe', `${danfse}/api/danfse${consulta({ stc, canhoto: String(canhoto) })}`, {
          metodo: 'POST',
          corpo: xml,
          tipo: 'application/xml',
          binario: true,
          timeoutMs: 120000,
        });
        return r.dados;
      },
      saude: () => requisitar(fetchImpl, 'de DANFSe', `${danfse}/health/ready`, { timeoutMs: 4000 }),
    },
  };
}

// ---------------------------------------------------------------------------
// Tabelas de apoio
// ---------------------------------------------------------------------------

export const ESTADOS_ITEM = {
  CALCULADO: { rotulo: 'Calculado', tom: 'ok' },
  CALCULO_SIMULADO: { rotulo: 'Cálculo simulado', tom: 'ok' },
  NAO_CALCULADO: { rotulo: 'Não calculado', tom: 'aviso' },
  NAO_IMPLEMENTADO: { rotulo: 'Não implementado', tom: 'aviso' },
  INCONSISTENCIA_ENTRADA: { rotulo: 'Inconsistência na entrada', tom: 'erro' },
  FALHA_TECNICA: { rotulo: 'Falha técnica', tom: 'erro' },
  FALHA_REQUISICAO: { rotulo: 'Operação recusada', tom: 'erro' },
};

export const DOCUMENTOS = [
  ['55', 'NF-e'], ['65', 'NFC-e'], ['91', 'NFS-e'], ['57', 'CT-e'], ['67', 'CT-e OS'],
  ['63', 'BP-e'], ['93', 'BP-e TM'], ['62', 'NFCom'],
];

export const UFS = {
  AC: 12, AL: 27, AP: 16, AM: 13, BA: 29, CE: 23, DF: 53, ES: 32, GO: 52, MA: 21, MT: 51, MS: 50, MG: 31, PA: 15,
  PB: 25, PR: 41, PE: 26, PI: 22, RJ: 33, RN: 24, RS: 43, RO: 11, RR: 14, SC: 42, SP: 35, SE: 28, TO: 17,
};

// ---------------------------------------------------------------------------
// Montagem das operações (formulário e planilha)
// ---------------------------------------------------------------------------

function idOperacao() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function semVazios(obj) {
  const saida = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const interno = semVazios(v);
      if (Object.keys(interno).length) saida[k] = interno;
    } else {
      saida[k] = v;
    }
  }
  return saida;
}

/** Operação do Simples Nacional (todos os valores vão como texto, como a API espera). */
export function operacaoSimples({ id, data, tpDoc, CRT, tpRegimeIBSCBS, tpEnteGov, itens }) {
  return semVazios({
    id: id || idOperacao(),
    versao: '2.0.0',
    data: dataISO(data),
    tpDoc: tpDoc ? String(tpDoc) : null,
    CRT: CRT ? String(CRT) : null,
    tpRegimeIBSCBS: tpRegimeIBSCBS ? String(tpRegimeIBSCBS) : null,
    tpEnteGov: tpEnteGov ? String(tpEnteGov) : null,
    itens: itens.map((it, i) =>
      semVazios({
        numero: inteiro(it.numero) ?? i + 1,
        cAtivSN: it.cAtivSN ? String(it.cAtivSN).padStart(2, '0') : null,
        cClassTrib: it.cClassTrib,
        baseCalculo: decimal(it.baseCalculo),
        valorImpostoSeletivo: decimal(it.valorImpostoSeletivo) ?? '0.00',
        pIBSSN: decimal(it.pIBSSN),
        pCBSSN: decimal(it.pCBSSN),
      }),
    ),
  });
}

/** Operação do regime geral (valores numéricos vão como número). */
export function operacaoRegimeGeral({ id, dhFatoGerador, municipio, uf, tpDoc, tpEnteGov, itens }) {
  return semVazios({
    id: id || idOperacao(),
    versao: '1.0.0',
    dhFatoGerador: dataHoraISO(dhFatoGerador),
    municipio: inteiro(municipio),
    uf: uf ? String(uf).toUpperCase() : null,
    tpDoc: inteiro(tpDoc),
    gCompraGov: tpEnteGov ? { tpEnteGov: inteiro(tpEnteGov) } : null,
    itens: itens.map((it, i) => {
      const temIS = it.isCst || it.isClassTrib || it.isBaseCalculo;
      return semVazios({
        numero: inteiro(it.numero) ?? i + 1,
        ncm: it.ncm,
        nbs: it.nbs,
        cst: it.cst,
        cClassTrib: it.cClassTrib,
        baseCalculo: numero(it.baseCalculo),
        quantidade: numero(it.quantidade),
        unidade: it.unidade,
        impostoSeletivo: temIS
          ? {
              cst: it.isCst,
              cClassTrib: it.isClassTrib,
              baseCalculo: numero(it.isBaseCalculo),
              quantidade: numero(it.isQuantidade),
              unidade: it.isUnidade,
              impostoInformado: numero(it.isImpostoInformado),
            }
          : null,
        aliquotasNominais: {
          cbs: numero(it.aliqCBS),
          ibsEstadual: numero(it.aliqIBSUF),
          ibsMunicipal: numero(it.aliqIBSMun),
          impostoSeletivo: { adValorem: numero(it.isAdValorem), adRem: numero(it.isAdRem) },
        },
      });
    }),
  });
}

// ---------------------------------------------------------------------------
// Leitura dos resultados
// ---------------------------------------------------------------------------

const resumirErros = (erros) =>
  (erros || []).map((e) => [e.code, e.title, e.detail].filter(Boolean).join(': ')).join(' | ');

/** Uma linha por item, com os valores mais usados do Simples Nacional. */
export function itensSimples(resposta) {
  return (resposta?.objetos || []).map((o) => {
    const t = o.tribCalc || {};
    return {
      item: o.nObj,
      estado: o.estadoItem,
      vRBSNitem: t.vRBSNitem,
      tpRBSN: t.tpRBSN,
      tpRBSNDescricao: t.tpRBSNDescricao,
      vBC: t.vBC,
      pIBSSN: t.pIBSSN,
      vIBSSN: t.vIBSSN,
      vIBSPendSusp: t.vIBSPendSusp,
      pCBSSN: t.pCBSSN,
      vCBSSN: t.vCBSSN,
      vCBSPendSusp: t.vCBSPendSusp,
      vIS: t.IS?.valor,
      totalItem: t.totalItem,
      erros: resumirErros(o.erros),
      _erros: o.erros || [],
    };
  });
}

/** Uma linha por item, com os valores mais usados do regime geral. */
export function itensRegimeGeral(resposta) {
  return (resposta?.objetos || []).map((o) => {
    const ibscbs = o.tribCalc?.IBSCBS || {};
    const g = ibscbs.gIBSCBS || {};
    const is = o.tribCalc?.IS || {};
    return {
      item: o.nObj,
      estado: o.estadoItem || (o.calculoSimulado ? 'CALCULO_SIMULADO' : 'CALCULADO'),
      cst: ibscbs.CST,
      cClassTrib: ibscbs.cClassTrib,
      vBC: g.vBC,
      pCBS: g.gCBS?.pCBS,
      pRedCBS: g.gCBS?.gRed?.pRedAliq,
      pAliqEfetCBS: g.gCBS?.gRed?.pAliqEfet,
      vCBS: g.gCBS?.vCBS,
      pIBSUF: g.gIBSUF?.pIBSUF,
      pRedIBSUF: g.gIBSUF?.gRed?.pRedAliq,
      pAliqEfetIBSUF: g.gIBSUF?.gRed?.pAliqEfet,
      vIBSUF: g.gIBSUF?.vIBSUF,
      pIBSMun: g.gIBSMun?.pIBSMun,
      pRedIBSMun: g.gIBSMun?.gRed?.pRedAliq,
      pAliqEfetIBSMun: g.gIBSMun?.gRed?.pAliqEfet,
      vIBSMun: g.gIBSMun?.vIBSMun,
      vIBS: g.vIBS,
      vBCIS: is.vBCIS,
      pIS: is.pIS,
      vIS: is.vIS,
      memoria: ibscbs.memoriaCalculo,
      memoriaIS: is.memoriaCalculo,
      erros: resumirErros(o.erros),
      _erros: o.erros || [],
    };
  });
}

// ---------------------------------------------------------------------------
// Planilhas (lote)
// ---------------------------------------------------------------------------

export const MODELOS = {
  simples: {
    nome: 'Simples Nacional',
    colunasEntrada: [
      'operacao', 'data', 'tpDoc', 'CRT', 'tpRegimeIBSCBS', 'tpEnteGov',
      'item', 'cAtivSN', 'cClassTrib', 'baseCalculo', 'valorImpostoSeletivo', 'pIBSSN', 'pCBSSN',
    ],
    obrigatorias: ['data', 'tpDoc', 'CRT', 'cClassTrib', 'baseCalculo'],
    exemplo: [
      { operacao: 'NF-1001', data: '15/03/2027', tpDoc: '55', CRT: '1', item: '1', cAtivSN: '01', cClassTrib: '000001', baseCalculo: '950,00', valorImpostoSeletivo: '50,00', pIBSSN: '1,25', pCBSSN: '2,75' },
      { operacao: 'NF-1001', data: '15/03/2027', tpDoc: '55', CRT: '1', item: '2', cAtivSN: '03', cClassTrib: '000001', baseCalculo: '1200,00', valorImpostoSeletivo: '0,00', pIBSSN: '1,10', pCBSSN: '2,40' },
      { operacao: 'NF-1002', data: '16/03/2027', tpDoc: '65', CRT: '1', item: '1', cAtivSN: '01', cClassTrib: '000001', baseCalculo: '89,90', valorImpostoSeletivo: '0,00', pIBSSN: '1,25', pCBSSN: '2,75' },
    ],
    colunasSaida: [
      'operacao', 'item', 'linhaPlanilha', 'estado', 'vRBSNitem', 'tpRBSN', 'vBC', 'pIBSSN', 'vIBSSN',
      'pCBSSN', 'vCBSSN', 'vIS', 'totalItem', 'erros',
    ],
    decimais: ['vRBSNitem', 'vBC', 'vIBSSN', 'vCBSSN', 'vIS', 'totalItem', 'pIBSSN', 'pCBSSN'],
  },
  'regime-geral': {
    nome: 'Regime geral',
    colunasEntrada: [
      'operacao', 'dhFatoGerador', 'municipio', 'uf', 'tpDoc', 'tpEnteGov',
      'item', 'ncm', 'nbs', 'cst', 'cClassTrib', 'baseCalculo', 'quantidade', 'unidade',
      'aliqCBS', 'aliqIBSUF', 'aliqIBSMun',
      'isCst', 'isClassTrib', 'isBaseCalculo', 'isQuantidade', 'isUnidade', 'isImpostoInformado', 'isAdValorem', 'isAdRem',
    ],
    obrigatorias: ['dhFatoGerador', 'municipio', 'cst', 'cClassTrib'],
    exemplo: [
      { operacao: 'NF-2001', dhFatoGerador: '10/03/2027 10:00', municipio: '1302603', uf: 'AM', item: '1', ncm: '10063021', cst: '200', cClassTrib: '200003', baseCalculo: '100,00', quantidade: '20', unidade: 'KG', aliqCBS: '8,8', aliqIBSUF: '0,05', aliqIBSMun: '0,05' },
      { operacao: 'NF-2001', dhFatoGerador: '10/03/2027 10:00', municipio: '1302603', uf: 'AM', item: '2', nbs: '122011200', cst: '200', cClassTrib: '200028', baseCalculo: '1200,00', aliqCBS: '8,8', aliqIBSUF: '0,05', aliqIBSMun: '0,05' },
      { operacao: 'NF-2002', dhFatoGerador: '11/03/2027 15:30', municipio: '1302603', uf: 'AM', item: '1', ncm: '22030000', cst: '000', cClassTrib: '000001', quantidade: '12', unidade: 'LT', aliqCBS: '8,8', aliqIBSUF: '0,05', aliqIBSMun: '0,05', isCst: '000', isClassTrib: '000001', isBaseCalculo: '150,00', isQuantidade: '12', isUnidade: 'LT', isImpostoInformado: '15,00', isAdValorem: '10' },
    ],
    colunasSaida: [
      'operacao', 'item', 'linhaPlanilha', 'estado', 'cst', 'cClassTrib', 'vBC', 'pCBS', 'pRedCBS', 'pAliqEfetCBS', 'vCBS',
      'pIBSUF', 'vIBSUF', 'pIBSMun', 'vIBSMun', 'vIBS', 'vBCIS', 'pIS', 'vIS', 'erros',
    ],
    decimais: ['vBC', 'pCBS', 'pRedCBS', 'pAliqEfetCBS', 'vCBS', 'pIBSUF', 'vIBSUF', 'pIBSMun', 'vIBSMun', 'vIBS', 'vBCIS', 'pIS', 'vIS'],
  },
};

const CAMPOS_OPERACAO = {
  simples: ['data', 'tpDoc', 'CRT', 'tpRegimeIBSCBS', 'tpEnteGov'],
  'regime-geral': ['dhFatoGerador', 'municipio', 'uf', 'tpDoc', 'tpEnteGov'],
};

/**
 * Agrupa as linhas da planilha em operações (pela coluna `operacao`; sem ela, cada linha vira uma operação)
 * e aponta problemas antes de chamar a API.
 */
export function prepararLote(tipo, linhas) {
  const modelo = MODELOS[tipo];
  if (!modelo) throw new Error(`Tipo de lote desconhecido: ${tipo}`);
  const problemas = [];
  const grupos = new Map();

  for (const linha of linhas) {
    const faltando = modelo.obrigatorias.filter((c) => !linha[c]);
    if (tipo === 'regime-geral' && !linha.ncm && !linha.nbs) faltando.push('ncm ou nbs');
    if (tipo === 'regime-geral' && !linha.baseCalculo && !linha.isBaseCalculo) faltando.push('baseCalculo');
    if (faltando.length) problemas.push({ linha: linha._linha, mensagem: `Faltam colunas obrigatórias: ${faltando.join(', ')}` });

    const chave = linha.operacao || `linha-${linha._linha}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(linha);
  }

  const operacoes = [];
  for (const [chave, grupo] of grupos) {
    const primeira = grupo[0];
    for (const outra of grupo.slice(1)) {
      for (const campo of CAMPOS_OPERACAO[tipo]) {
        if ((outra[campo] || '') !== (primeira[campo] || '')) {
          problemas.push({
            linha: outra._linha,
            mensagem: `"${campo}" diferente da primeira linha da operação ${chave}; vale o valor da linha ${primeira._linha}.`,
            aviso: true,
          });
        }
      }
    }
    const itens = grupo.map((l, i) => ({ ...l, numero: l.item || i + 1 }));
    const requisicao = tipo === 'simples' ? operacaoSimples({ ...primeira, id: null, itens }) : operacaoRegimeGeral({ ...primeira, id: null, itens });
    operacoes.push({ chave, linhas: grupo, requisicao });
  }

  problemas.sort((a, b) => a.linha - b.linha);
  return { operacoes, problemas, totalItens: linhas.length };
}

/** Executa as operações (até `paralelo` ao mesmo tempo) e devolve uma linha por item. */
export async function executarLote(tipo, operacoes, cliente, { paralelo = 3, aoProgredir } = {}) {
  const resultados = new Array(operacoes.length);
  let proxima = 0;
  let concluidas = 0;

  async function trabalhar() {
    while (proxima < operacoes.length) {
      const indice = proxima++;
      const op = operacoes[indice];
      try {
        const r =
          tipo === 'simples'
            ? await cliente.simplesNacional.calcular(op.requisicao)
            : await cliente.regimeGeral.calcularComObservabilidade(op.requisicao);
        resultados[indice] = { ...op, resposta: r.dados, aviso: r.avisoSimulado };
      } catch (e) {
        resultados[indice] = { ...op, falha: e.message, detalhe: e.dados, semResposta: semResposta(e) };
      }
      concluidas++;
      aoProgredir?.(concluidas, operacoes.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(paralelo, operacoes.length) }, trabalhar));

  const linhas = [];
  for (const r of resultados) {
    // mesma conversão de operacaoSimples/RegimeGeral: "01" vai como 1 e volta como nObj 1
    const numeroParaLinha = new Map(r.linhas.map((l, i) => [String(inteiro(l.item) ?? i + 1), l._linha]));
    if (r.falha) {
      r.linhas.forEach((l, i) =>
        linhas.push({ operacao: r.chave, item: l.item || i + 1, linhaPlanilha: l._linha, estado: 'FALHA_REQUISICAO', erros: r.falha }),
      );
      continue;
    }
    const itens = tipo === 'simples' ? itensSimples(r.resposta) : itensRegimeGeral(r.resposta);
    for (const it of itens) {
      linhas.push({ operacao: r.chave, linhaPlanilha: numeroParaLinha.get(String(it.item)) ?? '', ...it });
    }
  }

  const resumo = { operacoes: operacoes.length, itens: linhas.length, calculados: 0, comErro: 0, outros: 0 };
  for (const l of linhas) {
    const tom = ESTADOS_ITEM[l.estado]?.tom;
    if (tom === 'ok') resumo.calculados++;
    else if (tom === 'erro') resumo.comErro++;
    else resumo.outros++;
  }
  return { linhas, resultados, resumo };
}

/** Prepara as linhas de resultado para a planilha: decimais com vírgula e só as colunas de saída. */
export function linhasParaPlanilha(tipo, linhas) {
  const decimais = new Set(MODELOS[tipo].decimais);
  return linhas.map((l) => {
    const saida = { ...l };
    for (const c of decimais) if (saida[c] !== undefined) saida[c] = decimalBR(saida[c]);
    return saida;
  });
}
