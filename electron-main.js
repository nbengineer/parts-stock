const { app, BrowserWindow, dialog, Menu } = require("electron");
const { start, PORT } = require("./server");

let mainWindow = null;
let server = null;

function showWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "零件库存对照",
    backgroundColor: "#f6f1e8",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setName("零件库存对照");
    Menu.setApplicationMenu(null);
    try {
      const started = await start();
      server = started.server;
      showWindow(started.port);
    } catch (error) {
      if (error.code === "EADDRINUSE") {
        showWindow(error.port || PORT);
        return;
      }
      dialog.showErrorBox("零件库存对照", error.message || "启动失败");
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    if (server) server.close();
    app.quit();
  });
}
