// SeiLink CI-only helper addon (seilink_test.node): a stand-in for a user's hand in the
// seilink-host-check workflow. NEVER shipped (scripts/build-seilink-addon.mjs copies only
// seilink.node into resources/), and the product never posts input.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <napi.h>

namespace {

void Move(int x, int y) {
  INPUT in{};
  int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  SetCursorPos(x, y);
  in.type = INPUT_MOUSE;
  in.mi.dx = (LONG)(((x - vx) * 65535.0) / (vw - 1));
  in.mi.dy = (LONG)(((y - vy) * 65535.0) / (vh - 1));
  in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  SendInput(1, &in, sizeof(INPUT));
}

UINT Button(DWORD flags) {
  INPUT in{};
  in.type = INPUT_MOUSE;
  in.mi.dwFlags = flags;
  return SendInput(1, &in, sizeof(INPUT));
}

// testClick(x, y, count = 1): physical screen px. count 2 = a double click.
Napi::Value TestClick(const Napi::CallbackInfo& info) {
  int x = info[0].As<Napi::Number>().Int32Value();
  int y = info[1].As<Napi::Number>().Int32Value();
  int count = info.Length() > 2 ? info[2].As<Napi::Number>().Int32Value() : 1;
  Move(x, y);
  Sleep(60);
  UINT n = 0;
  for (int i = 0; i < count; i++) {
    n += Button(MOUSEEVENTF_LEFTDOWN);
    Sleep(30);
    n += Button(MOUSEEVENTF_LEFTUP);
    Sleep(90);
  }
  return Napi::Number::New(info.Env(), n);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("platform", "win32");
  exports.Set("testClick", Napi::Function::New(env, TestClick));
  return exports;
}

}  // namespace

NODE_API_MODULE(seilink_test, Init)
