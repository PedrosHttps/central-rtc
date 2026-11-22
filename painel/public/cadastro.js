// Tela de cadastro: a própria pessoa pede acesso; a conta só funciona depois de aprovada.
// Vindo do Google (?google=1), o e-mail é o que o Google confirmou e não há senha.

const form = document.querySelector('#form-cadastro');
const caixa = document.querySelector('#msg-cadastro');
let viaGoogle = false;

function mostrar(tom, texto) {
  caixa.className = `mensagem mensagem-${tom}`;
  caixa.textContent = texto;
  caixa.hidden = false;
}

async function prepararGoogle() {
  const r = await fetch('/api/google/identidade').catch(() => null);
  if (!r?.ok) return mostrar('erro', 'O tempo para concluir o cadastro com Google acabou. Use o botão do Google de novo.');
  const { email, nome } = await r.json();
  viaGoogle = true;
  form.email.value = email;
  form.email.readOnly = true;
  if (nome && !form.nome.value) form.nome.value = nome;
  for (const campo of form.querySelectorAll('[data-senha]')) campo.remove();
  document.querySelector('#explica').textContent =
    'Seu e-mail foi confirmado pelo Google. Conte para que vai usar a ferramenta: quando o pedido for aprovado, você entra pelo botão do Google.';
  form.motivo.focus();
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { repetida, ...dados } = Object.fromEntries(new FormData(form));
  if (!viaGoogle && dados.senha !== repetida) return mostrar('erro', 'As duas senhas não estão iguais.');
  const botao = form.querySelector('button[type=submit]');
  botao.disabled = true;
  try {
    const r = await fetch('/api/cadastro', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...dados, google: viaGoogle }),
    });
    const { mensagem } = await r.json().catch(() => ({}));
    if (!r.ok) return mostrar('erro', mensagem || 'Não foi possível enviar o pedido agora. Tente de novo.');
    form.replaceChildren(
      Object.assign(document.createElement('h1'), { textContent: 'Pedido enviado' }),
      Object.assign(document.createElement('p'), { className: 'mensagem mensagem-ok', textContent: mensagem }),
    );
    document.querySelector('#cadastro-google').hidden = true;
  } catch {
    mostrar('erro', 'O painel não respondeu. Confira sua conexão e tente de novo.');
  } finally {
    botao.disabled = false;
  }
});

if (new URLSearchParams(location.search).get('google')) prepararGoogle();
else {
  fetch('/api/acesso').then((r) => r.json()).then(({ google }) => {
    document.querySelector('#cadastro-google').hidden = !google;
  }).catch(() => {});
  // No celular, focar abriria o teclado por cima da tela.
  if (matchMedia('(pointer: fine)').matches) form.nome.focus();
}
