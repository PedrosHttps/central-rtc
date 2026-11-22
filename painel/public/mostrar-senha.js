// Caixa "Mostrar senha" (.mostrar-senha): mostra ou esconde todas as senhas do mesmo formulário.
// Vale para as telas de entrada e para os formulários que o painel cria depois, como o de trocar a senha.
document.addEventListener('change', (ev) => {
  if (!ev.target.matches('.mostrar-senha input')) return;
  for (const campo of ev.target.form.querySelectorAll('input[autocomplete$="-password"]')) {
    campo.type = ev.target.checked ? 'text' : 'password';
  }
});
