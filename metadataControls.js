(function () {
  'use strict';

  const sheetsUrl = document.getElementById('sheets-url');
  if (sheetsUrl && !document.getElementById('tmdb-key')) {
    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = 'TMDB API key (stored only in this browser)';
    const input = document.createElement('input');
    input.className = 'field';
    input.id = 'tmdb-key';
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder = 'Paste your TMDB key';
    sheetsUrl.insertAdjacentElement('afterend', label);
    label.insertAdjacentElement('afterend', input);
  }

  const modalActions = document.querySelector('.modal-actions');
  if (modalActions && !document.getElementById('modal-trailer')) {
    const trailer = document.createElement('button');
    trailer.className = 'btn';
    trailer.id = 'modal-trailer';
    trailer.hidden = true;
    trailer.textContent = 'Watch trailer';
    modalActions.prepend(trailer);
  }
}());