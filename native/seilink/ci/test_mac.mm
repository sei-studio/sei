// SeiLink CI-only helper addon (seilink_test.node): a stand-in for a user's hand in the
// seilink-host-check workflow. NEVER shipped (scripts/build-seilink-addon.mjs copies only
// seilink.node into resources/), and the product never posts input. Posting needs the
// Accessibility grant, which the GitHub macOS runners have.
#import <ApplicationServices/ApplicationServices.h>
#include <napi.h>
#include <unistd.h>

namespace {

void Post(CGEventType t, CGPoint p, int clickState) {
  CGEventRef e = CGEventCreateMouseEvent(nullptr, t, p, kCGMouseButtonLeft);
  if (clickState) CGEventSetIntegerValueField(e, kCGMouseEventClickState, clickState);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

// testClick(x, y, count = 1): global top-left points. count 2 = a double click.
Napi::Value TestClick(const Napi::CallbackInfo& info) {
  CGPoint p = CGPointMake(info[0].As<Napi::Number>().DoubleValue(), info[1].As<Napi::Number>().DoubleValue());
  int count = info.Length() > 2 ? info[2].As<Napi::Number>().Int32Value() : 1;
  Post(kCGEventMouseMoved, p, 0);
  usleep(60000);
  for (int i = 1; i <= count; i++) {
    Post(kCGEventLeftMouseDown, p, i);
    usleep(30000);
    Post(kCGEventLeftMouseUp, p, i);
    usleep(90000);
  }
  return Napi::Boolean::New(info.Env(), AXIsProcessTrusted());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("platform", "darwin");
  exports.Set("testClick", Napi::Function::New(env, TestClick));
  return exports;
}

}  // namespace

NODE_API_MODULE(seilink_test, Init)
