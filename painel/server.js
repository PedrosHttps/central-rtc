// Painel da Central RTC: serve a interface e repassa as chamadas para os três serviços da Receita.
// Sem dependências: precisa só do Node 22 ou mais novo.

import http from 'node:http';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(PASTA, 'public');
const PORTA = Number(process.env.PORTA || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const LIMITE_CORPO = 6 * 1024 * 1024; // o DANFSe aceita XML de até 5 MiB

// ============================================================================ contas

// Com PAINEL_USUARIO + PAINEL_SENHA o painel exige login. Essa conta é a do administrador, que cadastra as outras.
// Sem as duas variáveis o painel fica aberto, como no uso local.
const ADMIN = (process.env.PAINEL_USUARIO || '').trim().toLowerCase();
const SENHA_ADMIN = process.env.PAINEL_SENHA || '';
const EMAIL_ACESSO = process.env.PAINEL_EMAIL_ACESSO || '';
const ARQUIVO_USUARIOS = path.join(process.env.PAINEL_DADOS || path.join(PASTA, 'dados'), 'usuarios.json');
const COM_LOGIN = Boolean(SENHA_ADMIN);
const SENHA_MIN = 12;
const NOME_VALIDO = /^[a-z0-9.@-]{3,64}$/;

if (!ADMIN !== !SENHA_ADMIN) throw new Error('Defina PAINEL_USUARIO e PAINEL_SENHA juntos.');
if (ADMIN && !NOME_VALIDO.test(ADMIN)) throw new Error('PAINEL_USUARIO: use de 3 a 64 letras minúsculas, números, ponto, hífen ou @.');
if (SENHA_ADMIN && SENHA_ADMIN.length < SENHA_MIN) throw new Error(`PAINEL_SENHA precisa ter pelo menos ${SENHA_MIN} caracteres.`);

const scrypt = promisify(scryptCb);
const resumo = (texto) => createHash('sha256').update(texto).digest();

async function gerarHash(senha) {
  const sal = randomBytes(16);
  return { sal: sal.toString('hex'), hash: (await scrypt(senha, sal, 64)).toString('hex') };
}

async function senhaConfere(senha, registro) {
  const calculado = await scrypt(senha, Buffer.from(registro.sal, 'hex'), 64);
  return timingSafeEqual(calculado, Buffer.from(registro.hash, 'hex'));
}

const REGISTRO_ADMIN = COM_LOGIN ? await gerarHash(SENHA_ADMIN) : null;
// Usuário inexistente também passa pelo scrypt, para a resposta não demorar menos e revelar quais nomes existem.
const REGISTRO_FALSO = await gerarHash(randomBytes(16).toString('hex'));

function lerUsuarios() {
  try {
    return JSON.parse(readFileSync(ARQUIVO_USUARIOS, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e; // arquivo corrompido: melhor não subir do que apagar as contas
  }
}

// nome → { sal, hash, trocarSenha, criadoEm }. Sem protótipo: um nome como "constructor" não vira outra coisa.
const usuarios = Object.assign(Object.create(null), COM_LOGIN ? lerUsuarios() : {});

function salvarUsuarios() {
  mkdirSync(path.dirname(ARQUIVO_USUARIOS), { recursive: true });
  const temporario = `${ARQUIVO_USUARIOS}.tmp`;
  writeFileSync(temporario, JSON.stringify(usuarios, null, 2), { mode: 0o600 });
  renameSync(temporario, ARQUIVO_USUARIOS); // troca de uma vez: uma queda no meio não corrompe o arquivo
}

const registroDe = (nome) => (nome === ADMIN ? REGISTRO_ADMIN : usuarios[nome]);

// shortcut: sessões só na memória; reiniciar o painel pede login de novo a todos, ok para poucos usuários
const SESSAO_MS = 12 * 60 * 60 * 1000;
const sessoes = new Map(); // token → { nome, expira }

function criarSessao(nome) {
  const agora = Date.now();
  for (const [t, s] of sessoes) if (s.expira < agora) sessoes.delete(t);
  const token = randomBytes(32).toString('base64url');
  sessoes.set(token, { nome, expira: agora + SESSAO_MS });
  return token;
}

function sessaoDe(req) {
  const token = /(?:^|;\s*)sessao=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  const s = token && sessoes.get(token);
  if (!s) return null;
  if (s.expira < Date.now() || !registroDe(s.nome)) {
    sessoes.delete(token);
    return null;
  }
  return { token, nome: s.nome, admin: s.nome === ADMIN, trocarSenha: Boolean(usuarios[s.nome]?.trocarSenha) };
}

function encerrarSessoesDe(nome, exceto) {
  for (const [t, s] of sessoes) if (s.nome === nome && t !== exceto) sessoes.delete(t);
}

function cookieSessao(req, token, segundos) {
  // Secure só fora do localhost: no acesso local o painel é http e o navegador recusaria o cookie.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');
  return `sessao=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${segundos}${local ? '' : '; Secure'}`;
}

// ---------------------------------------------------------------- bloqueio de quem erra a senha

// Depois de 10 senhas erradas em 15 minutos, aquele endereço não consegue mais entrar até a janela acabar.
const MAX_FALHAS = 10;
const JANELA_MS = 15 * 60 * 1000;
const falhas = new Map(); // endereço → { n, desde, ultima }

// IPv6 conta pelo bloco /64 (os 4 primeiros grupos): um único cliente costuma receber o bloco inteiro.
function chaveDoIp(ip) {
  if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip;
  const [esq, dir = ''] = ip.split('%')[0].split('::');
  const a = esq ? esq.split(':') : [];
  const b = dir ? dir.split(':') : [];
  const grupos = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return `${grupos.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// Atrás do Tailscale e do Docker o IP real vem no último item do X-Forwarded-For (o que o proxy acrescentou).
const ipDe = (req) => chaveDoIp((req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '');

function bloqueado(ip) {
  const f = falhas.get(ip);
  return Boolean(f) && f.n >= MAX_FALHAS && Date.now() - f.desde < JANELA_MS;
}

function registrarFalha(ip, tentativa) {
  const marca = resumo(tentativa).toString('hex');
  const f = falhas.get(ip);
  if (f && Date.now() - f.desde < JANELA_MS) {
    // A mesma tentativa repetida não conta: é alguém reenviando, não adivinhando.
    if (f.ultima !== marca) f.n++;
    f.ultima = marca;
  } else falhas.set(ip, { n: 1, desde: Date.now(), ultima: marca });
  if (falhas.size > 10000) falhas.clear(); // shortcut: zera tudo se encher, ok para um painel de poucos usuários
}

// ---------------------------------------------------------------- rotas de conta

const erro = (status, mensagem) => Object.assign(new Error(mensagem), { status });

async function lerJson(req) {
  try {
    return JSON.parse((await lerCorpo(req)).toString('utf8') || '{}');
  } catch (e) {
    throw e.status ? e : erro(400, 'Corpo da requisição inválido.');
  }
}

function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < SENHA_MIN) throw erro(400, `A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`);
  if (senha.length > 200) throw erro(400, 'A senha pode ter no máximo 200 caracteres.');
}

async function entrar(req, res, ip) {
  if (bloqueado(ip)) {
    res.setHeader('Retry-After', String(JANELA_MS / 1000));
    throw erro(429, 'Muitas senhas erradas. Espere 15 minutos e tente de novo.');
  }
  const { usuario, senha } = await lerJson(req);
  const nome = String(usuario || '').trim().toLowerCase();
  const registro = registroDe(nome);
  const confere = await senhaConfere(String(senha || ''), registro || REGISTRO_FALSO);
  if (!registro || !confere) {
    registrarFalha(ip, `${nome}:${senha}`);
    throw erro(401, 'Usuário ou senha incorretos.');
  }
  falhas.delete(ip);
  res.setHeader('Set-Cookie', cookieSessao(req, criarSessao(nome), SESSAO_MS / 1000));
  return responderJson(res, 200, { usuario: nome, admin: nome === ADMIN, trocarSenha: Boolean(usuarios[nome]?.trocarSenha) });
}

async function trocarSenha(req, res, sessao, ip) {
  if (sessao.admin) throw erro(400, 'A senha do administrador fica no arquivo .env do servidor.');
  if (bloqueado(ip)) throw erro(429, 'Muitas senhas erradas. Espere 15 minutos e tente de novo.');
  const { atual, nova } = await lerJson(req);
  if (!(await senhaConfere(String(atual || ''), usuarios[sessao.nome]))) {
    registrarFalha(ip, `${sessao.nome}:${atual}`);
    throw erro(403, 'A senha atual está errada.');
  }
  validarSenha(nova);
  if (nova === atual) throw erro(400, 'A senha nova precisa ser diferente da atual.');
  usuarios[sessao.nome] = { ...usuarios[sessao.nome], ...(await gerarHash(nova)), trocarSenha: false };
  salvarUsuarios();
  encerrarSessoesDe(sessao.nome, sessao.token); // derruba a conta em outros aparelhos
  return responderJson(res, 200, { mensagem: 'Senha trocada.' });
}

async function rotasDeUsuarios(req, res, caminho) {
  if (caminho === '/api/usuarios' && req.method === 'GET') {
    const lista = Object.entries(usuarios)
      .map(([usuario, u]) => ({ usuario, criadoEm: u.criadoEm, trocarSenha: Boolean(u.trocarSenha) }))
      .sort((a, b) => a.usuario.localeCompare(b.usuario));
    return responderJson(res, 200, { admin: ADMIN, usuarios: lista });
  }
  if (caminho === '/api/usuarios' && req.method === 'POST') {
    const { usuario, senha } = await lerJson(req);
    const nome = String(usuario || '').trim().toLowerCase();
    if (!NOME_VALIDO.test(nome)) throw erro(400, 'Usuário: use de 3 a 64 letras minúsculas, números, ponto, hífen ou @.');
    if (registroDe(nome)) throw erro(409, `O usuário ${nome} já existe.`);
    validarSenha(senha);
    usuarios[nome] = { ...(await gerarHash(senha)), trocarSenha: true, criadoEm: new Date().toISOString() };
    salvarUsuarios();
    return responderJson(res, 201, { usuario: nome });
  }
  const m = caminho.match(/^\/api\/usuarios\/([^/]+)(\/senha)?$/);
  const nome = m && decodeURIComponent(m[1]);
  if (!m || !usuarios[nome]) throw erro(404, 'Usuário não encontrado.');
  if (m[2] && req.method === 'POST') {
    const { senha } = await lerJson(req);
    validarSenha(senha);
    usuarios[nome] = { ...usuarios[nome], ...(await gerarHash(senha)), trocarSenha: true };
    salvarUsuarios();
    encerrarSessoesDe(nome);
    return responderJson(res, 200, { usuario: nome });
  }
  if (!m[2] && req.method === 'DELETE') {
    delete usuarios[nome];
    salvarUsuarios();
    encerrarSessoesDe(nome);
    return responderJson(res, 200, { usuario: nome });
  }
  throw erro(405, 'Método não permitido.');
}

// Arquivos que a tela de login precisa antes de alguém entrar.
const PUBLICOS = /^\/(login\.html|login\.js|styles\.css|fontes\/[\w.-]+)$/;

// Responde as rotas de conta e barra quem não entrou. Devolve a sessão quando a requisição pode seguir.
async function controlarAcesso(req, res, caminho) {
  if (!COM_LOGIN) {
    if (caminho === '/api/eu') return responderJson(res, 200, { aberto: true });
    return caminho.startsWith('/api/') ? responderJson(res, 404, { mensagem: 'Não encontrado.' }) : true;
  }
  const ip = ipDe(req);
  if (caminho === '/api/acesso' && req.method === 'GET') return responderJson(res, 200, { email: EMAIL_ACESSO || null });
  if (caminho === '/api/entrar' && req.method === 'POST') return entrar(req, res, ip);
  if (PUBLICOS.test(caminho) && req.method === 'GET') return true;

  const sessao = sessaoDe(req);
  if (!sessao) {
    if (req.method === 'GET' && (caminho === '/' || caminho.endsWith('.html'))) {
      res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return responderJson(res, 401, { mensagem: 'Sua sessão acabou. Entre de novo.' });
  }

  if (caminho === '/api/sair' && req.method === 'POST') {
    sessoes.delete(sessao.token);
    res.setHeader('Set-Cookie', cookieSessao(req, '', 0));
    return responderJson(res, 200, { mensagem: 'Até logo.' });
  }
  if (caminho === '/api/eu' && req.method === 'GET') {
    return responderJson(res, 200, { usuario: sessao.nome, admin: sessao.admin, trocarSenha: sessao.trocarSenha });
  }
  if (caminho === '/api/senha' && req.method === 'POST') return trocarSenha(req, res, sessao, ip);
  // Com senha provisória só dá para carregar a interface e trocar a senha.
  if (sessao.trocarSenha && (caminho.startsWith('/api/') || caminho.startsWith('/svc/') || caminho === '/status')) {
    throw erro(403, 'Troque a senha provisória antes de continuar.');
  }
  if (caminho === '/api/usuarios' || caminho.startsWith('/api/usuarios/')) {
    if (!sessao.admin) throw erro(403, 'Só o administrador cadastra usuários.');
    return rotasDeUsuarios(req, res, caminho);
  }
  if (caminho.startsWith('/api/')) throw erro(404, 'Não encontrado.');
  return true;
}

// ============================================================================ serviços e arquivos

const SEGURANCA = {
  // Só carrega o que vem do próprio painel; blob: é a prévia do PDF; ninguém pode embutir o painel em outro site.
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; frame-src blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
};

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
    // shortcut: acima do limite o resto é lido e descartado (sem destruir a conexão) para o navegador receber o 413
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

// Os arquivos da interface ficam na memória já comprimidos; se mudarem no disco, são lidos de novo.
const COMPRIMIVEIS = new Set(['.html', '.js', '.css', '.json', '.csv', '.svg', '.txt']);
const cacheArquivos = new Map(); // caminho → { mtime, etag, dados, br, gzip }

async function lerArquivo(alvo, ext) {
  const { mtimeMs } = await stat(alvo);
  const salvo = cacheArquivos.get(alvo);
  if (salvo?.mtime === mtimeMs) return salvo;
  const dados = await readFile(alvo);
  const texto = COMPRIMIVEIS.has(ext);
  const arquivo = {
    mtime: mtimeMs,
    etag: `W/"${createHash('sha1').update(dados).digest('base64url')}"`,
    dados,
    br: texto ? brotliCompressSync(dados, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }) : null,
    gzip: texto ? gzipSync(dados, { level: 9 }) : null,
  };
  cacheArquivos.set(alvo, arquivo);
  return arquivo;
}

async function servirArquivo(req, res, caminhoUrl) {
  const relativo = decodeURIComponent(caminhoUrl === '/' ? '/index.html' : caminhoUrl);
  const alvo = path.normalize(path.join(RAIZ, relativo));
  if (!alvo.startsWith(RAIZ + path.sep)) return responderJson(res, 403, { mensagem: 'Caminho inválido.' });
  const ext = path.extname(alvo).toLowerCase();
  let arquivo;
  try {
    arquivo = await lerArquivo(alvo, ext);
  } catch {
    return responderJson(res, 404, { mensagem: 'Não encontrado.' });
  }
  const cabecalhos = {
    'Content-Type': TIPOS[ext] || 'application/octet-stream',
    // As fontes nunca mudam; o resto o navegador confere a cada visita e só baixa de novo se mudou.
    'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: arquivo.etag,
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === arquivo.etag) {
    res.writeHead(304, cabecalhos);
    return res.end();
  }
  const aceita = req.headers['accept-encoding'] || '';
  let corpo = arquivo.dados;
  if (arquivo.br && /\bbr\b/.test(aceita)) [corpo, cabecalhos['Content-Encoding']] = [arquivo.br, 'br'];
  else if (arquivo.gzip && /\bgzip\b/.test(aceita)) [corpo, cabecalhos['Content-Encoding']] = [arquivo.gzip, 'gzip'];
  res.writeHead(200, { ...cabecalhos, 'Content-Length': corpo.length });
  res.end(corpo);
}

const servidor = http.createServer(async (req, res) => {
  try {
    for (const [nome, valor] of Object.entries(SEGURANCA)) res.setHeader(nome, valor);
    const url = new URL(req.url, 'http://local');
    if ((await controlarAcesso(req, res, url.pathname)) !== true) return;

    const m = url.pathname.match(/^\/svc\/(rg|sn|danfse)(\/.*)?$/);
    if (m) return await repassar(req, res, m[1], (m[2] || '') + url.search);

    if (url.pathname === '/status') {
      const [rg, sn, danfse] = await Promise.all(['rg', 'sn', 'danfse'].map(verificarServico));
      return responderJson(res, 200, { rg, sn, danfse, verificadoEm: new Date().toISOString() });
    }

    if (req.method !== 'GET') return responderJson(res, 405, { mensagem: 'Método não permitido.' });
    return await servirArquivo(req, res, url.pathname);
  } catch (e) {
    if (res.headersSent) return res.end();
    responderJson(res, e.status || 500, { mensagem: e.status ? e.message : 'Erro interno do painel.' });
  }
});

servidor.listen(PORTA, HOST, () => {
  console.log(`Central RTC no ar: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORTA}${COM_LOGIN ? ' (com login)' : ''}`);
  for (const s of Object.values(SERVICOS)) console.log(`  · ${s.nome}: ${s.url}`);
});
