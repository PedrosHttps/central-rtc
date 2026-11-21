// Leitura e escrita de CSV sem dependências. Funciona no navegador e no Node.
// Aceita ";" (padrão do Excel em português), "," ou tabulação como separador.

const SEPARADORES = [';', ',', '\t'];

export function detectarSeparador(primeiraLinha) {
  let melhor = ';';
  let maior = -1;
  for (const sep of SEPARADORES) {
    let total = 0;
    let dentroDeAspas = false;
    for (const ch of primeiraLinha) {
      if (ch === '"') dentroDeAspas = !dentroDeAspas;
      else if (ch === sep && !dentroDeAspas) total++;
    }
    if (total > maior) {
      maior = total;
      melhor = sep;
    }
  }
  return melhor;
}

function quebrarEmCampos(texto, sep) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentroDeAspas = false;

  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (dentroDeAspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          dentroDeAspas = false;
        }
      } else {
        campo += ch;
      }
      continue;
    }
    if (ch === '"') {
      dentroDeAspas = true;
    } else if (ch === sep) {
      linha.push(campo);
      campo = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = '';
    } else {
      campo += ch;
    }
  }
  if (campo !== '' || linha.length > 0) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas;
}

/**
 * Converte o texto de um CSV em objetos, usando a primeira linha como cabeçalho.
 * Cada objeto recebe `_linha` com o número da linha no arquivo (1 = cabeçalho).
 */
export function lerCSV(texto) {
  const limpo = String(texto).replace(/^﻿/, '');
  const primeira = limpo.split(/\r?\n/, 1)[0] ?? '';
  const separador = detectarSeparador(primeira);
  const brutas = quebrarEmCampos(limpo, separador);
  if (brutas.length === 0) return { cabecalho: [], linhas: [], separador };

  const cabecalho = brutas[0].map((c) => c.trim());
  const linhas = [];
  for (let i = 1; i < brutas.length; i++) {
    const valores = brutas[i];
    if (valores.every((v) => v.trim() === '')) continue;
    const obj = { _linha: i + 1 };
    cabecalho.forEach((nome, j) => {
      if (nome) obj[nome] = (valores[j] ?? '').trim();
    });
    linhas.push(obj);
  }
  return { cabecalho, linhas, separador };
}

function escaparCampo(valor, sep) {
  if (valor === null || valor === undefined) return '';
  const s = String(valor);
  if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Gera o texto de um CSV a partir de objetos. Por padrão usa ";" e BOM, para abrir certo no Excel. */
export function gerarCSV(linhas, colunas, { separador = ';', bom = true } = {}) {
  const partes = [colunas.map((c) => escaparCampo(c, separador)).join(separador)];
  for (const linha of linhas) {
    partes.push(colunas.map((c) => escaparCampo(linha[c], separador)).join(separador));
  }
  return (bom ? '﻿' : '') + partes.join('\r\n') + '\r\n';
}
