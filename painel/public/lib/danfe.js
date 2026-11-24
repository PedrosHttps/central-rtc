// DANFE da NF-e (modelo 55): lê o XML e monta o código de barras da chave. Não precisa de certificado:
// o DANFE é só a versão impressa de uma nota que a Sefaz já autorizou. Sem DOMParser, para rodar também no Node.

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodificar = (s) =>
  s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] !== '#' ? (ENTIDADES[e] ?? m) : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

/** XML -> árvore { nome, atributos, filhos, texto }. Cobre o que a NF-e usa: prefixo de namespace some, CDATA vira texto. */
export function lerXML(xml) {
  const raiz = { nome: '', atributos: {}, filhos: [], texto: '' };
  const pilha = [raiz];
  const marcas = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|</g;
  for (const m of xml.matchAll(marcas)) {
    const atual = pilha.at(-1);
    if (m[1] !== undefined) atual.texto += m[1];
    else if (m[6] !== undefined) atual.texto += decodificar(m[6]);
    else if (m[0] === '<') throw new Error('O arquivo não é um XML válido.');
    else if (m[3]) {
      const nome = m[3].replace(/^.*:/, '');
      if (m[2]) {
        if (pilha.length === 1 || atual.nome !== nome) throw new Error('O arquivo não é um XML válido.');
        pilha.pop();
        continue;
      }
      const no = { nome, atributos: {}, filhos: [], texto: '' };
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) no.atributos[a[1]] = decodificar(a[2] ?? a[3]);
      atual.filhos.push(no);
      if (!m[5]) pilha.push(no);
    }
  }
  if (pilha.length !== 1 || !raiz.filhos.length) throw new Error('O arquivo não é um XML válido.');
  return raiz;
}

/** Primeiro descendente com esse nome, em profundidade. */
export function busca(no, nome) {
  for (const f of no?.filhos ?? []) {
    if (f.nome === nome) return f;
    const achado = busca(f, nome);
    if (achado) return achado;
  }
  return null;
}

export const filho = (no, nome) => no?.filhos.find((f) => f.nome === nome) ?? null;
export const filhos = (no, nome) => no?.filhos.filter((f) => f.nome === nome) ?? [];

/** Texto do caminho de filhos: v(emit, 'enderEmit', 'xMun'). Vazio quando falta. */
export function v(no, ...caminho) {
  for (const nome of caminho) no = filho(no, nome);
  return no ? no.texto.trim() : '';
}

/** Os grupos da NF-e que o DANFE mostra, ou um erro que diz o que há de errado com o arquivo. */
export function lerNFe(xml) {
  const doc = lerXML(xml);
  const inf = busca(doc, 'infNFe');
  if (!inf) {
    if (busca(doc, 'infNFSe') || busca(doc, 'infDPS')) throw new Error('Este XML é de NFS-e: use a seção DANFSe.');
    throw new Error('Não achei uma NF-e neste XML (falta o grupo infNFe).');
  }
  const ide = filho(inf, 'ide');
  if (v(ide, 'mod') === '65') throw new Error('Este XML é de NFC-e (modelo 65), que tem outro DANFE, com QR Code. Aqui só entra NF-e modelo 55.');
  const prot = busca(doc, 'infProt');
  const chave = v(prot, 'chNFe') || (inf.atributos.Id || '').replace(/^NFe/, '');
  if (!/^\d{44}$/.test(chave)) throw new Error('A chave de acesso da nota não tem 44 dígitos.');
  return {
    chave,
    ide,
    emit: filho(inf, 'emit'),
    dest: filho(inf, 'dest'),
    det: filhos(inf, 'det'),
    total: filho(inf, 'total'),
    transp: filho(inf, 'transp'),
    cobr: filho(inf, 'cobr'),
    infAdic: filho(inf, 'infAdic'),
    // Só o protocolo com cStat 100 (ou 150, fora do prazo) é autorização de uso.
    prot: ['100', '150'].includes(v(prot, 'cStat')) ? prot : null,
    homologacao: v(ide, 'tpAmb') === '2',
  };
}

// Larguras (barra, espaço, barra...) dos 107 símbolos do Code 128; o último é o de parada.
const PADROES = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
  '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 ' +
  '232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 ' +
  '313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 ' +
  '111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 ' +
  '114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'
).split(' ');

/** Code 128C, o código de barras da chave de acesso no DANFE: larguras alternadas, começando por barra. */
export function code128C(digitos) {
  if (!/^(\d\d)+$/.test(digitos)) throw new Error('O Code 128C precisa de um número par de dígitos.');
  const valores = [105, ...digitos.match(/\d\d/g).map(Number)];
  const soma = valores.reduce((s, valor, i) => s + valor * (i || 1), 0);
  return [...valores, soma % 103, 106].map((valor) => PADROES[valor]).join('');
}
