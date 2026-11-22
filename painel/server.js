// Painel da Central RTC: serve a interface e repassa as chamadas para os três serviços da Receita.
// Sem dependências: precisa só do Node 22 ou mais novo.

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORTA = Number(process.env.PORTA || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const LIMITE_CORPO = 6 * 1024 * 1024; // o DANFSe aceita XML de até 5 MiB

// Login opcional (janela de usuário e senha do navegador). Sem as duas variáveis o painel fica aberto, como no uso local.
const USUARIO = process.env.PAINEL_USUARIO || '';
const SENHA = process.env.PAINEL_SENHA || '';
if (!USUARIO !== !SENHA) throw new Error('Defina PAINEL_USUARIO e PAINEL_SENHA juntos.');
if (SENHA && SENHA.length < 12) throw new Error('PAINEL_SENHA precisa ter pelo menos 12 caracteres.');
const resumo = (texto) => createHash('sha256').update(texto).digest();
const CREDENCIAL = resumo(`${USUARIO}:${SENHA}`);

function autorizado(req) {
  if (!SENHA) return true;
  const [tipo, valor] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Basic' || !valor) return false;
  // Compara os resumos em tempo constante: não revela quantos caracteres acertou.
  return timingSafeEqual(resumo(Buffer.from(valor, 'base64').toString()), CREDENCIAL);
}

const SERVICOS = {
  rg: {
    nome: 'Regime geral (CBS, IBS e IS)',
    url: (process.env.RG_URL || 'http://localhost:8080/api').replace(/\/$/, ''),
    saude: '/calculadora/dados-abertos/versao',
  },
  sn: {
    nome: 'Simples Nacional',
    url: (process.env.SN_URL || 'http://localhost:8082/api').replace(/\/$/, ''),
    saude: '/versao',
  },
  danfse: {
    nome: 'Gerador de DANFSe',
    url: (process.env.DANFSE_URL || 'http://localhost:8081').replace(/\/$/, ''),
    saude: '/health/ready',
  },
};

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

const HEADERS_REPASSADOS = ['content-type', 'content-disposition', 'x-warning-dados-simulados', 'x-servico-simulado'];

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    // shortcut: acima do limite o resto é lido e descartado (sem destruir a conexão) para o navegador receber o 413; só quem passou do login chega aqui
    req.on('data', (p) => {
      total += p.length;
      if (total <= LIMITE_CORPO) partes.push(p);
    });
    req.on('end', () =>
      total > LIMITE_CORPO
        ? reject(Object.assign(new Error('Arquivo maior que o limite de 6 MB.'), { status: 413 }))
        : resolve(Buffer.concat(partes)),
    );
    req.on('error', reject);
  });
}

function responderJson(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

async function repassar(req, res, chave, resto) {
  const servico = SERVICOS[chave];
  const destino = `${servico.url}${resto}`;
  const metodo = req.method;
  if (!['GET', 'POST'].includes(metodo)) return responderJson(res, 405, { mensagem: 'Use GET ou POST.' });

  const corpo = metodo === 'POST' ? await lerCorpo(req) : undefined;
  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers.accept) headers.accept = req.headers.accept;

  let resposta;
  try {
    resposta = await fetch(destino, { method: metodo, headers, body: corpo, signal: AbortSignal.timeout(120000) });
  } catch {
    return responderJson(res, 502, {
      mensagem: `O serviço ${servico.nome} não está respondendo em ${servico.url}. Confira se ele está rodando.`,
    });
  }

  const saida = { 'Cache-Control': 'no-store' };
  for (const h of HEADERS_REPASSADOS) {
    const v = resposta.headers.get(h);
    if (v) saida[h] = v;
  }
  const dados = Buffer.from(await resposta.arrayBuffer());
  res.writeHead(resposta.status, saida);
  res.end(dados);
}

async function verificarServico(chave) {
  const s = SERVICOS[chave];
  try {
    const r = await fetch(`${s.url}${s.saude}`, { signal: AbortSignal.timeout(3500) });
    const tipo = r.headers.get('content-type') || '';
    const dados = tipo.includes('json') ? await r.json().catch(() => null) : null;
    return {
      nome: s.nome,
      url: s.url,
      online: r.ok,
      simulado: r.headers.get('x-servico-simulado') === 'true',
      versao: dados?.versaoApp || dados?.versao || dados?.app?.versao || null,
    };
  } catch {
    return { nome: s.nome, url: s.url, online: false };
  }
}

async function servirArquivo(res, caminhoUrl) {
  const relativo = decodeURIComponent(caminhoUrl === '/' ? '/index.html' : caminhoUrl);
  const alvo = path.normalize(path.join(RAIZ, relativo));
  if (!alvo.startsWith(RAIZ + path.sep)) return responderJson(res, 403, { mensagem: 'Caminho inválido.' });
  try {
    const dados = await readFile(alvo);
    const ext = path.extname(alvo).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TIPOS[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=604800' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(dados);
  } catch {
    responderJson(res, 404, { mensagem: 'Não encontrado.' });
  }
}

const servidor = http.createServer(async (req, res) => {
  try {
    if (!autorizado(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Central RTC", charset="UTF-8"', 'Cache-Control': 'no-store' });
      return res.end('Login necessário.');
    }
    const url = new URL(req.url, 'http://local');
    const m = url.pathname.match(/^\/svc\/(rg|sn|danfse)(\/.*)?$/);
    if (m) return await repassar(req, res, m[1], (m[2] || '') + url.search);

    if (url.pathname === '/status') {
      const [rg, sn, danfse] = await Promise.all(['rg', 'sn', 'danfse'].map(verificarServico));
      return responderJson(res, 200, { rg, sn, danfse, verificadoEm: new Date().toISOString() });
    }

    if (req.method !== 'GET') return responderJson(res, 405, { mensagem: 'Método não permitido.' });
    return await servirArquivo(res, url.pathname);
  } catch (e) {
    responderJson(res, e.status || 500, { mensagem: e.status ? e.message : 'Erro interno do painel.' });
  }
});

servidor.listen(PORTA, HOST, () => {
  console.log(`Central RTC no ar: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORTA}${SENHA ? ' (com login)' : ''}`);
  for (const s of Object.values(SERVICOS)) console.log(`  · ${s.nome}: ${s.url}`);
});
