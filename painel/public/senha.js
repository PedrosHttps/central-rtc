// Senha esquecida: sem link, pede o e-mail; com o link do e-mail (#token), cria a senha nova.

const token = location.hash.slice(1);
const form = document.querySelector(token ? '#form-nova' : '#form-pedir');
const caixa = form.querySelector('.mensagem');
form.hidden = false;
document.querySelector('#form-pedir').hidden = Boolean(token);
// Tira o token da barra de endereço: não fica no histórico nem vai junto se a pessoa copiar o endereço.
if (token) history.replaceState(null, '', location.pathname);

function mostrar(tom, texto) {
  caixa.className = `mensagem mensagem-${tom}`;
  caixa.textContent = texto;
  caixa.hidden = false;
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { repetida, ...dados } = Object.fromEntries(new FormData(form));
  if (token && dados.senha !== repetida) return mostrar('erro', 'As duas senhas não estão iguais.');
  const botao = form.querySelector('button[type=submit]');
  botao.disabled = true;
  try {
    const r = await fetch(token ? '/api/redefinir' : '/api/esqueci', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(token ? { token, senha: dados.senha } : dados),
    });
    const { mensagem } = await r.json().catch(() => ({}));
    if (!r.ok) return mostrar('erro', mensagem || 'Não foi possível agora. Tente de novo.');
    const link = Object.assign(document.createElement('a'), { href: 'login.html', textContent: 'Ir para o login' });
    form.replaceChildren(
      Object.assign(document.createElement('h1'), { textContent: token ? 'Senha salva' : 'Confira seu e-mail' }),
      Object.assign(document.createElement('p'), { className: 'mensagem mensagem-ok', textContent: mensagem }),
      ...(token ? [link] : []),
    );
  } catch {
    mostrar('erro', 'O painel não respondeu. Confira sua conexão e tente de novo.');
  } finally {
    botao.disabled = false;
  }
});

if (matchMedia('(pointer: fine)').matches) form.querySelector('input').focus();
