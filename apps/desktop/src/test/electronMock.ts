import { vi } from "vitest";

class MockBrowserWindow {
  readonly webContents = {
    on: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };

  center = vi.fn();
  close = vi.fn();
  destroy = vi.fn();
  focus = vi.fn();
  isDestroyed = vi.fn(() => false);
  isMinimized = vi.fn(() => false);
  loadFile = vi.fn(() => Promise.resolve());
  loadURL = vi.fn(() => Promise.resolve());
  maximize = vi.fn();
  minimize = vi.fn();
  on = vi.fn();
  once = vi.fn();
  removeListener = vi.fn();
  restore = vi.fn();
  setMenuBarVisibility = vi.fn();
  show = vi.fn();
}

vi.mock("electron", () => ({
  app: {
    commandLine: {
      appendSwitch: vi.fn(),
    },
    dock: {
      setIcon: vi.fn(),
    },
    exit: vi.fn(),
    getAppPath: vi.fn(() => "/app"),
    getPath: vi.fn(() => "/tmp"),
    getVersion: vi.fn(() => "0.0.0"),
    isPackaged: false,
    name: "T3 Code",
    on: vi.fn(),
    quit: vi.fn(),
    relaunch: vi.fn(),
    removeListener: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    runningUnderARM64Translation: false,
    setAboutPanelOptions: vi.fn(),
    setAppUserModelId: vi.fn(),
    setDesktopName: vi.fn(),
    setName: vi.fn(),
    setPath: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  BrowserWindow: MockBrowserWindow,
  clipboard: {
    writeText: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false })),
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn((template) => ({ template })),
    setApplicationMenu: vi.fn(),
  },
  nativeImage: {
    createFromPath: vi.fn((path) => ({ path })),
  },
  nativeTheme: {
    on: vi.fn(),
    removeListener: vi.fn(),
    shouldUseDarkColors: false,
    themeSource: "system",
  },
  protocol: {
    handle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
    unhandle: vi.fn(),
  },
  safeStorage: {
    decryptString: vi.fn((value) => value.toString("utf8")),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    isEncryptionAvailable: vi.fn(() => true),
  },
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(() => Promise.resolve()),
  },
}));
