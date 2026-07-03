/*
 * native-bridge.js — durable storage + auto-backup for Avon Traders when it runs
 * inside a Capacitor (Android/iOS) shell. On the plain web/PWA it does nothing:
 * window.NativeStore.available === false and the app keeps using localStorage.
 *
 * How it works on device:
 *  - The app still writes to localStorage synchronously (fast working copy).
 *  - After every save, the whole DB JSON is also written to a real file in the
 *    app's private data folder (Filesystem, Directory.DATA). This survives the
 *    browser clearing its cache, unlike localStorage in a normal PWA.
 *  - On launch, hydrate() reads that file back into localStorage BEFORE the app
 *    loads its data — so even if the WebView storage was wiped, data returns.
 *  - Once a day a timestamped copy is written to Documents/AvonBackups so the
 *    phone's own file manager / cloud backup can pick it up. Last 15 are kept.
 *  - "Backup now" opens the native share sheet with a .json file (Drive/WhatsApp).
 *
 * No bundler needed: official Capacitor plugins are reached via
 * Capacitor.registerPlugin(...) which the native runtime wires to the native code.
 */
(function () {
  var CAP = window.Capacitor;
  var isNative = !!(CAP && typeof CAP.isNativePlatform === 'function' && CAP.isNativePlatform());

  if (!isNative) {
    window.NativeStore = { available: false,
      hydrate: function () { return Promise.resolve(); },
      persist: function () {},
      exportNow: function () { return Promise.reject('web'); } };
    return;
  }

  // Native plugin proxies (native side installed via Gradle/CocoaPods from npm).
  var Filesystem = CAP.registerPlugin('Filesystem');
  var Share = CAP.registerPlugin('Share');

  var DB_FILE = 'avon_db.json';
  var BK_DIR = 'AvonBackups';
  var DIR_DATA = 'DATA';         // app-private, persistent
  var DIR_DOCS = 'DOCUMENTS';    // user-visible on Android via Files app
  var DIR_CACHE = 'CACHE';       // temp, for share
  var ENC = 'utf8';

  var writeTimer = null;
  var pendingJson = null;
  var lastBackupDay = null;

  function writeDbFile(json) {
    return Filesystem.writeFile({ path: DB_FILE, directory: DIR_DATA, encoding: ENC, data: json });
  }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function ensureBackupDir() {
    return Filesystem.mkdir({ path: BK_DIR, directory: DIR_DOCS, recursive: true })
      .catch(function () { /* already exists */ });
  }

  // Keep only the newest `keep` backup files.
  function pruneBackups(keep) {
    return Filesystem.readdir({ path: BK_DIR, directory: DIR_DOCS }).then(function (res) {
      var files = (res && res.files) ? res.files : [];
      // v6 returns objects {name,...}; older returns strings.
      var names = files.map(function (f) { return (typeof f === 'string') ? f : f.name; })
        .filter(function (n) { return n && n.indexOf('avon-') === 0; })
        .sort(); // names contain YYYYMMDD so lexical sort == chronological
      var extra = names.length - keep;
      var chain = Promise.resolve();
      for (var i = 0; i < extra; i++) {
        (function (nm) {
          chain = chain.then(function () {
            return Filesystem.deleteFile({ path: BK_DIR + '/' + nm, directory: DIR_DOCS }).catch(function () {});
          });
        })(names[i]);
      }
      return chain;
    }).catch(function () {});
  }

  function maybeDailyBackup(json) {
    var day = todayKey();
    if (lastBackupDay === day) return Promise.resolve();
    lastBackupDay = day;
    return ensureBackupDir().then(function () {
      return Filesystem.writeFile({
        path: BK_DIR + '/avon-' + day + '.json',
        directory: DIR_DOCS, encoding: ENC, data: json
      });
    }).then(function () { return pruneBackups(15); }).catch(function () {});
  }

  function flush() {
    var json = pendingJson; pendingJson = null;
    if (json == null) return;
    writeDbFile(json).then(function () { return maybeDailyBackup(json); }).catch(function () {});
  }

  window.NativeStore = {
    available: true,

    // Read the durable file into localStorage before the app loads its data.
    hydrate: function (key) {
      return Filesystem.readFile({ path: DB_FILE, directory: DIR_DATA, encoding: ENC })
        .then(function (r) {
          if (r && r.data) {
            try { localStorage.setItem(key, r.data); } catch (e) {}
          }
        })
        .catch(function () { /* first run: no file yet */ });
    },

    // Debounced durable write of the whole DB JSON.
    persist: function (json) {
      pendingJson = json;
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(flush, 400);
    },

    // Manual backup -> native share sheet (Drive / WhatsApp / email).
    exportNow: function (json, filename) {
      var name = filename || ('AvonTraders-backup-' + new Date().toISOString().slice(0, 10) + '.json');
      return Filesystem.writeFile({ path: name, directory: DIR_CACHE, encoding: ENC, data: json })
        .then(function () { return Filesystem.getUri({ path: name, directory: DIR_CACHE }); })
        .then(function (u) {
          return Share.share({
            title: 'Avon Traders backup',
            text: 'Avon Traders data backup',
            url: u.uri,
            dialogTitle: 'Save / send backup'
          });
        });
    }
  };
})();
