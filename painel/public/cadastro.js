// Tela de cadastro: a própria pessoa pede acesso; a conta só funciona depois de aprovada.

import './mostrar-senha.js';

const form = document.querySelector('#form-cadastro');
const caixa = document.querySelector('#msg-cadastro');

function mostrar(tom, texto) {
  caixa.className = `mensagem mensagem-${tom}`;
  caixa.textContent = texto;
  caixa.hidden = false;
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { repetida, ...dados } = Object.fromEntries(new FormData(form));
  if (dados.senha !== repetida) return mostrar('erro', 'As duas senhas não estão iguais.');
  const botao = form.querySelector('button[type=submit]');
  botao.disabled = true;
  try {
    const r = await fetch('/api/cadastro', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dados),
    });
    const { mensagem } = await r.json().catch(() => ({}));
    if (!r.ok) return mostrar('erro', mensagem || 'Não foi possível enviar o pedido agora. Tente de novo.');
    form.replaceChildren(
      Object.assign(document.createElement('h1'), { textContent: 'Pedido enviado' }),
      Object.assign(document.createElement('p'), { className: 'mensagem mensagem-ok', textContent: mensagem }),
    );
  } catch {
    mostrar('erro', 'O painel não respondeu. Confira sua conexão e tente de novo.');
  } finally {
    botao.disabled = false;
  }
});

// No celular, focar abriria o teclado por cima da tela.
if (matchMedia('(pointer: fine)').matches) form.nome.focus();
