// SeiLink CI-only helper addon (seilink_test.node): a stand-in for a user's hand in the
// seilink-host-check workflow. NEVER shipped (scripts/build-seilink-addon.mjs copies only
// seilink.node into resources/), and the product never posts input. Posting needs the
// Accessibility grant, which the GitHub macOS runners have.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <napi.h>
#include <unistd.h>
#include <string>

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

// axSetWindowFrame(bundleId, x, y, w, h): move and size the app's first standard window
// through Accessibility (Apple Events to the app need a separate Automation grant the
// runner may not have). Returns "ok" or what failed.
Napi::Value AxSetWindowFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string bundle = info[0].As<Napi::String>().Utf8Value();
  CGPoint pos = CGPointMake(info[1].As<Napi::Number>().DoubleValue(), info[2].As<Napi::Number>().DoubleValue());
  CGSize size = CGSizeMake(info[3].As<Napi::Number>().DoubleValue(), info[4].As<Napi::Number>().DoubleValue());
  if (!AXIsProcessTrusted()) return Napi::String::New(env, "not AX trusted");
  NSArray<NSRunningApplication*>* apps =
      [NSRunningApplication runningApplicationsWithBundleIdentifier:[NSString stringWithUTF8String:bundle.c_str()]];
  if (apps.count == 0) return Napi::String::New(env, "not running");
  NSRunningApplication* app = apps.firstObject;
  [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  AXUIElementRef axApp = AXUIElementCreateApplication(app.processIdentifier);
  CFArrayRef windows = nullptr;
  AXError err = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute, (CFTypeRef*)&windows);
  std::string res = "no window";
  if (err != kAXErrorSuccess) {
    res = "windows error " + std::to_string((int)err);
  } else if (windows && CFArrayGetCount(windows) > 0) {
    AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex(windows, 0);
    AXValueRef p = AXValueCreate((AXValueType)kAXValueCGPointType, &pos);
    AXValueRef sz = AXValueCreate((AXValueType)kAXValueCGSizeType, &size);
    AXError e1 = AXUIElementSetAttributeValue(w, kAXPositionAttribute, p);
    AXError e2 = AXUIElementSetAttributeValue(w, kAXSizeAttribute, sz);
    AXUIElementPerformAction(w, kAXRaiseAction);
    CFRelease(p);
    CFRelease(sz);
    res = (e1 == kAXErrorSuccess && e2 == kAXErrorSuccess)
              ? "ok"
              : "set error " + std::to_string((int)e1) + "/" + std::to_string((int)e2);
  }
  if (windows) CFRelease(windows);
  CFRelease(axApp);
  return Napi::String::New(env, res);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("platform", "darwin");
  exports.Set("testClick", Napi::Function::New(env, TestClick));
  exports.Set("axSetWindowFrame", Napi::Function::New(env, AxSetWindowFrame));
  return exports;
}

}  // namespace

NODE_API_MODULE(seilink_test, Init)
