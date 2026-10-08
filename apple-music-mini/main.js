const { app, BrowserWindow, session, shell } = require('electron');

// `components` solo existe en castlabs-electron (trae Widevine/DRM).
// En el Electron normal es undefined: la UI carga pero las canciones
// protegidas no se reproducen.
const { components } = require('electron');
const hasWidevine = !!(components && components.whenReady);

async function createWindow() {
  const win = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 360,
    minHeight: 480,
    title: 'Apple Music',
    backgroundColor: '#000000',
    autoHideMenuBar: true, // oculta la barra de menú (se ve con Alt)
    webPreferences: {
      // Un user-agent de Chrome real evita que Apple muestre
      // "navegador no soportado".
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL('https://music.apple.com');

  // Abrir enlaces externos (ej. iTunes, soporte) en el navegador del sistema
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://music.apple.com')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

app.whenReady().then(async () => {
  // Carga el CDM de Widevine antes de crear la ventana (solo castlabs)
  if (hasWidevine) {
    await components.whenReady();
    console.log('Widevine status:', components.status());
  } else {
    console.warn(
      '[aviso] Electron sin Widevine: la UI funciona pero las canciones ' +
        'protegidas por DRM no se reproducirán. Usa castlabs-electron.'
    );
  }

  // UA de Chrome para que Apple Music no bloquee el navegador
  session.defaultSession.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
