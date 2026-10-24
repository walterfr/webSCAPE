/**
 * Bloqueador leve de Anúncios, Trackers e Mineradores para LG webOS 5.6.2
 * Essencial para evitar crashes de Out-Of-Memory (OOM) no WAM da TV.
 */
'use strict';

var urlModule = require('url');
var URL = global.URL || urlModule.URL;

var BLOCKED_DOMAINS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adservice.google.com',
  '2mdn.net',
  'adnxs.com',
  'adsrvr.org',
  'advertising.com',
  'amazon-adsystem.com',
  'criteo.com',
  'criteo.net',
  'facebook.net',
  'Hotjar.com'.toLowerCase(),
  'moatads.com',
  'outbrain.com',
  'pubmatic.com',
  'rubiconproject.com',
  'scorecardresearch.com',
  'smartadserver.com',
  'taboola.com',
  'teads.tv',
  'tiktok.com/i18n/pixel',
  'unityads.unity3d.com',
  'yandex.ru/metrika',
  'zedo.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'adsterra.com',
  'exoclick.com',
  'juicyads.com',
  'trafficjunky.net',
  'clarity.ms',
  'mouseflow.com',
  'fullstory.com',
  'newrelic.com',
  'nr-data.net',
  'bugsnag.com',
  'sentry.io'
];

var BLOCKED_PATH_PATTERNS = [
  /\/ads\/|\/adserver|\/adframe|\/adview|\/pagead\//i,
  /\/popunder|\/popup\.js|\/prebid/i,
  /\/analytics\.js|\/gtag\/js|\/fbevents\.js/i
];

var enabled = true;
var totalBlocked = 0;

function shouldBlock(rawUrl) {
  if (!enabled || !rawUrl) return false;
  try {
    var parsed = new URL(rawUrl);
    var host = parsed.hostname.toLowerCase();

    for (var i = 0; i < BLOCKED_DOMAINS.length; i++) {
      var d = BLOCKED_DOMAINS[i];
      if (host === d || host.endsWith('.' + d)) {
        totalBlocked++;
        return true;
      }
    }

    var fullPath = parsed.pathname + parsed.search;
    for (var j = 0; j < BLOCKED_PATH_PATTERNS.length; j++) {
      if (BLOCKED_PATH_PATTERNS[j].test(fullPath)) {
        totalBlocked++;
        return true;
      }
    }
  } catch (_) {}
  return false;
}

function setEnabled(state) {
  enabled = !!state;
  return enabled;
}

function getStats() {
  return {
    enabled: enabled,
    totalBlocked: totalBlocked
  };
}

module.exports = {
  shouldBlock: shouldBlock,
  setEnabled: setEnabled,
  getStats: getStats
};
