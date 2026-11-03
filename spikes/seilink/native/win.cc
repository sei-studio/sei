// SeiLink spike: Windows desktop-layer attach + window-tree dump + passive raw input.
// Technical spike only. See spikes/seilink/README.md.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <wtsapi32.h>
#include <napi.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifndef WS_EX_NOREDIRECTIONBITMAP
#define WS_EX_NOREDIRECTIONBITMAP 0x00200000L
#endif

namespace {

std::string Hex(uintptr_t v) {
  char buf[32];
  snprintf(buf, sizeof buf, "0x%llX", (unsigned long long)v);
  return buf;
}

std::string Utf8(const wchar_t* w) {
  if (!w || !*w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

std::string ClassOf(HWND h) {
  wchar_t buf[256] = {0};
  GetClassNameW(h, buf, 255);
  return Utf8(buf);
}

std::string TitleOf(HWND h) {
  wchar_t buf[256] = {0};
  // InternalGetWindowText never sends a message, so a hung Explorer cannot block us.
  using Fn = int(WINAPI*)(HWND, LPWSTR, int);
  static Fn fn = (Fn)GetProcAddress(GetModuleHandleW(L"user32.dll"), "InternalGetWindowText");
  if (fn) fn(h, buf, 255);
  return Utf8(buf);
}

HWND HwndFrom(const Napi::Value& v) {
  HWND h = nullptr;
  if (v.IsBuffer()) {
    auto b = v.As<Napi::Buffer<uint8_t>>();
    memcpy(&h, b.Data(), std::min(b.Length(), sizeof(h)));
  } else if (v.IsNumber()) {
    h = (HWND)(uintptr_t)v.As<Napi::Number>().Int64Value();
  } else if (v.IsString()) {
    h = (HWND)(uintptr_t)std::stoull(v.As<Napi::String>().Utf8Value(), nullptr, 0);
  }
  return h;
}

Napi::Object RectObj(Napi::Env env, const RECT& r) {
  auto o = Napi::Object::New(env);
  o.Set("x", r.left);
  o.Set("y", r.top);
  o.Set("w", r.right - r.left);
  o.Set("h", r.bottom - r.top);
  return o;
}

Napi::Object WinInfo(Napi::Env env, HWND h) {
  auto o = Napi::Object::New(env);
  o.Set("hwnd", Hex((uintptr_t)h));
  if (!h || !IsWindow(h)) {
    o.Set("valid", false);
    return o;
  }
  o.Set("valid", true);
  o.Set("class", ClassOf(h));
  o.Set("title", TitleOf(h));
  DWORD pid = 0;
  DWORD tid = GetWindowThreadProcessId(h, &pid);
  o.Set("pid", (double)pid);
  o.Set("tid", (double)tid);
  LONG_PTR style = GetWindowLongPtrW(h, GWL_STYLE);
  LONG_PTR ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
  o.Set("style", Hex((uintptr_t)style));
  o.Set("exStyle", Hex((uintptr_t)ex));
  auto f = Napi::Array::New(env);
  uint32_t i = 0;
  auto add = [&](bool on, const char* name) { if (on) f.Set(i++, name); };
  add(style & WS_CHILD, "WS_CHILD");
  add(style & WS_POPUP, "WS_POPUP");
  add(style & WS_VISIBLE, "WS_VISIBLE");
  add(style & WS_CAPTION, "WS_CAPTION");
  add(style & WS_THICKFRAME, "WS_THICKFRAME");
  add(ex & WS_EX_LAYERED, "WS_EX_LAYERED");
  add(ex & WS_EX_NOREDIRECTIONBITMAP, "WS_EX_NOREDIRECTIONBITMAP");
  add(ex & WS_EX_NOACTIVATE, "WS_EX_NOACTIVATE");
  add(ex & WS_EX_TOPMOST, "WS_EX_TOPMOST");
  add(ex & WS_EX_TRANSPARENT, "WS_EX_TRANSPARENT");
  add(ex & WS_EX_TOOLWINDOW, "WS_EX_TOOLWINDOW");
  add(ex & WS_EX_APPWINDOW, "WS_EX_APPWINDOW");
  add(ex & WS_EX_COMPOSITED, "WS_EX_COMPOSITED");
  o.Set("flags", f);
  if (ex & WS_EX_LAYERED) {
    COLORREF key = 0;
    BYTE alpha = 0;
    DWORD lflags = 0;
    if (GetLayeredWindowAttributes(h, &key, &alpha, &lflags)) {
      o.Set("layeredAlpha", (double)alpha);
      o.Set("layeredFlags", (double)lflags);
    }
  }
  RECT r{};
  GetWindowRect(h, &r);
  o.Set("rect", RectObj(env, r));
  HWND parent = GetAncestor(h, GA_PARENT);
  o.Set("parent", Hex((uintptr_t)parent));
  o.Set("parentClass", parent ? ClassOf(parent) : "");
  o.Set("visible", (bool)IsWindowVisible(h));
  BOOL cloaked = FALSE;
  DwmGetWindowAttribute(h, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
  o.Set("cloaked", (bool)cloaked);
  return o;
}

Napi::Array ChildrenZ(Napi::Env env, HWND parent, int depth) {
  auto arr = Napi::Array::New(env);
  uint32_t i = 0;
  for (HWND c = GetWindow(parent, GW_CHILD); c && i < 64; c = GetWindow(c, GW_HWNDNEXT)) {
    auto o = WinInfo(env, c);
    o.Set("z", i);
    if (depth > 0) o.Set("children", ChildrenZ(env, c, depth - 1));
    arr.Set(i++, o);
  }
  return arr;
}

struct OsVer {
  DWORD major = 0, minor = 0, build = 0, ubr = 0;
  std::string product, display;
};

OsVer GetOsVer() {
  OsVer v;
  using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  auto fn = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  if (fn) {
    RTL_OSVERSIONINFOW info{};
    info.dwOSVersionInfoSize = sizeof(info);
    if (fn(&info) == 0) {
      v.major = info.dwMajorVersion;
      v.minor = info.dwMinorVersion;
      v.build = info.dwBuildNumber;
    }
  }
  HKEY k;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", 0,
                    KEY_READ, &k) == ERROR_SUCCESS) {
    DWORD ubr = 0, sz = sizeof(ubr);
    if (RegQueryValueExW(k, L"UBR", nullptr, nullptr, (LPBYTE)&ubr, &sz) == ERROR_SUCCESS) v.ubr = ubr;
    wchar_t buf[256];
    sz = sizeof(buf);
    if (RegQueryValueExW(k, L"ProductName", nullptr, nullptr, (LPBYTE)buf, &sz) == ERROR_SUCCESS)
      v.product = Utf8(buf);
    sz = sizeof(buf);
    if (RegQueryValueExW(k, L"DisplayVersion", nullptr, nullptr, (LPBYTE)buf, &sz) == ERROR_SUCCESS)
      v.display = Utf8(buf);
    RegCloseKey(k);
  }
  return v;
}

struct Desk {
  HWND progman = nullptr;
  bool raised = false;
  HWND defView = nullptr;       // SHELLDLL_DefView
  HWND defViewHost = nullptr;   // window that owns DefView (Progman, or a top-level WorkerW)
  HWND workerW = nullptr;       // wallpaper WorkerW we attach into / z-order against
};

Desk FindDesk(bool spawn, LRESULT* spawnResult) {
  Desk d;
  d.progman = FindWindowW(L"Progman", nullptr);
  if (!d.progman) return d;
  d.raised = (GetWindowLongPtrW(d.progman, GWL_EXSTYLE) & WS_EX_NOREDIRECTIONBITMAP) != 0;
  if (spawn) {
    DWORD_PTR res = 0;
    SendMessageTimeoutW(d.progman, 0x052C, 0xD, 0x1, SMTO_NORMAL, 1000, &res);
    if (spawnResult) *spawnResult = (LRESULT)res;
  }
  // Classic: the top-level window holding DefView, then the next top-level WorkerW after it.
  struct Ctx { Desk* d; } ctx{&d};
  EnumWindows(
      [](HWND top, LPARAM lp) -> BOOL {
        auto* c = (Ctx*)lp;
        HWND p = FindWindowExW(top, nullptr, L"SHELLDLL_DefView", nullptr);
        if (p) {
          c->d->defView = p;
          c->d->defViewHost = top;
          c->d->workerW = FindWindowExW(nullptr, top, L"WorkerW", nullptr);
        }
        return TRUE;
      },
      (LPARAM)&ctx);
  if (d.raised) {
    // Raised (24H2+): DefView and the wallpaper WorkerW are children of Progman.
    HWND dv = FindWindowExW(d.progman, nullptr, L"SHELLDLL_DefView", nullptr);
    if (dv) {
      d.defView = dv;
      d.defViewHost = d.progman;
    }
    d.workerW = FindWindowExW(d.progman, nullptr, L"WorkerW", nullptr);
  }
  return d;
}

Napi::Object DeskObj(Napi::Env env, const Desk& d) {
  auto o = Napi::Object::New(env);
  o.Set("progman", WinInfo(env, d.progman));
  o.Set("raised", d.raised);
  o.Set("layout", d.raised ? "raised" : "classic");
  o.Set("defView", WinInfo(env, d.defView));
  o.Set("defViewHost", WinInfo(env, d.defViewHost));
  o.Set("workerW", WinInfo(env, d.workerW));
  return o;
}

// ---- inspect(): OS + desktop hierarchy, no side effects (no 0x052C).
Napi::Value Inspect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND ours = info.Length() > 0 ? HwndFrom(info[0]) : nullptr;
  auto o = Napi::Object::New(env);
  OsVer v = GetOsVer();
  auto os = Napi::Object::New(env);
  os.Set("major", (double)v.major);
  os.Set("minor", (double)v.minor);
  os.Set("build", (double)v.build);
  os.Set("ubr", (double)v.ubr);
  os.Set("product", v.product);
  os.Set("displayVersion", v.display);
  o.Set("os", os);
  Desk d = FindDesk(false, nullptr);
  o.Set("desk", DeskObj(env, d));
  if (d.progman) o.Set("progmanChildren", ChildrenZ(env, d.progman, 1));
  // Top-level windows in z-order (top first). Keep shell windows, ours, and visible ones.
  struct Ctx {
    Napi::Env env;
    Napi::Array arr;
    uint32_t n;
    uint32_t z;
    HWND ours;
  } ctx{env, Napi::Array::New(env), 0, 0, ours};
  EnumWindows(
      [](HWND top, LPARAM lp) -> BOOL {
        auto* c = (Ctx*)lp;
        uint32_t z = c->z++;
        std::string cls = ClassOf(top);
        bool shell = cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd";
        bool visible = IsWindowVisible(top);
        if (!(shell || visible || top == c->ours) || c->n >= 60) return TRUE;
        auto w = WinInfo(c->env, top);
        w.Set("z", z);
        if (FindWindowExW(top, nullptr, L"SHELLDLL_DefView", nullptr)) w.Set("hasDefView", true);
        if (cls == "WorkerW" || top == c->ours) w.Set("children", ChildrenZ(c->env, top, 1));
        c->arr.Set(c->n++, w);
        return TRUE;
      },
      (LPARAM)&ctx);
  o.Set("topLevel", ctx.arr);
  if (ours) {
    auto chain = Napi::Array::New(env);
    uint32_t i = 0;
    for (HWND h = ours; h && i < 8; h = GetAncestor(h, GA_PARENT)) {
      chain.Set(i++, WinInfo(env, h));
      if (h == GetDesktopWindow()) break;
    }
    o.Set("oursChain", chain);
    o.Set("oursChildren", ChildrenZ(env, ours, 2));
  }
  HWND fg = GetForegroundWindow();
  o.Set("foreground", WinInfo(env, fg));
  return o;
}

// ---- attach(hwnd, {mode, x, y, w, h, stripStyle}):
//   mode "auto":    raised -> WS_EX_LAYERED child of Progman under DefView, above WorkerW (MS guidance);
//                   classic -> child of the spawned top-level WorkerW (0x052C).
//   mode "workerw": child of the wallpaper WorkerW in either layout (Lively IsWorkerWParent fallback).
Napi::Value Attach(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND h = HwndFrom(info[0]);
  auto opts = info.Length() > 1 && info[1].IsObject() ? info[1].As<Napi::Object>() : Napi::Object::New(env);
  std::string mode = opts.Has("mode") ? opts.Get("mode").As<Napi::String>().Utf8Value() : "auto";
  int x = opts.Has("x") ? opts.Get("x").As<Napi::Number>().Int32Value() : 0;
  int y = opts.Has("y") ? opts.Get("y").As<Napi::Number>().Int32Value() : 0;
  int w = opts.Has("w") ? opts.Get("w").As<Napi::Number>().Int32Value() : GetSystemMetrics(SM_CXSCREEN);
  int hh = opts.Has("h") ? opts.Get("h").As<Napi::Number>().Int32Value() : GetSystemMetrics(SM_CYSCREEN);
  bool strip = !opts.Has("stripStyle") || opts.Get("stripStyle").ToBoolean().Value();

  auto out = Napi::Object::New(env);
  auto steps = Napi::Array::New(env);
  uint32_t si = 0;
  auto step = [&](const std::string& s) { steps.Set(si++, s); };

  LRESULT spawnRes = 0;
  Desk d = FindDesk(true, &spawnRes);
  step("0x052C sent, result " + std::to_string((long long)spawnRes));
  out.Set("desk", DeskObj(env, d));
  if (!d.progman) {
    out.Set("ok", false);
    out.Set("error", "no Progman");
    out.Set("steps", steps);
    return out;
  }
  bool layered = d.raised && mode == "auto";
  std::string method;
  HWND parent = nullptr;
  if (layered) {
    method = "raised: WS_EX_LAYERED child of Progman, below SHELLDLL_DefView, above WorkerW";
    parent = d.progman;
  } else {
    method = d.raised ? "raised: child of Progman's WorkerW (Lively IsWorkerWParent)"
                      : "classic: child of top-level WorkerW spawned by 0x052C";
    parent = d.workerW;
  }
  out.Set("method", method);
  if (!parent || (layered && !d.defView)) {
    out.Set("ok", false);
    out.Set("error", !parent ? "no parent WorkerW found" : "no DefView under Progman");
    out.Set("steps", steps);
    return out;
  }

  LONG_PTR style = GetWindowLongPtrW(h, GWL_STYLE);
  LONG_PTR nstyle = style | WS_CHILD;
  if (strip) nstyle &= ~(LONG_PTR)(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
  SetWindowLongPtrW(h, GWL_STYLE, nstyle);
  step("style " + Hex(style) + " -> " + Hex(GetWindowLongPtrW(h, GWL_STYLE)));

  LONG_PTR ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
  LONG_PTR nex = (ex | WS_EX_NOACTIVATE) & ~(LONG_PTR)WS_EX_APPWINDOW;
  if (layered) nex |= WS_EX_LAYERED;  // must happen BEFORE SetParent (Lively/Godot note)
  SetWindowLongPtrW(h, GWL_EXSTYLE, nex);
  if (layered) {
    BOOL okl = SetLayeredWindowAttributes(h, 0, 255, LWA_ALPHA);
    step(std::string("SetLayeredWindowAttributes(255) ") + (okl ? "ok" : "FAILED " + std::to_string(GetLastError())));
  }
  step("exStyle " + Hex(ex) + " -> " + Hex(GetWindowLongPtrW(h, GWL_EXSTYLE)));

  SetLastError(0);
  HWND prev = SetParent(h, parent);
  DWORD spErr = GetLastError();
  step("SetParent -> " + Hex((uintptr_t)parent) + " prev " + Hex((uintptr_t)prev) + " err " + std::to_string(spErr));
  if (GetAncestor(h, GA_PARENT) != parent) {
    out.Set("ok", false);
    out.Set("error", "SetParent failed, err " + std::to_string(spErr));
    out.Set("steps", steps);
    return out;
  }

  POINT p{x, y};
  ScreenToClient(parent, &p);
  UINT flags = SWP_NOACTIVATE | SWP_FRAMECHANGED;
  HWND after = nullptr;
  if (layered) {
    after = d.defView;  // insert directly below DefView
  } else {
    flags |= SWP_NOZORDER;
  }
  BOOL okp = SetWindowPos(h, after, p.x, p.y, w, hh, flags);
  step("SetWindowPos client(" + std::to_string(p.x) + "," + std::to_string(p.y) + ") " + std::to_string(w) + "x" +
       std::to_string(hh) + (okp ? " ok" : " FAILED " + std::to_string(GetLastError())));

  if (layered && d.workerW) {
    // EnsureWorkerWZOrder: WorkerW must be the last (bottom) child of Progman.
    HWND last = nullptr;
    for (HWND c = GetWindow(d.progman, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT)) last = c;
    if (last != d.workerW) {
      SetWindowPos(d.workerW, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      step("WorkerW was not last child; moved to HWND_BOTTOM");
    } else {
      step("WorkerW already bottom child");
    }
  }
  out.Set("ok", true);
  out.Set("layered", layered);
  out.Set("parent", WinInfo(env, parent));
  out.Set("self", WinInfo(env, h));
  out.Set("steps", steps);
  return out;
}

// ---- status(hwnd): is our window still parented into a live desktop?
Napi::Value Status(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND h = HwndFrom(info[0]);
  auto o = Napi::Object::New(env);
  o.Set("isWindow", (bool)IsWindow(h));
  HWND parent = IsWindow(h) ? GetAncestor(h, GA_PARENT) : nullptr;
  o.Set("parent", Hex((uintptr_t)parent));
  o.Set("parentClass", parent ? ClassOf(parent) : "");
  HWND progman = FindWindowW(L"Progman", nullptr);
  o.Set("progman", Hex((uintptr_t)progman));
  o.Set("progmanHasDefView", progman && FindWindowExW(progman, nullptr, L"SHELLDLL_DefView", nullptr) != nullptr);
  bool anyDefView = false;
  EnumWindows([](HWND t, LPARAM lp) -> BOOL {
    if (FindWindowExW(t, nullptr, L"SHELLDLL_DefView", nullptr)) { *(bool*)lp = true; return FALSE; }
    return TRUE;
  }, (LPARAM)&anyDefView);
  o.Set("defViewExists", anyDefView);
  HWND tray = FindWindowW(L"Shell_TrayWnd", nullptr);
  DWORD pid = 0;
  if (tray) GetWindowThreadProcessId(tray, &pid);
  o.Set("explorerPid", (double)pid);
  return o;
}

// ---- passive raw input (RIDEV_INPUTSINK) on a private message-only window thread.
std::atomic<uint64_t> g_moves{0}, g_downs{0}, g_inputs{0};
std::mutex g_mu;
std::vector<std::string> g_clicks;  // "x,y,class,rootClass,desktop"
std::atomic<bool> g_rawStarted{false};
std::atomic<bool> g_rawOk{false};
DWORD g_rawErr = 0;

bool IsDesktopClass(const std::string& c) {
  return c == "SysListView32" || c == "SHELLDLL_DefView" || c == "Progman" || c == "WorkerW";
}

LRESULT CALLBACK RawProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_INPUT) {
    g_inputs++;
    RAWINPUT ri;
    UINT sz = sizeof(ri);
    if (GetRawInputData((HRAWINPUT)lp, RID_INPUT, &ri, &sz, sizeof(RAWINPUTHEADER)) != (UINT)-1 &&
        ri.header.dwType == RIM_TYPEMOUSE) {
      USHORT bf = ri.data.mouse.usButtonFlags;
      if (ri.data.mouse.lLastX || ri.data.mouse.lLastY || (ri.data.mouse.usFlags & MOUSE_MOVE_ABSOLUTE)) g_moves++;
      if (bf & (RI_MOUSE_LEFT_BUTTON_DOWN | RI_MOUSE_RIGHT_BUTTON_DOWN)) {
        g_downs++;
        POINT pt;
        GetCursorPos(&pt);
        HWND under = WindowFromPoint(pt);
        HWND root = under ? GetAncestor(under, GA_ROOT) : nullptr;
        std::string c = under ? ClassOf(under) : "";
        std::string rc = root ? ClassOf(root) : "";
        std::string rec = std::to_string(pt.x) + "," + std::to_string(pt.y) + "," + c + "," + rc + "," +
                          (IsDesktopClass(c) || rc == "Progman" || rc == "WorkerW" ? "desktop" : "other") + ",fg=" + ClassOf(GetForegroundWindow());
        std::lock_guard<std::mutex> l(g_mu);
        if (g_clicks.size() < 50) g_clicks.push_back(rec);
      }
    }
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

void RawThread() {
  WNDCLASSW wc{};
  wc.lpfnWndProc = RawProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"SeiLinkRawInput";
  RegisterClassW(&wc);
  HWND w = CreateWindowExW(0, wc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
  RAWINPUTDEVICE rid{};
  rid.usUsagePage = 0x01;
  rid.usUsage = 0x02;  // mouse
  rid.dwFlags = RIDEV_INPUTSINK;
  rid.hwndTarget = w;
  if (RegisterRawInputDevices(&rid, 1, sizeof(rid))) {
    g_rawOk = true;
  } else {
    g_rawErr = GetLastError();
  }
  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
}

Napi::Value RawInputStart(const Napi::CallbackInfo& info) {
  if (!g_rawStarted.exchange(true)) std::thread(RawThread).detach();
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value RawInputStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto o = Napi::Object::New(env);
  o.Set("registered", g_rawOk.load());
  o.Set("error", (double)g_rawErr);
  o.Set("inputs", (double)g_inputs.load());
  o.Set("moves", (double)g_moves.load());
  o.Set("downs", (double)g_downs.load());
  auto arr = Napi::Array::New(env);
  std::lock_guard<std::mutex> l(g_mu);
  for (uint32_t i = 0; i < g_clicks.size(); i++) arr.Set(i, g_clicks[i]);
  o.Set("clicks", arr);
  return o;
}

// ---- TEST HARNESS ONLY: simulate a user's physical click with SendInput (OS input queue).
// The product never posts mouse messages into Chromium; this only stands in for a real hand.
Napi::Value TestClick(const Napi::CallbackInfo& info) {
  int x = info[0].As<Napi::Number>().Int32Value();
  int y = info[1].As<Napi::Number>().Int32Value();
  SetCursorPos(x, y);
  INPUT in[3] = {};
  int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  in[0].type = INPUT_MOUSE;
  in[0].mi.dx = (LONG)(((x - vx) * 65535.0) / (vw - 1));
  in[0].mi.dy = (LONG)(((y - vy) * 65535.0) / (vh - 1));
  in[0].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  in[1].type = INPUT_MOUSE;
  in[1].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
  in[2].type = INPUT_MOUSE;
  in[2].mi.dwFlags = MOUSEEVENTF_LEFTUP;
  UINT n = SendInput(3, in, sizeof(INPUT));
  return Napi::Number::New(info.Env(), n);
}

Napi::Value Foreground(const Napi::CallbackInfo& info) {
  return WinInfo(info.Env(), GetForegroundWindow());
}

// Visible, uncloaked top-level windows of a class (e.g. "Notepad").
Napi::Value FindTop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string want = info[0].As<Napi::String>().Utf8Value();
  struct Ctx {
    Napi::Env env;
    std::string want;
    Napi::Array arr;
    uint32_t n;
  } ctx{env, want, Napi::Array::New(env), 0};
  EnumWindows(
      [](HWND t, LPARAM lp) -> BOOL {
        auto* c = (Ctx*)lp;
        if (IsWindowVisible(t) && ClassOf(t) == c->want) c->arr.Set(c->n++, WinInfo(c->env, t));
        return TRUE;
      },
      (LPARAM)&ctx);
  return ctx.arr;
}

#include "win_r2.inc"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("platform", "win32");
  exports.Set("inspect", Napi::Function::New(env, Inspect));
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("status", Napi::Function::New(env, Status));
  exports.Set("rawInputStart", Napi::Function::New(env, RawInputStart));
  exports.Set("rawInputStats", Napi::Function::New(env, RawInputStats));
  exports.Set("testClick", Napi::Function::New(env, TestClick));
  exports.Set("foreground", Napi::Function::New(env, Foreground));
  exports.Set("findTop", Napi::Function::New(env, FindTop));
  // round 2
  exports.Set("watchStart", Napi::Function::New(env, WatchStart));
  exports.Set("watchStats", Napi::Function::New(env, WatchStats));
  exports.Set("coverageNow", Napi::Function::New(env, CoverageNow));
  exports.Set("validate", Napi::Function::New(env, Validate));
  exports.Set("testKeys", Napi::Function::New(env, TestKeys));
  exports.Set("testShowWindow", Napi::Function::New(env, TestShowWindow));
  exports.Set("testPostMessage", Napi::Function::New(env, TestPostMessage));
  exports.Set("testSetWallpaper", Napi::Function::New(env, TestSetWallpaper));
  exports.Set("testDisplayModes", Napi::Function::New(env, TestDisplayModes));
  exports.Set("testSetDisplay", Napi::Function::New(env, TestSetDisplay));
  exports.Set("redrawParent", Napi::Function::New(env, RedrawParent));
  return exports;
}

}  // namespace

NODE_API_MODULE(seilink, Init)
