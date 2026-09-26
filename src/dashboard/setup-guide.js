'use strict';
// Setup-guide page wiring. External file because MV3's default CSP blocks
// inline scripts on extension pages (the old inline handlers never ran).
(function () {
  var back = document.getElementById('back-dashboard');
  if (back) {
    back.addEventListener('click', function () {
      var url = chrome.runtime.getURL('src/dashboard/dashboard.html#account');
      chrome.tabs.create({ url });
      window.close();
    });
  }
  var online = document.getElementById('open-online');
  if (online) {
    online.addEventListener('click', function () {
      if (window.UNSetupLinks) UNSetupLinks.openSetupSite();
    });
  }
})();
