import {
  criarCliente, operacaoSimples, operacaoRegimeGeral, itensSimples, itensRegimeGeral, ESTADOS_ITEM, UFS, DOCUMENTOS,
  MODELOS, prepararLote, executarLote, linhasParaPlanilha, semResposta,
} from './lib/rtc.js';
import { lerCSV, gerarCSV } from './lib/csv.js';
import { moeda, percentual } from './lib/formato.js';
import { criarZip, nomeUnico } from './lib/zip.js';

const cliente = criarCliente({ rg: '/svc/rg', sn: '/svc/sn', danfse: '/svc/danfse' });

// ============================================================================ utilidades

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

function h(tag, atributos = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(atributos || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return el;
}

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function agoraLocal() {
  const d = new Date();
  return `${hojeISO()}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function baixar(nome, conteudo, tipo) {
  const url = URL.createObjectURL(conteudo instanceof Blob ? conteudo : new Blob([conteudo], { type: tipo }));
  const a = h('a', { href: url, download: nome });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Como replaceChildren, mas ignora null/false (útil para blocos condicionais). */
function trocar(el, ...filhos) {
  el.replaceChildren(...filhos.flat().filter((f) => f !== null && f !== undefined && f !== false));
}

function carimbo(texto, tom = 'neutro') {
  return h('span', { class: 'carimbo', 'data-tom': tom, text: texto });
}

function carimboEstado(estado) {
  const info = ESTADOS_ITEM[estado] || { rotulo: estado || 'Sem estado', tom: 'neutro' };
  return carimbo(info.rotulo, info.tom);
}

function mensagem(tipo, titulo, texto) {
  return h('div', { class: `mensagem mensagem-${tipo}`, role: tipo === 'erro' ? 'alert' : null }, h('strong', { text: titulo }), texto ? h('p', { text: texto }) : null);
}

function erroParaMensagem(e) {
  if (e?.status === 404) return mensagem('aviso', 'Nada encontrado', 'O serviço não achou registro para esses dados nessa data.');
  const caiu = semResposta(e);
  if (caiu) setTimeout(atualizarStatus, 0);
  return mensagem('erro', caiu ?'Não foi possível falar com o serviço' : `O serviço recusou a requisição (HTTP ${e.status})`, e?.message || String(e));
}

async function comBotaoOcupado(botao, fn) {
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.setAttribute('aria-busy', 'true');
  botao.textContent = `${textoOriginal.replace(/\s*\(.*\)$/, '')}…`;
  try {
    return await fn();
  } finally {
    botao.disabled = false;
    botao.removeAttribute('aria-busy');
    botao.textContent = textoOriginal;
  }
}

function blocoBruto(titulo, ...conteudos) {
  return h(
    'details',
    { class: 'bruto' },
    h('summary', { text: titulo }),
    conteudos.map(([rotulo, obj]) => {
      const texto = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      return h(
        'div',
        {},
        h('p', { class: 'nota' }, rotulo, ' ', h('button', { type: 'button', class: 'botao-discreto botao', onclick: (ev) => copiar(texto, ev.currentTarget) }, 'Copiar')),
        h('pre', { class: 'codigo', text: texto }),
      );
    }),
  );
}

async function copiar(texto, botao) {
  try {
    await navigator.clipboard.writeText(texto);
    const antes = botao.textContent;
    botao.textContent = 'Copiado';
    setTimeout(() => (botao.textContent = antes), 1500);
  } catch {
    botao.textContent = 'Não deu para copiar';
  }
}

function celulaSaida(rotulo, valor, sub) {
  return h('div', { class: 'campo campo-saida' }, h('span', { text: rotulo }), h('strong', { text: valor ?? '—' }), sub ? h('span', { class: 'sub', text: sub }) : null);
}

function marcarInvalido(input, invalido) {
  const campo = input.closest('.campo');
  if (!campo) return;
  if (invalido) campo.setAttribute('data-invalido', '');
  else campo.removeAttribute('data-invalido');
}

function exigir(inputs) {
  let primeiro = null;
  for (const input of inputs) {
    const vazio = !String(input.value || '').trim();
    marcarInvalido(input, vazio);
    if (vazio && !primeiro) primeiro = input;
  }
  primeiro?.focus();
  return !primeiro;
}

const tamanhoLegivel = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);

// ============================================================================ navegação

const SECOES = ['simples', 'rg', 'consultas', 'danfse', 'lote'];

function abrirSecao(nome, { foco = false } = {}) {
  if (!SECOES.includes(nome)) nome = 'simples';
  for (const s of SECOES) $(`#secao-${s}`).hidden = s !== nome;
  for (const b of $$('.menu button')) {
    if (b.dataset.secao === nome) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (location.hash !== `#${nome}`) history.replaceState(null, '', `#${nome}`);
  if (foco) $(`#secao-${nome} h1`).focus({ preventScroll: false });
}

for (const b of $$('.menu button')) b.addEventListener('click', () => abrirSecao(b.dataset.secao));
for (const h1 of $$('.secao h1')) h1.tabIndex = -1;

for (const aba of $$('.abas [role=tab]')) {
  aba.addEventListener('click', () => {
    for (const outra of $$('[role=tab]', aba.parentElement)) {
      const ativa = outra === aba;
      outra.setAttribute('aria-selected', String(ativa));
      $(`#${outra.dataset.aba}`).hidden = !ativa;
    }
  });
}

// ============================================================================ status dos serviços

const NOMES_CURTOS = { rg: 'Regime geral', sn: 'Simples', danfse: 'DANFSe' };

async function atualizarStatus() {
  const lista = $('#servicos');
  if (!lista.children.length) {
    for (const k of Object.keys(NOMES_CURTOS)) lista.append(h('li', { 'data-servico': k }, NOMES_CURTOS[k], ' ', h('small', { text: 'verificando' })));
  }
  let status;
  try {
    const r = await fetch('/status', { cache: 'no-store' });
    if (r.status === 401) return location.assign('/login.html'); // a sessão acabou
    status = await r.json();
  } catch {
    $('#aviso-offline').hidden = false;
    $('#aviso-offline').textContent = 'O painel perdeu contato com o próprio servidor. Ele ainda está rodando?';
    return;
  }
  const fora = [];
  let simulado = false;
  for (const k of Object.keys(NOMES_CURTOS)) {
    const s = status[k];
    const li = $(`li[data-servico="${k}"]`, lista);
    li.dataset.estado = s.online ? 'online' : 'offline';
    li.title = `${s.nome}: ${s.url}`;
    $('small', li).textContent = s.online ? (s.versao ? `v${s.versao}` : 'no ar') : 'fora do ar';
    if (!s.online) fora.push(s.nome);
    if (s.simulado) simulado = true;
  }
  $('#aviso-simulador').hidden = !simulado;
  const aviso = $('#aviso-offline');
  aviso.hidden = fora.length === 0;
  if (fora.length) {
    aviso.replaceChildren(
      `${fora.length === 3 ? 'Nenhum serviço respondeu' : `Fora do ar: ${fora.join(', ')}`}. Suba os serviços com `,
      h('code', { text: 'docker compose up -d' }),
      ' ou, no Windows sem Docker, ',
      h('code', { text: 'powershell -ExecutionPolicy Bypass -File servicos-windows.ps1' }),
      ' na pasta do projeto (a primeira vez demora alguns minutos) e clique em Verificar de novo.',
    );
  }
}

$('#btn-status').addEventListener('click', (ev) => comBotaoOcupado(ev.currentTarget, atualizarStatus));

// ============================================================================ listas fixas

for (const sel of $$('select[data-documentos]')) {
  if (sel.hasAttribute('data-opcional')) sel.append(h('option', { value: '', text: 'Não informar' }));
  for (const [codigo, nome] of DOCUMENTOS) sel.append(h('option', { value: codigo, text: `${codigo} — ${nome}` }));
}
for (const sel of $$('select[data-ufs]')) {
  for (const uf of Object.keys(UFS).sort()) sel.append(h('option', { value: uf, text: uf }));
  sel.value = 'AM';
}

const nomeDocumento = (codigo) => DOCUMENTOS.find(([c]) => c === codigo)?.[1] || codigo;

// ============================================================================ Simples Nacional — cálculo

const formSN = $('#form-sn');
const itensSN = $('#sn-itens');
let atividadesSN = [];

const ATIVIDADES_RESERVA = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '90'].map((codigo) => ({ codigo, descricao: '' }));

async function carregarAtividadesSN() {
  const data = formSN.data.value;
  if (!data) return;
  try {
    const r = await cliente.simplesNacional.atividades({ data, tpDoc: formSN.tpDoc.value });
    atividadesSN = r.dados;
  } catch {
    atividadesSN = ATIVIDADES_RESERVA;
  }
  for (const sel of $$('select[data-atividades]', itensSN)) preencherAtividades(sel);
}

function preencherAtividades(sel) {
  const atual = sel.value || sel.dataset.valorInicial || '';
  sel.replaceChildren(h('option', { value: '', text: 'Não informar (o item não é calculado)' }));
  for (const a of atividadesSN) {
    const resumo = a.descricao ? ` — ${a.descricao.length > 70 ? `${a.descricao.slice(0, 68)}…` : a.descricao}` : '';
    const bloqueio = a.admissivelNoDocumento === false ? ' (não admitida neste documento)' : '';
    sel.append(h('option', { value: a.codigo, text: `${a.codigo}${resumo}${bloqueio}` }));
  }
  sel.value = atual;
  if (sel.value === atual) delete sel.dataset.valorInicial; // só esquece o valor pedido depois que a opção existir
}

function adicionarItemSN(valores = {}) {
  const item = $('#tpl-item-sn').content.firstElementChild.cloneNode(true);
  for (const [k, v] of Object.entries(valores)) {
    const campo = item.querySelector(`[name="${k}"]`);
    if (campo) campo.value = v;
  }
  const sel = $('select[data-atividades]', item);
  sel.dataset.valorInicial = valores.cAtivSN ?? '01';
  preencherAtividades(sel);
  $('[data-remover]', item).addEventListener('click', () => item.remove());
  itensSN.append(item);
  return item;
}

function lerItens(container) {
  return $$('[data-item]', container).map((item, i) => {
    const valores = { numero: i + 1 };
    for (const campo of $$('input, select', item)) valores[campo.name] = campo.value.trim();
    return valores;
  });
}

formSN.data.value = hojeISO() < '2027-01-01' ? '2027-01-15' : hojeISO();
formSN.data.addEventListener('change', carregarAtividadesSN);
formSN.tpDoc.addEventListener('change', carregarAtividadesSN);
$('[data-adicionar]', formSN).addEventListener('click', () => $('input[name=baseCalculo]', adicionarItemSN()).focus());
$('[data-exemplo]', formSN).addEventListener('click', () => {
  formSN.data.value = '2027-03-15';
  formSN.tpDoc.value = '55';
  formSN.CRT.value = '1';
  formSN.tpRegimeIBSCBS.value = '';
  formSN.tpEnteGov.value = '';
  itensSN.replaceChildren();
  adicionarItemSN({ cAtivSN: '01', cClassTrib: '000001', baseCalculo: '950,00', valorImpostoSeletivo: '50,00', pIBSSN: '1,25', pCBSSN: '2,75' });
  adicionarItemSN({ cAtivSN: '03', cClassTrib: '000001', baseCalculo: '1.200,00', valorImpostoSeletivo: '0,00', pIBSSN: '1,10', pCBSSN: '2,40' });
  carregarAtividadesSN();
});

formSN.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const saida = $('#sn-resultado');
  const obrigatorios = [formSN.data, ...$$('input[name=baseCalculo], input[name=cClassTrib]', itensSN)];
  if (!exigir(obrigatorios)) {
    trocar(saida, mensagem('aviso', 'Faltam dados', 'Preencha a data, a cClassTrib e a base de cálculo de cada item.'));
    return;
  }
  const op = operacaoSimples({
    data: formSN.data.value,
    tpDoc: formSN.tpDoc.value,
    CRT: formSN.CRT.value,
    tpRegimeIBSCBS: formSN.tpRegimeIBSCBS.value,
    tpEnteGov: formSN.tpEnteGov.value,
    itens: lerItens(itensSN),
  });
  await comBotaoOcupado(ev.submitter || $('[type=submit]', formSN), async () => {
    try {
      const r = await cliente.simplesNacional.calcular(op);
      trocar(saida, ...renderizarSimples(r.dados, op));
    } catch (e) {
      trocar(saida, erroParaMensagem(e), blocoBruto('Ver requisição enviada', ['Requisição', op]));
    }
    saida.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

function listaErros(erros) {
  return h(
    'ul',
    { class: 'erros' },
    erros.map((e) => h('li', {}, h('strong', { text: e.code || 'Erro' }), e.title, e.detail && e.detail !== e.title ? `: ${e.detail}` : '', e.pointer ? h('span', { class: 'ponteiro', text: `Campo: ${e.pointer}` }) : null)),
  );
}

function renderizarSimples(resposta, requisicao) {
  const itens = itensSimples(resposta);
  const blocos = [h('div', { class: 'cabecalho-resultado' }, h('h2', { text: 'Resultado' }), h('span', { class: 'nota', text: `${itens.length} ${itens.length === 1 ? 'item' : 'itens'}` }))];

  for (const it of itens) {
    const tom = ESTADOS_ITEM[it.estado]?.tom || 'neutro';
    const card = h('article', { class: 'resultado-item', 'data-tom': tom }, h('header', {}, h('h3', { text: `Item ${it.item}` }), carimboEstado(it.estado)));
    if (it.vBC !== undefined) {
      const pendente = Number(it.vIBSPendSusp || 0) + Number(it.vCBSPendSusp || 0) > 0;
      card.append(
        h(
          'div',
          { class: 'ficha' },
          celulaSaida('Receita bruta do item', moeda(it.vRBSNitem)),
          celulaSaida('Tipo de receita', it.tpRBSN ? `${it.tpRBSN}` : '—', it.tpRBSNDescricao),
          celulaSaida('Base de cálculo', moeda(it.vBC)),
          celulaSaida('IBS', moeda(it.vIBSSN), `alíquota de ${percentual(it.pIBSSN)}`),
          celulaSaida('CBS', moeda(it.vCBSSN), `alíquota de ${percentual(it.pCBSSN)}`),
          celulaSaida('Imposto Seletivo', moeda(it.vIS)),
          celulaSaida('Total do item', moeda(it.totalItem)),
        ),
      );
      if (pendente) card.append(h('p', { class: 'descricao', text: `Valores pendentes ou suspensos: IBS ${moeda(it.vIBSPendSusp)}, CBS ${moeda(it.vCBSPendSusp)}.` }));
    }
    if (it._erros.length) card.append(listaErros(it._erros));
    else if (it.estado === 'NAO_CALCULADO') {
      card.append(h('p', { class: 'descricao', text: 'A atividade não foi informada, não está vigente na data ou não é admitida neste documento, então o item fica fora do cálculo.' }));
    }
    blocos.push(card);
  }

  const t = resposta?.total;
  if (t) {
    blocos.push(
      h(
        'section',
        { class: 'totais' },
        h('h3', { text: 'Totais da operação' }),
        h(
          'dl',
          {},
          [['Receita bruta', t.vRBSNtot], ['IBS', t.vIBSSNtot], ['CBS', t.vCBSSNtot], ['Imposto Seletivo', t.totalIs], ['Total de tributos', t.totalTributos]].map(([r, v]) => h('div', {}, h('dt', { text: r }), h('dd', { text: moeda(v) }))),
        ),
      ),
    );
  }
  blocos.push(blocoBruto('Ver JSON da requisição e da resposta', ['Requisição', requisicao], ['Resposta', resposta]));
  return blocos;
}

// ============================================================================ Simples Nacional — atividades

const formAtiv = $('#form-ativ');
formAtiv.data.value = formSN.data.value;

const ROTULO_FATOR_R = { NAO_APLICAVEL: '—', OPCIONAL: 'Anexo III ou V, conforme o Fator R', INDISPONIVEL: 'Sem o anexo necessário' };

formAtiv.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const saida = $('#ativ-resultado');
  if (!exigir([formAtiv.data])) return;
  const anexos = $$('input[name=anexos]:checked', formAtiv).map((c) => c.value);
  await comBotaoOcupado(ev.submitter || $('[type=submit]', formAtiv), async () => {
    try {
      const r = await cliente.simplesNacional.atividades({
        data: formAtiv.data.value,
        anexos: anexos.length ? anexos : undefined,
        tpDoc: formAtiv.tpDoc.value,
        cClassTrib: formAtiv.cClassTrib.value.trim(),
      });
      trocar(saida, ...renderizarAtividades(r.dados, { filtrouAnexos: anexos.length > 0 }));
    } catch (e) {
      trocar(saida, erroParaMensagem(e));
    }
  });
});

function motivosIndisponivel(a) {
  const motivos = [];
  if (a.anexosFaltantes?.length) motivos.push(`falta o anexo ${a.anexosFaltantes.join(' e ')}`);
  if (a.admissivelNoDocumento === false) motivos.push('não admitida no documento');
  if (a.compativelComClassTrib === false) motivos.push('incompatível com a cClassTrib');
  return motivos.join('; ');
}

function renderizarAtividades(lista, { filtrouAnexos }) {
  const disponiveis = lista.filter((a) => a.disponivel).length;
  const tabela = h(
    'table',
    { class: 'tabela' },
    h('thead', {}, h('tr', {}, ['Código', 'Atividade', 'Anexo', 'Fator R', 'Documentos', 'Situação'].map((c) => h('th', { scope: 'col', text: c })))),
    h(
      'tbody',
      {},
      lista.map((a) =>
        h(
          'tr',
          { 'data-indisponivel': !a.disponivel },
          h('td', {}, h('span', { class: 'codigo-ativ', text: a.codigo })),
          h('td', { text: a.descricao }),
          h('td', { text: a.rotuloAnexo || 'Sem anexo' }),
          h('td', { text: ROTULO_FATOR_R[a.modoFatorR] || (a.sujeitaFatorR ? 'Sim' : '—') }),
          h('td', { text: a.tpDocsAdmissiveis?.length ? a.tpDocsAdmissiveis.map((c) => nomeDocumento(c).replace(/-/g, '\u2011')).join(', ') : 'Nenhum publicado' }),
          h('td', {}, a.disponivel ? carimbo('Disponível', 'ok') : carimbo('Indisponível', 'aviso'), a.disponivel ? null : h('div', { class: 'nota', text: motivosIndisponivel(a) })),
        ),
      ),
    ),
  );
  return [
    h('div', { class: 'cabecalho-resultado' }, h('h2', { text: `${lista.length} atividades vigentes` }), h('span', { class: 'nota', text: `${disponiveis} disponíveis${filtrouAnexos ? ' para os anexos marcados' : ''}` })),
    h('div', { class: 'tabela-rolagem' }, tabela),
  ];
}

// ============================================================================ Regime geral

const formRG = $('#form-rg');
const itensRG = $('#rg-itens');
let ultimaOperacaoRG = null;

formRG.dhFatoGerador.value = agoraLocal();
formRG.municipio.value = '1302603';

function anoRG() {
  return Number((formRG.dhFatoGerador.value || '').slice(0, 4)) || new Date().getFullYear();
}

function atualizarAliquotasRG() {
  const exige = anoRG() >= 2027;
  for (const el of $$('[data-aliquota]', itensRG)) el.hidden = !exige;
  $('#rg-nota-aliquotas').textContent = exige
    ? 'A partir de 2027, informe as alíquotas nominais de cada item. A calculadora marca esses resultados como cálculo simulado.'
    : 'Até 2026, a calculadora usa as alíquotas de referência cadastradas, por isso os campos de alíquota ficam ocultos.';
}

function adicionarItemRG(valores = {}) {
  const item = $('#tpl-item-rg').content.firstElementChild.cloneNode(true);
  const tipo = $('[name=tipoCodigo]', item);
  const rotulo = $('[data-rotulo-codigo]', item);
  const codigo = $('[name=codigo]', item);
  const ajustarTipo = () => {
    rotulo.textContent = tipo.value === 'nbs' ? 'Código NBS' : 'Código NCM';
    codigo.maxLength = tipo.value === 'nbs' ? 9 : 8;
  };
  tipo.addEventListener('change', ajustarTipo);
  for (const [k, v] of Object.entries(valores)) {
    const campo = item.querySelector(`[name="${k}"]`);
    if (campo) campo.value = v;
  }
  if (valores.isCst || valores.isBaseCalculo) $('details', item).open = true;
  ajustarTipo();
  $('[data-remover]', item).addEventListener('click', () => item.remove());
  itensRG.append(item);
  atualizarAliquotasRG();
  return item;
}

formRG.dhFatoGerador.addEventListener('change', atualizarAliquotasRG);
$('[data-adicionar]', formRG).addEventListener('click', () => $('input[name=codigo]', adicionarItemRG()).focus());
$('[data-exemplo]', formRG).addEventListener('click', () => {
  formRG.dhFatoGerador.value = '2027-03-10T10:00';
  formRG.municipio.value = '1302603';
  formRG.uf.value = 'AM';
  formRG.tpDoc.value = '';
  formRG.tpEnteGov.value = '';
  itensRG.replaceChildren();
  const aliq = { aliqCBS: '8,8', aliqIBSUF: '0,05', aliqIBSMun: '0,05' };
  adicionarItemRG({ tipoCodigo: 'ncm', codigo: '10063021', cst: '200', cClassTrib: '200003', baseCalculo: '100,00', quantidade: '20', unidade: 'KG', ...aliq });
  adicionarItemRG({ tipoCodigo: 'nbs', codigo: '122011200', cst: '200', cClassTrib: '200028', baseCalculo: '1.200,00', ...aliq });
  adicionarItemRG({
    tipoCodigo: 'ncm', codigo: '22030000', cst: '000', cClassTrib: '000001', quantidade: '12', unidade: 'LT', ...aliq,
    isCst: '000', isClassTrib: '000001', isBaseCalculo: '150,00', isQuantidade: '12', isUnidade: 'LT', isImpostoInformado: '15,00', isAdValorem: '10',
  });
});

function lerItensRG() {
  const exigeAliquota = anoRG() >= 2027;
  return lerItens(itensRG).map((it) => {
    const item = { ...it, [it.tipoCodigo]: it.codigo };
    if (!exigeAliquota) for (const k of ['aliqCBS', 'aliqIBSUF', 'aliqIBSMun', 'isAdValorem', 'isAdRem']) delete item[k];
    return item;
  });
}

formRG.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const saida = $('#rg-resultado');
  const obrigatorios = [formRG.dhFatoGerador, formRG.municipio, ...$$('input[name=codigo], input[name=cst], input[name=cClassTrib]', itensRG)];
  for (const item of $$('[data-item]', itensRG)) {
    const base = $('input[name=baseCalculo]', item);
    const baseIS = $('input[name=isBaseCalculo]', item);
    if (!baseIS.value.trim()) obrigatorios.push(base);
    else marcarInvalido(base, false);
  }
  if (!exigir(obrigatorios)) {
    trocar(saida, mensagem('aviso', 'Faltam dados', 'Preencha data, município e, em cada item, o código, a CST, a cClassTrib e a base de cálculo (ou a base do Imposto Seletivo).'));
    return;
  }
  const op = operacaoRegimeGeral({
    dhFatoGerador: formRG.dhFatoGerador.value,
    municipio: formRG.municipio.value,
    uf: formRG.uf.value,
    tpDoc: formRG.tpDoc.value,
    tpEnteGov: formRG.tpEnteGov.value,
    itens: lerItensRG(),
  });
  await comBotaoOcupado(ev.submitter || $('[type=submit]', formRG), async () => {
    try {
      const r = await cliente.regimeGeral.calcularComObservabilidade(op);
      ultimaOperacaoRG = op;
      trocar(saida, ...renderizarRegimeGeral(r.dados, op, r.avisoSimulado));
      $('#rg-xml').hidden = !itensRegimeGeral(r.dados).some((i) => ESTADOS_ITEM[i.estado]?.tom === 'ok');
      $('#rg-xml-saida').replaceChildren();
    } catch (e) {
      ultimaOperacaoRG = null;
      $('#rg-xml').hidden = true;
      trocar(saida, erroParaMensagem(e), blocoBruto('Ver requisição enviada', ['Requisição', op]));
    }
    saida.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

function textoMemoria(memoria) {
  if (!memoria) return null;
  if (typeof memoria === 'string') return memoria;
  return Object.entries(memoria)
    .filter(([, v]) => v)
    .map(([k, v]) => `${{ cbs: 'CBS', ibsUF: 'IBS estadual', ibsMun: 'IBS municipal' }[k] || k}: ${v}`)
    .join('\n\n');
}

function subAliquota(p, red, efet) {
  if (p === undefined) return null;
  return red !== undefined ? `${percentual(p)} com redução de ${percentual(red)}, efetiva ${percentual(efet)}` : `alíquota de ${percentual(p)}`;
}

function renderizarRegimeGeral(resposta, requisicao, aviso) {
  const itens = itensRegimeGeral(resposta);
  const blocos = [h('div', { class: 'cabecalho-resultado' }, h('h2', { text: 'Resultado' }), h('span', { class: 'nota', text: `${itens.length} ${itens.length === 1 ? 'item' : 'itens'}` }))];
  if (aviso) blocos.push(mensagem('aviso', 'Dados simulados', aviso));

  for (const it of itens) {
    const tom = ESTADOS_ITEM[it.estado]?.tom || 'neutro';
    const card = h('article', { class: 'resultado-item', 'data-tom': tom }, h('header', {}, h('h3', { text: `Item ${it.item}` }), carimboEstado(it.estado)));
    if (it.vBC !== undefined) {
      const linha = [
        celulaSaida('Base de cálculo', moeda(it.vBC), it.cClassTrib ? `CST ${it.cst}, cClassTrib ${it.cClassTrib}` : null),
        celulaSaida('CBS', moeda(it.vCBS), subAliquota(it.pCBS, it.pRedCBS, it.pAliqEfetCBS)),
        celulaSaida('IBS estadual', moeda(it.vIBSUF), subAliquota(it.pIBSUF, it.pRedIBSUF, it.pAliqEfetIBSUF)),
        celulaSaida('IBS municipal', moeda(it.vIBSMun), subAliquota(it.pIBSMun, it.pRedIBSMun, it.pAliqEfetIBSMun)),
        celulaSaida('IBS total', moeda(it.vIBS)),
      ];
      if (it.vIS !== undefined) linha.push(celulaSaida('Imposto Seletivo', moeda(it.vIS), `base ${moeda(it.vBCIS)}, alíquota ${percentual(it.pIS)}`));
      card.append(h('div', { class: 'ficha' }, linha));
      const memoria = [textoMemoria(it.memoria), it.memoriaIS ? `Imposto Seletivo: ${it.memoriaIS}` : null].filter(Boolean).join('\n\n');
      if (memoria) card.append(h('details', { class: 'memoria' }, h('summary', { text: 'Memória de cálculo' }), h('p', { text: memoria })));
    }
    if (it._erros.length) card.append(listaErros(it._erros));
    blocos.push(card);
  }

  const t = resposta?.total?.tribCalc;
  if (t) {
    const tot = t.IBSCBSTot || {};
    blocos.push(
      h(
        'section',
        { class: 'totais' },
        h('h3', { text: 'Totais da operação (só itens calculados)' }),
        h(
          'dl',
          {},
          [['Base IBS/CBS', tot.vBCIBSCBS], ['CBS', tot.gCBS?.vCBS], ['IBS', tot.gIBS?.vIBS], ['Imposto Seletivo', t.ISTot?.vIS]]
            .filter(([, v]) => v !== undefined)
            .map(([r, v]) => h('div', {}, h('dt', { text: r }), h('dd', { text: moeda(v) }))),
        ),
      ),
    );
  }
  blocos.push(blocoBruto('Ver JSON da requisição e da resposta', ['Requisição', requisicao], ['Resposta', resposta]));
  return blocos;
}

$('#btn-gerar-xml').addEventListener('click', async (ev) => {
  const saida = $('#rg-xml-saida');
  if (!ultimaOperacaoRG) return;
  const tipo = $('#rg-xml select[name=tipoXml]').value;
  await comBotaoOcupado(ev.currentTarget, async () => {
    let roc;
    try {
      roc = (await cliente.regimeGeral.calcular(ultimaOperacaoRG)).dados;
    } catch (e) {
      trocar(saida, 
        e.status === 422 ? mensagem('erro', 'O XML só é gerado quando todos os itens são calculados', `Corrija ou remova os itens com erro e calcule de novo. Detalhe: ${e.message}`) : erroParaMensagem(e),
      );
      return;
    }
    let xml;
    try {
      xml = (await cliente.regimeGeral.gerarXml(roc, tipo)).dados;
    } catch (e) {
      trocar(saida, erroParaMensagem(e));
      return;
    }
    let validacao;
    try {
      const v = await cliente.regimeGeral.validarXml(xml, tipo, 'grupo');
      validacao = String(v.dados).trim() === 'true' ? { ok: true } : { ok: false, texto: String(v.dados) };
    } catch (e) {
      validacao = { ok: false, texto: e.message };
    }
    trocar(saida, 
      h('div', { class: 'resumo-lote' }, validacao.ok ? carimbo('XML válido no XSD', 'ok') : carimbo('XML inválido', 'erro')),
      validacao.ok ? null : mensagem('erro', 'O validador apontou um problema', validacao.texto),
      h(
        'div',
        { class: 'acoes' },
        h('button', { type: 'button', class: 'botao', onclick: () => baixar(`grupo-tributacao-${tipo}.xml`, xml, 'application/xml') }, 'Baixar XML'),
        h('button', { type: 'button', class: 'botao botao-discreto', onclick: (e) => copiar(xml, e.currentTarget) }, 'Copiar'),
      ),
      h('pre', { class: 'codigo', text: xml }),
    );
  });
});

// ============================================================================ Consultas

const formConsulta = $('#form-consulta');
formConsulta.data.value = hojeISO();

const CONSULTAS = {
  classtrib: { rotulo: 'cClassTrib', exemplo: '200028', comData: true, fazer: (c, d) => cliente.regimeGeral.dadosAbertos(`classificacoes-tributarias/cbs-ibs/class-trib/${encodeURIComponent(c)}`, { data: d }) },
  ncm: { rotulo: 'NCM (8 dígitos)', exemplo: '22030000', comData: true, fazer: (c, d) => cliente.regimeGeral.dadosAbertos('ncm', { ncm: c, data: d }) },
  nbs: { rotulo: 'NBS (9 dígitos)', exemplo: '122011200', comData: true, fazer: (c, d) => cliente.regimeGeral.dadosAbertos('nbs', { nbs: c, data: d }) },
  'nbs-aplicaveis': { rotulo: 'cClassTrib', exemplo: '200028', comData: true, fazer: (c, d) => cliente.regimeGeral.dadosAbertos('nbs-aplicaveis', { cClassTrib: c, data: d }) },
  'aliq-uniao': { rotulo: null, comData: true, fazer: (c, d) => cliente.regimeGeral.dadosAbertos('aliquota-uniao', { data: d }) },
  'aliq-uf': { rotulo: 'UF (sigla ou código IBGE)', exemplo: 'AM', comData: true, fazer: (c, d) => cliente.regimeGeral.dadosAbertos('aliquota-uf', { codigoUf: UFS[c.toUpperCase()] ?? c, data: d }) },
  'aliq-mun': { rotulo: 'Município (código IBGE)', exemplo: '1302603', comData: true, fazer: (c, d) => cliente.regimeGeral.dadosAbertos('aliquota-municipio', { codigoMunicipio: c, data: d }) },
  'erro-rg': { rotulo: 'Código', exemplo: 'REG-011', comData: false, fazer: (c) => cliente.regimeGeral.erro(c.toUpperCase()) },
  'erro-sn': { rotulo: 'Código', exemplo: 'VSN-001', comData: false, fazer: (c) => cliente.simplesNacional.erro(c.toUpperCase()) },
};

function ajustarConsulta() {
  const cfg = CONSULTAS[formConsulta.tipo.value];
  $('[data-campo-codigo]', formConsulta).hidden = !cfg.rotulo;
  $('[data-rotulo-codigo]', formConsulta).textContent = cfg.rotulo || 'Código';
  formConsulta.codigo.placeholder = cfg.exemplo ? `Ex.: ${cfg.exemplo}` : '';
  $('[data-campo-data]', formConsulta).hidden = !cfg.comData;
  marcarInvalido(formConsulta.codigo, false);
}
formConsulta.tipo.addEventListener('change', ajustarConsulta);
ajustarConsulta();

formConsulta.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const cfg = CONSULTAS[formConsulta.tipo.value];
  const saida = $('#consulta-resultado');
  const exigidos = [...(cfg.rotulo ? [formConsulta.codigo] : []), ...(cfg.comData ? [formConsulta.data] : [])];
  if (!exigir(exigidos)) return;
  await comBotaoOcupado(ev.submitter || $('[type=submit]', formConsulta), async () => {
    try {
      const r = await cfg.fazer(formConsulta.codigo.value.trim(), formConsulta.data.value);
      trocar(saida, ...renderizarGenerico(r.dados));
    } catch (e) {
      const pos2027 = formConsulta.tipo.value.startsWith('aliq-') && formConsulta.data.value >= '2027-01-01';
      trocar(saida, 
        e.status === 404 && pos2027
          ? mensagem('aviso', 'Sem alíquota de referência para essa data', 'As alíquotas de referência estão cadastradas só para 2026. A partir de 2027, elas são informadas em cada item do cálculo.')
          : erroParaMensagem(e),
      );
    }
  });
});

function valorCurto(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function renderizarGenerico(dados) {
  if (dados === null || dados === undefined || dados === '') return [mensagem('aviso', 'Resposta vazia', 'O serviço respondeu sem conteúdo.')];
  if (typeof dados !== 'object') return [h('pre', { class: 'codigo', text: String(dados) })];
  if (Array.isArray(dados)) {
    if (!dados.length) return [mensagem('aviso', 'Nenhum registro', 'A consulta não retornou registros.')];
    if (typeof dados[0] !== 'object') return [h('p', {}, `${dados.length} registros: `, dados.slice(0, 200).join(', '))];
    const colunas = [...new Set(dados.slice(0, 50).flatMap((d) => Object.keys(d)))].slice(0, 8);
    return [
      h('p', { class: 'nota', text: `${dados.length} registros${dados.length > 200 ? ', mostrando os 200 primeiros' : ''}.` }),
      h(
        'div',
        { class: 'tabela-rolagem' },
        h('table', { class: 'tabela' }, h('thead', {}, h('tr', {}, colunas.map((c) => h('th', { text: c })))), h('tbody', {}, dados.slice(0, 200).map((d) => h('tr', {}, colunas.map((c) => h('td', { text: valorCurto(d[c]) })))))),
      ),
      blocoBruto('Ver JSON completo', ['Resposta', dados]),
    ];
  }
  return [h('dl', { class: 'chaves' }, Object.entries(dados).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: valorCurto(v) })])), blocoBruto('Ver JSON completo', ['Resposta', dados])];
}

// ============================================================================ DANFSe

const LIMITE_XML = 5 * 1024 * 1024;
const listaDanfse = $('#danfse-lista');
const previa = $('#danfse-previa');
let arquivosDanfse = [];
let proximoId = 1;

const ESTADOS_DANFSE = { pendente: ['Aguardando', 'neutro'], gerando: ['Gerando', 'neutro'], pronto: ['PDF pronto', 'ok'], erro: ['Erro', 'erro'] };

function nomePdf(nomeXml) {
  return nomeXml.replace(/\.xml$/i, '') + '.pdf';
}

function adicionarArquivosDanfse(files) {
  for (const arquivo of files) {
    if (!/\.xml$/i.test(arquivo.name) && !/xml/.test(arquivo.type)) continue;
    const grande = arquivo.size > LIMITE_XML;
    arquivosDanfse.push({ id: proximoId++, arquivo, nome: arquivo.name, estado: grande ? 'erro' : 'pendente', erro: grande ? 'O arquivo passa de 5 MB, o limite do gerador.' : null });
  }
  renderizarDanfse();
}

function liberarPdf(a) {
  if (a.url) URL.revokeObjectURL(a.url);
  a.url = null;
  a.pdf = null;
}

function mostrarPrevia(a) {
  previa.hidden = false;
  previa.src = a.url;
}

function renderizarDanfse() {
  listaDanfse.replaceChildren(
    ...arquivosDanfse.map((a) => {
      const [rotulo, tom] = ESTADOS_DANFSE[a.estado];
      return h(
        'li',
        {},
        h('span', { class: 'nome' }, a.nome, h('span', { class: 'tamanho', text: tamanhoLegivel(a.arquivo.size) })),
        carimbo(rotulo, tom),
        h(
          'span',
          { class: 'links' },
          a.url ? h('button', { type: 'button', onclick: () => mostrarPrevia(a) }, 'Ver') : null,
          a.url ? h('a', { href: a.url, download: nomePdf(a.nome) }, 'Baixar') : null,
          h('button', { type: 'button', onclick: () => { liberarPdf(a); arquivosDanfse = arquivosDanfse.filter((x) => x !== a); renderizarDanfse(); } }, 'Tirar'),
        ),
        a.erro ? h('span', { class: 'detalhe', text: a.erro }) : null,
      );
    }),
  );
  const temPendente = arquivosDanfse.some((a) => a.estado === 'pendente' || (a.estado === 'erro' && a.arquivo.size <= LIMITE_XML));
  $('#btn-danfse-gerar').disabled = !temPendente;
  $('#btn-danfse-zip').disabled = !arquivosDanfse.some((a) => a.estado === 'pronto');
  $('#btn-danfse-limpar').disabled = arquivosDanfse.length === 0;
  if (!arquivosDanfse.some((a) => a.url)) {
    previa.hidden = true;
    previa.removeAttribute('src');
  }
}

const zonaSoltar = $('#danfse-soltar');
$('#danfse-arquivos').addEventListener('change', (ev) => {
  adicionarArquivosDanfse(ev.target.files);
  ev.target.value = '';
});
zonaSoltar.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  zonaSoltar.setAttribute('data-arrastando', '');
});
zonaSoltar.addEventListener('dragleave', () => zonaSoltar.removeAttribute('data-arrastando'));
zonaSoltar.addEventListener('drop', (ev) => {
  ev.preventDefault();
  zonaSoltar.removeAttribute('data-arrastando');
  adicionarArquivosDanfse(ev.dataTransfer.files);
});

function invalidarPdfsGerados() {
  for (const a of arquivosDanfse) {
    if (a.estado === 'pronto') {
      liberarPdf(a);
      a.estado = 'pendente';
    }
  }
  renderizarDanfse();
}
$('#danfse-stc').addEventListener('change', invalidarPdfsGerados);
$('#danfse-canhoto').addEventListener('change', invalidarPdfsGerados);

$('#btn-danfse-gerar').addEventListener('click', async (ev) => {
  const stc = Number($('#danfse-stc').value);
  const canhoto = $('#danfse-canhoto').checked;
  const fila = arquivosDanfse.filter((a) => a.estado === 'pendente' || (a.estado === 'erro' && a.arquivo.size <= LIMITE_XML));
  await comBotaoOcupado(ev.currentTarget, async () => {
    let primeiro = null;
    for (const a of fila) {
      a.estado = 'gerando';
      a.erro = null;
      renderizarDanfse();
      try {
        const pdf = await cliente.danfse.gerar(await a.arquivo.text(), { stc, canhoto });
        a.pdf = pdf;
        a.url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
        a.estado = 'pronto';
        primeiro ??= a;
      } catch (e) {
        a.estado = 'erro';
        a.erro = e.message;
        if (semResposta(e)) {
          for (const resto of fila.filter((x) => x.estado === 'pendente')) resto.erro = 'Não processado: o gerador parou de responder.';
          break;
        }
      }
    }
    if (primeiro) mostrarPrevia(primeiro);
  });
  renderizarDanfse();
});

$('#btn-danfse-zip').addEventListener('click', () => {
  const usados = new Set();
  const zip = criarZip(arquivosDanfse.filter((a) => a.estado === 'pronto').map((a) => ({ nome: nomeUnico(nomePdf(a.nome), usados), dados: a.pdf })));
  baixar(`danfse-${hojeISO()}.zip`, new Blob([zip], { type: 'application/zip' }));
});

$('#btn-danfse-limpar').addEventListener('click', () => {
  arquivosDanfse.forEach(liberarPdf);
  arquivosDanfse = [];
  renderizarDanfse();
});

// ============================================================================ Em lote

const formLote = $('#form-lote');
let loteAtual = null;

$('#btn-modelo').addEventListener('click', () => {
  const tipo = formLote.tipo.value;
  const modelo = MODELOS[tipo];
  baixar(`modelo-${tipo}.csv`, gerarCSV(modelo.exemplo, modelo.colunasEntrada), 'text/csv;charset=utf-8');
});

async function prepararArquivoLote() {
  const arquivo = formLote.arquivo.files[0];
  const previaLote = $('#lote-previa');
  $('#lote-resultado').replaceChildren();
  loteAtual = null;
  $('#btn-lote').disabled = true;
  if (!arquivo) {
    trocar(previaLote, );
    return;
  }
  const tipo = formLote.tipo.value;
  const { linhas, cabecalho } = lerCSV(await arquivo.text());
  const conhecidas = new Set(MODELOS[tipo].colunasEntrada);
  const desconhecidas = cabecalho.filter((c) => c && !conhecidas.has(c));
  if (!linhas.length) {
    trocar(previaLote, mensagem('aviso', 'A planilha está vazia', 'Use a planilha modelo como ponto de partida.'));
    return;
  }
  const preparo = prepararLote(tipo, linhas);
  loteAtual = { tipo, ...preparo, nomeArquivo: arquivo.name };
  const bloqueios = preparo.problemas.filter((p) => !p.aviso);
  trocar(previaLote, 
    mensagem(
      bloqueios.length ? 'aviso' : 'ok',
      `${linhas.length} ${linhas.length === 1 ? 'item' : 'itens'} em ${preparo.operacoes.length} ${preparo.operacoes.length === 1 ? 'operação' : 'operações'}`,
      bloqueios.length ? 'Algumas linhas têm problemas. Dá para processar assim mesmo: a calculadora devolve o erro de cada item.' : 'Tudo pronto para processar.',
    ),
    desconhecidas.length ? mensagem('aviso', 'Colunas que não serão usadas', `${desconhecidas.join(', ')}. Confira se o tipo de cálculo escolhido é o certo.`) : null,
    preparo.problemas.length ? h('ul', { class: 'problemas' }, preparo.problemas.slice(0, 30).map((p) => h('li', { text: `Linha ${p.linha}: ${p.mensagem}` }))) : null,
  );
  $('#btn-lote').disabled = false;
}

formLote.arquivo.addEventListener('change', prepararArquivoLote);
formLote.tipo.addEventListener('change', prepararArquivoLote);

const COLUNAS_PREVIA = {
  simples: [['vBC', 'Base'], ['vIBSSN', 'IBS'], ['vCBSSN', 'CBS'], ['vIS', 'IS'], ['totalItem', 'Total']],
  'regime-geral': [['vBC', 'Base'], ['vCBS', 'CBS'], ['vIBSUF', 'IBS UF'], ['vIBSMun', 'IBS mun.'], ['vIS', 'IS']],
};

formLote.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!loteAtual) return;
  const { tipo, operacoes, nomeArquivo } = loteAtual;
  const progresso = $('#lote-progresso');
  const barra = $('.progresso-barra', progresso);
  const texto = $('.progresso-texto', progresso);
  const saida = $('#lote-resultado');
  progresso.hidden = false;
  barra.style.width = '0';
  texto.textContent = `0 de ${operacoes.length} operações`;
  trocar(saida, );

  await comBotaoOcupado(ev.submitter || $('#btn-lote'), async () => {
    const { linhas, resultados, resumo } = await executarLote(tipo, operacoes, cliente, {
      aoProgredir: (feitas, total) => {
        barra.style.width = `${(feitas / total) * 100}%`;
        texto.textContent = `${feitas} de ${total} operações`;
      },
    });
    const base = nomeArquivo.replace(/\.csv$/i, '');
    const csv = gerarCSV(linhasParaPlanilha(tipo, linhas), MODELOS[tipo].colunasSaida);
    const respostas = resultados.map((r) => ({ operacao: r.chave, requisicao: r.requisicao, resposta: r.resposta ?? null, falha: r.falha ?? null }));
    const servicoFora = resultados.length > 0 && resultados.every((r) => r.semResposta);

    trocar(saida, 
      servicoFora ? mensagem('erro', 'O serviço não respondeu', resultados[0].falha) : null,
      h(
        'div',
        { class: 'resumo-lote' },
        carimbo(`${resumo.calculados} ${resumo.calculados === 1 ? 'calculado' : 'calculados'}`, 'ok'),
        resumo.comErro ? carimbo(`${resumo.comErro} com erro`, 'erro') : null,
        resumo.outros ? carimbo(`${resumo.outros} ${resumo.outros === 1 ? 'não calculado' : 'não calculados'}`, 'aviso') : null,
      ),
      h(
        'div',
        { class: 'acoes' },
        h('button', { type: 'button', class: 'botao botao-principal', onclick: () => baixar(`${base}-resultado.csv`, csv, 'text/csv;charset=utf-8') }, 'Baixar resultado (.csv)'),
        h('button', { type: 'button', class: 'botao', onclick: () => baixar(`${base}-respostas.json`, JSON.stringify(respostas, null, 2), 'application/json') }, 'Baixar respostas completas (.json)'),
      ),
      tabelaLote(tipo, linhas),
    );
  });
  progresso.hidden = true;
});

function tabelaLote(tipo, linhas) {
  const extras = COLUNAS_PREVIA[tipo];
  return h(
    'div',
    {},
    linhas.length > 100 ? h('p', { class: 'nota', text: `Mostrando 100 de ${linhas.length} linhas. O arquivo baixado tem todas.` }) : null,
    h(
      'div',
      { class: 'tabela-rolagem' },
      h(
        'table',
        { class: 'tabela' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Operação' }), h('th', { text: 'Item' }), h('th', { text: 'Situação' }), extras.map(([, r]) => h('th', { class: 'num', text: r })), h('th', { text: 'Erros' }))),
        h(
          'tbody',
          {},
          linhas.slice(0, 100).map((l) =>
            h(
              'tr',
              {},
              h('td', { text: l.operacao }),
              h('td', { text: l.item }),
              h('td', {}, carimboEstado(l.estado)),
              extras.map(([c]) => h('td', { class: 'num', text: l[c] !== undefined ? moeda(l[c]) : '' })),
              h('td', { text: l.erros || '' }),
            ),
          ),
        ),
      ),
    ),
  );
}

// ============================================================================ conta: senha, usuários, sair

async function api(caminho, { metodo = 'GET', corpo } = {}) {
  const r = await fetch(caminho, {
    method: metodo,
    headers: corpo ? { 'content-type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (r.status === 401) location.assign('/login.html');
  if (!r.ok) throw new Error(dados.mensagem || `O painel respondeu com erro ${r.status}.`);
  return dados;
}

function senhaAleatoria() {
  const letras = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/l/I, que se confundem
  return [...crypto.getRandomValues(new Uint32Array(16))].map((n) => letras[n % letras.length]).join('');
}

function abrirDialogo(titulo, conteudo, { obrigatorio = false } = {}) {
  const d = h('dialog', { class: 'dialogo', 'aria-label': titulo },
    h('div', { class: 'dialogo-topo' },
      h('h2', { text: titulo }),
      obrigatorio ? null : h('button', { type: 'button', class: 'botao botao-discreto', onclick: () => d.close() }, 'Fechar'),
    ),
    conteudo,
  );
  if (obrigatorio) d.addEventListener('cancel', (ev) => ev.preventDefault());
  // Se o navegador fechar à força uma janela obrigatória, recarregar abre de novo.
  d.addEventListener('close', () => (obrigatorio ? location.reload() : d.remove()));
  document.body.append(d);
  d.showModal();
  return d;
}

const campoSenha = (rotulo, nome, autocomplete) =>
  h('label', { class: 'campo campo-largo' }, h('span', { text: rotulo }), h('input', { type: 'password', name: nome, autocomplete, required: true }));

function caixaMensagem() {
  return h('div', { class: 'mensagem', role: 'status', hidden: true });
}

function mostrar(caixa, tom, ...conteudo) {
  caixa.className = `mensagem mensagem-${tom}`;
  trocar(caixa, ...conteudo);
  caixa.hidden = false;
}

function dialogoTrocarSenha(obrigatorio) {
  const msg = caixaMensagem();
  const form = h('form', {},
    obrigatorio ? h('p', { class: 'nota', text: 'Você entrou com uma senha provisória. Escolha uma senha sua para continuar.' }) : null,
    h('div', { class: 'ficha' },
      campoSenha('Senha atual', 'atual', 'current-password'),
      campoSenha('Senha nova (12 caracteres ou mais)', 'nova', 'new-password'),
      campoSenha('Repita a senha nova', 'repetida', 'new-password'),
    ),
    msg,
    h('div', { class: 'acoes' }, h('button', { type: 'submit', class: 'botao botao-principal' }, 'Trocar senha')),
  );
  abrirDialogo('Trocar senha', form, { obrigatorio });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const { atual, nova, repetida } = Object.fromEntries(new FormData(form));
    msg.hidden = true;
    try {
      if (nova !== repetida) throw new Error('As duas senhas novas não estão iguais.');
      await comBotaoOcupado(ev.submitter, () => api('/api/senha', { metodo: 'POST', corpo: { atual, nova } }));
      if (obrigatorio) return location.reload();
      form.replaceWith(h('p', { class: 'mensagem mensagem-ok', text: 'Senha trocada. Nos outros aparelhos você vai precisar entrar de novo.' }));
    } catch (e) {
      mostrar(msg, 'erro', e.message);
    }
  });
}

function dialogoUsuarios() {
  const msg = caixaMensagem();
  const lista = h('div', { class: 'tabela-rolagem' }, 'Carregando…');
  const credenciais = (usuario, senha, texto) => [
    h('strong', { text: texto }),
    h('p', {}, 'Mande para a pessoa: usuário ', h('code', { text: usuario }), ' e senha provisória ', h('code', { text: senha }), '.'),
    h('p', { text: 'No primeiro acesso o painel pede para ela trocar a senha.' }),
  ];

  async function carregar() {
    const { admin, usuarios } = await api('/api/usuarios');
    const botao = (texto, fn) => h('button', { type: 'button', class: 'botao botao-discreto', onclick: fn }, texto);
    trocar(lista, h('table', { class: 'tabela' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Usuário' }), h('th', { text: 'Cadastro' }), h('th', { text: 'Situação' }), h('th', {}))),
      h('tbody', {},
        h('tr', {}, h('td', { text: admin }), h('td', { text: '—' }), h('td', { text: 'Administrador (senha no .env)' }), h('td', {})),
        usuarios.map((u) => h('tr', {},
          h('td', { text: u.usuario }),
          h('td', { text: new Date(u.criadoEm).toLocaleDateString('pt-BR') }),
          h('td', {}, carimbo(u.trocarSenha ? 'Senha provisória' : 'Ativo', u.trocarSenha ? 'aviso' : 'ok')),
          h('td', { class: 'acoes-linha' },
            botao('Nova senha', () => novaSenha(u.usuario)),
            botao('Remover', () => remover(u.usuario)),
          ),
        )),
      ),
    ));
  }

  async function novaSenha(usuario) {
    if (!confirm(`Gerar uma senha provisória nova para ${usuario}? A pessoa sai de todos os aparelhos.`)) return;
    const senha = senhaAleatoria();
    try {
      await api(`/api/usuarios/${encodeURIComponent(usuario)}/senha`, { metodo: 'POST', corpo: { senha } });
      mostrar(msg, 'ok', ...credenciais(usuario, senha, `Senha de ${usuario} trocada.`));
      await carregar();
    } catch (e) {
      mostrar(msg, 'erro', e.message);
    }
  }

  async function remover(usuario) {
    if (!confirm(`Remover o acesso de ${usuario}? A pessoa sai na hora e não consegue mais entrar.`)) return;
    try {
      await api(`/api/usuarios/${encodeURIComponent(usuario)}`, { metodo: 'DELETE' });
      mostrar(msg, 'ok', `Acesso de ${usuario} removido.`);
      await carregar();
    } catch (e) {
      mostrar(msg, 'erro', e.message);
    }
  }

  const form = h('form', {},
    h('h3', { class: 'titulo-bloco', text: 'Cadastrar pessoa' }),
    h('div', { class: 'ficha' },
      h('label', { class: 'campo campo-largo' }, h('span', { text: 'Usuário (pode ser o e-mail da pessoa)' }),
        h('input', { name: 'usuario', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true })),
      h('label', { class: 'campo campo-largo' }, h('span', { text: 'Senha provisória' }),
        h('input', { name: 'senha', autocomplete: 'off', spellcheck: 'false', required: true, value: senhaAleatoria() })),
    ),
    h('div', { class: 'acoes' },
      h('button', { type: 'submit', class: 'botao botao-principal' }, 'Cadastrar'),
      h('button', { type: 'button', class: 'botao botao-discreto', onclick: () => { form.elements.senha.value = senhaAleatoria(); } }, 'Gerar outra senha'),
    ),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const { usuario, senha } = Object.fromEntries(new FormData(form));
    try {
      const criado = await comBotaoOcupado(ev.submitter, () => api('/api/usuarios', { metodo: 'POST', corpo: { usuario, senha } }));
      mostrar(msg, 'ok', ...credenciais(criado.usuario, senha, `Conta de ${criado.usuario} criada.`));
      form.reset();
      form.elements.senha.value = senhaAleatoria();
      await carregar();
    } catch (e) {
      mostrar(msg, 'erro', e.message);
    }
  });

  abrirDialogo('Usuários', h('div', {}, msg, lista, form));
  carregar().catch((e) => mostrar(msg, 'erro', e.message));
}

async function iniciarConta() {
  const eu = await api('/api/eu');
  if (eu.aberto) return eu; // painel sem login (uso local)
  const area = $('#conta');
  trocar(area,
    h('span', { class: 'conta-nome' }, 'Entrou como ', h('strong', { text: eu.usuario })),
    eu.admin
      ? h('button', { type: 'button', class: 'botao botao-discreto', onclick: dialogoUsuarios }, 'Usuários')
      : h('button', { type: 'button', class: 'botao botao-discreto', onclick: () => dialogoTrocarSenha(false) }, 'Trocar senha'),
    h('button', {
      type: 'button',
      class: 'botao botao-discreto',
      onclick: async () => {
        await api('/api/sair', { metodo: 'POST' }).catch(() => {});
        location.assign('/login.html');
      },
    }, 'Sair'),
  );
  area.hidden = false;
  if (eu.trocarSenha) dialogoTrocarSenha(true);
  return eu;
}

// ============================================================================ início

adicionarItemSN({ cAtivSN: '01', cClassTrib: '000001' });
adicionarItemRG({ tipoCodigo: 'ncm', cst: '000', cClassTrib: '000001' });
abrirSecao(location.hash.slice(1) || 'simples');
window.addEventListener('hashchange', () => abrirSecao(location.hash.slice(1)));
const conta = await iniciarConta().catch(() => ({}));
// Com senha provisória o servidor recusa as consultas; elas começam depois da troca.
if (!conta.trocarSenha) {
  atualizarStatus().then(carregarAtividadesSN);
  setInterval(() => {
    if (document.visibilityState === 'visible') atualizarStatus();
  }, 30000);
}
