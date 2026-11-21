// SIMULADOR PARA DESENVOLVIMENTO — NÃO É A CALCULADORA OFICIAL.
// Imita os contratos (rotas, campos e formatos) dos três serviços da Receita para testar o painel
// e a linha de comando sem precisar subir Java e Go. Os valores calculados aqui são fictícios.
//
//   node dev/mock-servicos.js   → regime geral :8080, Simples :8082, DANFSe :8081

import http from 'node:http';

const ATIVIDADES = [
  ['01', 'Revenda de mercadorias, venda de mercadorias industrializadas pelo contribuinte', 'I', null, 'I', 'I'],
  ['02', 'Operações com os demais bens materiais, sem incidência de ICMS', 'I', null, 'I, menos ICMS', 'I'],
  ['03', 'Venda de mercadorias industrializadas pelo contribuinte, com industrialização incentivada na Zona Franca de Manaus', 'II', null, 'II', 'II'],
  ['04', 'Operações com os demais bens materiais, com industrialização incentivada na Zona Franca de Manaus, sem incidência de ICMS', 'II', null, 'II, menos ICMS', 'II'],
  ['05', 'Prestação de serviços de transporte intermunicipal e interestadual de carga ou de passageiros autorizados no inciso VI do art. 17 da LC 123', 'III', null, 'III, menos ISS, mais ICMS do I', 'III'],
  ['06', 'Prestação de serviços de comunicação', 'III', null, 'III, menos ISS, mais ICMS do I', 'III'],
  ['07', 'Prestação de serviços, cessão de direitos, de uso ou de espaço', 'III', null, 'III', 'III'],
  ['08', 'Prestação de serviços contábeis autorizados a pagar o ISS em valor fixo', 'III', null, 'III, menos ISS', 'III'],
  ['09', 'Prestação de serviços — Sujeitos ao Fator "R"', 'III', 'V', 'III ou V', 'III/V'],
  ['10', 'Prestação de serviços de transporte municipal rodoviário, metroviário, ferroviário e aquaviário de passageiros', 'III', null, 'III, menos ISS', 'III'],
  ['11', 'Locação de bens móveis e operações com serviços, bens imateriais e direitos', 'III', null, 'III, menos ISS', 'III'],
  ['12', 'Prestação de serviços da área da construção civil relacionados no art. 18 da LC 123 (Anexo III)', 'III', null, 'III', 'III'],
  ['13', 'Prestação de serviços da área da construção civil relacionados no art. 18 da LC 123 (Anexo IV)', 'IV', null, 'IV', 'IV'],
  ['14', 'Prestação de serviços', 'IV', null, 'IV', 'IV'],
  ['90', 'Operações não Tributáveis', null, null, null, null],
].map(([codigo, descricao, anexoSemFatorR, anexoComFatorR, rotuloAnexo, rotuloCurtoAnexo], i) => ({
  codigo, ordem: i + 1, descricao, anexoSemFatorR, anexoComFatorR, sujeitaFatorR: anexoComFatorR !== null, rotuloAnexo, rotuloCurtoAnexo,
}));

const ERROS_SN = {
  'VSN-001': ['Base de cálculo ausente', 'Informe a base de cálculo do item.'],
  'VSN-002': ['Base de cálculo inválida', 'A base de cálculo deve ser um decimal não negativo.'],
  'VSN-006': ['Alíquota do IBS ausente', 'Informe pIBSSN quando o cálculo do IBS for exigido.'],
  'VSN-004': ['Alíquota da CBS ausente', 'Informe pCBSSN quando o cálculo da CBS for exigido.'],
  'VSN-012': ['Data inválida', 'Use o formato AAAA-MM-DD.'],
  'VSN-016': ['CRT inválido', 'Valores aceitos: 1, 2, 3 ou 4.'],
};
const ERROS_RG = {
  'REG-011': ['NCM não vinculada', 'A NCM informada não está vinculada à classificação tributária.'],
  'REG-020': ['Alíquotas nominais obrigatórias', 'A partir de 2027, informe aliquotasNominais.'],
};

const REDUCOES = { 200003: 100, 200028: 60, 200035: 60 };

function arred(valor, casas = 2) {
  const f = 10 ** casas;
  const x = valor * f;
  const piso = Math.floor(x);
  const dif = x - piso;
  let r;
  if (Math.abs(dif - 0.5) < 1e-7) r = piso % 2 === 0 ? piso : piso + 1; // HALF_EVEN, como a calculadora
  else r = Math.round(x);
  return (r / f).toFixed(casas);
}

function enviar(res, status, corpo, tipo = 'application/json') {
  res.writeHead(status, { 'Content-Type': tipo, 'x-servico-simulado': 'true' });
  res.end(typeof corpo === 'string' || corpo instanceof Uint8Array ? corpo : JSON.stringify(corpo));
}

function lerCorpo(req) {
  return new Promise((resolve) => {
    const partes = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
  });
}

const erro = (code, title, detail, pointer) => ({ type: `https://exemplo/erros/${code}`, title, code, pointer, detail });

// ---------------------------------------------------------------------------- Simples Nacional
function calcularSimples(op) {
  const objetos = [];
  const total = { vRBSNtot: 0, vBC: 0, vIBSSNtot: 0, vIBSSNtotPendSusp: 0, vCBSSNtot: 0, vCBSSNtotPendSusp: 0, totalIs: 0, totalTributos: 0 };
  const globais = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(op.data || '')) globais.push(erro('VSN-012', 'Data inválida', `Data "${op.data}" fora do formato AAAA-MM-DD`, '#/data'));
  if (!['1', '2', '3', '4'].includes(op.CRT)) globais.push(erro('VSN-016', 'CRT inválido', `CRT "${op.CRT}" não reconhecido`, '#/CRT'));

  (op.itens || []).forEach((it, i) => {
    const p = `#/itens/${i}`;
    if (globais.length) return objetos.push({ nObj: it.numero, estadoItem: 'INCONSISTENCIA_ENTRADA', erros: globais });
    const atividade = ATIVIDADES.find((a) => a.codigo === it.cAtivSN);
    if (!atividade) return objetos.push({ nObj: it.numero, estadoItem: 'NAO_CALCULADO' });
    const erros = [];
    if (!it.baseCalculo) erros.push(erro('VSN-001', 'Base de cálculo ausente', 'baseCalculo não informada', `${p}/baseCalculo`));
    else if (!/^\d+(\.\d+)?$/.test(it.baseCalculo)) erros.push(erro('VSN-002', 'Base de cálculo inválida', `Valor "${it.baseCalculo}" inválido`, `${p}/baseCalculo`));
    if (!it.pIBSSN) erros.push(erro('VSN-006', 'Alíquota do IBS ausente', 'pIBSSN não informada', `${p}/pIBSSN`));
    if (!it.pCBSSN) erros.push(erro('VSN-004', 'Alíquota da CBS ausente', 'pCBSSN não informada', `${p}/pCBSSN`));
    if (erros.length) return objetos.push({ nObj: it.numero, estadoItem: 'INCONSISTENCIA_ENTRADA', erros });

    const base = Number(it.baseCalculo);
    const vis = Number(it.valorImpostoSeletivo || 0);
    const vIBS = arred((base * Number(it.pIBSSN)) / 100);
    const vCBS = arred((base * Number(it.pCBSSN)) / 100);
    const totalItem = arred(Number(vIBS) + Number(vCBS) + vis);
    objetos.push({
      nObj: it.numero,
      estadoItem: 'CALCULADO',
      tribCalc: {
        vRBSNitem: arred(base), tpRBSN: 1, tpRBSNDescricao: 'Receita bruta - interna', vBC: arred(base),
        pIBSSN: arred(Number(it.pIBSSN)), vIBSSN: vIBS, vIBSPendSusp: '0.00',
        pCBSSN: arred(Number(it.pCBSSN)), vCBSSN: vCBS, vCBSPendSusp: '0.00',
        IS: { valor: arred(vis) }, totalItem,
      },
    });
    total.vRBSNtot += base; total.vBC += base; total.vIBSSNtot += Number(vIBS); total.vCBSSNtot += Number(vCBS);
    total.totalIs += vis; total.totalTributos += Number(totalItem);
  });
  for (const k of Object.keys(total)) total[k] = arred(total[k]);
  return { oper: { data: op.data, tpDoc: op.tpDoc, CRT: op.CRT, tpRegimeIBSCBS: op.tpRegimeIBSCBS, tpEnteGov: op.tpEnteGov }, objetos, total };
}

const simples = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/api/versao') return enviar(res, 200, { versaoApp: '0.0.0-simulador', versaoDb: 'V0071', ambiente: 'simulador' });
  if (p === '/api/calculadora/simples-nacional/atividades' || p.startsWith('/api/calculadora/simples-nacional/atividades/')) {
    const data = url.searchParams.get('data');
    if (!data) return enviar(res, 400, { title: 'Bad Request', detail: 'O parâmetro data é obrigatório.', errors: [{ pointer: 'data', detail: 'obrigatório' }] });
    const anexosParam = url.searchParams.get('anexos');
    const anexos = anexosParam === null ? null : new Set(anexosParam.split(',').filter(Boolean));
    const tpDoc = url.searchParams.get('tpDoc');
    const lista = ATIVIDADES.map((a) => {
      const necessarios = [a.anexoSemFatorR, a.anexoComFatorR].filter(Boolean);
      const faltantes = anexos ? necessarios.filter((x) => !anexos.has(x)) : [];
      const docs = ['05', '10'].includes(a.codigo) ? ['57', '67', '63', '93'] : a.codigo === '06' ? ['62', '91'] : ['55', '65', '91'];
      const admissivel = tpDoc ? docs.includes(tpDoc) : null;
      const modoFatorR = !a.sujeitaFatorR ? 'NAO_APLICAVEL' : faltantes.length === 0 ? 'OPCIONAL' : 'INDISPONIVEL';
      return {
        ...a, disponivel: faltantes.length === 0 && admissivel !== false, anexosFaltantes: faltantes, modoFatorR,
        tpDocsAdmissiveis: docs, admissivelNoDocumento: admissivel, compativelComClassTrib: null,
      };
    });
    const codigo = p.split('/atividades/')[1];
    if (codigo) {
      const a = lista.find((x) => x.codigo === codigo);
      return a ? enviar(res, 200, a) : enviar(res, 404, '');
    }
    return enviar(res, 200, lista);
  }
  if (p === '/api/calculadora/observabilidade/simples-nacional' && req.method === 'POST') {
    try {
      return enviar(res, 200, calcularSimples(JSON.parse(await lerCorpo(req))));
    } catch {
      return enviar(res, 400, { title: 'Bad Request', detail: 'JSON inválido.' });
    }
  }
  if (p === '/api/calculadora/observabilidade/simples-nacional/erros') {
    const c = url.searchParams.get('codigo');
    return ERROS_SN[c] ? enviar(res, 200, { codigo: c, titulo: ERROS_SN[c][0], descricao: ERROS_SN[c][1] }) : enviar(res, 404, '');
  }
  enviar(res, 404, { title: 'Not Found', detail: `Rota ${p} não existe no simulador.` });
});

// ---------------------------------------------------------------------------- Regime geral
function calcularRegimeGeral(op) {
  const ano = Number(String(op.dhFatoGerador || '').slice(0, 4));
  const objetos = [];
  const tot = { vBC: 0, vIBS: 0, vIBSUF: 0, vIBSMun: 0, vCBS: 0, vIS: 0 };
  (op.itens || []).forEach((it, i) => {
    const p = `#/itens/${i}`;
    if (it.ncm === '02013000' && it.cClassTrib === '200035') {
      return objetos.push({ nObj: it.numero, estadoItem: 'INCONSISTENCIA_ENTRADA', erros: [erro('REG-011', 'NCM não vinculada', `NCM de código ${it.ncm} não vinculada à Classificação Tributária de código ${it.cClassTrib} (CBS e IBS)`, `${p}/ncm`)] });
    }
    const al = it.aliquotasNominais;
    if (ano >= 2027 && !al) {
      return objetos.push({ nObj: it.numero, estadoItem: 'INCONSISTENCIA_ENTRADA', erros: [erro('REG-020', 'Alíquotas nominais obrigatórias', 'A partir de 01/01/2027, aliquotasNominais é obrigatório', `${p}/aliquotasNominais`)] });
    }
    const pCBS = al ? Number(al.cbs) : 0.9;
    const pUF = al ? Number(al.ibsEstadual) : 0.1;
    const pMun = al ? Number(al.ibsMunicipal) : 0;
    let vIS = 0;
    let IS;
    if (it.impostoSeletivo) {
      const bis = Number(it.impostoSeletivo.baseCalculo);
      vIS = it.impostoSeletivo.impostoInformado ?? (bis * Number(al?.impostoSeletivo?.adValorem || 0)) / 100;
      IS = { CSTIS: it.impostoSeletivo.cst, cClassTribIS: it.impostoSeletivo.cClassTrib, vBCIS: arred(bis), pIS: arred(Number(al?.impostoSeletivo?.adValorem || 0)), vIS: arred(vIS), memoriaCalculo: `vIS = ${arred(bis)} × ${al?.impostoSeletivo?.adValorem ?? 0}% (simulado)` };
    }
    const base = it.baseCalculo ?? Number(it.impostoSeletivo?.baseCalculo || 0) + vIS;
    const red = REDUCOES[it.cClassTrib] ?? 0;
    const grupo = (aliq) => (red ? { gRed: { pRedAliq: arred(red), pAliqEfet: arred(aliq * (1 - red / 100)) } } : {});
    const ef = (aliq) => aliq * (1 - red / 100);
    const vUF = arred((base * ef(pUF)) / 100);
    const vMun = arred((base * ef(pMun)) / 100);
    const vCBS = arred((base * ef(pCBS)) / 100);
    const vIBS = arred(Number(vUF) + Number(vMun));
    objetos.push({
      nObj: it.numero,
      estadoItem: al ? 'CALCULO_SIMULADO' : 'CALCULADO',
      tribCalc: {
        ...(IS ? { IS } : {}),
        IBSCBS: {
          CST: it.cst, cClassTrib: it.cClassTrib,
          gIBSCBS: {
            vBC: arred(base),
            gIBSUF: { pIBSUF: arred(pUF), ...grupo(pUF), vIBSUF: vUF },
            gIBSMun: { pIBSMun: arred(pMun), ...grupo(pMun), vIBSMun: vMun },
            vIBS,
            gCBS: { pCBS: arred(pCBS), ...grupo(pCBS), vCBS },
          },
          memoriaCalculo: {
            cbs: `vCBS = ${arred(base)} × ${arred(ef(pCBS))}% = ${vCBS} (simulado)`,
            ibsUF: `vIBSUF = ${arred(base)} × ${arred(ef(pUF))}% = ${vUF} (simulado)`,
            ibsMun: `vIBSMun = ${arred(base)} × ${arred(ef(pMun))}% = ${vMun} (simulado)`,
          },
        },
      },
    });
    tot.vBC += Number(base); tot.vIBS += Number(vIBS); tot.vIBSUF += Number(vUF); tot.vIBSMun += Number(vMun); tot.vCBS += Number(vCBS); tot.vIS += Number(vIS);
  });
  return {
    objetos,
    total: { tribCalc: {
      ...(tot.vIS ? { ISTot: { vIS: arred(tot.vIS) } } : {}),
      IBSCBSTot: { vBCIBSCBS: arred(tot.vBC), gIBS: { gIBSUF: { vIBSUF: arred(tot.vIBSUF) }, gIBSMun: { vIBSMun: arred(tot.vIBSMun) }, vIBS: arred(tot.vIBS) }, gCBS: { vCBS: arred(tot.vCBS) } },
    } },
  };
}

const regimeGeral = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/api/, '');
  const data = url.searchParams.get('data');
  if (p === '/calculadora/dados-abertos/versao') return enviar(res, 200, { versaoApp: '0.0.0-simulador', versaoDb: 'V0071', ambiente: 'simulador' });
  if (p === '/calculadora/observabilidade/regime-geral' && req.method === 'POST') {
    const op = JSON.parse(await lerCorpo(req));
    if (!op.municipio) return enviar(res, 400, { title: 'Bad Request', detail: 'Requisição inválida', errors: [{ pointer: '#/municipio', detail: 'não deve ser nulo' }] });
    return enviar(res, 200, calcularRegimeGeral(op), 'application/json');
  }
  if (p === '/calculadora/regime-geral' && req.method === 'POST') {
    const r = calcularRegimeGeral(JSON.parse(await lerCorpo(req)));
    const comErro = r.objetos.find((o) => o.erros);
    if (comErro) return enviar(res, 422, { title: 'Erro de validação', detail: comErro.erros[0].detail, errors: comErro.erros });
    r.objetos = r.objetos.map((o) => ({ nObj: o.nObj, tribCalc: o.tribCalc, calculoSimulado: o.estadoItem === 'CALCULO_SIMULADO' }));
    return enviar(res, 200, r);
  }
  if (p === '/calculadora/xml/generate' && req.method === 'POST') {
    const roc = JSON.parse(await lerCorpo(req));
    const itens = roc.objetos.map((o) => {
      const g = o.tribCalc.IBSCBS.gIBSCBS;
      return `  <det nItem="${o.nObj}">\n    <IBSCBS>\n      <CST>${o.tribCalc.IBSCBS.CST}</CST>\n      <cClassTrib>${o.tribCalc.IBSCBS.cClassTrib}</cClassTrib>\n      <gIBSCBS>\n        <vBC>${g.vBC}</vBC>\n        <gIBSUF><pIBSUF>${g.gIBSUF.pIBSUF}</pIBSUF><vIBSUF>${g.gIBSUF.vIBSUF}</vIBSUF></gIBSUF>\n        <gIBSMun><pIBSMun>${g.gIBSMun.pIBSMun}</pIBSMun><vIBSMun>${g.gIBSMun.vIBSMun}</vIBSMun></gIBSMun>\n        <vIBS>${g.vIBS}</vIBS>\n        <gCBS><pCBS>${g.gCBS.pCBS}</pCBS><vCBS>${g.gCBS.vCBS}</vCBS></gCBS>\n      </gIBSCBS>\n    </IBSCBS>\n  </det>`;
    });
    return enviar(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<!-- XML SIMULADO (${url.searchParams.get('tipo')}) -->\n<grupo>\n${itens.join('\n')}\n</grupo>\n`, 'application/xml');
  }
  if (p === '/calculadora/xml/validate' && req.method === 'POST') {
    const xml = await lerCorpo(req);
    return xml.includes('<grupo>') ? enviar(res, 200, 'true') : enviar(res, 422, { title: 'XML inválido', detail: 'Linha 1, coluna 1: elemento raiz inesperado' });
  }
  if (p.startsWith('/calculadora/dados-abertos/')) {
    if (!data) return enviar(res, 400, { title: 'Bad Request', detail: 'O parâmetro data é obrigatório.' });
    const recurso = p.replace('/calculadora/dados-abertos/', '');
    if (recurso.startsWith('classificacoes-tributarias/cbs-ibs/class-trib/')) {
      const c = recurso.split('/').pop();
      return enviar(res, 200, { codigoClassificacaoTributaria: c, descricao: 'Classificação simulada', tipoAliquota: 'Padrão', percentualReducaoCbs: REDUCOES[c] ?? 0, percentualReducaoIbsUf: REDUCOES[c] ?? 0, inicioVigencia: '2026-01-01', fimVigencia: null });
    }
    if (recurso === 'ncm') return enviar(res, 200, { ncm: url.searchParams.get('ncm'), descricao: 'NCM simulada', tributadoPeloImpostoSeletivo: url.searchParams.get('ncm') === '22030000', aliquotaAdValorem: 10, inicioVigencia: '2026-01-01' });
    if (recurso === 'nbs') return enviar(res, 200, { nbs: url.searchParams.get('nbs'), descricao: 'NBS simulada', inicioVigencia: '2026-01-01' });
    if (recurso.startsWith('aliquota-')) {
      if (Number(data.slice(0, 4)) >= 2027) return enviar(res, 404, '');
      return enviar(res, 200, { aliquotaReferencia: recurso === 'aliquota-uniao' ? 0.9 : recurso === 'aliquota-uf' ? 0.1 : 0, aliquotaPropria: null });
    }
    return enviar(res, 404, '');
  }
  if (p === '/calculadora/observabilidade/erros') {
    const c = url.searchParams.get('codigo');
    return ERROS_RG[c] ? enviar(res, 200, { codigo: c, titulo: ERROS_RG[c][0], descricao: ERROS_RG[c][1] }) : enviar(res, 404, '');
  }
  enviar(res, 404, { title: 'Not Found', detail: `Rota ${p} não existe no simulador.` });
});

// ---------------------------------------------------------------------------- DANFSe
function pdfSimulado(linhas) {
  const texto = linhas.map((l, i) => `BT /F1 ${i ? 11 : 16} Tf 56 ${780 - i * 22} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${texto.length} >>\nstream\n${texto}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const posicoes = [];
  objetos.forEach((o, i) => {
    posicoes.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${posicoes.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const danfse = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health/ready') return enviar(res, 200, { status: 'ok' });
  if (url.pathname === '/api/danfse' && req.method === 'POST') {
    const xml = await lerCorpo(req);
    if (!xml.trim()) return enviar(res, 400, { sucesso: false, mensagem: 'Xml não informado.' });
    if (!/<(\w+:)?NFSe[\s>]/.test(xml)) return enviar(res, 400, { sucesso: false, mensagem: 'O XML não contém uma NFS-e (elemento NFSe não encontrado).' });
    const numero = xml.match(/<nNFSe>(\d+)<\/nNFSe>/)?.[1] ?? 's/n';
    const stc = url.searchParams.get('stc') ?? '0';
    const situacao = { 0: 'Valida', 1: 'Substituida', 2: 'Cancelada' }[stc] ?? 'Valida';
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="danfse.pdf"', 'x-servico-simulado': 'true' });
    return res.end(pdfSimulado(['DANFSe SIMULADO - sem valor fiscal', `NFS-e numero ${numero}`, `Situacao: ${situacao}`, `Canhoto: ${url.searchParams.get('canhoto') ?? 'true'}`]));
  }
  enviar(res, 404, { message: 'Not Found' });
});

const portas = { rg: Number(process.env.PORTA_RG || 8080), sn: Number(process.env.PORTA_SN || 8082), danfse: Number(process.env.PORTA_DANFSE || 8081) };
regimeGeral.listen(portas.rg, '127.0.0.1');
simples.listen(portas.sn, '127.0.0.1');
danfse.listen(portas.danfse, '127.0.0.1');
console.log(`Simulador (dados fictícios) no ar — regime geral :${portas.rg}, Simples :${portas.sn}, DANFSe :${portas.danfse}`);
