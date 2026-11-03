// SeiLink spike round 2 (Windows): room-host watcher, attach validation, coverage signal.
// Included from win.cc inside its anonymous namespace (uses Hex/ClassOf/TitleOf/FindDesk/WinInfo).
//
// watchStart(cb): one thread owns a hidden top-level window and the WinEventHooks.
//   - hidden top-level (not HWND_MESSAGE): broadcasts like TaskbarCreated, WM_DISPLAYCHANGE and
//     WM_SETTINGCHANGE only reach top-level windows, and the attached room is a WS_CHILD.
//   - WTSRegisterSessionNotification -> WM_WTSSESSION_CHANGE (lock/unlock).
//   - SetWinEventHook EVENT_SYSTEM_FOREGROUND / MINIMIZESTART..END / MOVESIZEEND globally, plus
//     EVENT_OBJECT_LOCATIONCHANGE scoped to the foreground window's thread (re-hooked on every
//     foreground change), so maximize/restore of the front window is seen without a global
//     high-frequency hook. All triggers coalesce into one 50 ms timer -> one coverage check.
// cb receives JSON strings; see Emit() call sites for the shapes.

Napi::ThreadSafeFunction g_tsfn;
std::atomic<bool> g_watchStarted{false};
UINT g_msgTaskbarCreated = 0;
HWND g_watchHwnd = nullptr;
std::atomic<uint64_t> g_hookEvents{0}, g_coverChecks{0}, g_coverChanges{0};
HWINEVENTHOOK g_locHook = nullptr;
HWND g_fgForHook = nullptr;
int g_lastCovered = -1;
std::string g_pendingWhy;

std::string JsonEsc(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 2);
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') {
      o += '\\';
      o += (char)c;
    } else if (c < 0x20) {
      char b[8];
      snprintf(b, sizeof b, "\\u%04x", c);
      o += b;
    } else {
      o += (char)c;
    }
  }
  return o;
}
std::string Q(const std::string& s) { return "\"" + JsonEsc(s) + "\""; }

void Emit(std::string json) {
  if (!g_tsfn) return;
  auto* p = new std::string(std::move(json));
  napi_status st = g_tsfn.NonBlockingCall(p, [](Napi::Env env, Napi::Function cb, std::string* s) {
    if (env != nullptr && !cb.IsEmpty()) cb.Call({Napi::String::New(env, *s)});
    delete s;
  });
  if (st != napi_ok) delete p;
}

uint64_t NowMs() { return GetTickCount64(); }

struct Cover {
  bool covered = false;
  std::string kind;  // "maximized" | "fullscreen" | "d3d-fullscreen" | ""
  std::string cls, title;
  DWORD pid = 0;
  RECT r{};
  int scanned = 0;
  int skippedShell = 0;
  int quns = 0;
  HWND hwnd = nullptr;
};

// True when rect `in` covers rect `outer` (within tol px). Round 2 runs 1-3 called it with the
// arguments swapped, so every on-monitor window read as "fullscreen".
bool Contains(const RECT& outer, const RECT& in, int tol) {
  return in.left <= outer.left + tol && in.top <= outer.top + tol && in.right >= outer.right - tol &&
         in.bottom >= outer.bottom - tol;
}

std::string ExeOf(DWORD pid) {
  HANDLE ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!ph) return "";
  wchar_t buf[MAX_PATH];
  DWORD n = MAX_PATH;
  std::string out;
  if (QueryFullProcessImageNameW(ph, 0, buf, &n)) {
    std::wstring w(buf, n);
    size_t k = w.find_last_of(L"\\/");
    if (k != std::wstring::npos) w = w.substr(k + 1);
    int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    out.resize(len);
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &out[0], len, nullptr, nullptr);
  }
  CloseHandle(ph);
  return out;
}

struct CoverCtx {
  Cover* cv;
  HMONITOR mon;
  MONITORINFO mi;
  DWORD self;
  std::vector<std::string>* all;  // debug: every window that passes the rule (no early stop)
};

// Any visible, uncloaked, non-minimized window that is maximized on the room's monitor or covers
// the whole monitor hides the wallpaper, whatever its z-order (the room is the bottom layer).
// Returns the kind, or nullptr when the window does not cover the room.
const char* CoverKind(HWND t, CoverCtx* c, RECT* outR) {
  if (!IsWindowVisible(t) || IsIconic(t)) return nullptr;
  LONG_PTR ex = GetWindowLongPtrW(t, GWL_EXSTYLE);
  if (ex & (WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW)) return nullptr;
  BOOL cloaked = FALSE;
  DwmGetWindowAttribute(t, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
  if (cloaked) return nullptr;
  std::string cls = ClassOf(t);
  if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd")
    return nullptr;
  // Shell-owned windows that are "visible" and uncloaked but draw nothing. Run 1 flagged
  // ApplicationManager_ImmersiveShellWindow, but run 1 also had the swapped Contains bug, so this
  // list is a guard that has not been shown necessary on its own.
  static const char* kInvisibleShell[] = {"ApplicationManager_ImmersiveShellWindow", "EdgeUiInputTopWndClass",
                                          "EdgeUiInputWndClass", "NativeHWNDHost", "Internet Explorer_Hidden",
                                          "ApplicationManager_DesktopShellWindow", "ForegroundStaging",
                                          "MultitaskingViewFrame", "XamlExplorerHostIslandWindow"};
  for (const char* k : kInvisibleShell)
    if (cls == k) {
      c->cv->skippedShell++;
      return nullptr;
    }
  // The room host's own windows never cover the room.
  DWORD pid = 0;
  GetWindowThreadProcessId(t, &pid);
  if (pid == c->self) return nullptr;
  if (ex & WS_EX_LAYERED) {
    BYTE alpha = 255;
    DWORD flags = 0;
    if (GetLayeredWindowAttributes(t, nullptr, &alpha, &flags) && (flags & LWA_ALPHA) && alpha < 16) return nullptr;
  }
  if (MonitorFromWindow(t, MONITOR_DEFAULTTONULL) != c->mon) return nullptr;
  RECT r{};
  if (FAILED(DwmGetWindowAttribute(t, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof(r)))) GetWindowRect(t, &r);
  *outR = r;
  if (Contains(c->mi.rcMonitor, r, 2)) return "fullscreen";  // the window covers the monitor
  if (IsZoomed(t) && Contains(c->mi.rcWork, r, 10)) return "maximized";
  return nullptr;
}

Cover ComputeCover(std::vector<std::string>* all = nullptr) {
  Cover cv;
  HMONITOR mon = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);  // spike: primary display
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  GetMonitorInfoW(mon, &mi);
  CoverCtx ctx{&cv, mon, mi, GetCurrentProcessId(), all};
  EnumWindows(
      [](HWND t, LPARAM lp) -> BOOL {
        auto* c = (CoverCtx*)lp;
        c->cv->scanned++;
        RECT r{};
        const char* kind = CoverKind(t, c, &r);
        if (!kind) return TRUE;
        DWORD pid = 0;
        GetWindowThreadProcessId(t, &pid);
        if (c->all) {
          char b[400];
          snprintf(b, sizeof b,
                   "{\"hwnd\":\"%s\",\"kind\":\"%s\",\"pid\":%lu,\"style\":\"0x%lX\",\"ex\":\"0x%lX\","
                   "\"rect\":{\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld}",
                   Hex((uintptr_t)t).c_str(), kind, pid, (unsigned long)GetWindowLongPtrW(t, GWL_STYLE),
                   (unsigned long)GetWindowLongPtrW(t, GWL_EXSTYLE), r.left, r.top, r.right - r.left, r.bottom - r.top);
          c->all->push_back(std::string(b) + ",\"class\":" + Q(ClassOf(t)) + ",\"title\":" + Q(TitleOf(t)) +
                            ",\"exe\":" + Q(ExeOf(pid)) + ",\"owner\":\"" + Hex((uintptr_t)GetWindow(t, GW_OWNER)) + "\"}");
        }
        if (!c->cv->covered) {
          c->cv->covered = true;
          c->cv->kind = kind;
          c->cv->cls = ClassOf(t);
          c->cv->title = TitleOf(t);
          c->cv->pid = pid;
          c->cv->r = r;
          c->cv->hwnd = t;
        }
        return c->all ? TRUE : FALSE;
      },
      (LPARAM)&ctx);
  QUERY_USER_NOTIFICATION_STATE q{};
  if (SUCCEEDED(SHQueryUserNotificationState(&q))) {
    cv.quns = (int)q;
    if (!cv.covered && q == QUNS_RUNNING_D3D_FULL_SCREEN) {
      cv.covered = true;
      cv.kind = "d3d-fullscreen";
    }
  }
  return cv;
}

std::string CoverJson(const Cover& cv) {
  char rb[96];
  snprintf(rb, sizeof rb, "{\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld}", cv.r.left, cv.r.top, cv.r.right - cv.r.left,
           cv.r.bottom - cv.r.top);
  HWND fg = GetForegroundWindow();
  return std::string("{\"covered\":") + (cv.covered ? "true" : "false") + ",\"kind\":" + Q(cv.kind) +
         ",\"by\":{\"class\":" + Q(cv.cls) + ",\"title\":" + Q(cv.title) + ",\"pid\":" + std::to_string(cv.pid) + ",\"exe\":" + Q(cv.pid ? ExeOf(cv.pid) : "") +
         ",\"hwnd\":" + Q(Hex((uintptr_t)cv.hwnd)) + ",\"rect\":" + rb + "},\"fgClass\":" + Q(fg ? ClassOf(fg) : "") +
         ",\"quns\":" + std::to_string(cv.quns) + ",\"scanned\":" + std::to_string(cv.scanned) +
         ",\"skippedShell\":" + std::to_string(cv.skippedShell) + "}";
}

void Recheck(const std::string& why) {
  g_coverChecks++;
  uint64_t t0 = NowMs();
  Cover cv = ComputeCover();
  int c = cv.covered ? 1 : 0;
  if (c != g_lastCovered) {
    g_lastCovered = c;
    g_coverChanges++;
    Emit("{\"type\":\"coverage\",\"trigger\":" + Q(why) + ",\"checkMs\":" + std::to_string(NowMs() - t0) +
         ",\"tick\":" + std::to_string(t0) + ",\"state\":" + CoverJson(cv) + "}");
  }
}

void ScheduleRecheck(const std::string& why) {
  if (g_pendingWhy.empty()) g_pendingWhy = why;
  SetTimer(g_watchHwnd, 1, 50, nullptr);
}

void CALLBACK HookProc(HWINEVENTHOOK, DWORD ev, HWND hwnd, LONG idObj, LONG idChild, DWORD, DWORD) {
  g_hookEvents++;
  if (ev == EVENT_OBJECT_LOCATIONCHANGE) {
    if (idObj != OBJID_WINDOW || idChild != CHILDID_SELF || hwnd != g_fgForHook) return;
    ScheduleRecheck("locationchange");
    return;
  }
  if (ev == EVENT_SYSTEM_FOREGROUND) {
    HWND fg = GetForegroundWindow();
    if (fg != g_fgForHook) {
      g_fgForHook = fg;
      if (g_locHook) UnhookWinEvent(g_locHook);
      g_locHook = nullptr;
      DWORD pid = 0, tid = fg ? GetWindowThreadProcessId(fg, &pid) : 0;
      if (tid)
        g_locHook = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, nullptr, HookProc, pid,
                                    tid, WINEVENT_OUTOFCONTEXT);
    }
    ScheduleRecheck("foreground:" + (fg ? ClassOf(fg) : std::string("null")));
    return;
  }
  ScheduleRecheck(ev == EVENT_SYSTEM_MINIMIZESTART ? "minimizestart"
                  : ev == EVENT_SYSTEM_MINIMIZEEND ? "minimizeend"
                  : ev == EVENT_SYSTEM_MOVESIZEEND ? "movesizeend"
                                                   : "winevent");
}

LRESULT CALLBACK WatchProc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
  if (g_msgTaskbarCreated && m == g_msgTaskbarCreated) {
    Emit("{\"type\":\"taskbarCreated\",\"tick\":" + std::to_string(NowMs()) + "}");
    ScheduleRecheck("taskbarCreated");
    return 0;
  }
  switch (m) {
    case WM_DISPLAYCHANGE:
      Emit("{\"type\":\"displayChange\",\"w\":" + std::to_string(LOWORD(lp)) + ",\"h\":" + std::to_string(HIWORD(lp)) +
           ",\"bpp\":" + std::to_string((int)wp) + ",\"tick\":" + std::to_string(NowMs()) + "}");
      ScheduleRecheck("displayChange");
      break;
    case WM_SETTINGCHANGE:
      Emit("{\"type\":\"settingChange\",\"action\":" + std::to_string((unsigned)wp) +
           ",\"tick\":" + std::to_string(NowMs()) + "}");
      break;
    case WM_WTSSESSION_CHANGE:
      Emit("{\"type\":\"session\",\"code\":" + std::to_string((unsigned)wp) + ",\"tick\":" + std::to_string(NowMs()) + "}");
      break;
    case WM_POWERBROADCAST:
      Emit("{\"type\":\"power\",\"code\":" + std::to_string((unsigned)wp) + "}");
      break;
    case WM_TIMER:
      if (wp == 1) {
        KillTimer(h, 1);
        std::string why = g_pendingWhy.empty() ? "timer" : g_pendingWhy;
        g_pendingWhy.clear();
        Recheck(why);
      }
      return 0;
  }
  return DefWindowProcW(h, m, wp, lp);
}

void WatchThread() {
  WNDCLASSW wc{};
  wc.lpfnWndProc = WatchProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"SeiLinkRoomWatch";
  RegisterClassW(&wc);
  g_msgTaskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
  // Hidden, never shown, unowned top-level window: receives broadcasts, never appears anywhere.
  g_watchHwnd = CreateWindowExW(WS_EX_NOACTIVATE, wc.lpszClassName, L"SeiLinkRoomWatch", WS_POPUP, 0, 0, 0, 0,
                                nullptr, nullptr, wc.hInstance, nullptr);
  ChangeWindowMessageFilterEx(g_watchHwnd, g_msgTaskbarCreated, MSGFLT_ALLOW, nullptr);
  BOOL wts = WTSRegisterSessionNotification(g_watchHwnd, NOTIFY_FOR_THIS_SESSION);
  HWINEVENTHOOK h1 = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, HookProc, 0, 0,
                                     WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  HWINEVENTHOOK h2 = SetWinEventHook(EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND, nullptr, HookProc, 0, 0,
                                     WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  HWINEVENTHOOK h3 = SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, nullptr, HookProc, 0, 0,
                                     WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  // Seed the scoped location hook for the current foreground window.
  HookProc(nullptr, EVENT_SYSTEM_FOREGROUND, GetForegroundWindow(), OBJID_WINDOW, CHILDID_SELF, 0, 0);
  Emit(std::string("{\"type\":\"watchStarted\",\"hwnd\":") + Q(Hex((uintptr_t)g_watchHwnd)) +
       ",\"taskbarCreatedMsg\":" + std::to_string(g_msgTaskbarCreated) + ",\"wts\":" + (wts ? "true" : "false") +
       ",\"hooks\":" + ((h1 && h2 && h3) ? "true" : "false") + "}");
  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
}

Napi::Value WatchStart(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_watchStarted.exchange(true)) return Napi::Boolean::New(env, false);
  g_tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "seilink-watch", 0, 1);
  g_tsfn.Unref(env);
  std::thread(WatchThread).detach();
  return Napi::Boolean::New(env, true);
}

Napi::Value WatchStats(const Napi::CallbackInfo& info) {
  auto o = Napi::Object::New(info.Env());
  o.Set("hookEvents", (double)g_hookEvents.load());
  o.Set("coverChecks", (double)g_coverChecks.load());
  o.Set("coverChanges", (double)g_coverChanges.load());
  return o;
}

Napi::Value CoverageNow(const Napi::CallbackInfo& info) {
  uint64_t t0 = NowMs();
  std::vector<std::string> all;
  Cover cv = ComputeCover(&all);
  std::string j = CoverJson(cv);
  std::string a = "[";
  for (size_t i = 0; i < all.size(); i++) a += (i ? "," : "") + all[i];
  a += "]";
  auto o = Napi::Object::New(info.Env());
  o.Set("json", j);
  o.Set("candidates", a);
  o.Set("ms", (double)(NowMs() - t0));
  return o;
}

// validate(hwnd, {w,h}): is the room still where attach() put it? Cheap (a few GetWindow calls plus
// one EnumWindows in FindDesk). Reasons list what is wrong; the host re-attaches when !ok.
Napi::Value Validate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND h = HwndFrom(info[0]);
  auto opts = info.Length() > 1 && info[1].IsObject() ? info[1].As<Napi::Object>() : Napi::Object::New(env);
  int ew = opts.Has("w") ? opts.Get("w").As<Napi::Number>().Int32Value() : 0;
  int eh = opts.Has("h") ? opts.Get("h").As<Napi::Number>().Int32Value() : 0;
  auto o = Napi::Object::New(env);
  auto reasons = Napi::Array::New(env);
  uint32_t ri = 0;
  auto bad = [&](const std::string& s) { reasons.Set(ri++, s); };
  Desk d = FindDesk(false, nullptr);
  o.Set("layout", d.raised ? "raised" : "classic");
  o.Set("progman", Hex((uintptr_t)d.progman));
  o.Set("workerW", Hex((uintptr_t)d.workerW));
  if (!d.progman) bad("no-progman");
  if (!d.defView) bad("no-defview");
  if (!IsWindow(h)) {
    bad("own-window-gone");
  } else {
    HWND parent = GetAncestor(h, GA_PARENT);
    o.Set("parent", Hex((uintptr_t)parent));
    o.Set("parentClass", parent ? ClassOf(parent) : "");
    if (d.raised) {
      if (parent != d.progman) bad("parent-not-progman");
      if (d.defView && GetWindow(d.defView, GW_HWNDNEXT) != h) bad("not-directly-below-defview");
      if (!d.workerW) bad("no-workerw");
      else {
        HWND last = nullptr;
        for (HWND c = GetWindow(d.progman, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT)) last = c;
        if (last != d.workerW) bad("workerw-not-bottom");
      }
    } else {
      if (!d.workerW) bad("no-workerw");
      else if (parent != d.workerW) bad("parent-not-wallpaper-workerw");
    }
    RECT r{};
    GetWindowRect(h, &r);
    o.Set("rect", RectObj(env, r));
    if (ew && eh && (r.right - r.left != ew || r.bottom - r.top != eh)) bad("size-mismatch");
    if (!IsWindowVisible(h)) o.Set("hidden", true);
  }
  o.Set("reasons", reasons);
  o.Set("ok", ri == 0);
  return o;
}

// ---- TEST HARNESS ONLY (stand-ins for a user or for the shell misbehaving).
Napi::Value TestKeys(const Napi::CallbackInfo& info) {
  auto arr = info[0].As<Napi::Array>();
  std::vector<INPUT> in;
  for (uint32_t i = 0; i < arr.Length(); i++) {
    INPUT k{};
    k.type = INPUT_KEYBOARD;
    k.ki.wVk = (WORD)arr.Get(i).As<Napi::Number>().Uint32Value();
    in.push_back(k);
  }
  for (int i = (int)arr.Length() - 1; i >= 0; i--) {
    INPUT k{};
    k.type = INPUT_KEYBOARD;
    k.ki.wVk = (WORD)arr.Get(i).As<Napi::Number>().Uint32Value();
    k.ki.dwFlags = KEYEVENTF_KEYUP;
    in.push_back(k);
  }
  UINT n = SendInput((UINT)in.size(), in.data(), sizeof(INPUT));
  return Napi::Number::New(info.Env(), n);
}

Napi::Value TestShowWindow(const Napi::CallbackInfo& info) {
  HWND h = HwndFrom(info[0]);
  int cmd = info[1].As<Napi::Number>().Int32Value();
  BOOL r = ShowWindow(h, cmd);
  return Napi::Boolean::New(info.Env(), r != 0);
}

Napi::Value TestPostMessage(const Napi::CallbackInfo& info) {
  HWND h = HwndFrom(info[0]);
  UINT msg = info[1].As<Napi::Number>().Uint32Value();
  BOOL r = PostMessageW(h, msg, 0, 0);
  auto o = Napi::Object::New(info.Env());
  o.Set("ok", r != 0);
  o.Set("err", (double)(r ? 0 : GetLastError()));
  return o;
}

Napi::Value TestSetWallpaper(const Napi::CallbackInfo& info) {
  std::string p = info[0].As<Napi::String>().Utf8Value();
  int n = MultiByteToWideChar(CP_UTF8, 0, p.c_str(), -1, nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, p.c_str(), -1, w.data(), n);
  BOOL r = SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, (PVOID)w.c_str(), SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);
  return Napi::Boolean::New(info.Env(), r != 0);
}

Napi::Value TestDisplayModes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto arr = Napi::Array::New(env);
  DEVMODEW dm{};
  dm.dmSize = sizeof(dm);
  uint32_t n = 0;
  std::vector<std::pair<DWORD, DWORD>> seen;
  for (DWORD i = 0; EnumDisplaySettingsW(nullptr, i, &dm) && n < 40; i++) {
    std::pair<DWORD, DWORD> k{dm.dmPelsWidth, dm.dmPelsHeight};
    bool dup = false;
    for (auto& s : seen) dup = dup || s == k;
    if (dup) continue;
    seen.push_back(k);
    auto o = Napi::Object::New(env);
    o.Set("w", (double)dm.dmPelsWidth);
    o.Set("h", (double)dm.dmPelsHeight);
    arr.Set(n++, o);
  }
  return arr;
}

// testSetDisplay(w, h) changes the primary mode (not persisted); testSetDisplay(0, 0) restores.
Napi::Value TestSetDisplay(const Napi::CallbackInfo& info) {
  DWORD w = info[0].As<Napi::Number>().Uint32Value(), h = info[1].As<Napi::Number>().Uint32Value();
  LONG r;
  if (!w) {
    r = ChangeDisplaySettingsW(nullptr, 0);
  } else {
    DEVMODEW dm{};
    dm.dmSize = sizeof(dm);
    EnumDisplaySettingsW(nullptr, ENUM_CURRENT_SETTINGS, &dm);
    dm.dmPelsWidth = w;
    dm.dmPelsHeight = h;
    dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    r = ChangeDisplaySettingsW(&dm, CDS_FULLSCREEN);
  }
  return Napi::Number::New(info.Env(), (double)r);
}

// redrawParent(hwnd): repaint the room's parent (WorkerW / Progman) after hiding the room. On the
// classic layout a hidden child left its last frame on screen until something else repainted
// the WorkerW (round 2 run 1, windows-2022).
// After hiding the attached room, make its parent repaint the wallpaper under it. Round 2 run 2:
// on the classic layout (child of the 0x052C WorkerW) the hidden room's last frame stayed on
// screen. hard=true also re-applies the current wallpaper (SPI_SETDESKWALLPAPER with NULL), the
// Lively "RefreshDesktop" trick, which forces the WorkerW to repaint.
Napi::Value RedrawParent(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND h = HwndFrom(info[0]);
  bool hard = info.Length() > 1 && info[1].IsBoolean() && info[1].As<Napi::Boolean>().Value();
  HWND p = h ? GetParent(h) : nullptr;
  auto o = Napi::Object::New(env);
  o.Set("visibleAfterHide", h ? IsWindowVisible(h) != FALSE : false);
  if (h && IsWindowVisible(h)) ShowWindow(h, SW_HIDE);
  o.Set("parentClass", p ? ClassOf(p) : "");
  BOOL ok = p ? RedrawWindow(p, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW) : FALSE;
  o.Set("redraw", ok != FALSE);
  if (hard) o.Set("spi", SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, nullptr, SPIF_UPDATEINIFILE) != FALSE);
  return o;
}
