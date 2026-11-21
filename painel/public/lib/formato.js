// Conversões de números e datas entre o jeito brasileiro de digitar e o formato das APIs.

/**
 * "1.234,56" -> "1234.56"; "1234.56" -> "1234.56"; "R$ 10" -> "10"; "" -> null.
 * Se não der para interpretar, devolve o texto original (a API acusa o erro com o código certo).
 */
export function decimal(valor) {
  if (valor === null || valor === undefined) return null;
  let s = String(valor).trim().replace(/R\$|\s|%/g, '');
  if (s === '') return null;
  if (s.includes(',') && s.includes('.')) {
    // o separador que vem por último é o decimal: "1.234,56" ou "1,234.56"
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  } else if (/^-?[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // "1.200" é mil e duzentos, não 1,2
  }
  return /^-?\d+(\.\d+)?$/.test(s) ? s : String(valor).trim();
}

/** Igual a `decimal`, mas devolve número (para APIs que recebem BigDecimal) ou o texto original se for inválido. */
export function numero(valor) {
  const d = decimal(valor);
  if (d === null) return null;
  return /^-?\d+(\.\d+)?$/.test(d) ? Number(d) : d;
}

export function inteiro(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const s = String(valor).trim();
  return /^\d+$/.test(s) ? Number(s) : s;
}

/** Deslocamento de fuso no formato "-04:00" para uma data (usa o fuso da máquina). */
export function deslocamentoFuso(data = new Date()) {
  const min = -data.getTimezoneOffset();
  const sinal = min >= 0 ? '+' : '-';
  const abs = Math.abs(min);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sinal}${hh}:${mm}`;
}

/** "10/03/2027" ou "2027-03-10" -> "2027-03-10". Devolve o texto original se não reconhecer. */
export function dataISO(valor) {
  if (!valor) return null;
  const s = String(valor).trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return s;
}

/**
 * Aceita data e hora com fuso (ISO completo), sem fuso, ou só a data.
 * Sem hora, usa 12:00; sem fuso, usa o da máquina.
 */
export function dataHoraISO(valor, fuso) {
  if (!valor) return null;
  const s = String(valor).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/.test(s)) return s;
  let m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/);
  if (m) return `${m[1]}T${m[2]}${m[3] ?? ':00'}${fuso ?? deslocamentoFuso(new Date(`${m[1]}T${m[2]}`))}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}:\d{2})(:\d{2})?)?$/);
  if (m) {
    const data = `${m[3]}-${m[2]}-${m[1]}`;
    const hora = m[4] ?? '12:00';
    return `${data}T${hora}${m[5] ?? ':00'}${fuso ?? deslocamentoFuso(new Date(`${data}T${hora}`))}`;
  }
  m = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (m) return `${m[1]}T12:00:00${fuso ?? deslocamentoFuso(new Date(`${m[1]}T12:00`))}`;
  return s;
}

/**
 * "1234.50" -> "1234,50" (para CSV que abre no Excel em português). Texto numérico mantém as casas
 * que a API devolveu; número recebe `casas` casas. Valores não numéricos passam direto.
 */
export function decimalBR(valor, casas = 2) {
  if (valor === null || valor === undefined || valor === '') return '';
  if (typeof valor === 'string' && /^-?\d+(\.\d+)?$/.test(valor)) return valor.replace('.', ',');
  const n = Number(valor);
  if (!Number.isFinite(n)) return String(valor);
  const texto = String(n);
  const decimais = (texto.split('.')[1] || '').length;
  return (decimais > casas ? texto : n.toFixed(casas)).replace('.', ','); // nunca corta casas que a API mandou
}

const MOEDA = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const PERCENTUAL = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function moeda(valor) {
  if (valor === null || valor === undefined || valor === '') return '—';
  const n = Number(valor);
  return Number.isFinite(n) ? MOEDA.format(n) : String(valor);
}

export function percentual(valor) {
  if (valor === null || valor === undefined || valor === '') return '—';
  const n = Number(valor);
  return Number.isFinite(n) ? `${PERCENTUAL.format(n)}%` : String(valor);
}
