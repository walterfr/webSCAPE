/**
 * Hook de Runtime do Proxy & Media Sniffer (Injetado nas páginas)
 * - Redireciona fetch/XHR/scripts dinâmicos para o proxy transpilador
 * - Captura streams .m3u8 / .mp4 para o Player Nativo de Hardware da TV LG
 * - Recebe comandos do controle remoto (Scroll, Zoom, D-Pad) via postMessage
 */
(function () {
  'use strict';

  var PROXY_BASE = window.__WEBOS_PROXY_BASE__ || 'http://127.0.0.1:8899';
  var TARGET_URL = window.__WEBOS_PROXY_TARGET__ || window.location.href;

  function resolveTargetUrl(inputUrl) {
    if (!inputUrl || typeof inputUrl !== 'string') return inputUrl;
    var trimmed = inputUrl.replace(/&amp;/g, '&').trim();
    if (
      !trimmed ||
      trimmed.indexOf('data:') === 0 ||
      trimmed.indexOf('blob:') === 0 ||
      trimmed.indexOf('javascript:') === 0 ||
      trimmed.indexOf('mailto:') === 0 ||
      trimmed.indexOf('about:') === 0 ||
      trimmed.charAt(0) === '#'
    ) {
      return inputUrl;
    }
    if (trimmed.indexOf(PROXY_BASE) === 0 || trimmed.indexOf('/proxy?url=') === 0) {
      return inputUrl;
    }
    try {
      // Se o script tentou usar a origem do proxy (127.0.0.1:8899/caminho), corrige para a origem real do site
      if (trimmed.indexOf(window.location.origin) === 0 && trimmed.indexOf('/proxy?') === -1) {
        var relPath = trimmed.slice(window.location.origin.length);
        var targetOrigin = new URL(TARGET_URL).origin;
        return targetOrigin + relPath;
      }
      return new URL(trimmed, TARGET_URL).href;
    } catch (_) {
      return inputUrl;
    }
  }

  function toProxyUrl(inputUrl, typeHint) {
    if (!inputUrl || typeof inputUrl !== 'string') return inputUrl;
    var trimmed = inputUrl.trim();
    if (
      !trimmed ||
      trimmed.indexOf('data:') === 0 ||
      trimmed.indexOf('blob:') === 0 ||
      trimmed.indexOf('javascript:') === 0 ||
      trimmed.indexOf('mailto:') === 0 ||
      trimmed.indexOf('about:') === 0 ||
      trimmed.charAt(0) === '#'
    ) {
      return inputUrl;
    }
    if (trimmed.indexOf(PROXY_BASE + '/proxy?') === 0 || trimmed.indexOf('/proxy?url=') === 0) {
      return inputUrl;
    }
    var resolved = resolveTargetUrl(trimmed);
    if (!resolved || resolved.indexOf('http') !== 0) return inputUrl;
    checkMediaUrl(resolved);
    var suffix = typeHint ? '&type=' + encodeURIComponent(typeHint) : '';
    return PROXY_BASE + '/proxy?url=' + encodeURIComponent(resolved) + suffix;
  }

  function getFormTargetUrl(form) {
    var rawAction = form.getAttribute('action') || form.action || TARGET_URL;
    try {
      var actionUrl = new URL(rawAction, window.location.href);
      var proxyOrigin = new URL(PROXY_BASE).origin;
      if (actionUrl.origin === proxyOrigin && actionUrl.pathname === '/proxy') {
        var targetUrl = actionUrl.searchParams.get('url');
        if (targetUrl) return new URL(targetUrl).href;
      }
      return resolveTargetUrl(rawAction);
    } catch (_) {
      return null;
    }
  }

  function serializeForm(form, submitter) {
    var values = [];
    var elements = form.elements || [];
    for (var i = 0; i < elements.length; i++) {
      var element = elements[i];
      var name = element.name;
      var type = String(element.type || '').toLowerCase();
      if (!name || element.disabled) continue;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image' || type === 'file') {
        if (element !== submitter) continue;
      }
      if ((type === 'checkbox' || type === 'radio') && !element.checked) continue;
      if (element.tagName && element.tagName.toLowerCase() === 'select' && element.multiple) {
        for (var j = 0; j < element.options.length; j++) {
          if (element.options[j].selected && !element.options[j].disabled) {
            values.push(encodeURIComponent(name) + '=' + encodeURIComponent(element.options[j].value).replace(/%20/g, '+'));
          }
        }
      } else {
        values.push(encodeURIComponent(name) + '=' + encodeURIComponent(element.value || '').replace(/%20/g, '+'));
      }
    }
    return values.join('&');
  }

  // Notifica a casca da TV quando vídeos HLS (.m3u8) ou MP4 diretos são detectados
  var detectedMedia = Object.create(null);
  function checkMediaUrl(url) {
    if (!url || typeof url !== 'string') return;
    if (/\.(m3u8|mp4|webm)(\?|$)/i.test(url) && !detectedMedia[url]) {
      detectedMedia[url] = true;
      try {
        window.parent.postMessage({
          type: 'WEBOS_BROWSER_MEDIA_DETECTED',
          mediaUrl: url,
          pageTitle: document.title || TARGET_URL
        }, '*');
      } catch (_) {}
    }
  }

  // 1. Hook window.fetch
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') {
          input = toProxyUrl(input, 'xhr');
        } else if (typeof URL !== 'undefined' && input instanceof URL) {
          input = toProxyUrl(input.href, 'xhr');
        } else if (typeof Request !== 'undefined' && input instanceof Request) {
          input = new Request(toProxyUrl(input.url, 'xhr'), input);
        }
      } catch (_) {}
      return origFetch.call(this, input, init);
    };
  }

  // 2. Hook XMLHttpRequest.prototype.open
  if (typeof XMLHttpRequest !== 'undefined') {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof url === 'string') {
        args[1] = toProxyUrl(url, 'xhr');
      }
      return origOpen.apply(this, args);
    };
  }

  // 3. Hook navigator.sendBeacon (bloqueia telemetria pesada ou roteia)
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon = function () { return true; };
  }

  // 4. Hook History.pushState / replaceState para não quebrar em cross-origin dentro do proxy
  if (typeof History !== 'undefined') {
    var origPushState = History.prototype.pushState;
    var origReplaceState = History.prototype.replaceState;
    History.prototype.pushState = function (state, title, url) {
      if (url) {
        var resolved = resolveTargetUrl(String(url));
        window.__WEBOS_PROXY_TARGET__ = resolved;
        TARGET_URL = resolved;
        try {
          window.parent.postMessage({
            type: 'WEBOS_BROWSER_URL_CHANGED',
            url: resolved,
            title: document.title || resolved
          }, '*');
        } catch (_) {}
      }
      try {
        return origPushState.call(this, state, title, url ? toProxyUrl(String(url), 'doc') : url);
      } catch (_) {
        return;
      }
    };
    History.prototype.replaceState = function (state, title, url) {
      if (url) {
        var resolved = resolveTargetUrl(String(url));
        window.__WEBOS_PROXY_TARGET__ = resolved;
        TARGET_URL = resolved;
      }
      try {
        return origReplaceState.call(this, state, title, url ? toProxyUrl(String(url), 'doc') : url);
      } catch (_) {
        return;
      }
    };
  }

  // 5. Hook setAttribute para <script>, <link>, <iframe>, <a>, <video>, <source> dinâmicos
  if (typeof Element !== 'undefined') {
    var origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var attr = String(name).toLowerCase();
      var tag = this.tagName ? this.tagName.toUpperCase() : '';
      if ((attr === 'src' || attr === 'href' || attr === 'action') && typeof value === 'string') {
        if (tag === 'SCRIPT') {
          value = toProxyUrl(value, 'js');
        } else if (tag === 'LINK') {
          value = toProxyUrl(value, 'css');
        } else if (tag === 'A' || tag === 'FORM' || tag === 'IFRAME') {
          value = toProxyUrl(value, 'doc');
        } else if (tag === 'VIDEO' || tag === 'SOURCE') {
          checkMediaUrl(resolveTargetUrl(value));
        }
      }
      if (attr === 'integrity' || attr === 'nonce') {
        return; // Ignora SRI pois o código JS/CSS é transpilado para Chrome 68
      }
      return origSetAttribute.call(this, name, value);
    };
  }

  // Hook propriedade .src de HTMLScriptElement para chunks Webpack/Vite/Next.js dinâmicos
  if (typeof HTMLScriptElement !== 'undefined') {
    var scriptSrcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (scriptSrcDesc && scriptSrcDesc.set) {
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        configurable: true,
        enumerable: true,
        get: function () { return scriptSrcDesc.get.call(this); },
        set: function (val) {
          this.removeAttribute('integrity');
          return scriptSrcDesc.set.call(this, toProxyUrl(String(val), 'js'));
        }
      });
    }
  }

  // 6. Intercepta cliques em links <a> e window.open para manter dentro do navegador da TV
  window.open = function (url) {
    if (url) {
      var resolved = resolveTargetUrl(String(url));
      try {
        window.parent.postMessage({
          type: 'WEBOS_BROWSER_OPEN_TAB',
          url: resolved
        }, '*');
      } catch (_) {
        window.location.href = toProxyUrl(resolved, 'doc');
      }
    }
    return window;
  };

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el.tagName !== 'A') {
      el = el.parentElement;
    }
    if (!el || !el.getAttribute) return;
    var rawHref = el.getAttribute('href');
    if (!rawHref || rawHref.charAt(0) === '#' || rawHref.indexOf('javascript:') === 0) return;

    var resolved = resolveTargetUrl(rawHref);
    if (el.getAttribute('target') === '_blank') {
      e.preventDefault();
      window.parent.postMessage({
        type: 'WEBOS_BROWSER_OPEN_TAB',
        url: resolved
      }, '*');
      return;
    }
    if (rawHref.indexOf(PROXY_BASE) !== 0 && rawHref.indexOf('/proxy?url=') !== 0) {
      e.preventDefault();
      window.location.href = toProxyUrl(resolved, 'doc');
    }
  }, true);

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.tagName || form.tagName.toLowerCase() !== 'form') return;
    if (String(form.method || 'get').toLowerCase() !== 'get') return;

    var targetUrl = getFormTargetUrl(form);
    if (!targetUrl) return;

    var query = serializeForm(form, e.submitter);
    if (query) {
      targetUrl += (targetUrl.indexOf('?') === -1 ? '?' : '&') + query;
    }

    e.preventDefault();
    window.location.href = toProxyUrl(targetUrl, 'doc');
  }, true);

  // 7. Notifica título e URL carregada + escaneia elementos <video> na página
  function notifyPageReady() {
    try {
      window.parent.postMessage({
        type: 'WEBOS_BROWSER_URL_CHANGED',
        url: TARGET_URL,
        title: document.title || TARGET_URL
      }, '*');
      var videos = document.querySelectorAll('video, video source');
      for (var i = 0; i < videos.length; i++) {
        var vSrc = videos[i].currentSrc || videos[i].src || videos[i].getAttribute('src');
        if (vSrc) checkMediaUrl(resolveTargetUrl(vSrc));
      }
    } catch (_) {}
  }

  window.addEventListener('DOMContentLoaded', notifyPageReady);
  window.addEventListener('load', notifyPageReady);

  // 8. Comandos vindos da UI da TV (Zoom, Scroll por D-Pad, Extrair Vídeo)
  var currentZoom = 1;
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'WEBOS_CMD_SCROLL') {
      window.scrollBy({ top: data.deltaY || 0, left: data.deltaX || 0, behavior: 'smooth' });
    } else if (data.type === 'WEBOS_CMD_ZOOM') {
      currentZoom = data.zoom || 1;
      if (document.documentElement) {
        document.documentElement.style.zoom = String(currentZoom);
      }
    }
  });
})();
