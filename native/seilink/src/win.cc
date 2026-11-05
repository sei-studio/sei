// SeiLink desktop host, Windows half (261104, milestone 3). Ported from the spike
// (exp/seilink-spike, spikes/seilink/native/win.cc + win_r2.inc); the window-tree dumps and the
// synthetic-input helpers stayed behind (the latter live in test_win.cc, never shipped).
//
// Loaded only by the room host process (src/main/seilink/host/hostEntry.ts), plus main's
// redrawDesktop() after a host that died without cleaning up. Exports:
//
//   attach(hwnd, {x,y,w,h})   put the room window behind the desktop icons, inside a container
//                             window of our own (the "room box", see below).
//       raised layout (24H2+): the box is a WS_EX_LAYERED child of Progman, directly below
//                              SHELLDLL_DefView, above the wallpaper WorkerW.
//       classic layout:        the box is a child of the top-level WorkerW that 0x052C spawns.
//   validate(hwnd, {w,h})     is it still there? {ok, layout, reasons[]}
//   shellStatus()             {progman, defView} (Explorer restarts start without a DefView)
//   watchStart(cb)            one thread: hidden top-level window (TaskbarCreated, display and
//                             setting changes, session lock), WinEventHooks -> coverage checks,
//                             and passive raw input (RIDEV_INPUTSINK) for clicks on her.
//                             cb(json) for every event; see the Emit() call sites.
//   setHitRect({x,y,w,h}|null) her box in physical screen px. Only presses that START inside it,
//                             on the desktop (not on a window over her), are reported.
//   coverageNow()             {covered, kind}
//   redrawDesktop(hwnd|null, hard)  repaint the wallpaper after the room is hidden or gone.
//   doubleClickMs()           the user's double-click interval.
//
// Nothing here ever posts input. Window titles and exe names are never reported.
//
// The room box (261105, T332): when Explorer dies, Windows destroys Progman / the WorkerW and every
// child window with it, including a child that belongs to another process. With the room window
// (Chromium's HWND) parented there directly, that destroy reached Chromium's window procedure
// from a kernel callback and the host died with 0xC000041D (STATUS_FATAL_USER_CALLBACK_EXCEPTION,
// CI 261105) before any JS ran. Now the room sits inside a plain window this module owns. A parent
// gets WM_DESTROY before its children, so the box's WM_DESTROY hides the room and lifts it out to
// the desktop (a hidden top-level popup again) before the destroy walks down to it, and emits
// {"type":"shellLost"}. The host then re-attaches once the new shell is up.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <wtsapi32.h>
#include <napi.h>

#include <algorithm>
#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cwchar>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

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

HWND HwndFrom(const Napi::Value& v) {
  HWND h = nullptr;
  if (v.IsBuffer()) {
    auto b = v.As<Napi::Buffer<uint8_t>>();
    memcpy(&h, b.Data(), std::min(b.Length(), sizeof(h)));
  } else if (v.IsNumber()) {
    h = (HWND)(uintptr_t)v.As<Napi::Number>().Int64Value();
  }
  return h;
}

int IntOpt(const Napi::Object& o, const char* k, int dflt) {
  return o.Has(k) && o.Get(k).IsNumber() ? o.Get(k).As<Napi::Number>().Int32Value() : dflt;
}

Napi::Object RectObj(Napi::Env env, const RECT& r) {
  auto o = Napi::Object::New(env);
  o.Set("x", r.left);
  o.Set("y", r.top);
  o.Set("w", r.right - r.left);
  o.Set("h", r.bottom - r.top);
  return o;
}

DWORD OsBuild() {
  using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  auto fn = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  if (!fn) return 0;
  RTL_OSVERSIONINFOW info{};
  info.dwOSVersionInfoSize = sizeof(info);
  return fn(&info) == 0 ? info.dwBuildNumber : 0;
}

// ---------------------------------------------------------------- desktop layout

struct Desk {
  HWND progman = nullptr;
  bool raised = false;
  HWND defView = nullptr;      // SHELLDLL_DefView
  HWND defViewHost = nullptr;  // window that owns DefView (Progman, or a top-level WorkerW)
  HWND workerW = nullptr;      // wallpaper WorkerW we attach into / z-order against
};

Desk FindDesk(bool spawn) {
  Desk d;
  d.progman = FindWindowW(L"Progman", nullptr);
  if (!d.progman) return d;
  d.raised = (GetWindowLongPtrW(d.progman, GWL_EXSTYLE) & WS_EX_NOREDIRECTIONBITMAP) != 0;
  if (spawn) {
    // Ask Explorer for the wallpaper WorkerW (classic) / make sure the raised tree exists.
    DWORD_PTR res = 0;
    SendMessageTimeoutW(d.progman, 0x052C, 0xD, 0x1, SMTO_NORMAL, 1000, &res);
  }
  // Classic: the top-level window holding DefView, then the next top-level WorkerW after it.
  EnumWindows(
      [](HWND top, LPARAM lp) -> BOOL {
        auto* dd = (Desk*)lp;
        HWND p = FindWindowExW(top, nullptr, L"SHELLDLL_DefView", nullptr);
        if (p) {
          dd->defView = p;
          dd->defViewHost = top;
          dd->workerW = FindWindowExW(nullptr, top, L"WorkerW", nullptr);
        }
        return TRUE;
      },
      (LPARAM)&d);
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

// ---------------------------------------------------------------- CI trace
// SEI_SEILINK_NATIVE_TRACE=<file> (the CI self-test only): append-only, flushed line by line so
// it survives the process dying. Logs every exception the process raises (code, address and a
// short stack as module+offset, from a vectored handler that only observes), the room box's and
// the room window's messages, and the watcher's shell events. Off (one null check) otherwise.

FILE* g_trace = nullptr;
std::mutex g_traceMu;

void Trace(const char* fmt, ...) {
  if (!g_trace) return;
  std::lock_guard<std::mutex> l(g_traceMu);
  fprintf(g_trace, "[%lu %lu %llu] ", GetCurrentProcessId(), GetCurrentThreadId(), (unsigned long long)GetTickCount64());
  va_list ap;
  va_start(ap, fmt);
  vfprintf(g_trace, fmt, ap);
  va_end(ap);
  fputc('\n', g_trace);
  fflush(g_trace);
}

void ModOff(void* addr, char* out, size_t n) {
  HMODULE mod = nullptr;
  wchar_t name[MAX_PATH] = {0};
  if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                         (LPCWSTR)addr, &mod) &&
      GetModuleFileNameW(mod, name, MAX_PATH)) {
    const wchar_t* base = wcsrchr(name, L'\\');
    snprintf(out, n, "%ls+0x%llX", base ? base + 1 : name, (unsigned long long)((uintptr_t)addr - (uintptr_t)mod));
  } else {
    snprintf(out, n, "0x%llX", (unsigned long long)(uintptr_t)addr);
  }
}

LONG CALLBACK TraceVeh(PEXCEPTION_POINTERS ep) {
  DWORD code = ep->ExceptionRecord->ExceptionCode;
  // Thread naming, debug prints and C++ throws Chromium catches itself are noise.
  if (code == 0x406D1388 || code == 0x40010006 || code == 0x4001000A || code == 0xE06D7363) return EXCEPTION_CONTINUE_SEARCH;
  char at[300];
  ModOff(ep->ExceptionRecord->ExceptionAddress, at, sizeof at);
  std::string st;
  void* frames[28];
  USHORT nf = CaptureStackBackTrace(0, 28, frames, nullptr);
  for (USHORT i = 0; i < nf; i++) {
    char f[300];
    ModOff(frames[i], f, sizeof f);
    st += " ";
    st += f;
  }
  ULONG_PTR p0 = ep->ExceptionRecord->NumberParameters > 0 ? ep->ExceptionRecord->ExceptionInformation[0] : 0;
  ULONG_PTR p1 = ep->ExceptionRecord->NumberParameters > 1 ? ep->ExceptionRecord->ExceptionInformation[1] : 0;
  Trace("EXCEPTION 0x%08lX at %s flags 0x%lX p0 0x%llX p1 0x%llX stack%s", code, at, ep->ExceptionRecord->ExceptionFlags,
        (unsigned long long)p0, (unsigned long long)p1, st.c_str());
  return EXCEPTION_CONTINUE_SEARCH;
}

void TraceInit() {
  char path[MAX_PATH] = {0};
  DWORD n = GetEnvironmentVariableA("SEI_SEILINK_NATIVE_TRACE", path, MAX_PATH);
  if (!n || n >= MAX_PATH || g_trace) return;
  g_trace = fopen(path, "a");
  if (!g_trace) return;
  AddVectoredExceptionHandler(1, TraceVeh);
  Trace("trace on");
}

bool Noisy(UINT m) {
  return m == WM_PAINT || m == WM_TIMER || m == WM_NCHITTEST || m == WM_SETCURSOR || m == WM_MOUSEMOVE ||
         m == WM_ERASEBKGND || m == WM_GETOBJECT || m == 0x0060 /* WM_SYNCPAINT-ish ime */ || m == WM_NCMOUSEMOVE;
}

WNDPROC g_roomOldProc = nullptr;
HWND g_roomTraced = nullptr;

LRESULT CALLBACK RoomTraceProc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
  if (!Noisy(m)) Trace("room msg 0x%04X wp 0x%llX lp 0x%llX insend %d", m, (unsigned long long)wp, (unsigned long long)lp, InSendMessageEx(nullptr));
  LRESULT r = CallWindowProcW(g_roomOldProc, h, m, wp, lp);
  if (m == WM_DESTROY || m == WM_NCDESTROY) Trace("room msg 0x%04X returned", m);
  return r;
}

void TraceRoom(HWND h) {
  if (!g_trace || !h || h == g_roomTraced) return;
  g_roomOldProc = (WNDPROC)SetWindowLongPtrW(h, GWLP_WNDPROC, (LONG_PTR)RoomTraceProc);
  g_roomTraced = h;
  Trace("room traced 0x%llX", (unsigned long long)(uintptr_t)h);
}

// ---------------------------------------------------------------- room box

void Emit(std::string json);  // watcher section

HWND g_box = nullptr;   // our container, child of Progman / the WorkerW
HWND g_room = nullptr;  // the room window attach() last put in it
bool g_boxLayered = false;
const wchar_t kBoxClass[] = L"SeiLinkRoomBox";

bool IsBox(HWND h) { return h && h == g_box && IsWindow(h); }

// Make `room` a hidden, unparented popup again (its state before the first attach).
bool LiftOut(HWND room) {
  ShowWindow(room, SW_HIDE);
  SetLastError(0);
  SetParent(room, nullptr);
  LONG_PTR style = GetWindowLongPtrW(room, GWL_STYLE);
  SetWindowLongPtrW(room, GWL_STYLE, (style & ~(LONG_PTR)WS_CHILD) | WS_POPUP);
  return GetAncestor(room, GA_PARENT) == GetDesktopWindow();
}

LRESULT CALLBACK BoxProc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
  if (!Noisy(m)) Trace("box msg 0x%04X wp 0x%llX insend %d", m, (unsigned long long)wp, InSendMessageEx(nullptr));
  switch (m) {
    case WM_DESTROY: {
      // The shell is going away (or the process is exiting). Save the room first.
      HWND room = g_room;
      if (room && IsWindow(room) && GetAncestor(room, GA_PARENT) == h) {
        bool ok = LiftOut(room);
        Trace("box rescue %s err %lu", ok ? "ok" : "FAILED", GetLastError());
        Emit(std::string("{\"type\":\"shellLost\",\"rescued\":") + (ok ? "true" : "false") +
             ",\"err\":" + std::to_string(GetLastError()) + "}");
      }
      return 0;
    }
    case WM_NCDESTROY:
      if (g_box == h) g_box = nullptr;
      break;
    case WM_ERASEBKGND:
      return 1;  // the room covers all of it
    case WM_NCHITTEST:
      return HTTRANSPARENT;
    case WM_MOUSEACTIVATE:
      return MA_NOACTIVATE;
  }
  return DefWindowProcW(h, m, wp, lp);
}

// The box under `parent` (made, or moved there). Created on the calling thread, which is the
// room window's own (the host's main thread), so the rescue in WM_DESTROY is a same-thread call.
HWND EnsureBox(HWND parent, bool layered, int x, int y, int w, int hh, std::string* why) {
  static bool registered = false;
  HINSTANCE inst = GetModuleHandleW(nullptr);
  if (!registered) {
    WNDCLASSW wc{};
    wc.lpfnWndProc = BoxProc;
    wc.hInstance = inst;
    wc.lpszClassName = kBoxClass;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    registered = RegisterClassW(&wc) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
  }
  if (IsBox(g_box) && GetAncestor(g_box, GA_PARENT) == parent && g_boxLayered == layered) return g_box;
  HWND old = IsBox(g_box) ? g_box : nullptr;
  // WS_EX_LAYERED is set at creation, before the box has a parent's redirection to join (the
  // Lively/Godot note for the raised layout). WS_EX_NOPARENTNOTIFY: no WM_PARENTNOTIFY round trip
  // into Explorer while we create or destroy it.
  DWORD ex = WS_EX_NOACTIVATE | WS_EX_NOPARENTNOTIFY | (layered ? WS_EX_LAYERED : 0);
  POINT p{x, y};
  ScreenToClient(parent, &p);
  HWND b = CreateWindowExW(ex, kBoxClass, L"", WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS, p.x, p.y, w,
                           hh, parent, nullptr, inst, nullptr);
  if (!b) {
    if (why) *why = "CreateWindowEx err " + std::to_string(GetLastError());
    return nullptr;
  }
  if (layered && !SetLayeredWindowAttributes(b, 0, 255, LWA_ALPHA) && why)
    *why = "box SetLayeredWindowAttributes failed " + std::to_string(GetLastError());
  g_box = b;
  g_boxLayered = layered;
  if (old) {
    // Move the room over first so the old box's WM_DESTROY has nothing to rescue.
    if (g_room && IsWindow(g_room) && GetAncestor(g_room, GA_PARENT) == old) SetParent(g_room, b);
    DestroyWindow(old);
  }
  return b;
}

Napi::Value Attach(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND h = HwndFrom(info[0]);
  auto opts = info.Length() > 1 && info[1].IsObject() ? info[1].As<Napi::Object>() : Napi::Object::New(env);
  int x = IntOpt(opts, "x", 0);
  int y = IntOpt(opts, "y", 0);
  int w = IntOpt(opts, "w", GetSystemMetrics(SM_CXSCREEN));
  int hh = IntOpt(opts, "h", GetSystemMetrics(SM_CYSCREEN));

  auto out = Napi::Object::New(env);
  auto steps = Napi::Array::New(env);
  uint32_t si = 0;
  auto step = [&](const std::string& s) { steps.Set(si++, s); };
  auto fail = [&](const char* failure, const std::string& detail) {
    out.Set("ok", false);
    out.Set("failure", failure);
    out.Set("error", detail);
    out.Set("steps", steps);
    return out;
  };
  out.Set("osBuild", (double)OsBuild());
  if (!h || !IsWindow(h)) return fail("no_window", "room window handle is not a window");

  Desk d = FindDesk(true);
  out.Set("layout", d.raised ? "raised" : "classic");
  if (!d.progman) return fail("no_shell", "no Progman");
  HWND parent = d.raised ? d.progman : d.workerW;
  out.Set("method", d.raised ? "raised: layered box in Progman below DefView" : "classic: box in the 0x052C WorkerW");
  if (!parent) return fail("no_workerw", "no wallpaper WorkerW");
  if (d.raised && !d.defView) return fail("no_shell", "no DefView under Progman");

  std::string boxWhy;
  HWND box = EnsureBox(parent, d.raised, x, y, w, hh, &boxWhy);
  if (!box) return fail("set_parent_failed", "room box: " + boxWhy);
  if (!boxWhy.empty()) step(boxWhy);
  g_room = h;
  TraceRoom(h);

  LONG_PTR style = GetWindowLongPtrW(h, GWL_STYLE);
  LONG_PTR nstyle = (style | WS_CHILD) &
                    ~(LONG_PTR)(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
  SetWindowLongPtrW(h, GWL_STYLE, nstyle);
  LONG_PTR ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
  // The box carries WS_EX_LAYERED now; a room left layered by an older attach would be a layered
  // child inside a layered child, so it is cleared.
  LONG_PTR nex = (ex | WS_EX_NOACTIVATE) & ~(LONG_PTR)(WS_EX_APPWINDOW | WS_EX_LAYERED);
  SetWindowLongPtrW(h, GWL_EXSTYLE, nex);

  SetLastError(0);
  if (GetAncestor(h, GA_PARENT) != box) SetParent(h, box);
  DWORD spErr = GetLastError();
  if (GetAncestor(h, GA_PARENT) != box) return fail("set_parent_failed", "SetParent err " + std::to_string(spErr));
  step("parent " + ClassOf(parent) + " via box");

  POINT p{x, y};
  ScreenToClient(parent, &p);
  UINT flags = SWP_NOACTIVATE | SWP_SHOWWINDOW;
  HWND after = nullptr;
  if (d.raised) after = d.defView;  // insert the box directly below DefView
  else flags |= SWP_NOZORDER;
  if (!SetWindowPos(box, after, p.x, p.y, w, hh, flags)) step("box SetWindowPos failed " + std::to_string(GetLastError()));
  if (!SetWindowPos(h, nullptr, 0, 0, w, hh, SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED))
    step("SetWindowPos failed " + std::to_string(GetLastError()));
  // A leftover non-client frame shrinks the page (CI 261104: an 8 px strip each side).
  RECT cr{};
  if (GetClientRect(h, &cr) && (cr.right - cr.left != w || cr.bottom - cr.top != hh))
    step("client " + std::to_string(cr.right - cr.left) + "x" + std::to_string(cr.bottom - cr.top) + " of " +
         std::to_string(w) + "x" + std::to_string(hh));

  if (d.raised && d.workerW) {
    // The wallpaper WorkerW must stay the last (bottom) child of Progman.
    HWND last = nullptr;
    for (HWND c = GetWindow(d.progman, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT)) last = c;
    if (last != d.workerW) {
      SetWindowPos(d.workerW, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      step("WorkerW moved to bottom");
    }
  }
  out.Set("ok", true);
  out.Set("steps", steps);
  return out;
}

Napi::Value ShellStatus(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto o = Napi::Object::New(env);
  HWND progman = FindWindowW(L"Progman", nullptr);
  bool anyDefView = false;
  EnumWindows(
      [](HWND t, LPARAM lp) -> BOOL {
        if (FindWindowExW(t, nullptr, L"SHELLDLL_DefView", nullptr)) {
          *(bool*)lp = true;
          return FALSE;
        }
        return TRUE;
      },
      (LPARAM)&anyDefView);
  o.Set("progman", progman != nullptr);
  o.Set("defView", anyDefView);
  return o;
}

// validate(hwnd, {w,h}): is the room still where attach() put it? Cheap. The host re-attaches when
// !ok (see hostEntry.ts for the raised-layout WorkerW exception).
Napi::Value Validate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND h = HwndFrom(info[0]);
  auto opts = info.Length() > 1 && info[1].IsObject() ? info[1].As<Napi::Object>() : Napi::Object::New(env);
  int ew = IntOpt(opts, "w", 0);
  int eh = IntOpt(opts, "h", 0);
  auto o = Napi::Object::New(env);
  auto reasons = Napi::Array::New(env);
  uint32_t ri = 0;
  auto bad = [&](const char* s) { reasons.Set(ri++, s); };
  Desk d = FindDesk(false);
  o.Set("layout", d.raised ? "raised" : "classic");
  if (!d.progman) bad("no-progman");
  if (!d.defView) bad("no-defview");
  if (!IsWindow(h)) {
    bad("own-window-gone");
  } else {
    // The room sits in our box; the box is what Explorer's tree holds.
    HWND parent = GetAncestor(h, GA_PARENT);
    bool inBox = IsBox(parent);
    if (!inBox) bad("not-in-box");
    HWND top = inBox ? GetAncestor(parent, GA_PARENT) : parent;
    HWND node = inBox ? parent : h;
    if (d.raised) {
      if (top != d.progman) bad("parent-not-progman");
      if (d.defView && GetWindow(d.defView, GW_HWNDNEXT) != node) bad("not-directly-below-defview");
      if (!d.workerW) {
        bad("no-workerw");
      } else {
        HWND last = nullptr;
        for (HWND c = GetWindow(d.progman, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT)) last = c;
        if (last != d.workerW) bad("workerw-not-bottom");
      }
    } else {
      if (!d.workerW) bad("no-workerw");
      else if (top != d.workerW) bad("parent-not-wallpaper-workerw");
    }
    if (inBox && !IsWindowVisible(parent)) o.Set("hidden", true);
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

// redrawDesktop(hwnd|null, hard): hide the room (when given) and make the wallpaper repaint. On
// the classic layout a hidden child left its last frame on screen until the WorkerW repainted
// (spike round 2, windows-2022); hard=true also re-applies the current wallpaper
// (SPI_SETDESKWALLPAPER with NULL, Lively's RefreshDesktop), which forces it.
Napi::Value RedrawDesktop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND h = info.Length() > 0 ? HwndFrom(info[0]) : nullptr;
  bool hard = info.Length() > 1 && info[1].IsBoolean() && info[1].As<Napi::Boolean>().Value();
  HWND p = h && IsWindow(h) ? GetParent(h) : nullptr;
  if (h && IsWindow(h) && IsWindowVisible(h)) ShowWindow(h, SW_HIDE);
  if (IsBox(p)) {
    // The box draws nothing of its own; hide it too and repaint what is under it.
    ShowWindow(p, SW_HIDE);
    p = GetParent(p);
  }
  BOOL ok = TRUE;
  if (p) ok = RedrawWindow(p, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW);
  if (hard) ok = SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, nullptr, SPIF_UPDATEINIFILE) && ok;
  return Napi::Boolean::New(env, ok != FALSE);
}

Napi::Value DoubleClickMs(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), (double)GetDoubleClickTime());
}

// ---------------------------------------------------------------- watcher thread

Napi::ThreadSafeFunction g_tsfn;
std::atomic<bool> g_watchStarted{false};
UINT g_msgTaskbarCreated = 0;
HWND g_watchHwnd = nullptr;
HWINEVENTHOOK g_locHook = nullptr;
HWND g_fgForHook = nullptr;
int g_lastCovered = -1;
std::string g_pendingWhy;

std::mutex g_hitMu;
bool g_hitSet = false;
RECT g_hit{};
bool g_downInside[2] = {false, false};  // left, right

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
  if (!g_watchStarted) return;
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
  std::string cls;
};

// True when rect `in` covers rect `outer` (within tol px). The spike's runs 1-3 called it with the
// arguments swapped, so every on-monitor window read as "fullscreen".
bool Contains(const RECT& outer, const RECT& in, int tol) {
  return in.left <= outer.left + tol && in.top <= outer.top + tol && in.right >= outer.right - tol &&
         in.bottom >= outer.bottom - tol;
}

struct CoverCtx {
  Cover* cv;
  HMONITOR mon;
  MONITORINFO mi;
  DWORD self;
};

// Any visible, uncloaked, non-minimized window that is maximized on the room's monitor or covers
// the whole monitor hides the wallpaper, whatever its z-order (the room is the bottom layer).
const char* CoverKind(HWND t, CoverCtx* c) {
  if (!IsWindowVisible(t) || IsIconic(t)) return nullptr;
  LONG_PTR ex = GetWindowLongPtrW(t, GWL_EXSTYLE);
  if (ex & (WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW)) return nullptr;
  BOOL cloaked = FALSE;
  DwmGetWindowAttribute(t, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
  if (cloaked) return nullptr;
  std::string cls = ClassOf(t);
  if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd")
    return nullptr;
  // Shell-owned windows that are "visible" and uncloaked but draw nothing (a guard from the spike).
  static const char* kInvisibleShell[] = {"ApplicationManager_ImmersiveShellWindow", "EdgeUiInputTopWndClass",
                                          "EdgeUiInputWndClass", "NativeHWNDHost", "Internet Explorer_Hidden",
                                          "ApplicationManager_DesktopShellWindow", "ForegroundStaging",
                                          "MultitaskingViewFrame", "XamlExplorerHostIslandWindow"};
  for (const char* k : kInvisibleShell)
    if (cls == k) return nullptr;
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
  if (Contains(c->mi.rcMonitor, r, 2)) return "fullscreen";
  if (IsZoomed(t) && Contains(c->mi.rcWork, r, 10)) return "maximized";
  return nullptr;
}

Cover ComputeCover() {
  Cover cv;
  // v1: the room lives on the primary display only.
  HMONITOR mon = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  GetMonitorInfoW(mon, &mi);
  CoverCtx ctx{&cv, mon, mi, GetCurrentProcessId()};
  EnumWindows(
      [](HWND t, LPARAM lp) -> BOOL {
        auto* c = (CoverCtx*)lp;
        const char* kind = CoverKind(t, c);
        if (!kind) return TRUE;
        c->cv->covered = true;
        c->cv->kind = kind;
        c->cv->cls = ClassOf(t);
        return FALSE;
      },
      (LPARAM)&ctx);
  QUERY_USER_NOTIFICATION_STATE q{};
  if (!cv.covered && SUCCEEDED(SHQueryUserNotificationState(&q)) && q == QUNS_RUNNING_D3D_FULL_SCREEN) {
    cv.covered = true;
    cv.kind = "d3d-fullscreen";
  }
  return cv;
}

void Recheck(const std::string& why) {
  uint64_t t0 = NowMs();
  Cover cv = ComputeCover();
  int c = cv.covered ? 1 : 0;
  if (c != g_lastCovered) {
    g_lastCovered = c;
    Emit("{\"type\":\"coverage\",\"trigger\":" + Q(why) + ",\"checkMs\":" + std::to_string(NowMs() - t0) +
         ",\"covered\":" + (cv.covered ? "true" : "false") + ",\"kind\":" + Q(cv.kind) + ",\"by\":" + Q(cv.cls) + "}");
  }
}

void ScheduleRecheck(const std::string& why) {
  if (g_pendingWhy.empty()) g_pendingWhy = why;
  SetTimer(g_watchHwnd, 1, 50, nullptr);
}

void CALLBACK HookProc(HWINEVENTHOOK, DWORD ev, HWND hwnd, LONG idObj, LONG idChild, DWORD, DWORD) {
  if (ev != EVENT_OBJECT_LOCATIONCHANGE) Trace("hook ev 0x%lX hwnd 0x%llX", ev, (unsigned long long)(uintptr_t)hwnd);
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
      // Location changes of the front window only (maximize / restore), never a global hook.
      if (tid)
        g_locHook = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, nullptr, HookProc, pid,
                                    tid, WINEVENT_OUTOFCONTEXT);
    }
    ScheduleRecheck("foreground");
    return;
  }
  ScheduleRecheck(ev == EVENT_SYSTEM_MINIMIZESTART ? "minimizestart"
                  : ev == EVENT_SYSTEM_MINIMIZEEND ? "minimizeend"
                  : ev == EVENT_SYSTEM_MOVESIZEEND ? "movesizeend"
                                                   : "winevent");
}

bool IsDesktopClass(const std::string& c) {
  return c == "SysListView32" || c == "SHELLDLL_DefView" || c == "Progman" || c == "WorkerW";
}

// Is the window under the cursor the desktop (or our own room)? A window over her is not.
bool PointOnDesktop(POINT pt) {
  HWND under = WindowFromPoint(pt);
  if (!under) return false;
  DWORD pid = 0;
  GetWindowThreadProcessId(under, &pid);
  if (pid == GetCurrentProcessId()) return true;
  if (IsDesktopClass(ClassOf(under))) return true;
  HWND root = GetAncestor(under, GA_ROOT);
  std::string rc = root ? ClassOf(root) : "";
  return rc == "Progman" || rc == "WorkerW";
}

void OnRawMouse(const RAWMOUSE& m) {
  USHORT bf = m.usButtonFlags;
  const USHORT downs[2] = {RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_DOWN};
  const USHORT ups[2] = {RI_MOUSE_LEFT_BUTTON_UP, RI_MOUSE_RIGHT_BUTTON_UP};
  const char* names[2] = {"left", "right"};
  if (!(bf & (downs[0] | downs[1] | ups[0] | ups[1]))) return;
  POINT pt;
  GetCursorPos(&pt);
  for (int b = 0; b < 2; b++) {
    const char* kind = nullptr;
    if (bf & downs[b]) {
      bool inside;
      {
        std::lock_guard<std::mutex> l(g_hitMu);
        inside = g_hitSet && pt.x >= g_hit.left && pt.x < g_hit.right && pt.y >= g_hit.top && pt.y < g_hit.bottom;
      }
      // Only presses that start on HER (her box, on the desktop) are reported at all.
      g_downInside[b] = inside && PointOnDesktop(pt);
      if (g_downInside[b]) kind = "down";
    } else if ((bf & ups[b]) && g_downInside[b]) {
      g_downInside[b] = false;
      kind = "up";
    }
    if (kind)
      Emit(std::string("{\"type\":\"pointer\",\"kind\":\"") + kind + "\",\"button\":\"" + names[b] + "\",\"x\":" +
           std::to_string(pt.x) + ",\"y\":" + std::to_string(pt.y) + ",\"t\":" + std::to_string(NowMs()) + "}");
  }
}

LRESULT CALLBACK WatchProc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
  if (g_msgTaskbarCreated && m == g_msgTaskbarCreated) {
    Trace("watch TaskbarCreated");
    Emit("{\"type\":\"taskbarCreated\"}");
    ScheduleRecheck("taskbarCreated");
    return 0;
  }
  switch (m) {
    case WM_INPUT: {
      RAWINPUT ri;
      UINT sz = sizeof(ri);
      if (GetRawInputData((HRAWINPUT)lp, RID_INPUT, &ri, &sz, sizeof(RAWINPUTHEADER)) != (UINT)-1 &&
          ri.header.dwType == RIM_TYPEMOUSE)
        OnRawMouse(ri.data.mouse);
      break;  // DefWindowProc must still see WM_INPUT
    }
    case WM_DISPLAYCHANGE:
      Emit("{\"type\":\"displayChange\"}");
      ScheduleRecheck("displayChange");
      break;
    case WM_SETTINGCHANGE:
      Emit("{\"type\":\"settingChange\",\"action\":" + std::to_string((unsigned)wp) + "}");
      break;
    case WM_WTSSESSION_CHANGE:
      Emit("{\"type\":\"session\",\"code\":" + std::to_string((unsigned)wp) + "}");
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
  // Hidden, never shown, unowned top-level window (not HWND_MESSAGE): TaskbarCreated,
  // WM_DISPLAYCHANGE and WM_SETTINGCHANGE are broadcasts that reach top-level windows only.
  g_watchHwnd = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, wc.lpszClassName, L"", WS_POPUP, 0, 0, 0, 0,
                                nullptr, nullptr, wc.hInstance, nullptr);
  ChangeWindowMessageFilterEx(g_watchHwnd, g_msgTaskbarCreated, MSGFLT_ALLOW, nullptr);
  BOOL wts = WTSRegisterSessionNotification(g_watchHwnd, NOTIFY_FOR_THIS_SESSION);
  HWINEVENTHOOK h1 = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, HookProc, 0, 0,
                                     WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  HWINEVENTHOOK h2 = SetWinEventHook(EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND, nullptr, HookProc, 0, 0,
                                     WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  HWINEVENTHOOK h3 = SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, nullptr, HookProc, 0, 0,
                                     WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  // Passive mouse input: the desktop still gets every click (nothing is captured or swallowed).
  RAWINPUTDEVICE rid{};
  rid.usUsagePage = 0x01;
  rid.usUsage = 0x02;  // mouse
  rid.dwFlags = RIDEV_INPUTSINK;
  rid.hwndTarget = g_watchHwnd;
  BOOL raw = RegisterRawInputDevices(&rid, 1, sizeof(rid));
  // Seed the scoped location hook for the current foreground window, and the first coverage state.
  HookProc(nullptr, EVENT_SYSTEM_FOREGROUND, GetForegroundWindow(), OBJID_WINDOW, CHILDID_SELF, 0, 0);
  Emit(std::string("{\"type\":\"watchStarted\",\"wts\":") + (wts ? "true" : "false") +
       ",\"hooks\":" + ((h1 && h2 && h3) ? "true" : "false") + ",\"rawInput\":" + (raw ? "true" : "false") + "}");
  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
}

Napi::Value WatchStart(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "watchStart: expected a callback function").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_watchStarted) return Napi::Boolean::New(env, false);
  g_tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "seilink-watch", 0, 1);
  g_tsfn.Unref(env);
  g_watchStarted = true;
  std::thread(WatchThread).detach();
  return Napi::Boolean::New(env, true);
}

Napi::Value SetHitRect(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> l(g_hitMu);
  if (info.Length() < 1 || !info[0].IsObject()) {
    g_hitSet = false;
    return info.Env().Undefined();
  }
  auto o = info[0].As<Napi::Object>();
  int x = IntOpt(o, "x", 0), y = IntOpt(o, "y", 0), w = IntOpt(o, "w", 0), h = IntOpt(o, "h", 0);
  g_hit = RECT{x, y, x + std::max(0, w), y + std::max(0, h)};
  g_hitSet = w > 0 && h > 0;
  return info.Env().Undefined();
}

Napi::Value CoverageNow(const Napi::CallbackInfo& info) {
  Cover cv = ComputeCover();
  auto o = Napi::Object::New(info.Env());
  o.Set("covered", cv.covered);
  o.Set("kind", cv.kind);
  return o;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  TraceInit();
  exports.Set("platform", "win32");
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("validate", Napi::Function::New(env, Validate));
  exports.Set("shellStatus", Napi::Function::New(env, ShellStatus));
  exports.Set("watchStart", Napi::Function::New(env, WatchStart));
  exports.Set("setHitRect", Napi::Function::New(env, SetHitRect));
  exports.Set("coverageNow", Napi::Function::New(env, CoverageNow));
  exports.Set("redrawDesktop", Napi::Function::New(env, RedrawDesktop));
  exports.Set("doubleClickMs", Napi::Function::New(env, DoubleClickMs));
  return exports;
}

}  // namespace

NODE_API_MODULE(seilink, Init)
