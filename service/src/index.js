/**
 * Entrypoint do Background JS Service para LG webOS 5.6.2 (com.webscape.app.service)
 * - Registra métodos no Luna Bus (webos-service) com suporte a subscription keep-alive
 * - Inicia o Servidor Proxy Transpilador em 127.0.0.1:8899
 * - Funciona também fora da TV (modo LAN/PC) se webos-service não existir
 */
'use strict';

// Polyfill global.URL para Node.js 8.12.0 no webOS 5.6.2
var urlModule = require('url');
if (typeof URL === 'undefined' && urlModule.URL) {
  global.URL = urlModule.URL;
}

var proxyModule = require('./proxy');
var adblock = require('./adblock');

var PROXY_PORT = Number(process.env.WEBOS_PROXY_PORT) || 8899;
var PROXY_HOST = process.env.WEBOS_PROXY_HOST || '127.0.0.1';

var proxyInstance = proxyModule.createProxyServer(PROXY_PORT, PROXY_HOST);
var proxyInfo = {
  running: false,
  port: PROXY_PORT,
  host: PROXY_HOST,
  proxyBase: 'http://' + PROXY_HOST + ':' + PROXY_PORT
};

proxyInstance.start(function (err, info) {
  if (!err && info) {
    proxyInfo.running = true;
    proxyInfo.port = info.port;
    proxyInfo.host = info.host;
    proxyInfo.proxyBase = info.proxyBase;
    console.log('[webSCAPE] Proxy Transpilador ativo em ' + info.proxyBase);
  } else {
    console.error('[webSCAPE] Erro ao iniciar proxy:', err && err.message);
  }
});

// Integração com Luna Bus (webos-service nativo da TV LG)
var Service = null;
try {
  Service = require('webos-service');
} catch (_) {
  Service = null;
}

if (Service) {
  var service = new Service('com.webscape.app.service');
  var subscriptions = Object.create(null);
  var heartbeatTimer = null;

  // Mantém o serviço vivo na TV enquanto o navegador estiver aberto (evita idle timeout de 30s do webOS)
  if (service.activityManager && typeof service.activityManager.create === 'function') {
    try {
      service.activityManager.create('keepAlive', function () {});
    } catch (_) {}
  }

  var startMethod = service.register('startProxy');
  startMethod.on('request', function (message) {
    var isSub = message.isSubscription;
    if (isSub) {
      subscriptions[message.uniqueToken] = message;
      if (!heartbeatTimer) {
        heartbeatTimer = setInterval(function () {
          var tokens = Object.keys(subscriptions);
          if (tokens.length === 0) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
            return;
          }
          for (var i = 0; i < tokens.length; i++) {
            try {
              subscriptions[tokens[i]].respond({
                returnValue: true,
                running: proxyInfo.running,
                proxyBase: proxyInfo.proxyBase,
                controlToken: proxyInstance.controlToken,
                adblock: adblock.getStats()
              });
            } catch (_) {
              delete subscriptions[tokens[i]];
            }
          }
        }, 10000);
      }
    }

    message.respond({
      returnValue: true,
      running: proxyInfo.running,
      proxyBase: proxyInfo.proxyBase,
      controlToken: proxyInstance.controlToken,
      adblock: adblock.getStats(),
      subscribed: !!isSub
    });
  });

  startMethod.on('cancel', function (message) {
    delete subscriptions[message.uniqueToken];
  });

  service.register('status', function (message) {
    message.respond({
      returnValue: true,
      running: proxyInfo.running,
      proxyBase: proxyInfo.proxyBase,
      controlToken: proxyInstance.controlToken,
      adblock: adblock.getStats()
    });
  });
}
