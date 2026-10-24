/**
 * Servidor de Desenvolvimento / Modo LAN
 * Sobe o Proxy Transpilador em 0.0.0.0:8899 para testes no PC ou acesso via LAN pela TV
 */
'use strict';

var proxyModule = require('./proxy');
var PORT = Number(process.env.WEBOS_PROXY_PORT) || 8899;
var HOST = process.env.WEBOS_PROXY_HOST || '127.0.0.1';

var instance = proxyModule.createProxyServer(PORT, HOST);
instance.start(function (err, info) {
  if (err) {
    console.error('Erro ao iniciar servidor:', err);
    process.exit(1);
  }
  console.log('=====================================================');
  console.log(' Proxy Transpilador webOS 5.6.2 (Chrome 68) ATIVO');
  console.log(' Endpoint: ' + info.proxyBase);
  console.log(' Health:   ' + info.proxyBase + '/health');
  console.log('=====================================================');
});
