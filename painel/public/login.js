// Tela de login: entra e volta para o painel. Mostra o contato do administrador quando o servidor tem.

const form = document.querySelector('#form-entrar');
const caixaErro = document.querySelector('#erro-entrar');

function mostrarErro(texto) {
  caixaErro.textContent = texto;
  caixaErro.hidden = false;
}

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
    mostrarErro(mensagem || 'Não foi possível entrar agora. Tente de novo.');
    form.senha.select();
  } catch {
    mostrarErro('O painel não respondeu. Confira sua conexão e tente de novo.');
  } finally {
    botao.disabled = false;
  }
});

fetch('/api/acesso')
  .then((r) => r.json())
  .then(({ email }) => {
    if (!email) return;
    const ajuda = document.querySelector('#link-ajuda');
    const esqueci = document.querySelector('#link-esqueci');
    ajuda.href = `mailto:${email}?subject=${encodeURIComponent('Central RTC')}`;
    // O aviso de escrever do e-mail da conta vai no corpo da mensagem, não na tela.
    esqueci.href = `mailto:${email}?subject=${encodeURIComponent('Central RTC: esqueci a senha')}&body=${encodeURIComponent('Escrevo do e-mail da minha conta e peço uma senha nova.')}`;
    ajuda.hidden = esqueci.hidden = false;
  })
  .catch(() => {});

// No celular, focar abriria o teclado por cima da tela antes de a pessoa escolher o que fazer.
if (matchMedia("(pointer: fine)").matches) form.usuario.focus();
