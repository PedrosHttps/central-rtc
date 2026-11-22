// Monitor do administrador: quem está conectado, todas as contas e as tentativas de cadastro.
// Só lê /api/monitor (o servidor recusa quem não é administrador) e se atualiza a cada 20 segundos.
import { h } from './lib/dom.js';

const $ = (sel) => document.querySelector(sel);
const CINCO_MIN = 5 * 60 * 1000;

const quando = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function ha(iso, agora) {
  if (!iso) return '—';
  const min = Math.round((agora - Date.parse(iso)) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 48 * 60) return `há ${Math.round(min / 60)} h`;
  return quando(iso);
}

function aparelho(ua = '') {
  const sistema = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'outro sistema';
  const navegador = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'navegador';
  return `${navegador} no ${sistema}`;
}

const carimbo = (texto, tom) => h('span', { class: 'carimbo', 'data-tom': tom, text: texto });
const STATUS = { ativo: ['Ativa', 'ok'], pendente: ['Em análise', 'aviso'], recusado: ['Recusada', 'erro'] };

function tabela(colunas, linhas, vazio) {
  if (!linhas.length) return h('p', { class: 'nota', text: vazio });
  return h('div', { class: 'tabela-rolagem' },
    h('table', { class: 'tabela' },
      h('thead', {}, h('tr', {}, colunas.map((c) => h('th', { scope: 'col', text: c })))),
      h('tbody', {}, linhas.map((celulas) => h('tr', {}, celulas.map((c) => h('td', {}, c ?? '—'))))),
    ));
}

async function carregar() {
  const r = await fetch('/api/monitor').catch(() => null);
  if (r?.status === 401) return location.assign('/login.html');
  if (r?.status === 403) return location.assign('/');
  if (!r?.ok) {
    $('#erro').textContent = 'O painel não respondeu. Tentando de novo em 20 segundos.';
    $('#erro').hidden = false;
    return;
  }
  $('#erro').hidden = true;
  const { agora: agoraIso, conectados, contas, tentativas } = await r.json();
  const agora = Date.parse(agoraIso);
  const online = (c) => agora - Date.parse(c.vistoEm) < CINCO_MIN;

  $('#resumo').replaceChildren(
    ...[
      ['Online agora', conectados.filter(online).length],
      ['Sessões abertas', conectados.length],
      ['Contas ativas', contas.filter((c) => c.status === 'ativo').length],
      ['Em análise', contas.filter((c) => c.status === 'pendente').length],
      ['Tentativas de cadastro', tentativas.length],
    ].map(([rotulo, valor]) => h('div', {}, h('dt', { text: rotulo }), h('dd', { text: String(valor) }))),
  );

  $('#conectados').replaceChildren(tabela(
    ['Usuário', 'Situação', 'Último uso', 'Entrou em', 'Endereço (IP)', 'Aparelho'],
    conectados.map((c) => [
      c.usuario,
      online(c) ? carimbo('Online', 'ok') : carimbo('Inativo', 'neutro'),
      ha(c.vistoEm, agora),
      quando(c.desde),
      c.ip,
      aparelho(c.aparelho),
    ]),
    'Ninguém conectado agora.',
  ));

  $('#contas').replaceChildren(tabela(
    ['E-mail (usuário)', 'Nome', 'Empresa', 'Situação', 'Criada em', 'Último acesso', 'Decisão'],
    contas.map((c) => {
      const [rotulo, tom] = STATUS[c.status] || [c.status, 'neutro'];
      const decisao = c.decisao ? `${c.decisao.acao === 'aprovar' ? 'Aprovada' : 'Recusada'} por ${c.decisao.por}${c.decisao.observacao ? `: ${c.decisao.observacao}` : ''}` : null;
      return [c.usuario, c.nome, c.empresa, carimbo(rotulo, tom), quando(c.criadoEm), ha(c.ultimoAcesso, agora), decisao];
    }),
    'Nenhuma conta cadastrada.',
  ));

  $('#tentativas').replaceChildren(tabela(
    ['Quando', 'E-mail', 'Nome', 'Empresa', 'Endereço (IP)', 'Resultado'],
    tentativas.map((t) => [
      quando(t.em), t.email, t.nome, t.empresa, t.ip,
      carimbo(t.resultado, t.resultado.startsWith('Conta criada') ? 'ok' : 'aviso'),
    ]),
    'Nenhuma tentativa desde que o painel ligou.',
  ));

  $('#atualizado').textContent = `Atualizado às ${new Date(agora).toLocaleTimeString('pt-BR', { timeStyle: 'short' })}`;
}

$('#btn-atualizar').addEventListener('click', carregar);
setInterval(() => document.visibilityState === 'visible' && carregar(), 20000);
carregar();
