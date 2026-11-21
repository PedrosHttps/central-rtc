// Gerador de ZIP mínimo (sem compressão), suficiente para juntar PDFs e CSVs.
// Funciona no navegador e no Node. Nomes em UTF-8.

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dataDOS(d) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dia = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, dia };
}

/**
 * @param {{nome: string, dados: Uint8Array | string}[]} arquivos
 * @returns {Uint8Array}
 */
export function criarZip(arquivos, agora = new Date()) {
  const enc = new TextEncoder();
  const { hora, dia } = dataDOS(agora);
  const locais = [];
  const centrais = [];
  let deslocamento = 0;

  for (const arq of arquivos) {
    const nome = enc.encode(arq.nome);
    const dados = typeof arq.dados === 'string' ? enc.encode(arq.dados) : arq.dados;
    const crc = crc32(dados);

    const local = new Uint8Array(30 + nome.length);
    const vl = new DataView(local.buffer);
    vl.setUint32(0, 0x04034b50, true);
    vl.setUint16(4, 20, true);
    vl.setUint16(6, 0x0800, true); // nome em UTF-8
    vl.setUint16(8, 0, true); // sem compressão
    vl.setUint16(10, hora, true);
    vl.setUint16(12, dia, true);
    vl.setUint32(14, crc, true);
    vl.setUint32(18, dados.length, true);
    vl.setUint32(22, dados.length, true);
    vl.setUint16(26, nome.length, true);
    vl.setUint16(28, 0, true);
    local.set(nome, 30);
    locais.push(local, dados);

    const central = new Uint8Array(46 + nome.length);
    const vc = new DataView(central.buffer);
    vc.setUint32(0, 0x02014b50, true);
    vc.setUint16(4, 20, true);
    vc.setUint16(6, 20, true);
    vc.setUint16(8, 0x0800, true);
    vc.setUint16(10, 0, true);
    vc.setUint16(12, hora, true);
    vc.setUint16(14, dia, true);
    vc.setUint32(16, crc, true);
    vc.setUint32(20, dados.length, true);
    vc.setUint32(24, dados.length, true);
    vc.setUint16(28, nome.length, true);
    vc.setUint32(42, deslocamento, true);
    central.set(nome, 46);
    centrais.push(central);

    deslocamento += local.length + dados.length;
  }

  const tamanhoCentral = centrais.reduce((s, c) => s + c.length, 0);
  const fim = new Uint8Array(22);
  const vf = new DataView(fim.buffer);
  vf.setUint32(0, 0x06054b50, true);
  vf.setUint16(8, arquivos.length, true);
  vf.setUint16(10, arquivos.length, true);
  vf.setUint32(12, tamanhoCentral, true);
  vf.setUint32(16, deslocamento, true);

  const partes = [...locais, ...centrais, fim];
  const total = partes.reduce((s, p) => s + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    saida.set(p, pos);
    pos += p.length;
  }
  return saida;
}

/** Evita nomes repetidos dentro do mesmo ZIP: "nota.pdf", "nota (2).pdf"... */
export function nomeUnico(nome, usados) {
  if (!usados.has(nome)) {
    usados.add(nome);
    return nome;
  }
  const ponto = nome.lastIndexOf('.');
  const base = ponto > 0 ? nome.slice(0, ponto) : nome;
  const ext = ponto > 0 ? nome.slice(ponto) : '';
  let i = 2;
  while (usados.has(`${base} (${i})${ext}`)) i++;
  const novo = `${base} (${i})${ext}`;
  usados.add(novo);
  return novo;
}
