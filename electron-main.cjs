const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Zobrazované jméno aplikace (titulek, menu) – může mít diakritiku,
// i když název balíčku je bezdiakritický kvůli podpisu na macOS.
app.setName("Mzdová kalkulačka");

const isDev = !app.isPackaged;

// Zachyť každou nezachycenou chybu v hlavním procesu a ukaž ji,
// místo aby appka tiše spadla.
process.on("uncaughtException", (err) => {
  try {
    dialog.showErrorBox("Chyba aplikace", String(err && err.stack ? err.stack : err));
  } catch (_) {}
  console.error("uncaughtException:", err);
});

function resolveIndexHtml() {
  // Zkus několik míst, kam se index.html může v balíčku dostat
  const candidates = [
    path.join(__dirname, "dist", "index.html"),
    path.join(process.resourcesPath || "", "app", "dist", "index.html"),
    path.join(process.resourcesPath || "", "dist", "index.html"),
    path.join(app.getAppPath(), "dist", "index.html"),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[0]; // fallback, ať aspoň zkusí
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 380,
    minHeight: 600,
    title: "Mzdová kalkulačka",
    backgroundColor: "#f2f4f8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    const indexPath = resolveIndexHtml();
    win.loadFile(indexPath).catch((err) => {
      dialog.showErrorBox(
        "Nepodařilo se načíst aplikaci",
        "Cesta: " + indexPath + "\n\n" + String(err)
      );
    });
  }

  // Když se obsah okna nenačte, ukaž důvod místo prázdného/zavřeného okna
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    dialog.showErrorBox(
      "Načtení selhalo",
      `Kód: ${code}\nPopis: ${desc}\nURL: ${url}`
    );
  });

  // Externí odkazy otvírej v systémovém prohlížeči
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
