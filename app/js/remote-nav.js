/**
 * Gerenciador de Controle Remoto LG (Magic Remote + D-Pad + Botões Coloridos)
 * KeyCodes oficiais LG webOS:
 * - Back: 461 (ou Escape 27)
 * - Vermelho: 403 | Verde: 404 | Amarelo: 405 | Azul: 406
 * - Channel Up (PageUp): 33 / 427 | Channel Down (PageDown): 34 / 428
 */
(function () {
  'use strict';

  var KEY_BACK = 461;
  var KEY_RED = 403;
  var KEY_GREEN = 404;
  var KEY_YELLOW = 405;
  var KEY_BLUE = 406;
  var KEY_CH_UP = 427;
  var KEY_CH_DOWN = 428;

  function getFocusableElements() {
    var list = document.querySelectorAll('.focusable');
    var visible = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.offsetWidth > 0 && el.offsetHeight > 0 && !el.classList.contains('hidden')) {
        visible.push(el);
      }
    }
    return visible;
  }

  function moveFocusByDirection(dir) {
    var items = getFocusableElements();
    if (!items.length) return;

    var active = document.activeElement;
    var idx = items.indexOf(active);
    if (idx === -1) {
      items[0].focus();
      return;
    }

    var currentRect = active.getBoundingClientRect();
    var cx = currentRect.left + currentRect.width / 2;
    var cy = currentRect.top + currentRect.height / 2;

    var bestEl = null;
    var bestScore = Infinity;

    for (var i = 0; i < items.length; i++) {
      if (i === idx) continue;
      var r = items[i].getBoundingClientRect();
      var tx = r.left + r.width / 2;
      var ty = r.top + r.height / 2;
      var dx = tx - cx;
      var dy = ty - cy;

      if (dir === 'left' && dx >= -10) continue;
      if (dir === 'right' && dx <= 10) continue;
      if (dir === 'up' && dy >= -10) continue;
      if (dir === 'down' && dy <= 10) continue;

      var dist = Math.hypot(dx, dy);
      var penalty = (dir === 'left' || dir === 'right') ? Math.abs(dy) * 2.5 : Math.abs(dx) * 2.5;
      var score = dist + penalty;

      if (score < bestScore) {
        bestScore = score;
        bestEl = items[i];
      }
    }

    if (bestEl) {
      bestEl.focus();
    }
  }

  function setupRemoteListeners(handlers) {
    window.addEventListener('keydown', function (e) {
      var code = e.keyCode || e.which;
      var activeTag = document.activeElement ? document.activeElement.tagName : '';
      var isTyping = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

      // 1. Botão Voltar (LG Back 461 ou Esc 27)
      if (code === KEY_BACK || code === 27) {
        e.preventDefault();
        if (window.NeoNativePlayer && window.NeoNativePlayer.isOpen()) {
          window.NeoNativePlayer.close();
          return;
        }
        if (handlers.onBack) handlers.onBack();
        return;
      }

      // 2. Teclas Coloridas do Controle LG (funcionam a qualquer momento)
      if (code === KEY_RED || (e.altKey && code === 49)) {
        e.preventDefault();
        if (handlers.onRedButton) handlers.onRedButton();
        return;
      }
      if (code === KEY_GREEN || (e.altKey && code === 50)) {
        e.preventDefault();
        if (handlers.onGreenButton) handlers.onGreenButton();
        return;
      }
      if (code === KEY_YELLOW || (e.altKey && code === 51)) {
        e.preventDefault();
        if (handlers.onYellowButton) handlers.onYellowButton();
        return;
      }
      if (code === KEY_BLUE || (e.altKey && code === 52)) {
        e.preventDefault();
        if (handlers.onBlueButton) handlers.onBlueButton();
        return;
      }

      // 3. Rolagem rápida pelo Channel Up / Channel Down ou PageUp / PageDown
      if (code === KEY_CH_UP || code === 33) {
        e.preventDefault();
        if (handlers.onScrollPage) handlers.onScrollPage(-520);
        return;
      }
      if (code === KEY_CH_DOWN || code === 34) {
        e.preventDefault();
        if (handlers.onScrollPage) handlers.onScrollPage(520);
        return;
      }

      // 4. Setas D-Pad quando não estiver digitando na barra de URL
      if (!isTyping) {
        if (code === 37) { e.preventDefault(); moveFocusByDirection('left'); }
        else if (code === 39) { e.preventDefault(); moveFocusByDirection('right'); }
        else if (code === 38) { e.preventDefault(); moveFocusByDirection('up'); }
        else if (code === 40) { e.preventDefault(); moveFocusByDirection('down'); }
      }
    });
  }

  window.NeoRemoteNav = {
    init: setupRemoteListeners
  };
})();
