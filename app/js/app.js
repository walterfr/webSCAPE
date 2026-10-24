/**
 * Controlador Principal do webSCAPE para LG webOS 5.6.2
 * - Acorda e mantém vivo o JS Service local via PalmServiceBridge (Luna Bus)
 * - Usa arquitetura de Iframe Único com Troca de Estado (Tab Suspension nativa: 0 MB RAM por aba inativa)
 * - Integra AdBlock, Zoom, Alternador de User-Agent e Sniffer de Vídeo Nativo
 */
(function () {
  'use strict';

  var DEFAULT_PROXY = localStorage.getItem('neo_proxy_base') || 'http://127.0.0.1:8899';
  var proxyBase = DEFAULT_PROXY;

  var SPEED_DIAL_SITES = [
    { name: 'Google', url: 'https://www.google.com.br', color: '#2563eb', icon: 'G' },
    { name: 'YouTube Web', url: 'https://m.youtube.com', color: '#dc2626', icon: '▶' },
    { name: 'Globo / G1', url: 'https://g1.globo.com', color: '#b91c1c', icon: 'G1' },
    { name: 'Wikipedia', url: 'https://pt.wikipedia.org', color: '#475569', icon: 'W' },
    { name: 'Reddit', url: 'https://old.reddit.com', color: '#ea580c', icon: 'R' },
    { name: 'Twitch', url: 'https://m.twitch.tv', color: '#7c3aed', icon: 'T' },
    { name: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html', color: '#d97706', icon: 'D' },
    { name: 'GitHub', url: 'https://github.com', color: '#1e293b', icon: 'GH' }
  ];

  var ZOOM_LEVELS = [1, 1.25, 1.5, 0.85];
  var UA_MODES = ['desktop', 'mobile', 'tv'];
  var UA_LABELS = { desktop: 'Desktop', mobile: 'Mobile', tv: 'SmartTV' };

  var state = {
    tabs: [],
    activeTabId: null,
    zoomIndex: 0,
    uaIndex: 0,
    adblockEnabled: true,
    adblockCount: 0,
    serviceOnline: false,
    chromeCollapsed: false
  };

  // Referências DOM
  var topChrome = document.getElementById('top-chrome');
  var topHoverZone = document.getElementById('top-hover-zone');
  var serviceDot = document.getElementById('service-dot');
  var serviceLabel = document.getElementById('service-status-label');
  var tabsContainer = document.getElementById('tabs-container');
  var btnNewTab = document.getElementById('btn-new-tab');
  var btnBack = document.getElementById('btn-back');
  var btnForward = document.getElementById('btn-forward');
  var btnReload = document.getElementById('btn-reload');
  var btnHome = document.getElementById('btn-home');
  var urlForm = document.getElementById('url-form');
  var urlInput = document.getElementById('url-input');
  var btnNativeVideo = document.getElementById('btn-native-video');
  var mediaCountEl = document.getElementById('media-count');
  var btnZoom = document.getElementById('btn-zoom');
  var zoomLabel = document.getElementById('zoom-label');
  var btnAdblock = document.getElementById('btn-adblock');
  var adblockLabel = document.getElementById('adblock-label');
  var btnUa = document.getElementById('btn-ua');
  var uaLabel = document.getElementById('ua-label');
  var homeScreen = document.getElementById('home-screen');
  var speedDialGrid = document.getElementById('speed-dial-grid');
  var browserFrame = document.getElementById('browser-frame');
  var proxyEndpointDisplay = document.getElementById('proxy-endpoint-display');
  var btnChangeProxy = document.getElementById('btn-change-proxy');
  var btnClearSession = document.getElementById('btn-clear-session');
  var toastEl = document.getElementById('tv-toast');

  var toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.add('hidden');
    }, 2800);
  }

  // 1. Acorda o JS Service nativo no webOS via PalmServiceBridge (Luna Bus)
  var lunaBridge = null;
  function startLunaService() {
    try {
      if (typeof PalmServiceBridge !== 'undefined') {
        lunaBridge = new PalmServiceBridge();
        lunaBridge.onservicecallback = function (msg) {
          try {
            var res = JSON.parse(msg);
            if (res && res.proxyBase) {
              proxyBase = res.proxyBase;
              proxyEndpointDisplay.textContent = proxyBase;
              updateServiceUI(true, res.adblock);
            }
          } catch (_) {}
        };
        lunaBridge.call(
          'luna://com.webscape.app.service/startProxy',
          JSON.stringify({ subscribe: true })
        );
      }
    } catch (_) {}
  }

  // 2. Verifica saúde do Proxy Transpilador HTTP
  function checkProxyHealth() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', proxyBase + '/health', true);
    xhr.timeout = 3000;
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          updateServiceUI(true, data.adblock);
        } catch (_) {
          updateServiceUI(false);
        }
      } else {
        updateServiceUI(false);
      }
    };
    xhr.onerror = function () { updateServiceUI(false); };
    xhr.ontimeout = function () { updateServiceUI(false); };
    xhr.send();
  }

  function updateServiceUI(online, adblockStats) {
    state.serviceOnline = online;
    serviceDot.className = 'brand-dot ' + (online ? 'online' : 'offline');
    serviceLabel.textContent = online ? 'Chrome 68 Transpiler Ativo' : 'Proxy Offline';
    if (adblockStats) {
      state.adblockEnabled = !!adblockStats.enabled;
      state.adblockCount = adblockStats.totalBlocked || 0;
      adblockLabel.textContent = (state.adblockEnabled ? 'ON' : 'OFF') + ' (' + state.adblockCount + ')';
      if (state.adblockEnabled) btnAdblock.classList.add('active');
      else btnAdblock.classList.remove('active');
    }
  }

  function sendProxyConfig(payload, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', proxyBase + '/config', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var res = JSON.parse(xhr.responseText);
          updateServiceUI(true, res.adblock);
          if (cb) cb(res);
        } catch (_) {}
      }
    };
    xhr.send(JSON.stringify(payload));
  }

  // 3. Gerenciamento de Abas com Suspensão Automática de Memória
  function createTab(initialUrl) {
    var id = 'tab_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    var tab = {
      id: id,
      title: initialUrl ? initialUrl : 'Nova Aba',
      url: initialUrl || '',
      history: initialUrl ? [initialUrl] : [],
      historyIndex: initialUrl ? 0 : -1,
      mediaUrls: []
    };
    state.tabs.push(tab);
    switchTab(id);
    return tab;
  }

  function getActiveTab() {
    for (var i = 0; i < state.tabs.length; i++) {
      if (state.tabs[i].id === state.activeTabId) return state.tabs[i];
    }
    return null;
  }

  function switchTab(tabId) {
    state.activeTabId = tabId;
    var tab = getActiveTab();
    renderTabs();
    if (!tab) return;

    updateMediaButton(tab);
    if (!tab.url) {
      urlInput.value = '';
      browserFrame.src = 'about:blank';
      browserFrame.classList.add('hidden');
      homeScreen.classList.remove('hidden');
    } else {
      urlInput.value = tab.url;
      homeScreen.classList.add('hidden');
      browserFrame.classList.remove('hidden');
      loadUrlInFrame(tab.url);
    }
  }

  function closeTab(tabId, e) {
    if (e) e.stopPropagation();
    if (state.tabs.length <= 1) {
      // Se for a última aba, reseta para a Home Screen
      var onlyTab = state.tabs[0];
      onlyTab.url = '';
      onlyTab.title = 'Nova Aba';
      onlyTab.history = [];
      onlyTab.historyIndex = -1;
      onlyTab.mediaUrls = [];
      switchTab(onlyTab.id);
      return;
    }
    var idx = -1;
    for (var i = 0; i < state.tabs.length; i++) {
      if (state.tabs[i].id === tabId) { idx = i; break; }
    }
    if (idx !== -1) {
      state.tabs.splice(idx, 1);
      if (state.activeTabId === tabId) {
        var nextTab = state.tabs[Math.max(0, idx - 1)];
        switchTab(nextTab.id);
      } else {
        renderTabs();
      }
    }
  }

  function renderTabs() {
    tabsContainer.innerHTML = '';
    for (var i = 0; i < state.tabs.length; i++) {
      (function (tab) {
        var item = document.createElement('div');
        item.className = 'tab-item focusable' + (tab.id === state.activeTabId ? ' active' : '');
        item.tabIndex = 0;

        var titleSpan = document.createElement('span');
        titleSpan.className = 'tab-title';
        titleSpan.textContent = tab.title || 'Nova Aba';

        var closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Fechar aba';
        closeBtn.addEventListener('click', function (ev) { closeTab(tab.id, ev); });

        item.appendChild(titleSpan);
        item.appendChild(closeBtn);
        item.addEventListener('click', function () { switchTab(tab.id); });
        item.addEventListener('keydown', function (ev) {
          if (ev.keyCode === 13) switchTab(tab.id);
        });
        tabsContainer.appendChild(item);
      })(state.tabs[i]);
    }
  }

  // 4. Navegação de URL / Pesquisa
  function normalizeInputToUrl(raw) {
    var input = String(raw || '').trim();
    if (!input) return '';
    if (/^https?:\/\//i.test(input)) return input;
    if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(input) && input.indexOf(' ') === -1) {
      return 'https://' + input;
    }
    return 'https://www.google.com.br/search?q=' + encodeURIComponent(input);
  }

  function navigateActiveTab(rawInput, pushHistory) {
    var targetUrl = normalizeInputToUrl(rawInput);
    if (!targetUrl) return;

    var tab = getActiveTab();
    if (!tab) return;

    tab.url = targetUrl;
    tab.title = targetUrl.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0];
    tab.mediaUrls = [];
    updateMediaButton(tab);

    if (pushHistory !== false) {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(targetUrl);
      tab.historyIndex = tab.history.length - 1;
    }

    urlInput.value = targetUrl;
    renderTabs();
    homeScreen.classList.add('hidden');
    browserFrame.classList.remove('hidden');
    loadUrlInFrame(targetUrl);
  }

  function loadUrlInFrame(targetUrl) {
    var proxied = proxyBase + '/proxy?url=' + encodeURIComponent(targetUrl) + '&type=doc';
    if (browserFrame.src !== proxied) {
      browserFrame.src = proxied;
    }
  }

  function updateMediaButton(tab) {
    if (!tab || !tab.mediaUrls || tab.mediaUrls.length === 0) {
      btnNativeVideo.classList.add('hidden');
      mediaCountEl.textContent = '0';
    } else {
      btnNativeVideo.classList.remove('hidden');
      mediaCountEl.textContent = String(tab.mediaUrls.length);
    }
  }

  // 5. Renderiza Speed Dial na tela inicial
  function renderSpeedDial() {
    speedDialGrid.innerHTML = '';
    for (var i = 0; i < SPEED_DIAL_SITES.length; i++) {
      (function (site) {
        var card = document.createElement('div');
        card.className = 'dial-card focusable';
        card.tabIndex = 0;

        var icon = document.createElement('div');
        icon.className = 'dial-icon';
        icon.style.backgroundColor = site.color;
        icon.textContent = site.icon;

        var info = document.createElement('div');
        info.className = 'dial-info';

        var name = document.createElement('div');
        name.className = 'dial-name';
        name.textContent = site.name;

        var urlText = document.createElement('div');
        urlText.className = 'dial-url';
        urlText.textContent = site.url;

        info.appendChild(name);
        info.appendChild(urlText);
        card.appendChild(icon);
        card.appendChild(info);

        card.addEventListener('click', function () {
          navigateActiveTab(site.url, true);
        });
        card.addEventListener('keydown', function (ev) {
          if (ev.keyCode === 13) navigateActiveTab(site.url, true);
        });

        speedDialGrid.appendChild(card);
      })(SPEED_DIAL_SITES[i]);
    }
  }

  // 6. Ações de Barra e Atalhos Coloridos do Controle LG
  function toggleTopChrome(forceState) {
    state.chromeCollapsed = typeof forceState === 'boolean' ? forceState : !state.chromeCollapsed;
    if (state.chromeCollapsed) {
      topChrome.classList.add('collapsed');
      showToast('Barra oculta (Botão Vermelho ou mova o cursor ao topo para exibir)');
    } else {
      topChrome.classList.remove('collapsed');
    }
  }

  function cycleZoom() {
    state.zoomIndex = (state.zoomIndex + 1) % ZOOM_LEVELS.length;
    var z = ZOOM_LEVELS[state.zoomIndex];
    zoomLabel.textContent = Math.round(z * 100) + '%';
    showToast('Zoom da página: ' + Math.round(z * 100) + '%');
    if (browserFrame.contentWindow) {
      browserFrame.contentWindow.postMessage({ type: 'WEBOS_CMD_ZOOM', zoom: z }, '*');
    }
  }

  function toggleAdblock() {
    var nextState = !state.adblockEnabled;
    sendProxyConfig({ adblock: nextState }, function () {
      showToast('AdBlock ' + (nextState ? 'ATIVADO' : 'DESATIVADO'));
    });
  }

  function cycleUserAgent() {
    state.uaIndex = (state.uaIndex + 1) % UA_MODES.length;
    var mode = UA_MODES[state.uaIndex];
    uaLabel.textContent = UA_LABELS[mode];
    sendProxyConfig({ userAgentMode: mode }, function () {
      showToast('Modo User-Agent: ' + UA_LABELS[mode] + ' (recarregando...)');
      var tab = getActiveTab();
      if (tab && tab.url) loadUrlInFrame(tab.url);
    });
  }

  function goBack() {
    var tab = getActiveTab();
    if (!tab) return;
    if (tab.historyIndex > 0) {
      tab.historyIndex--;
      navigateActiveTab(tab.history[tab.historyIndex], false);
    } else if (tab.url) {
      tab.url = '';
      tab.title = 'Nova Aba';
      switchTab(tab.id);
    }
  }

  function goForward() {
    var tab = getActiveTab();
    if (!tab) return;
    if (tab.historyIndex < tab.history.length - 1) {
      tab.historyIndex++;
      navigateActiveTab(tab.history[tab.historyIndex], false);
    }
  }

  // 7. Eventos de UI e PostMessage vindos do Iframe
  btnNewTab.addEventListener('click', function () { createTab(''); });
  btnBack.addEventListener('click', goBack);
  btnForward.addEventListener('click', goForward);
  btnReload.addEventListener('click', function () {
    var tab = getActiveTab();
    if (tab && tab.url) {
      browserFrame.src = proxyBase + '/proxy?url=' + encodeURIComponent(tab.url) + '&type=doc&_t=' + Date.now();
    }
  });
  btnHome.addEventListener('click', function () {
    var tab = getActiveTab();
    if (!tab) return;
    tab.url = '';
    tab.title = 'Nova Aba';
    switchTab(tab.id);
  });

  urlForm.addEventListener('submit', function (e) {
    e.preventDefault();
    navigateActiveTab(urlInput.value, true);
    urlInput.blur();
  });

  btnZoom.addEventListener('click', cycleZoom);
  btnAdblock.addEventListener('click', toggleAdblock);
  btnUa.addEventListener('click', cycleUserAgent);

  btnNativeVideo.addEventListener('click', function () {
    var tab = getActiveTab();
    if (tab && tab.mediaUrls.length > 0) {
      var latestMedia = tab.mediaUrls[tab.mediaUrls.length - 1];
      window.NeoNativePlayer.open(latestMedia, tab.title);
    }
  });

  topHoverZone.addEventListener('mouseenter', function () {
    if (state.chromeCollapsed) toggleTopChrome(false);
  });

  btnChangeProxy.addEventListener('click', function () {
    var nextProxy = window.prompt('Endereço do Proxy Transpilador (padrão local na TV: http://127.0.0.1:8899):', proxyBase);
    if (nextProxy && /^https?:\/\//i.test(nextProxy.trim())) {
      proxyBase = nextProxy.trim().replace(/\/+$/, '');
      localStorage.setItem('neo_proxy_base', proxyBase);
      proxyEndpointDisplay.textContent = proxyBase;
      checkProxyHealth();
      showToast('Proxy atualizado para ' + proxyBase);
    }
  });

  btnClearSession.addEventListener('click', function () {
    sendProxyConfig({ clearSession: true }, function () {
      showToast('Cookies e sessão do proxy limpos com sucesso');
    });
  });

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    var tab = getActiveTab();
    if (!tab) return;

    if (data.type === 'WEBOS_BROWSER_URL_CHANGED') {
      if (data.url && data.url.indexOf('http') === 0) {
        tab.url = data.url;
        urlInput.value = data.url;
      }
      if (data.title) {
        tab.title = data.title;
        renderTabs();
      }
      checkProxyHealth();
    } else if (data.type === 'WEBOS_BROWSER_OPEN_TAB') {
      if (data.url) {
        createTab(data.url);
        showToast('Nova aba aberta: ' + data.url);
      }
    } else if (data.type === 'WEBOS_BROWSER_MEDIA_DETECTED') {
      if (data.mediaUrl && tab.mediaUrls.indexOf(data.mediaUrl) === -1) {
        tab.mediaUrls.push(data.mediaUrl);
        updateMediaButton(tab);
        showToast('Vídeo detectado! Clique em "▶ Vídeo Nativo" para reproduzir via hardware');
      }
    }
  });

  // Inicializa atalhos do Controle Remoto LG
  window.NeoRemoteNav.init({
    onBack: function () {
      if (state.chromeCollapsed) {
        toggleTopChrome(false);
      } else {
        goBack();
      }
    },
    onRedButton: function () { toggleTopChrome(); },
    onGreenButton: function () { cycleZoom(); },
    onYellowButton: function () { toggleAdblock(); },
    onBlueButton: function () { cycleUserAgent(); },
    onScrollPage: function (deltaY) {
      if (browserFrame.contentWindow) {
        browserFrame.contentWindow.postMessage({ type: 'WEBOS_CMD_SCROLL', deltaY: deltaY }, '*');
      }
    }
  });

  // Inicialização
  proxyEndpointDisplay.textContent = proxyBase;
  renderSpeedDial();
  createTab('');
  startLunaService();
  checkProxyHealth();
  setInterval(checkProxyHealth, 8000);
})();
