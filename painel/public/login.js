// Tela de login: entra e volta para o painel. Mostra o contato do administrador quando o servidor tem um e-mail configurado.

const form = document.querySelector('#form-entrar');
const caixaErro = document.querySelector('#erro-entrar');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const botao = form.querySelector('button[type=submit]');
  const dados = Object.fromEntries(new FormData(form));
  caixaErro.hidden = true;
  botao.disabled = true;
  try {
    const r = await fetch('/api/entrar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dados),
    });
    if (r.ok) return location.assign('/');
    const { mensagem } = await r.json().catch(() => ({}));
    caixaErro.textContent = mensagem || 'Não foi possível entrar agora. Tente de novo.';
    caixaErro.hidden = false;
    form.senha.select();
  } catch {
    caixaErro.textContent = 'O painel não respondeu. Confira sua conexão e tente de novo.';
    caixaErro.hidden = false;
  } finally {
    botao.disabled = false;
  }
});

fetch('/api/acesso')
  .then((r) => r.json())
  .then(({ email }) => {
    if (!email) return;
    document.querySelector('#link-pedir-acesso').href = `mailto:${email}?subject=${encodeURIComponent('Central RTC')}`;
    document.querySelector('#pedir-acesso').hidden = false;
  })
  .catch(() => {});

form.usuario.focus();
